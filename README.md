> **本项目基于 [Worker Web SSH（CF-Workers-WebSSH）](https://github.com/cmliu/CF-Workers-WebSSH) 深度开发。**<br>
> 在上游原生 WebSSH 能力的基础上，扩展主机管理、加密云端存储、地球可视化与操作系统识别，打造面向个人管理员的云端 SSH 工作台。感谢原作者的开源贡献。

<div align="center">

# EdgeSSH

**打开浏览器，连接你的服务器。**

运行于 Cloudflare Workers 的轻量 SSH 工作台<br>
主机总览 · 交互终端 · 文件管理 · 进程监控

<p>
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Apache 2.0" src="https://img.shields.io/badge/License-Apache%202.0-546E7A?style=flat-square">
</p>

[功能特性](#功能特性) · [界面预览](#界面预览) · [快速开始](#快速开始) · [本地开发](#本地开发) · [安全与限制](#安全与限制)

</div>

---

## 界面预览

<div align="center">

![EdgeSSH 演示界面](docs/images/edgessh-dashboard-demo.png)

<sub>演示数据使用保留地址，不对应任何真实服务器。</sub>

</div>

## 功能特性

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🗂️ 主机管理</h3>
      <p>集中保存服务器资料与连接凭据，支持搜索、分组筛选与编辑。从列表直接进入工作台，无需反复输入连接信息。</p>
    </td>
    <td width="50%" valign="top">
      <h3>🌍 地球可视化</h3>
      <p>以可交互地球呈现主机地理位置，支持点位连接、刷新定位，配合城市与国旗展示服务器分布。</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>⌨️ 浏览器终端</h3>
      <p>基于 xterm.js，支持交互式 Shell、窗口尺寸同步、全屏与会话日志，适配桌面和移动端，工作台支持中英文切换。</p>
    </td>
    <td valign="top">
      <h3>📁 SFTP 文件管理</h3>
      <p>从左侧「文件管理」进入专用页面，选择已保存主机，浏览目录、上传与下载、新建文件夹、重命名、删除文件或空目录；与终端侧栏共用文件操作逻辑与 SSH 会话。</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>📊 实时进程面板</h3>
      <p>通过独立通道查看远端进程与 CPU、负载、内存和 Swap 信息，无需离开 SSH 工作台。</p>
    </td>
    <td valign="top">
      <h3>🐧 系统自动识别</h3>
      <p>通过 SSH 命令探测操作系统，记录系统版本与架构，并以品牌色圆角图标区分常见系统与发行版。</p>
    </td>
  </tr>
</table>

### 不只是一个终端

- **边缘原生**：Worker 通过 Cloudflare TCP Sockets 直接连接 SSH 服务器，无需额外部署 SSH 中转服务，每个会话由 Durable Object 隔离。
- **身份保护**：Cloudflare Access 与原生 GitHub OAuth 二选一，只允许管理员登录；切换方式仍使用同一份主机资料。
- **加密存储**：主机资料、密码、私钥与指纹通过 AES-256-GCM 加密后保存到 D1，浏览器不持久化连接凭据。
- **指纹确认**：首次连接时展示服务器 SHA-256 指纹，确认后才发送 SSH 凭据。
- **灵活连接**：支持密码、单密码提示的 keyboard-interactive，以及未加密 OpenSSH 私钥认证；支持 UTF-8、GB18030、Big5 终端编码。
- **轻量实现**：TypeScript + Vite + Web Crypto；地球采用 Canvas 球面投影，不引入 Three.js 等大型三维依赖。

## 工作原理

```text
浏览器 · 主机总览 / xterm.js / SFTP / 进程面板
    │ HTTPS / WebSocket · Cloudflare Access 或 GitHub OAuth
    ▼
Cloudflare Worker
    ├── 静态资源与 API
    ├── 主机资料加密读写 ──→ D1
    └── 一次性会话票据
            ▼
    Durable Object · 每会话 SSH 客户端
            │ Cloudflare TCP Socket
            ▼
        公网 SSH 服务器
```

SSH 握手、密钥交换、认证与通道逻辑在 Worker 内完成。浏览器连接的是 Worker，而不是直接建立到服务器的 TCP 连接。

## 快速开始

### 环境准备

- Node.js **22.12.0 或更高版本**，以及 npm。
- 可使用 Workers、Durable Objects 与 D1 的 Cloudflare 账户。
- 准备一个由同一 Cloudflare 账户管理的自定义域名（推荐），或使用自动分配的 `workers.dev` 地址。
- 选择 Cloudflare Access 或原生 GitHub OAuth。GitHub 模式不需要开通 Zero Trust。
- 一台你有权访问的公网 SSH 服务器。

### 一次运行，自动配置认证与部署

在 Fork 的 **设置（Settings）> 机密和变量（Secrets and variables）> Actions** 设置 `AUTH_PROVIDER` Variable，二选一；未填写时默认 `cloudflare`，兼容旧部署。两种模式都将应用部署到 Cloudflare Workers，**不是选择云服务商**。

| 配置 | GitHub 位置 | `cloudflare` | `github` |
| --- | --- | --- | --- |
| `AUTH_PROVIDER` | Variable | `cloudflare` | `github` |
| `CLOUDFLARE_API_TOKEN` | Secret | 必填 | 必填，不需要 Access 权限 |
| `CUSTOM_DOMAIN` | Variable | 推荐，如 `ssh.example.com` | 推荐，如 `ssh.example.com` |
| `PREVIEW_DOMAIN` | Variable | 可选；仅在部署独立预览 Worker 时填写 hostname | 可选；仅在部署独立预览 Worker 时填写 hostname |
| `ADMIN_EMAIL` | Variable | 管理员邮箱，也可在 Run workflow 输入 | 不填 |
| `GITHUB_CLIENT_ID` | Variable | 不填 | OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | Secret | 不填 | OAuth App 的 Client Secret |
| `GITHUB_ADMIN` | Variable | 不填 | 首次启用时解析数字 ID 的 GitHub 用户名 |
| `GITHUB_ADMIN_ID` | Variable | 不填 | 通常留空；显式更换管理员时填写数字 ID |

`CUSTOM_DOMAIN` 只填主机名，不带 `https://`、路径或通配符。域名需要由部署账户的 Cloudflare Zone 管理，Token 需要该 Zone 的 Workers Routes 编辑和 Zone 读取权限；Action 会自动绑定 Worker，Cloudflare 负责 DNS 与证书。确实使用 `workers.dev` 时才将它留空，且不要把 `*.workers.dev` 填进去。

**Cloudflare 模式**：先在 Cloudflare 控制台启用 Zero Trust，然后运行 Action，自动配置 Access 应用、邮箱 Allow 策略和 OTP。可在 Access 中明确允许多个邮箱或多个 IdP；它们只是同一管理员工作区的多个获准登录身份，不会产生独立资料库。

**GitHub 模式**：先在 GitHub **设置（Settings）> 开发者设置（Developer settings）> OAuth 应用（OAuth Apps）** 创建一个 OAuth App，回调地址填 `https://你的入口/auth/callback`。首次工作流会解析管理员数字 ID 并固定到 D1，后续不再因用户名变化而更新，且跳过全部 Zero Trust API。入口尚不确定时，可先使用占位回调地址，部署后从 Action 摘要复制正式地址，再回 GitHub 更新。详情见[部署指南](DEPLOYMENT.md)。

```text
确定自定义域名（或使用 workers.dev）+ 选择登录方式 + 填写对应变量/Secret
    ↓ Run workflow
发现账户并绑定自定义域名（或获取 workers.dev 子域）→ 仅配置所选认证方式
    → 创建/复用 D1 → 保留管理员资料归属 → 首次生成加密密钥
    → 数据库迁移 → 写入 Worker Secrets → 部署 Worker
    ↓
在 Actions 运行摘要打开访问地址，使用所选方式登录
```

无需手填 Account ID、D1 ID、Team Domain、AUD 或随机密钥。Token 能访问多个账户时，才需要用 `CLOUDFLARE_ACCOUNT_ID` 选择目标账户。

EdgeSSH 面向**单管理员工作区**，不允许匿名访问。两种认证不会同时生效；切换方式不改数据库、资料所有者或加密密钥，并会让旧会话失效。旧库只有一个所有者时自动沿用原 ID 并永久记录，新库使用固定管理员 ID；发现多个所有者会停止而非静默合并。若原域名已有 Access 网关，改 GitHub 前需要解除该域名的旧 Access 保护；工作流不会擅自删除安全策略。

### 获取项目

```bash
git clone https://github.com/aozorae/EdgeSSH.git
cd EdgeSSH
npm ci
```

### 其他可选配置

以下通常都可以留空，保存为 Actions Variable：

| 名称 | 示例值 | 用途 |
| --- | --- | --- |
| `ADMIN_EMAIL` | `you@example.com` | 省去每次手动输入邮箱；修改后更新脚本创建的邮箱策略 |
| `CLOUDFLARE_ACCOUNT_ID` | `0123456789abcdef0123456789abcdef` | 多账户 Token 的账户选择 |
| `WORKER_NAME` | `my-edgessh` | 默认 `edgessh` |
| `D1_DATABASE_NAME` | `my-edgessh-accounts` | 默认 `<Worker 名>-accounts` |
| `D1_DATABASE_ID` | `00000000-0000-4000-8000-000000000001` | 复用明确指定的数据库 |
| `ACCESS_IDP_IDS` | `一个或多个 IdP UUID，以逗号分隔` | 创建新应用时使用已有 GitHub/其他 IdP，而非自动配置 OTP |
| `GITHUB_ADMIN_ID` | `12345678` | 仅在明确更换 GitHub 管理员时填写 |
| `PREVIEW_DOMAIN` | `preview.example.com` | 可选；仅供 `部署预览 Worker` 使用，留空自动生成 `<Worker 名>-preview.<账户 workers.dev 子域>.workers.dev` |

`ENCRYPTION_KEY` 由部署流程管理并持久保存在 **Cloudflare Worker Secrets**；Cloudflare 模式另存 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`，GitHub 模式同步 `GITHUB_CLIENT_SECRET`。不需要用户复制自动生成的值回 GitHub。加密密钥只在首次部署生成，后续保留，即使 GitHub 留有旧值也不会覆盖线上密钥。不要删除 Worker 或其加密密钥；Cloudflare 不提供密钥明文读回，丢失后无法解密已有资料。

推送 `main` 或手动运行 `Deploy` 都会执行检查并只部署主 Worker，不会自动新建预览 Worker。需要代理不可信网站时，再从 Actions 手动运行 **部署预览 Worker**；它调用同一套可复用部署逻辑并设置 `deploy_preview=true`，只在该工作流临时设置 `DEPLOY_PREVIEW_WORKER`。只在首次 Run workflow 输入邮箱也可以：后续未提供邮箱时保留已有认证配置。需要更换域名或重新自动配置 Access 时，请再次提供邮箱。

Fork 启用 Actions 后，`Force Update` 每小时检查一次官方 `aozorae/EdgeSSH` 的 `main`。只有当前版本与官方最新版本之间出现带有独立 Git trailer `EdgeSSH-Auto-Update: true` 的提交时，工作流才会将 Fork 的 `main` 精确同步到最新一个标记提交，并在同一次运行中直接部署该 SHA；普通提交不会触发同步。也可从 Actions 页面手动运行检查。该流程会覆盖 Fork 在 `main` 上的自定义提交，自定义开发请保留在其他分支。

完整权限、自动更新、旧版迁移及 GitHub 登录扩展说明见[部署指南](DEPLOYMENT.md)；手工维护见 [Zero Trust 指南](docs/ZERO_TRUST.md)。

## 本地开发

安装依赖并准备本地变量：

```bash
npm ci
cp .env.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev
```

按部署指南在 `.dev.vars` 中填写所需配置。本地开发仍保留 Access 身份校验，不提供匿名绕过；本地变量文件不得提交。

需要前端热更新时，在另一个终端运行 `npm run dev:web`。Vite 默认位于 `http://localhost:5173`，将 `/api` 代理到本地 Worker 的 `8787` 端口；公网目标限制在本地同样生效。

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 构建前端并启动本地 Worker |
| `npm run dev:web` | 启动 Vite 前端开发服务器 |
| `npm run build:web` | 构建前端到 `dist/` |
| `npm run typecheck` | 检查 Worker 与前端类型 |
| `npm test` | 运行测试 |
| `npm run test:browser` | 文件管理浏览器回归（首次运行前执行 `npx playwright install chromium`） |
| `npm run check` | 类型检查、测试与部署 dry-run（包含前端构建） |
| `npm run deploy` | 构建前端并部署 Worker |

## 项目结构

```text
EdgeSSH/
├── .github/workflows/ # GitHub Actions 自动部署
├── frontend/          # 主机总览、地球可视化与 SSH 工作台
├── src/
│   ├── accounts/      # Access 认证、主机管理与加密存储
│   ├── backend/       # 会话生命周期、SFTP 与系统信息探测
│   ├── ssh/           # SSH 协议、认证、密码学与通道
│   └── worker.ts      # HTTP、API 与 WebSocket 入口
├── migrations/        # D1 数据库迁移
├── tests/             # 自动化测试
├── DEPLOYMENT.md      # 部署与验收指南
└── wrangler.toml      # Worker 与资源绑定配置
```

## 安全与限制

### 独立预览 Worker

默认端口转发路径为主 Worker 的 `/_forward/<session>/`，界面默认 **trusted**，只应连接你信任的网站。页面会显示醒目风险警告，并要求勾选信任确认；连接期间禁用 trusted/isolated 切换，用户需先点击停止再切换。路径同源、HttpOnly Cookie 和新窗口都不是沙箱：恶意脚本仍可能代发主站 SSH API；主站 Cookie 不会转发给远端，但这不能防止同源 JavaScript 调用主站接口。

需要不可信网站时，从 Actions 运行 **部署预览 Worker**（可选填写 `PREVIEW_DOMAIN`，默认 `<Worker 名>-preview.<账户 workers.dev 子域>.workers.dev`）。该工作流先更新主 Worker 配置，再部署只绑定 `SSH_SESSIONS` 的独立 Worker，并设置主站 `PREVIEW_ORIGIN`；普通 push/`Deploy` 只发布主 Worker，已有 `PREVIEW_ORIGIN` 会保留，不会自动删除既有预览，普通发布也不会更新预览代码。现有预览 Worker 保留即可在界面切换；修改预览实现时须重新运行该工作流。运行后在界面选择 **isolated**；选择隔离模式但未部署预览 Worker 时不会回退到标准转发，而是明确拒绝连接。预览域名必须与主站跨 site：同账户双 `workers.dev` 会拒绝，主站仅用 `workers.dev` 时需独立自定义域名。专用预览同一 origin 内的不同目标网站不相互隔离，切换前关闭旧预览窗口。

isolated 模式凭据只在 URL fragment 中短暂传递，随后立即换成 HttpOnly Cookie；fragment 票据每 60 秒只能一次性兑换，断线或 1 小时后失效。trusted 链接依赖主站登录及账户绑定，不使用一次性 fragment。标准实现会改写 HTML 属性、`srcset`、CSS URL、`Location`、Cookie 名称与 Path，并注入常见 `fetch`/XHR/EventSource/history/cookie 兼容脚本；不承诺任意网站透明代理。严格 CSP、动态 ES 模块、写死的 location、复杂 inline CSS/JS 框架仍可能需要 baseURL 配置，优先使用独立隔离模式。

支持 HTTP/SSE、相对资源、表单、目标 Cookie、重定向和 HTTP Basic 鉴权；仅支持 HTTP 上游 `127.0.0.1`。上传上限 16 MiB，CSS 重写上限 2 MiB，最多 24 个并发 SSH 通道；授权最长 1 小时，单通道闲置 60 秒。不支持 HTTPS 上游、WebSocket、Service Worker、JavaScript 写死 `localhost` 或 OAuth 固定 callback。SFTP 文件上传仍是独立的 64 MiB 限制。

### 端口转发

在端口转发页面选择主机和端口转发类型（例如 `127.0.0.1` 的 HTTP），确认 SSH 主机指纹后，系统会打开新的预览窗口。离开管理页或刷新后，Worker 会继续保持 SSH 转发 8 分钟；在期限内重新进入页面，可看到原端口、模式和截止时间，并可重新打开预览或立即停止。8 分钟到期、用户点击停止、SSH 断线或 Durable Object 重启后，预览失效；仅关闭目标预览 tab 不保证停止。预览票据只使用一次，不能分享给他人。

### 安全边界

- **不是端到端加密**：Worker 是实际的 SSH 客户端，会在会话内处理明文凭据。请仅部署到可信账户，并使用最小权限的 SSH 账号或密钥。
- 主机资料绑定固定管理员 ID，不随认证来源切换；会话使用一次性票据，辅助通道使用附着令牌，并检查同源请求。
- 连接目标仅限公网地址；域名解析后校验目标 IP，降低 SSRF 与 DNS 重绑定风险。
- 地理定位会向外部定位服务发送服务器公网 IP，不发送 SSH 凭据或命令；位置点位**不代表在线状态**。
- `workers.dev` 与自定义域名都可以作为正式入口。Cloudflare 模式需要对应 Access 应用；GitHub 模式由 Worker 的管理员授权与 HttpOnly 会话保护，两者都不允许匿名 SSH。

### 当前支持范围

| 类别 | 支持情况 |
| --- | --- |
| 会话 | SSH 2.0、交互式 Shell、PTY、窗口尺寸同步、Keepalive |
| 文件协议 | SFTP v3；单文件上传与下载上限 64 MiB；仅删除空目录 |
| 私钥认证 | 未加密 OpenSSH Ed25519、RSA、ECDSA P-256/P-384/P-521 |
| 主机管理 | 单一管理员工作区最多 200 台；不提供多租户或独立用户资料 |
| 终端编码 | UTF-8、GB18030、Big5，取决于浏览器解码支持 |
| 端口转发 | HTTP/SSE、相对资源、表单、Cookie、重定向、HTTP Basic 鉴权 |

暂不支持加密私钥、PEM/PKCS#8 私钥、SSH Agent、多因素键盘交互认证、SCP、ProxyJump、SSH 压缩与会话内 rekey；不支持出站 TCP 25 端口。

### 独立文件管理

左侧点击 **文件管理**，选择云端保存的主机并连接。首次连接或指纹变化时仍须确认主机身份。双击目录进入，或在路径栏输入绝对路径后按 Enter；选中文件后可下载、重命名、删除，也可上传文件和新建文件夹。

独立页面的右侧文件列表使用按需加载的 React Arborist 虚拟化内核，沿用白橙主题，并为文件夹、压缩包、文档、脚本、配置和链接等显示简洁图标。支持方向键、Home / End 选择及 Enter 打开；终端内的原生文件表格保持不变。

文件页继续使用原有完整 SSH 会话，不要求服务器提供独立的 SFTP-only 入口；不会执行主机配置中的初始命令。点击 **打开 SSH 终端** 可继续使用同一会话，文件传输不会因视图切换而中断。切换主机前先断开连接；离开到总览会关闭会话，正在传输时会要求确认。

### 代码片段

左侧 **代码片段** 页面可以搜索、新建、复制、编辑和删除常用命令，支持多行脚本。首次使用内置 10 条 Linux 查看类命令；内置片段与自建片段一样可以修改或删除，删空后不会自动补回。最多保存 200 条，名称不超过 80 个字符，命令不超过 8192 个字符。

终端右侧提供可折叠浮窗，拖动标题栏调整位置；键盘聚焦标题栏后，也可用方向键移动、Home 键复位。手机上默认收起。点击 **填入编辑器** 只写入命令草稿，不自动执行；检查后再用命令编辑器发送。片段管理页与终端共用同一个片段库，切换两者不会断开现有 SSH 会话。

片段通过管理员认证、同源 API 与 D1 加密存储同步，不把命令持久化到浏览器。升级自动应用增量 migration，保留现有主机、认证和加密密钥。

## 参与贡献

欢迎通过 Issue 反馈问题或通过 Pull Request 提交改进。提交前请运行 `npm run check`；涉及连接、文件传输或进程面板的改动，请使用真实且已获授权的 SSH 目标验证。

反馈时请附上复现步骤和必要的环境信息，**不要上传密码、私钥、Access Token 或未脱敏的日志**。

## 贡献者

- [CM / cmliu](https://github.com/cmliu)：原作者，完成项目的初始设计与核心实现。
- [aozorae](https://github.com/aozorae)：当前维护者。

## 致谢

- [Worker Web SSH / cmliu/CF-Workers-WebSSH](https://github.com/cmliu/CF-Workers-WebSSH)：本项目的直接上游与开发基础。
- [huashengdun/webssh](https://github.com/huashengdun/webssh)：WebSSH 终端与前端兼容 API 参考。
- [newbietan/CloudSSH](https://github.com/newbietan/CloudSSH)：Cloudflare Workers SSH 实现参考。
- [crazypeace/huashengdun-webssh](https://github.com/crazypeace/huashengdun-webssh)：WebSSH 二次开发与前端兼容性参考。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。使用、修改与分发时，请保留适用的许可证与版权声明。
