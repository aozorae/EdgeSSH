# EdgeSSH 部署与验收

## 先确定入口并选择一种登录方式

本项目只有一个管理员、一份主机资料库。`AUTH_PROVIDER` 决定唯一生效的认证方式，不同时维护两套登录状态。两种方式都部署到 Cloudflare Workers，但 **GitHub 模式不需要 Zero Trust 或 Access 权限**。

多数用户建议先准备自定义域名，例如 `ssh.example.com`。在 GitHub **设置（Settings）> 机密和变量（Secrets and variables）> Actions** 配置：

| 名称 | 类型 | Cloudflare 模式 | GitHub 模式 |
| --- | --- | --- | --- |
| `AUTH_PROVIDER` | Variable | `cloudflare`（默认） | `github` |
| `CLOUDFLARE_API_TOKEN` | Secret | 必填 | 必填 |
| `CUSTOM_DOMAIN` | Variable | 推荐填写实际主机名 | 推荐填写实际主机名 |
| `PREVIEW_DOMAIN` | Variable | 可选；仅部署独立预览 Worker 时使用 | 可选；仅部署独立预览 Worker 时使用 |
| `ADMIN_EMAIL` | Variable | 管理员邮箱 | 不需要 |
| `GITHUB_CLIENT_ID` | Variable | 不需要 | OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | Secret | 不需要 | OAuth App 的 Client Secret |
| `GITHUB_ADMIN` | Variable | 不需要 | 首次启用时用于解析数字 ID 的 GitHub 用户名 |
| `GITHUB_ADMIN_ID` | Variable | 不需要 | 通常不填；显式更换管理员时填写新的数字用户 ID |

`CUSTOM_DOMAIN` 只填完整主机名，不带 `https://`、路径或通配符。域名必须由部署账户的 Cloudflare Zone 管理；Action 会自动绑定 Worker，Cloudflare 负责 DNS 与证书。需要使用免费 `workers.dev` 地址时将它留空，不能填写 `*.workers.dev`。

敏感值不要放 Variable。工作流只校验所选方式的配置，另一种方式的旧配置不会参与认证。

## Cloudflare 模式准备

1. 在 Cloudflare **启用 Zero Trust**，完成团队域名与计划初始化。组织开通涉及账户确认，不由脚本代办。
2. Fork 本仓库，启用 GitHub Actions，在 **设置（Settings）> 机密和变量（Secrets and variables）> Actions** 保存 `CLOUDFLARE_API_TOKEN` Secret，并按上表保存 `CUSTOM_DOMAIN` 与 `AUTH_PROVIDER` Variable。
3. 在 **Actions > Deploy > 运行工作流（Run workflow）** 输入管理员邮箱，运行并等待摘要给出访问地址。可将邮箱保存为 `ADMIN_EMAIL` Variable，省去重复输入。

无需手动创建 Access 应用、OTP、D1，也无需抄录 Account ID、Team Domain 或 AUD。填写 `CUSTOM_DOMAIN` 时使用自定义域名；留空才使用 `https://edgessh.<账户子域>.workers.dev`。

Access 应用的策略是唯一授权名单。可以在控制台添加多个明确邮箱，也可以启用多个 IdP；通过这些策略的身份都拥有同一管理员工作区的完整权限，共用一份主机资料。Worker 不再维护第二份邮箱白名单。

## GitHub 模式准备

1. 打开 GitHub **设置（Settings）> 开发者设置（Developer settings）> OAuth 应用（OAuth Apps）> 新建 OAuth 应用（New OAuth App）**。
2. **应用名称（Application name）**自定；**主页 URL（Homepage URL）**填 EdgeSSH 地址，**授权回调 URL（Authorization callback URL）**填 `https://你的入口/auth/callback`。
3. 保存 Client ID，生成一个 Client Secret，按上表分别保存到 Actions Variable 和 Secret。
4. 设置 `AUTH_PROVIDER=github`、`CUSTOM_DOMAIN=你的主机名`、首次使用的 `GITHUB_ADMIN=你的GitHub用户名`，保存 Cloudflare API Token，然后运行 **Actions > Deploy**。使用 `workers.dev` 时才省略 `CUSTOM_DOMAIN`；邮箱输入框留空。
5. 若首次部署前不知道入口，可先为 OAuth App 使用占位 URL；部署后将 Action 摘要中的正式入口与回调地址复制回 OAuth App 设置，再登录。

