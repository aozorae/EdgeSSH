# 部署文档站到 Cloudflare Pages

VitePress 文档源码保存在独立分支 `codex/docs-auth-providers`，不放入应用 `main`。目前由维护者手工构建并发布到 Cloudflare Pages，应用仓库的 main 没有 `Deploy docs` 工作流。文档不会写入 Worker 的 `dist/`，也不访问 D1 或运行时 Secret。

## 首次部署

在文档分支的隔离工作目录中，通过进程环境提供两个部署凭据：

- `CLOUDFLARE_ACCOUNT_ID`。
- `CLOUDFLARE_API_TOKEN`（勿写入源码或命令行参数）。

API Token 需要 **账户（Account）> Cloudflare Pages（Cloudflare Pages）：编辑（Edit）**。可选环境变量 `DOCS_PROJECT_NAME` 控制项目名，默认 `edgessh-docs`。普通应用部署者不需要发布文档站。

进入：

```bash
npm ci
npm run deploy:docs
```

首次运行会按名称检查 Pages 项目，不存在时创建，存在时直接复用。随后构建 `docs/.vitepress/dist` 并发布到生产分支 `main`。

## 添加多个自定义域名

首次成功后打开 Cloudflare Dashboard：

```text
Workers & Pages → edgessh-docs → Custom domains
```

选择 **Set up a custom domain**，逐个添加文档域名。Pages 项目与 EdgeSSH Worker 相互独立，因此可以为文档站绑定多个域名，而不修改 Worker 的 `CUSTOM_DOMAIN`。

<ScreenshotPlaceholder
  title="Cloudflare Pages 自定义域名"
  description="请截取 Pages 项目的 Custom domains 页面和添加入口。隐藏与文档站无关的其他项目和域名。"
  filename="11-pages-custom-domain.png"
/>

## 维护约定

应用代码修改推送 main 后通过 Deploy 发布；文档源码分支单独提交推送，再执行 Pages 发布。两者各自验证，不把 Pages 构建产物或历史部署凭据合并到 main。

Pages 默认地址为 `edgessh-docs.pages.dev`。当前无需自定义域名即可阅读；不要把文档站域名误填成 SSH 应用的 `CUSTOM_DOMAIN`。

### 首页与搜索信息

首页 `docs/index.md` 介绍产品用途与功能，部署步骤保留在部署指南中。页面标题与摘要由 frontmatter 设置；`docs/.vitepress/config.ts` 统一生成规范链接、Open Graph / Twitter 分享信息、首页软件结构化数据及站点地图，`docs/public/robots.txt` 声明站点地图入口。

正式域名变更时，同步更新配置中的 `siteUrl`、`robots.txt` 和 `tests/docs-seo.test.mjs`，避免规范链接仍指向旧站。不要为 Pages 临时预览地址生成另一套规范链接。`npm run test:docs` 会构建并检查实际静态 HTML、站点地图、分享信息及首页站内链接。

## 本地预览

```bash
npm run docs:dev
```

生产构建检查：

```bash
npm run docs:build
npm run docs:preview
```
