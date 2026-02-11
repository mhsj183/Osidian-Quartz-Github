#!/usr/bin/env node
/**
 * Obsidian 可发布内容 → Quartz content 同步脚本
 * 以「相对路径 + 最后修改时间」比对：新增、更新、删除。
 * 不修改 index.md 等非本工具写入的文件。
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "config.json");

async function loadConfig() {
  const defaults = {
    obsidianDir: path.join(PROJECT_ROOT, "obsidian"),
    quartzContentDir: path.join(PROJECT_ROOT, "quartz", "content"),
  };
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const resolvePath = (p) =>
      path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
    return {
      obsidianDir: cfg.obsidianDir != null ? resolvePath(cfg.obsidianDir) : defaults.obsidianDir,
      quartzContentDir: cfg.quartzContentDir != null ? resolvePath(cfg.quartzContentDir) : defaults.quartzContentDir,
    };
  } catch {
    return defaults;
  }
}

// 优先级：环境变量 > config.json > 默认值
function resolvePaths(config) {
  const obsidianDir = process.env.OBSIDIAN_DIR
    ? path.resolve(PROJECT_ROOT, process.env.OBSIDIAN_DIR)
    : config.obsidianDir;
  const quartzContentDir = process.env.QUARTZ_CONTENT_DIR
    ? path.resolve(PROJECT_ROOT, process.env.QUARTZ_CONTENT_DIR)
    : config.quartzContentDir;
  return { obsidianDir, quartzContentDir };
}

// 同步状态放在工具目录内，与 obsidian / quartz 解耦
const MANIFEST_PATH = path.join(__dirname, ".obsidian-sync-manifest.json");

// --- frontmatter & publishable ---
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---/;
// 同时匹配「可发布」与「已发布」
const PUBLISHABLE_REGEX = /(?:可发布|已发布)\s*:\s*true/;

function hasPublishableFrontmatter(content) {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return false;
  return PUBLISHABLE_REGEX.test(match[1]);
}

// --- asset extraction: ![[...]] and ![...](relative path) ---
const WIKI_IMAGE_REGEX = /!\[\[([^\]]+)\]\]/g;
const MD_IMAGE_REGEX = /!\[[^\]]*\]\((?!https?:\/\/)([^)]+)\)/g;

function extractAssetRefs(content) {
  const refs = new Set();
  let m;
  while ((m = WIKI_IMAGE_REGEX.exec(content)) !== null) refs.add(m[1].trim());
  WIKI_IMAGE_REGEX.lastIndex = 0;
  while ((m = MD_IMAGE_REGEX.exec(content)) !== null) {
    const href = m[1].trim();
    if (!href.startsWith("http")) refs.add(href);
  }
  return [...refs];
}

// Quartz 的 slugifyFilePath 会把空格等字符替换为连字符，输出的图片路径与源文件名不一致。
// 同步时使用相同的 slugify 规则，确保 markdown 中的引用与 Quartz 构建后的实际路径一致。
function slugifyBasename(basename) {
  const ext = path.extname(basename);
  const base = basename.slice(0, -ext.length);
  const slug = base
    .replace(/\s/g, "-")
    .replace(/&/g, "-and-")
    .replace(/%/g, "-percent")
    .replace(/\?/g, "")
    .replace(/#/g, "");
  return slug + ext;
}

// Resolve asset path in obsidian: first image/, then same dir as md
function resolveAssetPath(obsidianDir, mdDir, ref) {
  const base = path.join(obsidianDir, mdDir);
  const inImage = path.join(obsidianDir, "image", path.basename(ref));
  const inSameDir = path.join(base, ref);
  return { inImage, inSameDir, basename: path.basename(ref) };
}

async function findAssetFile(obsidianDir, mdDir, ref) {
  const basename = path.basename(ref);
  const slugified = slugifyBasename(basename);
  const imageDir = path.join(obsidianDir, "image");
  const base = path.join(obsidianDir, mdDir);
  const candidates = [
    path.join(imageDir, basename),
    path.join(base, ref),
    path.join(imageDir, slugified),
  ];
  // 额外：在 image 目录下按 slugify 名模糊匹配（处理 Obsidian 粘贴命名差异）
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  // 最后尝试：遍历 image 目录，按 slugify 后的 basename 匹配
  try {
    const files = await fs.readdir(imageDir);
    const wantSlug = slugified.toLowerCase();
    for (const f of files) {
      if (slugifyBasename(f).toLowerCase() === wantSlug) {
        return path.join(imageDir, f);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// Recursively list all .md under dir, relative to base
async function listMdFiles(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "image") {
      out.push(...(await listMdFiles(full, base)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push({ full, rel: rel.replace(/\\/g, "/") });
    }
  }
  return out;
}

async function getPublishableSet(obsidianDir) {
  const candidates = await listMdFiles(obsidianDir);
  const result = new Map();
  for (const { full, rel } of candidates) {
    const content = await fs.readFile(full, "utf-8");
    if (!hasPublishableFrontmatter(content)) continue;
    const stat = await fs.stat(full);
    const refs = extractAssetRefs(content);
    const mdDir = path.dirname(rel);
    const resolvedAssets = [];
    for (const ref of refs) {
      const assetPath = await findAssetFile(obsidianDir, mdDir, ref);
      if (assetPath) {
        const basename = path.basename(ref);
        const slugifiedBasename = slugifyBasename(basename);
        resolvedAssets.push({ ref, basename, slugifiedBasename, sourcePath: assetPath });
      }
    }
    result.set(rel, {
      mtime: stat.mtimeMs,
      content,
      assets: resolvedAssets,
    });
  }
  return result;
}

function convertContentForQuartz(content, assets) {
  let out = content;
  for (const { ref, slugifiedBasename } of assets) {
    const wiki = `![[${ref}]]`;
    const replacement = `![](../image/${slugifiedBasename})`;
    out = out.split(wiki).join(replacement);
  }
  // Also replace any remaining ![[...]] that might use same basename (fallback to slugify)
  const wikiGlobal = /!\[\[([^\]]+)\]\]/g;
  out = out.replace(wikiGlobal, (_, inner) => {
    const base = path.basename(inner.trim());
    const slugified = slugifyBasename(base);
    return `![](../image/${slugified})`;
  });
  return out;
}

async function readManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writeManifest(entriesObj) {
  await fs.writeFile(
    MANIFEST_PATH,
    JSON.stringify({ version: 1, entries: entriesObj }, null, 2),
    "utf-8"
  );
}

async function run() {
  const config = await loadConfig();
  const { obsidianDir: OBSIDIAN_DIR, quartzContentDir: QUARTZ_CONTENT_DIR } =
    resolvePaths(config);

  const publishable = await getPublishableSet(OBSIDIAN_DIR);
  const manifest = await readManifest();
  const entries = manifest.entries || {};
  const newEntries = {};

  // 1. Delete: in manifest but not in publishable
  const toDeleteMd = Object.keys(entries).filter((rel) => !publishable.has(rel));
  const assetsStillReferenced = new Set();
  for (const [, data] of publishable) {
    for (const a of data.assets) assetsStillReferenced.add(`image/${a.slugifiedBasename}`);
  }
  for (const rel of toDeleteMd) {
    const quartzMdPath = path.join(QUARTZ_CONTENT_DIR, rel);
    try {
      await fs.unlink(quartzMdPath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const a of entries[rel].assets || []) {
      if (!assetsStillReferenced.has(a)) {
        const assetPath = path.join(QUARTZ_CONTENT_DIR, a);
        try {
          await fs.unlink(assetPath);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    }
  }
  // Remove empty dirs under content (e.g. 玩家/ if empty)
  const dirsToCheck = new Set(toDeleteMd.map((r) => path.dirname(r)));
  for (const d of dirsToCheck) {
    if (!d || d === ".") continue;
    const fullDir = path.join(QUARTZ_CONTENT_DIR, d);
    try {
      const names = await fs.readdir(fullDir);
      if (names.length === 0) await fs.rmdir(fullDir);
    } catch {
      // ignore
    }
  }

  // 2. Add / Update: in publishable; new or mtime newer
  const contentImageDir = path.join(QUARTZ_CONTENT_DIR, "image");
  await fs.mkdir(contentImageDir, { recursive: true });

  for (const [rel, data] of publishable) {
    const prev = entries[rel];
    const isNew = !prev;
    const isUpdated = prev && data.mtime > prev.mtime;
    const prevAssets = new Set(prev?.assets || []);
    const currAssets = new Set(data.assets.map((a) => `image/${a.slugifiedBasename}`));
    const assetsChanged =
      prevAssets.size !== currAssets.size ||
      [...currAssets].some((a) => !prevAssets.has(a));
    if (!isNew && !isUpdated && !assetsChanged) {
      newEntries[rel] = prev;
      continue;
    }

    const quartzMdPath = path.join(QUARTZ_CONTENT_DIR, rel);
    const quartzMdDir = path.dirname(quartzMdPath);
    await fs.mkdir(quartzMdDir, { recursive: true });

    const assetPathsInContent = [];
    for (const { slugifiedBasename, sourcePath } of data.assets) {
      const destPath = path.join(contentImageDir, slugifiedBasename);
      await fs.copyFile(sourcePath, destPath);
      assetPathsInContent.push(`image/${slugifiedBasename}`);
    }

    const converted = convertContentForQuartz(data.content, data.assets);
    await fs.writeFile(quartzMdPath, converted, "utf-8");

    newEntries[rel] = { mtime: data.mtime, assets: assetPathsInContent };
  }

  await writeManifest(newEntries);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