GitHub OAuth App 必须由用户在 GitHub 创建；普通 GitHub Token 没有官方“创建 OAuth App”的 REST 接口，工作流不会假装自动完成它。

登录时仅读取 GitHub 公开身份，不申请仓库、组织或私人邮箱权限。首次部署将用户名解析为数字用户 ID 并固定在 D1；后续普通部署直接复用该 ID，不会因用户名改名或易主而改变管理员。仅在明确更换管理员时设置 `GITHUB_ADMIN_ID` 为新的数字 ID 并部署，部署会同时撤销旧会话；完成后可保留该值作为显式配置。

## API Token 权限

在 Cloudflare **我的个人资料（My Profile）> API 令牌（API Tokens）> 创建令牌（Create Token）**，以 **编辑 Cloudflare Workers（Edit Cloudflare Workers）** 模板为起点，保留部署所需权限，并补齐以下账户权限。Cloudflare 中文界面可能仍显示部分英文；下表同时保留英文原名。控制台的编辑（Edit）/读取（Read）对应 API 文档的 Write/Read。

| 账户（Account）权限 | 级别 | 用途 |
| --- | --- | --- |
| Workers 脚本（Workers Scripts） | 编辑（Edit） | Worker、Durable Object、Secret 和子域部署 |
| Workers KV 存储（Workers KV Storage） | 编辑（Edit） | 保留官方 Workers 模板的部署权限 |
| 账户设置（Account Settings） | 读取（Read） | 自动发现账户 |
| D1 | 编辑（Edit） | 查找/创建数据库、检查旧数据与执行迁移 |
| Access：应用和策略（Apps and Policies） | 编辑（Edit） | **仅 cloudflare 模式**：查找/创建应用及邮箱策略 |
| Access：组织、身份提供程序和组（Organizations, Identity Providers, and Groups） | 编辑（Edit） | **仅 cloudflare 模式**：获取团队域名、查找/创建 OTP |

账户资源只选择实际部署账户。若 Token 可访问多个账户，设置 Actions Variable `CLOUDFLARE_ACCOUNT_ID`，脚本不会猜测目标账户。

只用 `workers.dev` 不需要自定义域名的区域权限。使用 `CUSTOM_DOMAIN` 时，还需模板的 **区域（Zone）> Workers 路由（Workers Routes）：编辑（Edit）、区域（Zone）：读取（Read）**，并将区域资源范围限定到该域名所在 Zone。域名必须已经由同账户的 Cloudflare 管理。

API Token 只存 GitHub Secret，不放普通变量、代码或命令行输入框。不要将 Token 填到 Run workflow 的邮箱字段。

## 独立预览 Worker 与端口转发

| 模式 | 默认入口 | 适用场景 | 部署要求 |
| --- | --- | --- | --- |
| `trusted` | 主 Worker `/_forward/<session>/` | 你信任的目标网站 | 无需第二 Worker；默认模式 |
| `isolated` | 独立预览 Worker | 不可信或可能被入侵的目标网站 | Actions 运行 `部署预览 Worker`，预览域名必须跨 site |

同源路径、HttpOnly Cookie 和新窗口不是沙箱；恶意脚本仍可代发主站 SSH API。主站 Cookie 不会转发给远端，但不防同源 JavaScript 调用接口。界面会显示风险警告并要求信任确认；连接期间禁用切换，用户需先点击停止再切换。未部署预览 Worker 时选择 isolated 不会回退到标准转发，而是明确拒绝连接。

普通 push 或 `Deploy` 只发布主 Worker，不新建 preview。需要 isolated 时，运行 Actions **部署预览 Worker**，该 workflow 先更新主 Worker 配置，再调用原可复用 Deploy 并传入 `deploy_preview=true`，仅该流程设置 `DEPLOY_PREVIEW_WORKER`；可选填写 `PREVIEW_DOMAIN`，留空默认 `<WORKER_NAME>-preview.<账户子域>.workers.dev`。它发布只绑定 `SSH_SESSIONS` 的预览 Worker，不绑定 D1、ASSETS、加密密钥或主站接口，并设置主站 `PREVIEW_ORIGIN`。已有 `PREVIEW_ORIGIN` 在常规发布中保留，不自动删除；普通发布不会更新预览代码，修改预览实现时须重新运行该 workflow，现有预览 Worker 无需重新部署即可在界面切换。

