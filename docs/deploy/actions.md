# 使用 GitHub Actions 部署

**选一种登录方式，填对应变量，运行一次 Deploy。** 应用始终部署到 Cloudflare Workers；`AUTH_PROVIDER` 只决定管理员怎样登录，不是选择云服务商。

## 1. Fork 并准备 Token

Fork [EdgeSSH](https://github.com/aozorae/EdgeSSH)，启用 Actions。在仓库 **Settings → Secrets and variables → Actions** 中保存 `CLOUDFLARE_API_TOKEN` **Secret**。

Token 权限见[创建 API Token](/deploy/api-token)。账户 ID、D1 ID 和加密密钥通常不需要填写；自定义域名也不是必需项。

## 2. 二选一填写配置

### 方案 A：Cloudflare Access

适合已经启用 Zero Trust 的用户。先完成 Cloudflare Zero Trust 的组织开通与团队域设置，再填写：

| 名称 | 保存位置 | 值 |
| --- | --- | --- |
| `AUTH_PROVIDER` | Variable | `cloudflare`（不填也默认此模式） |
| `CLOUDFLARE_API_TOKEN` | Secret | 含 Access/IdP 管理权限的 Cloudflare Token |
| `ADMIN_EMAIL` | Variable | 你的管理员邮箱；也可在 Run workflow 输入 |

Action 自动创建/复用 Access 应用、明确邮箱 Allow 策略与 OTP，获取 Team Domain 和 AUD，并写入 Worker Secrets。不需要手工复制这些参数。

### 方案 B：原生 GitHub OAuth

**不需要开通 Cloudflare Zero Trust，也不需要 Access/IdP 权限。** 这不是在 Access 中添加 GitHub 身份提供程序，而是直接由 EdgeSSH 验证 GitHub 登录。

| 名称 | 保存位置 | 值 |
| --- | --- | --- |
| `AUTH_PROVIDER` | Variable | `github` |
| `CLOUDFLARE_API_TOKEN` | Secret | Workers/D1 部署 Token |
| `GITHUB_CLIENT_ID` | Variable | GitHub OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | Secret | 同一 OAuth App 的 Client Secret |
| `GITHUB_ADMIN` | Variable | 唯一允许登录的个人 GitHub 用户名 |

先按 [GitHub OAuth 配置](/deploy/github-oauth)创建 OAuth App。回调地址为 `https://你的入口/auth/callback`。GitHub 模式不填管理员邮箱，也不填任何 Access 参数。

::: warning 不要混淆 Variable 与 Secret
API Token、Client Secret 和加密密钥不能放普通 Variable。其他模式遗留的变量不参与认证；工作流只验证当前模式必需的值。
:::

## 3. 运行 Deploy

进入 **Actions → Deploy → Run workflow**，选择 `main`。Cloudflare 模式可在邮箱框输入管理员邮箱；GitHub 模式留空。

工作流依次执行：

1. 配置格式校验、类型检查、测试、构建和 dry-run。
2. 发现账户及 `workers.dev` 子域；多账户 Token 才需额外指定 `CLOUDFLARE_ACCOUNT_ID`。
3. 只配置所选认证方式，按名称或显式 ID 复用 D1。
4. 沿用旧库唯一资料所有者 ID，新库使用固定管理员 ID。
5. 首次生成加密密钥，后续保留原值；执行数据库迁移。
6. 通过标准输入同步所需 Secret 并部署，检查当前模式必需的 Secret 是否存在。
7. 在运行摘要给出访问地址；GitHub 模式另给出 OAuth 回调地址。

默认访问 `https://edgessh.<你的 Workers 子域>.workers.dev`。自定义域名通过可选 `CUSTOM_DOMAIN` 配置，使用 `workers.dev` 时不要填它。

<ScreenshotPlaceholder title="Deploy 成功记录" description="部署步骤名称可能随版本调整，请以最新运行摘要为准。" filename="05-deploy-success.png" src="/screenshots/05-deploy-success.png" alt="EdgeSSH Deploy 成功记录示例" caption="历史界面示例；当前运行成功后会在摘要给出入口与认证模式。" />

## 4. 登录与验收

- Cloudflare 模式：入口先跳 Access，只允许指定邮箱登录。
- GitHub 模式：首页点击「登录」前往 GitHub；只有 `GITHUB_ADMIN` 对应账号可以进入。
- 登录后检查主机列表，使用真实已授权目标验收 SSH、SFTP 与进程面板。

详见[部署后验收](/deploy/verification)。只看到网页，不代表登录与 SSH 已通过验收。

## 更新与切换

以后推送 `main` 或重跑 Deploy 即可，复用原 Worker、D1 和加密密钥。切换 `AUTH_PROVIDER` 后仍是一位管理员、同一份主机资料，不需要绑定两套账号。

若旧域名还在 Access 网关后面，切换 GitHub 前先解除该域名的旧保护，避免双重登录；脚本不会擅自删除安全策略。完整步骤见[切换登录方式](/deploy/switch-login)。
