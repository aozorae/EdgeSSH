# 创建 Cloudflare API Token

部署 Token 只负责让 GitHub Actions 管理 Worker、D1 与自定义域名。它不是 EdgeSSH 的登录凭据，也不应作为 Worker 运行时变量。

## 创建入口

1. 登录 Cloudflare 控制面板（Dashboard）。
2. 打开右上角个人资料。
3. 进入 **我的个人资料（My Profile）→ API 令牌（API Tokens）**。
4. 选择 **创建令牌（Create Token）**。
5. 以 **编辑 Cloudflare Workers（Edit Cloudflare Workers）** 模板作为起点。

Cloudflare 中文界面仍可能显示部分英文产品名或权限名，按括号中的英文原名定位即可。

## 权限建议

确保 Token 覆盖以下能力：

| 范围 | 权限 | 用途 |
| --- | --- | --- |
| 账户（Account） | Workers 脚本（Workers Scripts）：编辑（Edit） | 创建或更新 EdgeSSH Worker |
| 账户（Account） | D1：编辑（Edit） | 查找、创建 D1 并执行 migration |
| 账户（Account） | 账户设置（Account Settings）：读取（Read） | 自动发现账户 |
| 账户（Account） | Access：应用和策略（Apps and Policies）：编辑（Edit） | **仅 cloudflare 模式**：创建/复用 Access 应用和策略 |
| 账户（Account） | Access：组织、身份提供程序和组（Organizations, Identity Providers, and Groups）：编辑（Edit） | **仅 cloudflare 模式**：读取团队域、创建/复用 OTP |
| 区域（Zone） | Workers 路由（Workers Routes）：编辑（Edit）；区域（Zone）：读取（Read） | **使用自定义域名时需要**：绑定 `CUSTOM_DOMAIN` |

Cloudflare 控制台的权限名称可能随界面调整。判断标准是：Token 能部署 Worker、管理目标账户的 D1，并为目标 Zone 配置 Worker 自定义域名。

资源范围应限定到实际账户和域名。EdgeSSH 不使用 KV 或 R2，不要为了省事授予无关资源权限。

<ScreenshotPlaceholder
  title="API Token 权限与资源范围"
  description="请截取权限表和 Account/Zone Resources 选择结果。必须遮盖 Token 值、账户邮箱和与教程无关的域名。"
  filename="02-cloudflare-api-token-permissions.png"
  src="/screenshots/02-cloudflare-api-token-permissions.png"
  alt="Cloudflare API Token 模板选择页面"
  caption="Cloudflare Token 模板入口示例；最终权限与资源范围以本页表格为准。"
/>

## 保存到 GitHub

Token 创建完成后，只会完整显示一次：

1. 复制 Token。
2. 打开 Fork 的 **设置（Settings）→ 机密和变量（Secrets and variables）→ Actions**。
3. 在 **机密（Secrets）** 中创建 `CLOUDFLARE_API_TOKEN`。
4. 粘贴并保存。

不要把 Token 存为普通 Variable。也不要把 Token 写入 `.env`、`.dev.vars`、`wrangler.toml`、README 或截图。

GitHub 模式不需要任何 Access/IdP 权限。创建完成后回到[部署流程](/deploy/actions)，只填写所选模式的参数。多数用户使用自定义域名，需要上表的 Zone 权限；仅使用 `workers.dev` 时不需要。

## 验证与排错

Action 报 `Authentication error` 或 `Invalid API Token` 时：

- 确认复制的是 API Token，不是 Global API Key。
- 确认 Secret 名称精确为 `CLOUDFLARE_API_TOKEN`。
- 确认 Token 尚未被撤销或过期。
- 确认 Account Resources 包含 `CLOUDFLARE_ACCOUNT_ID` 对应账户。

Action 能部署 Worker、但无法创建 D1 时，通常是缺少 Account `D1: Edit`。能部署但自定义域名绑定失败时，通常是 Zone 范围或 Workers Routes 权限不正确。

## 文档站 Pages 权限

维护者手工发布文档站时还需要 Account `Cloudflare Pages: Edit`；普通 EdgeSSH 部署用户不需要此权限。文档源码单独维护，不在应用 `main`，也没有主分支 `Deploy docs` 工作流。
