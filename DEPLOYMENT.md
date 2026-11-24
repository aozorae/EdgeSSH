# EdgeSSH 部署与验收

## 终端复制与 CPU 监控验收

- 终端选中文字后，在终端内任意位置右键，使用独立菜单的“复制”；菜单打开后新增输出不应改变本次待复制的文本。无选区时“复制”禁用，可使用“全选”。
- 有终端选区时，`Ctrl+C`、`Ctrl+Insert` 和 `Cmd+C` 复制选区；无选区时 `Ctrl+C` 仍向 SSH 发送中断。远端应用接管鼠标时，使用 `Shift` 拖选。
- 复制在本机浏览器执行，正式入口使用 HTTPS；浏览器限制剪贴板时会尝试传统复制，失败显示提示。无需为此增加 Cloudflare 权限。
- Linux 整机 CPU 使用相邻两次 `/proc/stat` 的差值，不使用反复启动 `top` 的第一帧。首份数据仅建立基线，显示 `--`；计数重置或采样无效时重新建立基线。`iowait` 计为空闲、`steal` 计为忙，`guest` 不重复计入。进程表中的 `%CPU` 仍由 `top` 提供，与整机占用口径不同。
- 更新后需要重新构建前端并部署 Worker（现有 Deploy 工作流会执行），刷新页面并重新建立 SSH 连接后验收；旧连接仍可能运行旧的采集命令。

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
| `GH_CLIENT_ID` | Variable | 不需要 | OAuth App 的 Client ID |
| `GH_CLIENT_SECRET` | Secret | 不需要 | OAuth App 的 Client Secret |
| `GH_ADMIN` | Variable | 不需要 | 首次启用时用于解析数字 ID 的 GitHub 用户名 |
| `GH_ADMIN_ID` | Variable | 不需要 | 通常不填；显式更换管理员时填写新的数字用户 ID |

`CUSTOM_DOMAIN` 只填完整主机名，不带 `https://`、路径或通配符。域名必须由部署账户的 Cloudflare Zone 管理；Action 会自动绑定 Worker，Cloudflare 负责 DNS 与证书。需要使用免费 `workers.dev` 地址时将它留空，不能填写 `*.workers.dev`。

从旧版 GitHub 登录配置升级时，先在仓库 Actions 设置中将 `GITHUB_CLIENT_ID`、`GITHUB_ADMIN`（如有）分别改为 `GH_CLIENT_ID`、`GH_ADMIN`，并将原 `GITHUB_CLIENT_SECRET` 的值重新保存为 **Secret** `GH_CLIENT_SECRET`。若曾显式设置 `GITHUB_ADMIN_ID`，改为 `GH_ADMIN_ID`。完成这些配置后再合并或拉取新版并运行 Deploy；旧 Secret 无法从 GitHub 读回，不要为迁移更换 OAuth App 或 `ENCRYPTION_KEY`。已有管理员数字 ID 会从 D1 沿用。

敏感值不要放 Variable。工作流只校验所选方式的配置，另一种方式的旧配置不会参与认证。

## Cloudflare 模式准备

1. 在 Cloudflare **启用 Zero Trust**，完成团队域名与计划初始化。组织开通涉及账户确认，不由脚本代办。
2. Fork 本仓库，启用 GitHub Actions，在 **设置（Settings）> 机密和变量（Secrets and variables）> Actions** 保存 `CLOUDFLARE_API_TOKEN` Secret，并按上表保存 `CUSTOM_DOMAIN` 与 `AUTH_PROVIDER` Variable。
3. 在 **Actions > Deploy > 运行工作流（Run workflow）** 输入管理员邮箱，运行并等待摘要给出访问地址。可将邮箱保存为 `ADMIN_EMAIL` Variable，省去重复输入。

无需手动创建 Access 应用、OTP、D1，也无需抄录 Account ID、Team Domain 或 AUD。填写 `CUSTOM_DOMAIN` 时使用自定义域名；留空才使用 `https://edgessh.<账户子域>.workers.dev`。

Access 应用的策略是唯一授权名单。可以在控制台添加多个明确邮箱，也可以启用多个 IdP；通过这些策略的身份都拥有同一管理员工作区的完整权限，共用一份主机资料。Worker 不再维护第二份邮箱白名单。

## GitHub 模式准备

### 第 1 步：Fork 并确定唯一入口

1. Fork 本仓库，打开**自己的 Fork** 的 **Actions** 页面，按页面提示启用工作流。首次部署使用最新 `main`，不要检出独立文档分支。
2. 二选一确定入口，不要把两种方案混填：

