# 创建 Cloudflare API Token

部署 Token 只负责让 GitHub Actions 管理 Worker、D1 与自定义域名。它不是 EdgeSSH 的登录凭据，也不应作为 Worker 运行时变量。

## 创建入口

1. 登录 Cloudflare 控制面板（Dashboard）。
2. 打开右上角个人资料。
3. 进入 **我的个人资料（My Profile）→ API 令牌（API Tokens）**。
4. 选择 **创建令牌（Create Token）**。
5. 以 **编辑 Cloudflare Workers（Edit Cloudflare Workers）** 模板作为起点。

Cloudflare 中文界面仍可能显示部分英文产品名或权限名，按括号中的英文原名定位即可。控制台的编辑（Edit）/读取（Read）对应 API 文档的 Write/Read。

## 权限建议

以模板创建后，按下表保留或补齐权限。范围、权限名和级别均同时列出中英文：

| 范围 | 权限 | 级别 | 何时需要 | 覆盖能力 |
| --- | --- | --- | --- | --- |
| 账户（Account） | Workers 脚本（Workers Scripts） | 编辑（Edit） | **始终需要** | 部署主/预览 Worker、Durable Object、变量和 Secret；管理 `workers.dev` 子域 |
| 账户（Account） | D1（D1） | 编辑（Edit） | **始终需要** | 查找/创建 D1、检查旧数据、查询工作区状态和执行 migration |
| 账户（Account） | 账户设置（Account Settings） | 读取（Read） | 未配置 `CLOUDFLARE_ACCOUNT_ID` 时需要 | 通过 `/accounts` 自动发现唯一账户；显式配置账户 ID 后可省略 |
| 区域（Zone） | 区域（Zone） | 读取（Read） | 配置 `CUSTOM_DOMAIN` 或 `PREVIEW_DOMAIN` 时需要 | 让 Wrangler 查询域名所属 Zone；账户 ID 不能代替 Zone 权限 |
| 区域（Zone） | Workers 路由（Workers Routes） | 编辑（Edit） | 配置 `CUSTOM_DOMAIN` 或 `PREVIEW_DOMAIN` 时需要 | 新增或调整 Worker 的自定义域名绑定 |
| 账户（Account） | Access：应用和策略（Access: Apps and Policies） | 编辑（Edit） | **仅 Cloudflare 登录模式**的首次启用、切回或配置修复 | 查找/创建 Access 应用，读取及更新邮箱策略 |
| 账户（Account） | Access：组织、身份提供程序和组（Access: Organizations, Identity Providers, and Groups） | 编辑（Edit） | **仅 Cloudflare 登录模式**的首次启用、切回或配置修复 | 读取 Zero Trust 团队域，查找身份提供程序，缺少时创建 OTP |

Cloudflare 可能拆分、合并或重命名 Access 权限。若 Cloudflare 登录模式下已经找不到表中的两项精确名称，可使用兼容兜底：在 **账户（Account）** 权限中，将英文名称以 **`Access:`** 开头的权限全部设为 **编辑（Edit）**。中文界面也可能保留 `Access:` 英文前缀；该做法授权范围比上表更宽，仅在界面变化导致无法按最小权限配置时使用。GitHub 登录模式不需要这样设置。

账户资源（Account Resources）只选择实际部署账户。使用自定义域名时，区域资源（Zone Resources）选择 `Include → Specific zone → 域名所属 Zone`；主站和预览域名分属不同 Zone 时，两者都要包含。GitHub 登录模式完全不调用 Access API，因此不需要两项 Access 权限。

### GitHub 登录用户可直接核对的清单

1. **Permissions** 添加 `Account → Workers Scripts → Edit` 和 `Account → D1 → Edit`。
2. 默认自动发现账户时，再添加 `Account → Account Settings → Read`；如果已在 Fork 的 Actions **Variables** 设置 `CLOUDFLARE_ACCOUNT_ID`，可省略此项。该值是 32 位 **Account ID**，不是 Zone ID。
3. **Account Resources** 选择 `Include → Specific account → 实际部署账户`，避免 Token 同时覆盖多个账户而无法自动判断。
4. 使用自定义域名时，再添加 `Zone → Zone → Read` 和 `Zone → Workers Routes → Edit`，并在 **Zone Resources** 中包含域名所属 Zone。只使用 `workers.dev`、未配置主站或预览自定义域名时，可省略这两项。
5. 普通 GitHub Actions 托管 runner 的出口不固定；不要随意限制 Token 的 Client IP Address Filtering，否则 Actions 可能被拒绝。有效期应覆盖后续部署。
6. 检查摘要后创建 Token，只复制 Token 值，不把名称或 Global API Key 一起粘贴。
7. 保存到自己的 Fork 的 **Settings → Secrets and variables → Actions → Secrets → New repository secret**，名称精确为 `CLOUDFLARE_API_TOKEN`。这是部署 Token，**不是** OAuth App 的 `GH_CLIENT_SECRET`。

