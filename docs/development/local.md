# 本地开发

本地开发需要 Node.js 22.12.0 或更高版本，以及 npm。

## 安装依赖

```bash
git clone https://github.com/aozorae/EdgeSSH.git
cd EdgeSSH
npm ci
```

## 准备本地变量

```bash
cp .env.example .dev.vars
```

在 `.dev.vars` 中填写 `AUTH_PROVIDER`、`ADMIN_ACCOUNT_ID` 与 `ENCRYPTION_KEY`。Cloudflare 模式另填 Team Domain/AUD；GitHub 模式另填 `APP_ORIGIN`、OAuth Client ID/Secret、管理员数字 ID。使用真实认证，不提供匿名绕过；GitHub 回调与 Cookie 调试建议使用可信 HTTPS 开发入口。

初始化本地 D1：

```bash
npx wrangler d1 migrations apply DB --local
```

## 启动 Worker

```bash
npm run dev
```

Wrangler 会按 `wrangler.toml` 构建前端并启动本地 Worker。

需要前端热更新时，在另一个终端运行：

```bash
npm run dev:web
```

Vite 默认位于 `http://localhost:5173`，并把 `/api` 与 `/auth` 代理到本地 Worker 的 `8787` 端口。

## 启动文档站

```bash
npm run docs:dev
```

上述命令仅在文档源码分支 `codex/docs-auth-providers` 可用；应用 `main` 不包含文档站构建依赖。文档站不需要 D1、Access 或 SSH 目标。

## 检查命令

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查 Worker 与前端类型 |
| `npm test` | 运行 Node 测试 |
| `npm run build:web` | 构建 EdgeSSH 前端 |
| `npm run docs:build` | 构建 VitePress 文档 |
| `npm run check` | 应用 main：类型、测试、前端构建与 Wrangler dry-run；文档独立构建 |

涉及连接、SFTP 或进程面板的改动，最终仍要使用真实且已授权的 SSH 目标验收。