| 方案 | Actions Variable `CUSTOM_DOMAIN` | OAuth App 的主页与回调 |
| --- | --- | --- |
| 自定义域名 | 如 `ssh.example.com`，**只填主机名** | `https://ssh.example.com` 和 `https://ssh.example.com/auth/callback` |
| 免费 workers.dev | **不创建或留空**，不能填 workers.dev 地址 | 部署摘要里的正式入口，以及该入口加 `/auth/callback` |

自定义域名必须已由部署所用 Cloudflare 账户托管，建议使用尚未绑定其他应用的子域名；不需要手动新建 Worker、D1 或为本项目抄写 DNS 路由。若旧入口已经启用 Access，先按下文“切换登录方式”解除旧网关，不要叠加两层认证。

**本步检查**：你知道将来打开哪个入口；`CUSTOM_DOMAIN` 中没有 `https://`、斜杠、占位符或文档站域名。配置自定义域名后，备用 workers.dev 入口会关闭。

### 第 2 步：创建 GitHub OAuth App

在 GitHub **个人头像 > Settings > Developer settings > OAuth Apps > New OAuth App** 创建应用。注意是 **OAuth Apps**，不是 GitHub Apps，也不是 Personal access tokens。

| 表单字段 | 填写示例 |
| --- | --- |
| Application name | `My EdgeSSH`（名字自定） |
| Homepage URL | `https://ssh.example.com` |
| Authorization callback URL | `https://ssh.example.com/auth/callback` |

使用 workers.dev 且首次不知道地址时，可以先用 `https://example.com` 和 `https://example.com/auth/callback` 占位；**第 5 步必须替换为你自己的真实入口后才能登录**。

保存应用，复制 **Client ID**；点击 **Generate a new client secret**，安全保存刚生成的 **Client Secret**。二者必须来自同一个 OAuth App。不要把 Client ID、Client Secret、Cloudflare API Token 相互混用。

GitHub OAuth App 必须由用户在 GitHub 创建；普通 GitHub Token 没有官方“创建 OAuth App”的 REST 接口，工作流不会假装自动完成它。

### 第 3 步：在 Fork 的 Actions 保存配置

进入**仓库**（不是个人 OAuth App 页面）的 **Settings > Secrets and variables > Actions**。在两个页签分别点击 **New repository variable** / **New repository secret**；不要建到未被工作流引用的 Environment 中。

| 页签 | Name（原样复制） | Value / Secret |
| --- | --- | --- |
| Variables | `AUTH_PROVIDER` | `github`（小写） |
| Variables | `GH_CLIENT_ID` | 上一步的 Client ID |
| Variables | `GH_ADMIN` | 唯一允许登录的个人 GitHub 用户名 |
| Variables | `CUSTOM_DOMAIN` | 仅自定义域名方案填写，如 `ssh.example.com` |
| Secrets | `GH_CLIENT_SECRET` | 同一 OAuth App 的 Client Secret |
| Secrets | `CLOUDFLARE_API_TOKEN` | 按下一节最小权限创建的 Cloudflare API Token |

例如管理员个人主页是 `https://github.com/example-user`，`GH_ADMIN` 就填 `example-user`，不是完整 URL、邮箱、组织名或显示昵称。Value 不加引号、尖括号或注释。通常不要填 `GH_ADMIN_ID`、`ADMIN_EMAIL`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 或 `ENCRYPTION_KEY`，也不需要额外的 GitHub PAT。

如需指定账户，在 **Variables** 保存 `CLOUDFLARE_ACCOUNT_ID`（32 位 Account ID，不是 Zone ID）。这种情况下 Token 可省略 Account Settings Read；不指定则需该读取权限且 Token 只应覆盖一个账户。

**本步检查**：两个 Secret 都在 **Secrets** 页签；`AUTH_PROVIDER`、`GH_CLIENT_ID`、`GH_ADMIN` 在 **Variables** 页签。工作流不会从 Secret 读取后三者。旧版 `CUSTOM_DOMAIN` Secret 优先于同名 Variable；若更换域名，务必同步处理旧值，避免仍部署到旧入口。不要手动在 Cloudflare 创建同名运行时覆盖配置。

### 第 4 步：运行 Deploy，检查整次任务而非单个步骤

打开 **Actions > Deploy > Run workflow**，选择 **main**，管理员邮箱框留空，点击运行。等待整次任务变绿，打开运行摘要。

首次部署会复用或创建 Worker 和 D1、迁移数据库、固定管理员数字 ID，并安全生成/保存加密密钥；重跑保留原密钥与资料。GitHub 模式部署结束前，还会实际访问正式入口：