不需要额外的 GitHub PAT、`repo`/组织权限、Access/IdP 权限或 Global API Key。不要为解决浏览器登录错误直接扩大所有权限。

EdgeSSH 的 `CUSTOM_DOMAIN` 和 `PREVIEW_DOMAIN` 使用 **Workers 自定义域名（Workers Custom Domains）**，不是普通 route pattern，但不能据此删除 Zone 权限。Wrangler 部署时仍需绑定自定义域名；请保留模板中的 **区域（Zone）> 区域（Zone）：读取（Read）** 与 **区域（Zone）> Workers 路由（Workers Routes）：编辑（Edit）**，并限定到目标 Zone。仅使用 `workers.dev` 时不需要这两项。

EdgeSSH 不使用 **Workers KV 存储（Workers KV Storage）** 或 **R2 存储（Workers R2 Storage）**。可以移除模板自带的 KV 权限，不要额外授予 R2。

<ScreenshotPlaceholder
  title="API Token 权限与资源范围"
  description="请截取权限表和 Account Resources 选择结果。使用自定义域名时，还应展示 Zone Read、Workers Routes Edit 与 Zone Resources。必须遮盖 Token 值、账户邮箱和与教程无关的域名。"
  filename="02-cloudflare-api-token-permissions.png"
  src="/screenshots/02-cloudflare-api-token-permissions.png"
  alt="Cloudflare API Token 模板选择页面"
  caption="Cloudflare Token 模板入口示例；最终权限以本页最小权限表为准。可移除 KV 权限；使用自定义域名时须保留 Zone Read 与 Workers Routes Edit。"
/>

## 保存到 GitHub

Token 创建完成后，只会完整显示一次：

1. 复制 Token。
2. 打开 Fork 的 **设置（Settings）→ 机密和变量（Secrets and variables）→ Actions**。
3. 在 **机密（Secrets）** 中创建 `CLOUDFLARE_API_TOKEN`。
4. 粘贴并保存。

不要把 Token 存为普通 Variable。也不要把 Token 写入 `.env`、`.dev.vars`、`wrangler.toml`、README 或截图。

GitHub 模式不需要任何 Access/IdP 权限。创建完成后回到[部署流程](/deploy/actions)，只填写所选模式的参数。是否需要 Zone 权限取决于是否配置自定义域名，与登录方式无关。

## 验证与排错

Action 报 `Authentication error` 或 `Invalid API Token` 时：

- 确认复制的是 API Token，不是 Global API Key。
- 确认 Secret 名称精确为 `CLOUDFLARE_API_TOKEN`。
- 确认 Token 尚未被撤销或过期。
- 确认 Account Resources 包含 `CLOUDFLARE_ACCOUNT_ID` 对应账户。
- 使用自定义域名时，确认 Zone Resources 包含域名所属 Zone，并具备 `Zone → Zone → Read` 与 `Zone → Workers Routes → Edit`。

Action 能部署 Worker、但无法创建 D1 时，通常是缺少 **账户（Account）> D1（D1）：编辑（Edit）**。自定义域名绑定失败时，先确认域名所属 Zone 与 Worker 位于同一账户，再检查 **Workers Scripts：编辑（Edit）**、**Zone：读取（Read）**、**Workers Routes：编辑（Edit）** 以及 Zone Resources；不要因 Worker 上传成功就认定域名绑定权限也已齐全。

**区分部署权限与运行时登录**：Cloudflare Token 由 Actions 部署时使用；Worker 登录读取 D1 绑定并与 GitHub 交换 OAuth 令牌，不携带这个部署 Token。浏览器回调 403“不是管理员”应检查登录账号；点击登录出现通用 500 应先按 [GitHub 登录排障](/deploy/github-oauth#按失败阶段排查)定位。2026-10-07 已修复的 Base64 密钥解码错误无需新增权限或换密钥。

## 文档站 Pages 权限

维护者手工发布文档站时还需要 **账户（Account）> Cloudflare Pages（Cloudflare Pages）：编辑（Edit）**；普通 EdgeSSH 部署用户不需要此权限。文档源码单独维护，不在应用 `main`，也没有主分支 `Deploy docs` 工作流。