主站与预览必须跨 site：自定义域名加默认 `workers.dev` 可行；自定义域名加同站自定义域名会拒绝；同账户双 `workers.dev` 也会拒绝，主站只有 `workers.dev` 时需独立自定义域名。专用 preview 同一 origin 内不同目标网站不相互隔离，切换前关闭旧预览窗口。

操作步骤：在端口转发页面选择主机和端口转发类型（如 `127.0.0.1` HTTP）→ 选择 `trusted` 或 `isolated`（trusted 需勾选界面信任确认，isolated 不需要）→ 确认指纹并连接。连接期间禁用模式切换，需先点击停止再切换。离开管理页或刷新后，Worker 保持 SSH 转发 8 分钟；期限内重新进入可恢复显示、重新打开预览或立即停止。8 分钟到期、用户点击停止、SSH 断线或 Durable Object 重启后预览失效；仅关闭目标预览 tab 不保证停止。isolated 票据 60 秒内只能兑换一次，兑换后的授权最长 1 小时；trusted 链接依赖主站登录及账户绑定，不使用一次性 fragment。

标准实现改写 HTML 属性、`srcset`、CSS URL、`Location`、Cookie 名称与 Path，并注入常见 `fetch`/XHR/EventSource/history/cookie 兼容脚本；不承诺任意网站透明代理。严格 CSP、动态 ES 模块、写死的 location、复杂 inline CSS/JS 框架仍可能需要 baseURL 配置，优先使用 isolated。仅支持 HTTP/SSE、相对资源、表单、目标 Cookie、重定向和 HTTP Basic 鉴权；HTTP 上游限 `127.0.0.1`，上传 16 MiB，CSS 重写 2 MiB，最多 24 个并发通道，通道闲置 60 秒。HTTPS 上游、WebSocket、Service Worker、写死 `localhost`、OAuth 固定 callback 不支持；SFTP 上传仍为 64 MiB。

## 自动执行顺序

1. 校验本地配置，运行类型检查、测试、前端构建和 Wrangler dry-run。
2. 自动发现唯一账户（显式账户 ID 优先），读取现有 Worker Secret **名称**，不尝试读取密钥明文。
3. 有 `CUSTOM_DOMAIN` 时使用该入口；否则读取账户 `workers.dev` 子域，未注册时自动注册确定性名称。已有子域不改名，避免影响其他 Worker。
4. 根据 `AUTH_PROVIDER` 仅准备所选认证：Cloudflare 普通重部署核对实际入口仍有 Access 网关，首次启用或从 GitHub 切回时核对应用、策略、Team Domain 与 AUD；GitHub 首次解析并固定管理员数字 ID，后续直接复用。
5. GitHub 模式不调用 Zero Trust API；Cloudflare 模式不需要 GitHub OAuth 参数。既有 Access 应用不重写人工 IdP 配置。
6. 按 ID 或名称复用 D1，不存在才创建；指定 ID 不存在时直接失败，不用新空库替代。
7. 已有 `ENCRYPTION_KEY` 则保留；没有密钥且 D1 没有主机资料时，用安全随机数生成 32 字节密钥。
8. 执行远程 migration，仅应用增量 schema，不清空数据；单行 `workspace_state` 永久保存资料所有者、当前认证方式和会话代次。
9. 自动沿用旧库唯一资料所有者 ID，新库使用固定 `admin`。即使主机表后来清空，工作区 ID 也不再重新推断。新增 Secret 通过标准输入交给 Wrangler；部署后核对当前模式必需的 Secret，并输出入口和 GitHub 回调地址。

生产任务通过 concurrency 串行运行，失败可修正原因后重跑，已创建的资源会复用。请勿用多个仓库同时管理同一个 Worker。

设置自定义域名时关闭备用 `workers.dev` 入口；两个 Worker 都关闭 Cloudflare 版本预览 URL；独立 workflow 发布专用 preview Worker 的正式地址。Cloudflare 模式校验 Access JWT；GitHub 模式使用 state、PKCE 和签名 HttpOnly Cookie。缺少认证不降级为匿名 SSH。

## 官方强制更新