- `/auth/login` 必须返回指向 GitHub 的 **302**，且能够签发 OAuth 临时 Cookie；
- 未携带登录 Cookie 的 `/api/auth/me` 必须返回 **401**，证明 D1 工作区与认证配置可读取且未开放匿名访问；
- 验收失败会让 Deploy 失败，而不是只凭“上传 Worker 成功”宣告可用。

**本步检查**：整次 Deploy 成功，日志有“GitHub 登录入口签名与 D1 工作区验收通过”，摘要显示 `github`、你的正式入口和回调地址。`/api/health` 返回正常或首页能打开，不能替代登录验收。此检查不向 GitHub提交授权，不验证 Client Secret 是否被撤销，仍须完成下一步。

### 第 5 步：回填回调地址并完成真实登录

1. 回到 **个人 Settings > Developer settings > OAuth Apps > 你的应用**。
2. 把摘要中的入口填入 **Homepage URL**；把完整回调地址填入 **Authorization callback URL**，保存。协议必须为 `https://`，域名必须相同，路径精确为 `/auth/callback`，不要多加末尾斜杠。
3. 打开摘要中的正式入口，点击 **登录**，使用 `GH_ADMIN` 指定的账号授权。若浏览器登录了别人的 GitHub，先切换账号。
4. 成功后应回到主机总览；同一浏览器访问 `/api/auth/me` 应返回 **200** 和 `provider: "github"`。随后用自己授权的服务器验证 SSH；没有 SSH 主机不会影响 GitHub 登录验证。

不要收藏或重新使用带 `code`、`state` 的 callback 地址；每次失败都从首页重新点登录。上面的占位 URL 只解决“先取得正式地址”的顺序问题，不是有效登录配置。

登录时仅读取 GitHub 公开身份，不申请仓库、组织或私人邮箱权限。首次部署将用户名解析为数字用户 ID 并固定在 D1；后续普通部署直接复用该 ID，不会因用户名改名或易主而改变管理员。仅在明确更换管理员时设置 `GH_ADMIN_ID` 为新的数字 ID 并部署，部署会同时撤销旧会话；完成后可保留该值作为显式配置。

### 已部署用户：修复“服务暂时不可用，请稍后重试”

2026-10-07 修复了一个可复现的 GitHub 登录代码缺陷：自动生成的 `ENCRYPTION_KEY` 是标准 Base64，但旧代码按 Base64URL 解码；密钥包含 `+` 或 `/` 时，点击登录可能直接返回 **500**，甚至还没跳到 GitHub。原测试密钥不含这些字符，所以没拦住它。**该缺陷不代表你填错配置，也不是缺少 Access 权限。**

1. 在 Fork 执行 **Sync fork > Update branch**，确认已包含本次 Base64 解码修复。只重新运行旧提交对应的任务，不会获得新代码。
2. 保留现有 Worker、D1、OAuth App、`GH_CLIENT_SECRET` 和 `ENCRYPTION_KEY`。不要删除资源、清库、反复生成新密钥来碰运气。
3. 对更新后的 **main** 运行一次 **Deploy**，确认整次任务成功并通过上述入口验收。
4. 从摘要中的入口重新登录，不使用旧 callback 链接。

修复使用原密钥字节，不迁移或重加密已有主机资料。若更新后仍失败，按下文的“失败阶段”排查；同一句通用 500 也可能来自其他异常，不能只凭文案认定是这一原因。

## API Token 权限

在 Cloudflare **我的个人资料（My Profile）> API 令牌（API Tokens）> 创建令牌（Create Token）**，以 **编辑 Cloudflare Workers（Edit Cloudflare Workers）** 模板为起点，再按下表删减或补齐权限。Cloudflare 中文界面可能仍显示部分英文；范围、权限名和级别均同时列出中英文。控制台的编辑（Edit）/读取（Read）对应 API 文档的 Write/Read。

