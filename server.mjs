#!/usr/bin/env node
/**
 * Obsidian-Quartz Dashboard
 * Web UI for sync, publish, watcher, and daily cron.
 */

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import chokidar from "chokidar";
import cron from "node-cron";
import fs from "fs/promises";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SYNC_DIR = __dirname;
const SYNC_SCRIPT = path.join(__dirname, "sync.mjs");
const CONFIG_PATH = path.join(__dirname, "config.json");
// Quartz 仓库根目录由配置中的 quartzContentDir 推导（其父目录），支持独立部署时 Quartz 在任意路径

const DEFAULT_CONFIG = { obsidianDir: "obsidian", quartzContentDir: "quartz/content", cronHour: 2 };

async function loadSyncConfig() {
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

async function loadRawConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const h = cfg.cronHour;
    const cronHour = typeof h === "number" && h >= 0 && h <= 23 ? h : DEFAULT_CONFIG.cronHour;
    return {
      obsidianDir: cfg.obsidianDir ?? DEFAULT_CONFIG.obsidianDir,
      quartzContentDir: cfg.quartzContentDir ?? DEFAULT_CONFIG.quartzContentDir,
      cronHour,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveRawConfig(config) {
  const toSave = {
    obsidianDir: config.obsidianDir,
    quartzContentDir: config.quartzContentDir,
  };
  if (typeof config.cronHour === "number" && config.cronHour >= 0 && config.cronHour <= 23) {
    toSave.cronHour = config.cronHour;
  }
  await fs.writeFile(CONFIG_PATH, JSON.stringify(toSave, null, 2), "utf-8");
}

/**
 * 调起系统目录选择对话框，返回用户选择的绝对路径（或相对项目根的路径）。
 * @param {string} prompt - 对话框标题
 * @returns {Promise<{ path: string, relative?: string } | { cancelled: true }>}
 */
function pickDirectory(prompt) {
  return new Promise((resolve) => {
    const platform = os.platform();
    if (platform === "darwin") {
      const child = spawn("osascript", ["-e", `return POSIX path of (choose folder with prompt "${(prompt || "选择目录").replace(/"/g, '\\"')}")`], {
        stdio: ["inherit", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.stderr?.on("data", (d) => { err += d.toString(); });
      child.on("close", (code) => {
        const p = out.trim();
        if (code !== 0 || !p) return resolve({ cancelled: true });
        const absPath = path.resolve(p);
        const rel = path.relative(PROJECT_ROOT, absPath);
        const relativePath = !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : undefined;
        resolve({ path: absPath, relative: relativePath });
      });
    } else if (platform === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = "${(prompt || "选择目录").replace(/"/g, '`"')}"
$d.ShowDialog() | Out-Null
if ($d.SelectedPath) { $d.SelectedPath }`;
      const child = spawn("powershell", ["-NoProfile", "-Command", ps], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.on("close", (code) => {
        const p = out.trim();
        if (code !== 0 || !p) return resolve({ cancelled: true });
        const absPath = path.resolve(p);
        const rel = path.relative(PROJECT_ROOT, absPath);
        const relativePath = !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : undefined;
        resolve({ path: absPath, relative: relativePath });
      });
    } else {
      const child = spawn("zenity", ["--file-selection", "--directory", "--title", prompt || "选择目录"], {
        stdio: ["inherit", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.on("close", (code) => {
        const p = out.trim();
        if (code !== 0 || !p) return resolve({ cancelled: true });
        const absPath = path.resolve(p);
        const rel = path.relative(PROJECT_ROOT, absPath);
        const relativePath = !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : undefined;
        resolve({ path: absPath, relative: relativePath });
      });
    }
  });
}

const STATE_FILE = path.join(__dirname, ".dashboard-state.json");

const PORT = process.env.PORT || 3001;
const DEBOUNCE_MS = 2000;
const DEFAULT_CRON = "0 2 * * *"; // 02:00 daily
const MAX_TASK_LOGS = 50;

// --- State ---
let state = {
  lastSyncAt: null,
  lastSyncSuccess: null,
  lastSyncError: null,
  lastPublishAt: null,
  lastPublishSuccess: null,
  lastPublishError: null,
  watcherEnabled: false,
  lastCronRunAt: null,
  lastCronSuccess: null,
  lastCronError: null,
  isRunning: false,
};

/** @type {{ type: string, at: string, result: 'running'|'success'|'fail', error?: string }[]} */
let taskLogs = [];

function appendLog(type, result, error) {
  taskLogs.unshift({ type, at: new Date().toISOString(), result, error });
  if (taskLogs.length > MAX_TASK_LOGS) taskLogs.pop();
}

function updateLastRunningLog(type, result, error) {
  const idx = taskLogs.findIndex((l) => l.type === type && l.result === "running");
  if (idx >= 0) {
    taskLogs[idx] = { ...taskLogs[idx], result, error };
  }
}

let watcher = null;
let syncDebounceTimer = null;

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    state = { ...state, ...JSON.parse(raw) };
  } catch {
    // use defaults
  }
}

async function saveState() {
  try {
    const toSave = { ...state };
    delete toSave.isRunning;
    await fs.writeFile(STATE_FILE, JSON.stringify(toSave, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save state:", e);
  }
}

// --- Run sync ---
function runSync(opts = {}) {
  if (state.isRunning) return Promise.resolve({ ok: false, error: "已有任务在运行" });
  state.isRunning = true;
  state.lastSyncAt = new Date().toISOString();
  if (!opts.noLog) appendLog("sync", "running");

  return new Promise((resolve) => {
    const proc = spawn("node", [SYNC_SCRIPT], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => { out += d.toString(); });
    proc.stderr?.on("data", (d) => { err += d.toString(); });
    proc.on("close", (code) => {
      state.isRunning = false;
      state.lastSyncSuccess = code === 0;
      state.lastSyncError = code !== 0 ? (err || out || `exit ${code}`) : null;
      if (!opts.noLog) updateLastRunningLog("sync", code === 0 ? "success" : "fail", state.lastSyncError || undefined);
      saveState();
      resolve({ ok: code === 0, stdout: out, stderr: err, code });
    });
    proc.on("error", (e) => {
      state.isRunning = false;
      state.lastSyncSuccess = false;
      state.lastSyncError = e.message;
      if (!opts.noLog) updateLastRunningLog("sync", "fail", e.message);
      saveState();
      resolve({ ok: false, error: e.message });
    });
  });
}

// --- Run publish (quartz sync) ---
async function runPublish(opts = {}) {
  if (state.isRunning) return { ok: false, error: "已有任务在运行" };
  state.isRunning = true;
  state.lastPublishAt = new Date().toISOString();
  if (!opts.noLog) appendLog("publish", "running");
  let quartzDir;
  try {
    const cfg = await loadSyncConfig();
    quartzDir = path.dirname(cfg.quartzContentDir);
  } catch (e) {
    state.isRunning = false;
    if (!opts.noLog) updateLastRunningLog("publish", "fail", e.message);
    saveState();
    return { ok: false, error: "无法读取配置以确定 Quartz 目录: " + e.message };
  }

  return new Promise((resolve) => {
    const proc = spawn("npx", ["quartz", "sync", "--no-pull"], {
      cwd: quartzDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => { out += d.toString(); });
    proc.stderr?.on("data", (d) => { err += d.toString(); });
    proc.on("close", (code) => {
      state.isRunning = false;
      state.lastPublishSuccess = code === 0;
      state.lastPublishError = code !== 0 ? (err || out || `exit ${code}`) : null;
      if (!opts.noLog) updateLastRunningLog("publish", code === 0 ? "success" : "fail", state.lastPublishError || undefined);
      saveState();
      resolve({ ok: code === 0, stdout: out, stderr: err, code });
    });
    proc.on("error", (e) => {
      state.isRunning = false;
      state.lastPublishSuccess = false;
      state.lastPublishError = e.message;
      if (!opts.noLog) updateLastRunningLog("publish", "fail", e.message);
      saveState();
      resolve({ ok: false, error: e.message });
    });
  });
}

// --- Watcher ---
async function startWatcher() {
  if (watcher) return;
  const config = await loadSyncConfig();
  watcher = chokidar.watch(path.join(config.obsidianDir, "**/*.md"), {
    ignored: /(^|[\/\\])\../,
    persistent: true,
  });
  watcher.on("change", () => scheduleSync());
  watcher.on("add", () => scheduleSync());
  watcher.on("unlink", () => scheduleSync());
  state.watcherEnabled = true;
  saveState();
  console.log("Watcher started for", config.obsidianDir);
}

function scheduleSync() {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    syncDebounceTimer = null;
    if (state.watcherEnabled) {
      console.log("Watcher triggered sync");
      await runSync();
    }
  }, DEBOUNCE_MS);
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
  state.watcherEnabled = false;
  saveState();
  console.log("Watcher stopped");
}

// --- Cron ---
let cronTask = null;

function getCronSpec() {
  if (process.env.CRON_SCHEDULE) return process.env.CRON_SCHEDULE;
  return loadRawConfig().then((cfg) => `0 ${cfg.cronHour} * * *`).catch(() => DEFAULT_CRON);
}

async function scheduleCron() {
  const spec = await getCronSpec();
  if (cronTask) cronTask.stop();
  cronTask = cron.schedule(spec, async () => {
    state.lastCronRunAt = new Date().toISOString();
    appendLog("cron", "running");
    console.log("Daily cron: running sync + publish");
    const syncRes = await runSync({ noLog: true });
    if (!syncRes.ok) {
      state.lastCronSuccess = false;
      state.lastCronError = "Sync failed: " + (state.lastSyncError || "unknown");
      updateLastRunningLog("cron", "fail", state.lastCronError);
      saveState();
      return;
    }
    const pubRes = await runPublish({ noLog: true });
    state.lastCronSuccess = pubRes.ok;
    state.lastCronError = pubRes.ok ? null : "Publish failed: " + (state.lastPublishError || "unknown");
    updateLastRunningLog("cron", pubRes.ok ? "success" : "fail", state.lastCronError || undefined);
    saveState();
  });
  console.log("Cron scheduled:", spec);
}

async function getNextCronRun() {
  const spec = await getCronSpec();
  const parts = spec.trim().split(/\s+/);
  if (parts.length >= 5) {
    const [min, hour] = parts;
    return `每天 ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  return spec;
}

async function rescheduleCron() {
  await scheduleCron();
}

// --- Express ---
const app = express();
app.use(express.json());

// API 路由必须在 static 之前，避免 /api/* 被误当作静态或返回 HTML
app.get("/api/logs", (req, res) => {
  res.json({ logs: [...taskLogs] });
});

app.get("/api/status", async (req, res) => {
  const nextCron = await getNextCronRun();
  res.json({
    lastSyncAt: state.lastSyncAt,
    lastSyncSuccess: state.lastSyncSuccess,
    lastSyncError: state.lastSyncError,
    lastPublishAt: state.lastPublishAt,
    lastPublishSuccess: state.lastPublishSuccess,
    lastPublishError: state.lastPublishError,
    watcherEnabled: state.watcherEnabled,
    lastCronRunAt: state.lastCronRunAt,
    lastCronSuccess: state.lastCronSuccess,
    lastCronError: state.lastCronError,
    nextCron,
    isRunning: state.isRunning,
  });
});

app.post("/api/sync", async (req, res) => {
  const result = await runSync();
  res.json(result);
});

app.post("/api/publish", async (req, res) => {
  const result = await runPublish();
  res.json(result);
});

app.post("/api/sync-and-publish", async (req, res) => {
  appendLog("sync-and-publish", "running");
  const syncRes = await runSync({ noLog: true });
  if (!syncRes.ok) {
    updateLastRunningLog("sync-and-publish", "fail", "Sync failed: " + (state.lastSyncError || "unknown"));
    return res.json({ ok: false, error: "Sync failed", details: syncRes });
  }
  const pubRes = await runPublish({ noLog: true });
  updateLastRunningLog("sync-and-publish", pubRes.ok ? "success" : "fail", pubRes.ok ? undefined : (state.lastPublishError || "unknown"));
  res.json(pubRes);
});

app.post("/api/watcher", async (req, res) => {
  const { enabled } = req.body || {};
  if (enabled === true) {
    await startWatcher();
  } else {
    stopWatcher();
  }
  res.json({ watcherEnabled: state.watcherEnabled });
});

app.get("/api/config", async (req, res) => {
  try {
    const raw = await loadRawConfig();
    const resolved = await loadSyncConfig();
    res.json({
      obsidianDir: raw.obsidianDir,
      quartzContentDir: raw.quartzContentDir,
      cronHour: raw.cronHour,
      obsidianDirResolved: resolved.obsidianDir,
      quartzContentDirResolved: resolved.quartzContentDir,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/config", async (req, res) => {
  const { obsidianDir, quartzContentDir } = req.body || {};
  if (typeof obsidianDir !== "string" || typeof quartzContentDir !== "string") {
    return res.status(400).json({ error: "obsidianDir 和 quartzContentDir 均为必填字符串" });
  }
  try {
    const raw = await loadRawConfig();
    await saveRawConfig({
      obsidianDir: obsidianDir.trim(),
      quartzContentDir: quartzContentDir.trim(),
      cronHour: raw.cronHour,
    });
    if (state.watcherEnabled) {
      stopWatcher();
      await startWatcher();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/config", async (req, res) => {
  const { cronHour } = req.body || {};
  if (typeof cronHour !== "number" || cronHour < 0 || cronHour > 23) {
    return res.status(400).json({ error: "cronHour 必须为 0–23 的整数" });
  }
  try {
    const raw = await loadRawConfig();
    await saveRawConfig({ ...raw, cronHour: Math.floor(cronHour) });
    await rescheduleCron();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/pick-dir", async (req, res) => {
  const { which } = req.body || {};
  const prompt = which === "quartz" ? "选择 Quartz 内容目录" : "选择 Obsidian 目录";
  try {
    const result = await pickDirectory(prompt);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quartz 预览代理：/quartz-preview -> http://localhost:8082，同源 iframe 无跨域问题
const QUARTZ_PREVIEW_PORT = 8082;
const QUARTZ_PREVIEW_WS_PORT = 3004;
const QUARTZ_PREVIEW_PREFIX = "/quartz-preview";

let quartzPreviewProcess = null;

async function startQuartzPreview() {
  if (quartzPreviewProcess) return;
  let quartzDir;
  try {
    const cfg = await loadSyncConfig();
    quartzDir = path.dirname(cfg.quartzContentDir);
  } catch (e) {
    console.warn("Quartz 预览自动启动跳过：无法读取配置", e.message);
    return;
  }
  const proc = spawn("npx", ["quartz", "build", "--serve", "--port", String(QUARTZ_PREVIEW_PORT), "--wsPort", String(QUARTZ_PREVIEW_WS_PORT)], {
    cwd: quartzDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  quartzPreviewProcess = proc;
  proc.stdout?.on("data", (d) => process.stdout.write(d));
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  proc.on("close", (code, signal) => {
    quartzPreviewProcess = null;
    if (code != null && code !== 0) console.log("Quartz 预览进程退出:", code, signal || "");
  });
  proc.on("error", (e) => {
    quartzPreviewProcess = null;
    console.warn("Quartz 预览启动失败:", e.message);
  });
  console.log("Quartz 预览已启动（工作目录:", quartzDir, "）");
}

function stopQuartzPreview() {
  if (quartzPreviewProcess) {
    quartzPreviewProcess.kill("SIGTERM");
    quartzPreviewProcess = null;
    console.log("Quartz 预览已停止");
  }
}
app.use(QUARTZ_PREVIEW_PREFIX, (req, res) => {
  const upstreamPath = req.url || "/";
  const opt = {
    hostname: "localhost",
    port: QUARTZ_PREVIEW_PORT,
    path: upstreamPath,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${QUARTZ_PREVIEW_PORT}` },
  };
  const proxyReq = http.request(opt, (proxyRes) => {
    res.status(proxyRes.statusCode);
    Object.keys(proxyRes.headers).forEach((k) => res.setHeader(k, proxyRes.headers[k]));
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    if (err.code === "ECONNREFUSED") {
      res.status(503).setHeader("Content-Type", "text/html; charset=utf-8").send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quartz 预览未启动</title></head><body style="font-family:sans-serif;padding:2rem;max-width:32rem;">
        <h2>Quartz 预览服务未启动</h2>
        <p>请在<strong>项目根目录</strong>下先进入 quartz 目录，再执行：</p>
        <pre style="background:#f0f0f0;padding:1rem;border-radius:6px;">cd quartz
npx quartz build --serve --port ${QUARTZ_PREVIEW_PORT} --wsPort ${QUARTZ_PREVIEW_WS_PORT}</pre>
        <p>（若已在 quartz 目录，直接执行第二行即可。启动后刷新本页即可看到预览。）</p>
        </body></html>`
      );
    } else {
      res.status(502).send("Proxy error: " + err.message);
    }
  });
  req.pipe(proxyReq);
});

app.use(express.static(path.join(__dirname, "public")));

// 环境变量 AUTO_WATCH=1 时，启动时自动开启监听（无需打开浏览器勾选）
const autoWatch = /^(1|true|yes)$/i.test(String(process.env.AUTO_WATCH || "").trim());
// 环境变量 AUTO_QUARTZ_PREVIEW=1 时，启动时自动启动 Quartz 预览服务
const autoQuartzPreview = /^(1|true|yes)$/i.test(String(process.env.AUTO_QUARTZ_PREVIEW || "").trim());

function onExit() {
  stopQuartzPreview();
}
process.on("SIGINT", onExit);
process.on("SIGTERM", onExit);

// --- Start ---
const MAX_PORT_ATTEMPTS = 10;

function tryListen(port) {
  const server = app.listen(port, () => {
    console.log(`Dashboard: http://localhost:${server.address().port}`);
    if (state.watcherEnabled) console.log("自动同步已开启（监听 Obsidian 下 md 变更）");
  });
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && port < PORT + MAX_PORT_ATTEMPTS) {
      console.log(`端口 ${port} 已被占用，尝试 ${port + 1}...`);
      server.close(() => tryListen(port + 1));
    } else {
      throw err;
    }
  });
}

(async () => {
  await loadState();
  if (state.watcherEnabled || autoWatch) await startWatcher();
  if (autoQuartzPreview) await startQuartzPreview();
  await scheduleCron();
  tryListen(PORT);
})();
