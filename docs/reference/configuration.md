# 配置项

唯一用户配置入口：GitHub **Settings → Secrets and variables → Actions**。根据 `AUTH_PROVIDER` 只填一组认证参数。

## 必填与按模式必填

| 名称 | GitHub 类型 | 用途 |
| --- | --- | --- |
| `AUTH_PROVIDER` | Variable | `cloudflare` 或 `github`，默认 `cloudflare` |
| `CLOUDFLARE_API_TOKEN` | Secret | 两种模式都需要的云资源部署凭据 |
| `ADMIN_EMAIL` | Variable，兼容 Secret | Cloudflare 模式管理员邮箱；Run workflow 输入优先 |
| `GITHUB_CLIENT_ID` | Variable | 仅 GitHub 模式，OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | Secret | 仅 GitHub 模式，同一 OAuth App 的 Client Secret |
| `GITHUB_ADMIN` | Variable | 仅 GitHub 模式，唯一管理员的个人 GitHub 用户名 |

## 可选部署配置

| 名称 | 类型 | 默认与说明 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable，兼容 Secret | 自动发现唯一账户；多账户 Token 才需指定 |
| `WORKER_NAME` | Variable | `edgessh` |
| `D1_DATABASE_NAME` | Variable | `<Worker 名>-accounts` |
| `D1_DATABASE_ID` | Variable | 指定已有 D1；不存在时停止，不另建空库替代 |
| `CUSTOM_DOMAIN` | Variable，兼容 Secret | 如 `ssh.example.com`；Secret 优先；使用 workers.dev 留空 |
| `ACCESS_IDP_IDS` | Variable | 仅 Cloudflare 模式新建应用：逗号分隔的已有 IdP UUID |
| `ENCRYPTION_KEY` | Secret，仅高级恢复/首次自备 | 32 字节 Base64；已有 Worker 密钥不会被覆盖 |

## 自动生成的 Worker 配置

- 共同 Secret：`ENCRYPTION_KEY`。
- Cloudflare 模式 Secret：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。
- GitHub 模式 Secret：从 Actions 同步 `GITHUB_CLIENT_SECRET`。
- 普通变量：`AUTH_PROVIDER`、`APP_ORIGIN`、`ADMIN_ACCOUNT_ID`；GitHub 模式还有 `GITHUB_CLIENT_ID`、解析得到的 `GITHUB_ADMIN_ID`。

这些自动配置无需再去 Worker 控制台维护一遍。运行时 Secret 不写源码、普通变量或临时配置。旧模式的 Secret 可能保留，但运行时不读取另一种模式的认证凭据。

`ADMIN_ACCOUNT_ID` 是资料归属，不是认证开关；只在外部身份验证成功后使用。切换登录方式不改变它。

## 绑定与本地开发

`DB` 是 D1 binding，`SSH_SESSIONS` 是 Durable Object binding，`ASSETS` 是静态资源 binding，不要创建同名普通变量。

`CONNECT_TIMEOUT_MS` 默认 `10000`，范围 2000–30000 毫秒。本地将 `.env.example` 复制为 `.dev.vars`，仅填所选模式参数，不提供匿名绕过。