| 范围 | 权限 | 级别 | 何时需要 | 覆盖能力 |
| --- | --- | --- | --- | --- |
| 账户（Account） | Workers 脚本（Workers Scripts） | 编辑（Edit） | **始终需要** | 部署主/预览 Worker、Durable Object、变量和 Secret；读取或注册 `workers.dev` 子域；绑定 Workers 自定义域名（Custom Domains） |
| 账户（Account） | D1（D1） | 编辑（Edit） | **始终需要** | 查找/创建数据库、检查旧数据、查询工作区状态和执行 migration |
| 账户（Account） | 账户设置（Account Settings） | 读取（Read） | 未配置 `CLOUDFLARE_ACCOUNT_ID` 时需要 | 通过 `/accounts` 自动发现唯一账户；显式配置账户 ID 后可省略 |
| 账户（Account） | Access：应用和策略（Access: Apps and Policies） | 编辑（Edit） | **仅 Cloudflare 登录模式**的首次启用、切回或配置修复 | 查找/创建 Access 应用，读取及更新邮箱策略 |
| 账户（Account） | Access：组织、身份提供程序和组（Access: Organizations, Identity Providers, and Groups） | 编辑（Edit） | **仅 Cloudflare 登录模式**的首次启用、切回或配置修复 | 读取 Zero Trust 团队域，查找身份提供程序，缺少时创建 OTP |

Cloudflare 可能拆分、合并或重命名 Access 权限。若 Cloudflare 登录模式下已经找不到表中的两项精确名称，可使用兼容兜底：在 **账户（Account）** 权限中，将英文名称以 **`Access:`** 开头的权限全部设为 **编辑（Edit）**。中文界面也可能保留 `Access:` 英文前缀；该做法授权范围比上表更宽，仅在界面变化导致无法按最小权限配置时使用。GitHub 登录模式不需要这样设置。

账户资源（Account Resources）只选择实际部署账户。若 Token 可访问多个账户，设置 Actions Variable `CLOUDFLARE_ACCOUNT_ID`，脚本不会猜测目标账户。GitHub 登录模式完全不调用 Access API，因此不需要两项 Access 权限。

EdgeSSH 的 `CUSTOM_DOMAIN` 使用账户级 **Workers 自定义域名（Workers Custom Domains）** API，该能力由 **Workers 脚本（Workers Scripts）：编辑（Edit）** 覆盖；现有配置不使用普通 Workers 路由。因此，无论使用 `workers.dev` 还是 `CUSTOM_DOMAIN`，都不需要模板自带的 **区域（Zone）> Workers 路由（Workers Routes）：编辑（Edit）** 或 **区域（Zone）：读取（Read）**。只有自行把 `wrangler` 配置改成普通 route pattern 时，才需要把这两项 Zone 权限加回并限定到目标 Zone。

EdgeSSH 不使用 **Workers KV 存储（Workers KV Storage）** 或 **R2 存储（Workers R2 Storage）**；可以移除模板自带的 KV 权限，也不要额外授予 R2。维护者发布独立文档站时另需 **账户（Account）> Cloudflare Pages（Cloudflare Pages）：编辑（Edit）**，普通 EdgeSSH 部署不需要。

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

标准实现改写 HTML 属性、`srcset`、CSS URL、`Location`、Cookie 名称与 Path，并注入常见 `fetch`/XHR/EventSource/history/cookie 兼容脚本；不承诺任意网站透明代理。严格 CSP、动态 ES 模块、写死的 location、复杂 inline CSS/JS 框架仍可能需要 baseURL 配置，优先使用 isolated。仅支持 HTTP/SSE、相对资源、表单、目标 Cookie、重定向和 HTTP Basic 鉴权；HTTP 上游限 `127.0.0.1`，上传 16 MiB，CSS 重写 2 MiB，最多 24 个并发通道，通道闲置 60 秒。HTTPS 上游、WebSocket、Service Worker、写死 `localhost`、OAuth 固定 callback 不支持；SFTP 上传上限为 2 GiB，下载上限仍为 64 MiB。

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
| `GH_ADMIN_ID` | Variable | 仅显式更换 GitHub 管理员时填写数字用户 ID |
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

GitHub 会话使用 Secure、HttpOnly、SameSite=Lax Cookie，Cookie 与签名令牌有效期均为 30 天；OAuth 临时 state/PKCE Cookie 仍为 10 分钟。退出会先验证当前身份，再让该实例的全部管理员会话失效并清除本浏览器 Cookie，但不注销 GitHub 网站账号。Access 退出同样记录撤销时间并跳转到 Access 注销。会话签名通过 HKDF 从原加密密钥派生独立用途的密钥，无需用户再管理 SESSION_SECRET；撤销不会轮换 `ENCRYPTION_KEY`。无需新增用户表、设备后台或账号绑定流程。

新建 Cloudflare Access 应用的默认会话期限为 30 天（`720h`）。已有应用不会被普通部署改写，需在 Zero Trust 的 Access 应用设置中调整 Session Duration，并确认 Allow 策略的期限使用应用默认值或同为 30 天。已签发的 GitHub/Access Cookie 不会自动延长，重新登录后才采用新期限；主动退出和会话撤销仍可提前使其失效。

