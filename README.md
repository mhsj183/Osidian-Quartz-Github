# Obsidian-Quartz-Github

Obsidian 可发布内容 → Quartz content 同步工具，附带 Web 操作面板，支持一键同步、发布与定时任务。**可独立部署**：本仓库不包含 Obsidian 库或 Quartz 站点，克隆后通过面板或配置文件指定路径即可使用。

## 功能特性

- **手动同步**：将 Obsidian 中「可发布」或「已发布」的 md 文件同步到 `quartz/content`
- **手动发布**：执行 `npx quartz sync`，提交并推送到 GitHub，触发站点部署
- **一键同步并发布**：按序完成同步与发布
- **自动同步**：开启后，监听 Obsidian md 文件变更（含「可发布」属性），自动执行同步
- **每日定时发布**：默认每天凌晨 2 点自动执行「同步 + 发布」
- **Web 操作面板**：浏览器内完成同步、发布、配置与日志查看
- **Quartz 预览代理**：面板内嵌 Quartz 站点预览，同源加载无需跨域

## 前置要求

- Node.js 18+
- 已存在的 [Obsidian](https://obsidian.md/) 仓库与 [Quartz](https://quartz.jzhao.xyz/) 项目
- `quartz/` 已配置 Git `origin`（用于发布到 GitHub）

## 快速开始

### 1. 安装依赖

```bash
git clone <your-repo-url>
cd Obsidian-Quartz-Github  # 或你的项目目录名
npm install
```

### 2. 配置路径（可选）

复制示例配置并编辑：

```bash
cp config.example.json config.json
```

编辑 `config.json`，设置 Obsidian 与 Quartz 内容目录：

```json
{
  "obsidianDir": "obsidian",
  "quartzContentDir": "quartz/content"
}
```

未配置时，默认使用项目根下的 `obsidian` 与 `quartz/content`。

### 3. 启动 Web 面板

```bash
npm start
```

浏览器访问 **http://localhost:3001** 进行操作。

### 4. 一键启动（自动同步 + Quartz 预览）

```bash
npm run start:watch
```

或使用环境变量：`AUTO_WATCH=1 AUTO_QUARTZ_PREVIEW=1 npm start`。

## 使用方式

### 方式一：Web 面板（推荐）

通过浏览器完成同步、发布、自动监听和定时任务配置。端口默认 3001，若被占用会自动尝试 3002、3003…

### 方式二：命令行同步

在本目录执行：

```bash
node sync.mjs
```

（若本目录在父项目下，也可在父项目根目录执行 `node Obsidian-Quartz-Github/sync.mjs`）

## 配置说明

### 配置文件

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `obsidianDir` | Obsidian 笔记根目录 | `"obsidian"` 或绝对路径 |
| `quartzContentDir` | Quartz 内容目录 | `"quartz/content"` 或绝对路径 |

- 相对路径相对于本目录的父目录（项目根）；也可使用绝对路径
- 未配置时使用默认值：`obsidian`、`quartz/content`

### 环境变量

| 变量 | 说明 | 优先级 |
|------|------|--------|
| `OBSIDIAN_DIR` | Obsidian 目录 | 环境变量 > config.json > 默认值 |
| `QUARTZ_CONTENT_DIR` | Quartz 内容目录 | 同上 |
| `PORT` | Web 服务端口 | 默认 3001 |
| `CRON_SCHEDULE` | 定时任务 cron 表达式 | 默认 `0 2 * * *`（每天 02:00） |
| `AUTO_WATCH` | 启动时自动开启监听 | `1` / `true` / `yes` |
| `AUTO_QUARTZ_PREVIEW` | 启动时自动启动 Quartz 预览 | 同上 |

## 同步规则

- **新增**：obsidian 中可发布 md 不在上次同步记录中 → 复制 md 与引用资源到 `quartz/content`，并写入 manifest
- **更新**：可发布 md 已存在且源文件 mtime 更新 → 覆盖对应 md 与资源，更新 manifest
- **删除**：上次同步过的 md 已删除或改为不可发布 → 从 `quartz/content` 删除该 md；若某资源不再被任何可发布 md 引用，则一并删除

同步状态保存在 `.obsidian-sync-manifest.json`，已加入 `.gitignore`，不提交到仓库。

**可发布条件**：md 文件 frontmatter 中需包含 `可发布: true` 或 `已发布: true`。

**资源路径**：图片优先从 `obsidian/image/` 或 md 所在目录查找，引用会转换为 Quartz 的 `../image/` 路径。

## 目录结构

```
Obsidian-Quartz-Github/
├── server.mjs              # Web 服务
├── sync.mjs                # 同步脚本
├── config.example.json     # 配置示例
├── package.json
├── public/
│   ├── index.html          # 操作面板
│   ├── style.css
│   └── app.js
├── .dashboard-state.json   # 运行时状态（自动生成，gitignore）
└── .obsidian-sync-manifest.json   # 同步状态（自动生成，gitignore）
```

## 提交到 GitHub

本仓库设计为**独立项目**：克隆后即可使用，Obsidian 库与 Quartz 站点可放在其它目录或其它仓库。

**提交步骤**：在 `Obsidian-Quartz-Github` 目录内 `git init`，添加 GitHub 远程仓库，推送即可。不要提交 `config.json`、`.obsidian-sync-manifest.json`、`.dashboard-state.json`（已加入 .gitignore）。

## 注意事项

- 确保存在 `obsidian/` 与 `quartz/`（或按 config 配置的路径）
- 确保 `quartz/` 是 Git 仓库并已配置 `origin`；若使用 GitHub Pages，需在仓库 Settings → Pages 中设置 Source 为 GitHub Actions
- md 与图片名支持中文、emoji，脚本使用 UTF-8 读写
- 目录选择功能依赖系统对话框：macOS (osascript)、Windows (PowerShell)、Linux (zenity)