Fork 中的 `Force Update` 工作流每小时第 17 分钟运行，也支持从 Actions 页面手动运行。它会获取官方 `aozorae/EdgeSSH` 的 `main`，扫描 Fork 当前 `main` 到官方最新版本之间的提交，并查找以下完整 Git trailer：

```text
EdgeSSH-Auto-Update: true
```

不存在标记时，工作流成功结束且不改代码、不部署。存在标记时，它选择拓扑顺序中最新的标记提交，以 `force-with-lease` 将 Fork 的 `main` 精确更新到该 SHA，然后直接调用 `Deploy` 的可复用部署任务并检出同一个 SHA。部署不依赖这次推送再次触发工作流，因此不会受 GitHub 防递归机制影响。

此能力用于维护者发布必须尽快应用的安全或兼容性更新。精确同步会移除 Fork 在 `main` 上独有的提交；需要长期维护的自定义改动应放在其他分支。若检测期间 `main` 又被人工更新，lease 会让本次任务停止，下一次运行会基于新版本重新检查。仓库或组织策略还必须允许工作流使用 `contents: write`，否则无法更新分支。

## 其他可选配置

| 名称 | GitHub 位置 | 默认/示例 |
| --- | --- | --- |
| `ADMIN_EMAIL` | Variable，兼容 Secret | `you@example.com`；Run workflow 输入优先 |
| `CLOUDFLARE_ACCOUNT_ID` | Variable，兼容 Secret | 仅多账户 Token 需要指定 |
| `WORKER_NAME` | Variable | `edgessh` |
| `D1_DATABASE_NAME` | Variable | `<Worker 名>-accounts` |
| `D1_DATABASE_ID` | Variable | 指定已有 D1 UUID，不填则按名称查找 |
| `ACCESS_IDP_IDS` | Variable | 新应用采用的 IdP UUID，多个用逗号分隔 |
| `GITHUB_ADMIN_ID` | Variable | 仅显式更换 GitHub 管理员时填写数字用户 ID |
| `PREVIEW_DOMAIN` | Variable | 仅 `部署预览 Worker` 使用；留空为 `<WORKER_NAME>-preview.<账户子域>.workers.dev` |
| `ENCRYPTION_KEY` | Secret，仅恢复/迁移使用 | 仅 Worker 尚无密钥时使用；已有密钥不会覆盖 |

`DB`、`SSH_SESSIONS`、`ASSETS` 是资源绑定，不是需要用户创建的变量。`CONNECT_TIMEOUT_MS` 已有默认值 `10000`。

<a id="worker-runtime-secrets"></a>

## 密钥生命周期与旧版升级

- `ENCRYPTION_KEY` 的持久化来源是 **Cloudflare Worker Secrets**。Cloudflare 模式自动取得并保存 Team Domain/AUD；GitHub Client Secret 由 GitHub Actions Secret 同步到 Worker。不要保存为 Variable 或明文配置。
- 新部署不需要 GitHub 写 Secrets 权限或额外 GitHub Token。生成的值不写入文件、命令行参数或 Actions artifact。
- 重跑、推送新代码时保留原加密密钥。GitHub 中遗留的同名密钥不会替换 Worker 中的密钥。
- **已有 D1 主机资料但缺少密钥时停止部署。** 必须恢复原密钥，不能生成新密钥假装修复。Cloudflare API 不提供 Secret 明文读回，自动生成的密钥也不会显示给用户；不要删除 Worker/Secret。需要独立灾备时，可在首次部署前自行生成并安全备份 32 字节 Base64 密钥，再保存为 `ENCRYPTION_KEY` GitHub Secret。
- 旧部署无需重新输入邮箱，也不要求复制 Secret 回 GitHub；同为 Cloudflare 模式的普通重部署会实际探测入口仍受 Access 保护并保留现有 Secret，不要求新增 Zero Trust API 权限。首次启用或从 GitHub 切回时才从 Access 应用核对 Team Domain、AUD 与策略；任何路径都不会仅凭 Secret 名称判定有效，也不会改写人工维护的 IdP 或身份策略。
- 若需要自动创建/管理 Access，或更换 hostname，请提供 `ADMIN_EMAIL`。自动管理使用账户级 Access API；原有 Zone 级应用请先核对，不要在同一 hostname 叠加应用。
- 切换认证方式不改变 `ENCRYPTION_KEY`、D1 和管理员资料所有者。不要通过更换密钥来切换登录方式。