Cloudflare 模式仍可用 `ACCESS_IDP_IDS` 为新 Access 应用选择现成 IdP；这属于 Access 模式，不是原生 `AUTH_PROVIDER=github`。

## 排障

- **Deploy 中 Cloudflare API 返回 403**：检查 API Token 的权限、账户范围与有效期；若自行改成普通路由再检查 Zone 范围。浏览器 OAuth 回调返回 403“不是管理员”是另一回事，不需要扩大 Cloudflare Token 权限。
- **找不到唯一账户**：限定 Token 到一个账户，或配置 `CLOUDFLARE_ACCOUNT_ID`。
- **组织读取失败**：先完成 Zero Trust 开通和团队域设置。
- **首次部署缺少邮箱**：在 Run workflow 输入，或设置 `ADMIN_EMAIL`。
- **既有策略被人工修改**：脚本不会覆盖额外 require/exclude 等条件；在控制台维护，或改名后重跑。
- **更换域名后无法登录**：带邮箱重新运行以配置新 hostname 的应用；不要仅改路由而沿用旧 AUD。
- **OTP 未收到**：确认输入邮箱完全匹配 Allow 策略，检查垃圾邮件。GitHub 等其他 IdP 的账户邮箱同样必须匹配授权。
- **GitHub 回调失败**：检查 OAuth App 回调地址是否精确为 `https://实际入口/auth/callback`，Client ID/Secret 是否来自同一 OAuth App；重新从首页登录，不复用旧回调链接。
- **点击登录后、跳到 GitHub 前返回 500**：先同步含 Base64 解码修复的 `main` 并重新 Deploy，保留原 `ENCRYPTION_KEY`；不要授予额外 Access 权限。
- **提示“请从配置的正式入口登录”**：打开 Deploy 摘要的正式入口；核对 `CUSTOM_DOMAIN` 的 Secret/Variable 是否冲突，不要手工覆盖 Worker 的 `APP_ORIGIN`。
- **GitHub 授权返回后仍报 500/502**：检查失败请求是否为 `/auth/callback`、GitHub 连通性、OAuth App 的 Client Secret 与 D1 状态；从首页重新发起流程。不要把 callback URL、Cookie 或 Secret 发给他人。
- **Deploy 的入口验收无法连接**：检查自定义域名是否位于同一 Cloudflare 账户、DNS/证书是否就绪，待就绪后重跑；不要跳过验收或因超时重建数据库。
- **GitHub 拒绝管理员**：`GH_ADMIN` 应填个人用户名，不是邮箱或组织；用该账号重新授权。
- 手工配置、截图与 Access JWT 排查见 [Zero Trust 指南](docs/ZERO_TRUST.md)。

需要反馈时只提供：出错的步骤、正式入口（如可公开）、失败请求的**路径和 HTTP 状态码**、Deploy 提交 SHA/运行链接、脱敏错误截图。不要提供 API Token、Client Secret、ENCRYPTION_KEY、完整回调查询参数、请求 Cookie 或未经脱敏的整份网络日志。第三方服务故障、账户限制或 DNS 尚未生效时，应先解决对应问题；文档与自动检查不能替代真实授权验收。

## 验收清单

- `npm run check`：类型检查、测试、前端构建与部署 dry-run。
- 空账户 bootstrap 与重复部署：只创建一次应用/OTP/D1，密钥不轮换，不覆盖 GitHub IdP。
- Cloudflare 模式未登录跳 Access；GitHub 模式点击首页「登录」前往 GitHub，未授权账号不可进入。
- 登录后 `/api/auth/me` 与主机列表可用；无 JWT、伪造/过期 JWT 不可访问主机、票据或 WebSocket。
- 加密资料跨部署保持可解密；测试不得清空生产 D1。
- 真实 SSH、SFTP 与进程面板必须使用已获授权目标；未提供目标和登录会话时不声称验收完成。
- 文件管理浏览器回归：`npx playwright install chromium` 后运行 `npm run test:browser`，覆盖桌面/375px 手机的入口、目录导航、上传/下载字节、新建/重命名/删除、主机切换、指纹确认与传输期间导航。测试只模拟 API 和 WebSocket，不替代真实服务器验收。
- 线上登录后，从左侧「文件管理」选择授权主机，在专用临时目录验证上传、下载、新建、重命名与删除空目录，再切换到终端确认同一会话仍可用。不得用既有生产文件验证删除或覆盖。