## 切换登录方式，保留同一管理员资料

1. 修改 `AUTH_PROVIDER`，补齐目标方式的配置，然后运行 Deploy。
2. 保持 Worker、D1 和加密密钥不变。首次升级只读检查旧库唯一所有者并写入固定工作区状态，不搬迁、不重加密资料。
3. 新库统一使用 `admin`。若旧库实际有多个资料所有者，脚本停止，不会猜测或合并原本隔离的数据。
4. 从 Cloudflare 改 GitHub 时，**先解除入口域名原有的 Access 网关保护**，否则浏览器仍会先看到 Access。脚本发现这种情况会停止，不自动删除安全策略。仅解除登录网关，不要删除 Worker、D1 或 Secret。
5. 反向切换时，Action 会核对或准备有效 Access 应用；只有 Secret 名称但入口配置不完整会明确失败。切换会递增会话代次，旧 provider 的 Cookie 即使切回原方式也不会复活。

GitHub 会话使用 Secure、HttpOnly、SameSite=Lax Cookie，有效期 8 小时；退出会先验证当前身份，再让该实例的全部管理员会话失效并清除本浏览器 Cookie，但不注销 GitHub 网站账号。Access 退出同样记录撤销时间并跳转到 Access 注销。会话签名通过 HKDF 从原加密密钥派生独立用途的密钥，无需用户再管理 SESSION_SECRET；撤销不会轮换 `ENCRYPTION_KEY`。无需新增用户表、设备后台或账号绑定流程。

Cloudflare 模式仍可用 `ACCESS_IDP_IDS` 为新 Access 应用选择现成 IdP；这属于 Access 模式，不是原生 `AUTH_PROVIDER=github`。

## 排障

- **403**：检查 Token 权限及账户/Zone 范围，不是重新生成加密密钥。
- **找不到唯一账户**：限定 Token 到一个账户，或配置 `CLOUDFLARE_ACCOUNT_ID`。
- **组织读取失败**：先完成 Zero Trust 开通和团队域设置。
- **首次部署缺少邮箱**：在 Run workflow 输入，或设置 `ADMIN_EMAIL`。
- **既有策略被人工修改**：脚本不会覆盖额外 require/exclude 等条件；在控制台维护，或改名后重跑。
- **更换域名后无法登录**：带邮箱重新运行以配置新 hostname 的应用；不要仅改路由而沿用旧 AUD。
- **OTP 未收到**：确认输入邮箱完全匹配 Allow 策略，检查垃圾邮件。GitHub 等其他 IdP 的账户邮箱同样必须匹配授权。
- **GitHub 回调失败**：检查 OAuth App 回调地址是否精确为 `https://实际入口/auth/callback`，Client ID/Secret 是否来自同一 OAuth App；重新从首页登录，不复用旧回调链接。
- **GitHub 拒绝管理员**：`GITHUB_ADMIN` 应填个人用户名，不是邮箱或组织；用该账号重新授权。
- 手工配置、截图与 Access JWT 排查见 [Zero Trust 指南](docs/ZERO_TRUST.md)。

## 验收清单

- `npm run check`：类型检查、测试、前端构建与部署 dry-run。
- 空账户 bootstrap 与重复部署：只创建一次应用/OTP/D1，密钥不轮换，不覆盖 GitHub IdP。
- Cloudflare 模式未登录跳 Access；GitHub 模式点击首页「登录」前往 GitHub，未授权账号不可进入。
- 登录后 `/api/auth/me` 与主机列表可用；无 JWT、伪造/过期 JWT 不可访问主机、票据或 WebSocket。
- 加密资料跨部署保持可解密；测试不得清空生产 D1。
- 真实 SSH、SFTP 与进程面板必须使用已获授权目标；未提供目标和登录会话时不声称验收完成。
- 文件管理浏览器回归：`npx playwright install chromium` 后运行 `npm run test:browser`，覆盖桌面/375px 手机的入口、目录导航、上传/下载字节、新建/重命名/删除、主机切换、指纹确认与传输期间导航。测试只模拟 API 和 WebSocket，不替代真实服务器验收。
- 线上登录后，从左侧「文件管理」选择授权主机，在专用临时目录验证上传、下载、新建、重命名与删除空目录，再切换到终端确认同一会话仍可用。不得用既有生产文件验证删除或覆盖。
