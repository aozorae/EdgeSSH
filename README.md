<div align="center">

# EdgeSSH · 开源 WebSSH 工作台

<p><strong>浏览器里的 SSH 终端与 SFTP 文件管理，运行在你自己的 Cloudflare 上。</strong></p>

把主机管理、在线终端、文件传输、进程监控与远程 HTTP 服务预览，收进一个个人服务器管理工作台，无需额外维护 SSH 中转服务器。

<p><sub>An open-source, self-hosted WebSSH client on Cloudflare Workers — browser-based SSH terminal, SFTP file manager, and server monitoring.</sub></p>

**Cloudflare-native · Self-hosted · Single-admin · Multi-session · Open source**

<br />

<p>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&amp;logoColor=white" alt="Cloudflare Workers" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-546E7A" alt="Apache License 2.0" /></a>
  <a href="https://edgessh-docs.pages.dev/"><img src="https://img.shields.io/badge/Docs-EdgeSSH-0B84F3" alt="EdgeSSH 产品与使用文档" /></a>
</p>

<br />

<p>
  <strong><a href="https://edgessh-docs.pages.dev/deploy/actions">快速部署</a></strong> ·
  <a href="#功能特性">功能特性</a> ·
  <a href="#安全设计">安全设计</a> ·
  <a href="#本地开发">本地开发</a> ·
  <a href="https://edgessh-docs.pages.dev/">文档站 →</a>
</p>

<br />

![EdgeSSH WebSSH 工作台：全球主机总览与服务器管理](docs/images/showcase/01-dashboard.png)

<sub>全部演示数据使用文档保留地址与虚构信息，不对应任何真实服务器。</sub>

<br />

**你的服务器 · 你的凭据 · 你的 Cloudflare · 你的 SSH 工作台**

</div>

<details>
<summary><strong>快速导航 · 功能、部署与技术说明</strong></summary>

- **了解产品**：[为什么是 EdgeSSH](#为什么是-edgessh) · [功能特性](#功能特性) · [多会话选项卡](#session-tabs) · [地球与平铺地图](#globe-map) · [当前支持](#当前支持)
- **开始使用**：[快速部署](#快速部署) · [认证方式](#认证) · [完整部署指南](https://edgessh-docs.pages.dev/deploy/actions)
- **了解边界**：[安全设计](#安全设计) · [信任边界](#信任边界) · [端口转发安全](#端口转发安全)
- **参与开发**：[本地开发](#本地开发) · [项目结构](#项目结构) · [Contributing](#contributing)

</details>

---

## CLI / Agent 调用

本地 Agent 可以通过 CLI 使用现有主机、SSH 和文件功能，使用 Cloudflare Access 浏览器登录并复用令牌。需要先部署本次代码并安装 Node.js 22.12+ 与 cloudflared。

```sh
npm --prefix cli ci
npm install --global ./cli
edgessh login --url https://ssh.example.com
edgessh hosts
edgessh exec "主机名" --json -- 'uname -a'
edgessh get "主机名" /var/log/app.log ./app.log
```

支持交互终端、目录查看、上传下载、创建目录、重命名和删除。命令执行与文件操作按需连接，完成即断开，设有超时和输出上限。安装、指纹确认、Agent 用法和资源消耗说明见 [CLI 文档](cli/README.md)。

## 为什么是 EdgeSSH？

SSH 客户端不少，WebSSH 也算不上新鲜。

EdgeSSH 想解决的是另一件事：

> **能不能不再维护一套 SSH 中转服务器，却依然拥有一个随时能从浏览器打开的个人 SSH 工作台？**

EdgeSSH 把 WebSSH 的连接层、主机管理与工作台界面，一起部署在 Cloudflare 上。

浏览器只负责交互；应用逻辑与认证交给 Cloudflare Worker；每一个 SSH 会话都由独立的 Durable Object 承载，再通过 Cloudflare TCP Sockets 连到你的服务器。一个页面可以同时持有多个这样的会话，互不干扰。

<table>
<tr>

<td width="25%" valign="top">

### ☁️ Cloudflare Native

跑在 Cloudflare Workers 上。

不用再单独维护一台 WebSSH 中转 VPS。

</td>

<td width="25%" valign="top">

### 🧰 SSH Workspace

不只是一个 Terminal。

主机、文件、进程、代码片段和远程服务，都在同一个工作台里。

多条会话可以并行挂着，用选项卡切换。

</td>

<td width="25%" valign="top">

### 🔐 Self-hosted

部署在你自己的 Cloudflare 账户里。

数据库、Worker 和配置，全部由你掌控。

</td>

<td width="25%" valign="top">

### 👤 Single Admin

面向个人服务器管理场景。

没有多租户、没有成员系统，也没有复杂的权限模型。

</td>

</tr>
</table>

<div align="center">

**它不只是塞进浏览器里的一个 Terminal。**

<p><strong>它是部署在 Cloudflare 上的个人 SSH 工作台。</strong></p>

</div>

---

## 功能特性

### 一个地方，管好你所有的服务器

EdgeSSH 把散落各处的服务器连接信息，收进统一的主机库。

在这里你可以：

- 保存、编辑服务器信息
- 搜索与整理主机
- 记录系统类型与服务器所在地
- 从 Dashboard 直接跳进 SSH
- 用密码、上传的 SSH 私钥或密钥链中的已有密钥认证
- 在不同设备间访问同一份工作区

主机资料与连接凭据会先用 **AES-256-GCM** 加密，再写入 D1。

### 密钥链

- 直接粘贴或上传未设口令的 OpenSSH Ed25519 / RSA / ECDSA 私钥；也可点击「生成」将 Ed25519 公私钥填入输入框，确认后保存
- 公钥可填写并校验，也可从私钥自动提取；支持复制公钥和按需下载私钥
- 私钥加密保存在 D1，列表不返回私钥；主机只保存密钥引用，连接时由 Worker 解密
- 同一密钥可用于多台主机，以及终端、文件管理和端口转发；仍被主机引用时不可删除

下载的私钥文件未设口令，请妥善保管。密钥链不会自动把公钥安装到目标服务器。

---

<a id="session-tabs"></a>

### 🗂️ 多会话选项卡 · Session Tabs

**一个工作台,不再只有一条连接。**

终端页顶部是一条会话选项卡:每一条 SSH 连接各占一栏,切换时谁都不会被断开。

- 同时保持多个会话:同一台主机最多 **3** 条,全局最多 **10** 条
- 切走的会话在后台继续运行,长任务不会因为你去看了另一台主机而中断
- 顶栏显示当前会话所在主机的国旗与名称,浏览器标签页标题跟着当前主机走
- 键盘:`←` / `→` 循环切换,`Delete` / `Backspace` 关闭当前选项卡
- 每一栏带连接状态点:空闲 / 连接中 / 已连接 / 断开中 / 错误
- **关闭选项卡才是显式断开**;刷新或误关页面不会让会话立刻消失

#### 刷新之后,还是同一个 shell

页面重载时,Durable Object 会把 SSH 连接短暂留着,新页面凭本地保存的会话身份把它接回来:

- 保留窗口默认 **5 分钟**,配置上限 **30 分钟**
- 本地只保存会话身份(目标、名称、后端会话 ID),**不保存密码与私钥**
- 超过 24 小时的恢复记录直接丢弃,而不是给一个"也许还回得来"的假象
- shell 确实已经结束,就需要重新输入一次凭据——这也正是值得把 shell 捡回来的原因

> 保留期间的会话仍然占用 Durable Object 资源。主动断开会立即销毁;只有刷新、短暂掉线、误关标签这类"没有要求断开"的情况才会被保留。

---

### 🖥️ SSH 在线终端 · Terminal

**打开浏览器，就是进了服务器。**

![EdgeSSH 实时 SSH 终端](docs/images/showcase/02-ssh-terminal.png)

基于 xterm.js 的交互式终端，支持：

- SSH 2.0
- PTY
- 窗口尺寸同步
- Keepalive
- 全屏终端
- UTF-8 / GB18030 / Big5
- 密码认证
- keyboard-interactive
- OpenSSH 私钥认证
- OpenSSH 口令加密私钥(bcrypt KDF)
- 多会话并行([见上文选项卡](#session-tabs))

![EdgeSSH 终端命令工作流](docs/images/showcase/03-terminal-command-workflow.png)

第一次连接某台服务器时，EdgeSSH 会先展示它的 **SHA-256 Host Key Fingerprint**。

只有你确认无误后，才会继续发送 SSH 凭据。

---

### 📁 SFTP 文件管理 · File Manager

**不必为了改一个文件,再多开一个工具。**

![EdgeSSH SFTP 文件管理](docs/images/showcase/05-sftp-file-manager.png)

EdgeSSH 内置了一个基于 SFTP 的文件管理器：

- 浏览服务器目录
- 上传与下载
- 新建文件夹
- 重命名
- 删除文件
- 键盘导航
- 文件类型图标
- 从文件管理器直接跳回 SSH Terminal

同一个会话里的 Terminal 与 File Manager 共用一条 SSH 连接，切换之间不必重新连接。

文件树、进程监控与端口转发都跟随当前所在的选项卡：切到哪一条会话，看到的就是那一台服务器的文件与进程。

---

### 📊 服务器进程监控 · Server Monitor

![EdgeSSH 实时进程监控](docs/images/showcase/04-process-monitor.png)

在 SSH 会话里就能直接看到：

**CPU · Load · Memory · Swap · Processes · OS · Architecture**

不需要跳出工作台,也不需要在服务器上额外装一个 Agent。

---

### 🔌 HTTP 端口转发 · Port Forwarding

服务器上有些服务只监听：

```text
127.0.0.1:3000
```

在 EdgeSSH 里,同样可以打开它。

![EdgeSSH 隔离端口转发预览](docs/images/showcase/07-isolated-web-preview.png)

EdgeSSH 能借助已有的 SSH 会话,访问服务器本地的 HTTP 服务,并在浏览器里给出一个临时预览。

适合这些场景:

**开发服务器 · 本地 Dashboard · 管理面板 · 调试接口**

如果要打开的是一个不太信任的网页,可以改用独立的 Preview Worker,把预览页面和 EdgeSSH 管理界面隔离开来。

> Port Forwarding 不是一个通用反向代理。WebSocket、HTTPS 上游以及部分复杂 Web 应用,目前还有一些限制。

[查看端口转发与安全说明 →](#端口转发安全)

---

### 📝 命令片段库 · Code Snippets

![EdgeSSH 加密同步命令库](docs/images/showcase/06-command-library.png)

把常用命令存下来:

```bash
docker ps
df -h
free -h
journalctl -xe
```

需要的时候:

**搜索 → 填入 Terminal → 检查一遍 → 执行**

代码片段通过 D1 同步,而不是只存在某一个浏览器里。

入口收进了终端页顶栏的「快捷命令指令」下拉,不用再展开侧边面板就能取用。

---

<a id="globe-map"></a>

### 🌍 服务器,也可以从地球上看

EdgeSSH 会根据服务器的公网 IP,估算出大致地理位置,并画在 Dashboard 的地球上。

点一下主机,就能从地图直接跳进对应的服务器。

#### 两种形态,一次过渡

- **自转球体**:只画正面的标记,主机随地球慢慢转过来
- **平铺世界地图**:把整幅世界一次性展开,所有主机同屏可见,横向吃满整个面板

两种形态之间用同一批采样点做「展开 / 收拢」过渡,来回切换不需要重新加载数据。

#### 按大洲统计,点一下就聚焦

标题右侧列出了每台主机所属的大洲,以及各自的数量:

```text
亚洲：2    欧洲：1    北美洲：2    位置未知：1
```

- 只有确实有主机的大洲才会出现,数量为零的不占位
- 点一个大洲:球体**转到该大洲正对屏幕并停住自转**;平铺地图则**放大到该大洲铺满画布**,其他大洲自然移出画面
- 再点一次就取消,世界恢复自转 / 恢复完整平铺
- 带着选中的大洲切换两种形态,新形态仍然框住同一个大洲
- 解析不到位置的主机统一归入 **位置未知**,它只计数、不可点:没有坐标,就没有可以聚焦的地方

地球组件用的是轻量的 Canvas 球面投影,没有引入 Three.js 这类较重的 3D Runtime。

> 地理位置仅用于可视化展示,不代表服务器的实时在线状态。南极洲不在可选大洲之内。

---

## 一套工作台,多种服务器管理方式

```text
                         EdgeSSH
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
      Hosts              Workspace           Tools
        │                   │                   │
    Credentials       Session Tabs          File Manager
      Groups              Terminal           Monitoring
    Locations              SFTP              Snippets
        │                   │             Port Forward
        └───────────────────┼───────────────────┘
                            │
                     Globe & Flat Map
                            │
                       Your Servers
```

不管你手上是:

**VPS · Cloud VM · NAS · Home Server · Development Machine**

只要它能通过公网 SSH 访问,就可以加入 EdgeSSH。

---

## Cloudflare-native

EdgeSSH 不需要你另外部署一套 WebSSH Backend。

```text
Browser
│
│ HTTPS / WebSocket
▼
Cloudflare Worker
│
├── Authentication
├── Host Management
├── Encrypted Storage ──────→ D1
├── Static App / API
│
└── Session Ticket
        │
        ▼
Durable Object
│
│ Cloudflare TCP Socket
▼
SSH Server
```

SSH 握手、认证、密钥交换以及 Channel 通信,都在 Worker 一侧完成。

浏览器实际连接的是你的 EdgeSSH Worker,而不是直接跟目标服务器建立 TCP 连接。

多会话模式下,一个页面可以同时持有多个 Session Ticket:每一个都对应自己的 Durable Object 与自己的那条 SSH 连接。页面重载时 Worker 侧仍按保留窗口留着对应的 Durable Object,等同一个 shell 被接回来。

### 用到的 Cloudflare 能力

**Workers**

跑起 EdgeSSH 的应用、API 与 SSH 协议逻辑。

**Durable Objects**

给每个 SSH 会话一份独立的生命周期与 WebSocket 状态。

多会话下每个页面可以同时挂着多个 Durable Object;断开连接后,Durable Object 还会在保留窗口内继续持有那条 SSH 连接,等客户端回来接管同一个 shell。

**D1**

存放加密后的主机资料、管理员信息和代码片段。

**TCP Sockets**

从 Cloudflare 网络出发,建立到 SSH Server 的 TCP 连接。

---

## 认证

EdgeSSH 是一个 **Single-admin Workspace**。

它不是 SaaS 多租户系统,没有成员、组织,也没有角色权限。

目前支持两种登录方式:

<table>
<tr>

<td width="50%" valign="top">

### GitHub OAuth

适合想快速部署的用户。

用指定的 GitHub 账号,作为唯一的管理员身份。

**不需要 Cloudflare Zero Trust。**

</td>

<td width="50%" valign="top">

### Cloudflare Access

适合已经在用 Cloudflare Zero Trust 的用户。

可以用邮箱 OTP,也可以接入已有的 Identity Provider。

</td>

</tr>
</table>

两种方式二选一即可。

切换认证 Provider 不会新建一个用户工作区,也不会重新生成一份主机资料库。

---

## 安全设计

服务器管理工具天生要经手高权限凭据,所以 EdgeSSH 一直在尽量收窄默认的攻击面。

### 加密存储

主机密码、私钥以及相关敏感资料,都会用 **AES-256-GCM** 加密后再存进 D1。

浏览器不会长期保存 SSH 凭据。

### Host Key Verification

第一次连接服务器,必须确认 SSH Host Key Fingerprint。

指纹一旦发生变化,会再次要求你确认。

![EdgeSSH SSH 主机指纹确认](docs/images/showcase/08-host-key-verification.png)

### Single-admin

EdgeSSH 不开放注册,也没有多租户的数据隔离逻辑。

整个实例只属于一个管理员工作区。

### Session Isolation

每个 SSH 会话都由自己的 Durable Object 单独管理:终端缓冲、文件树、进程面板和凭据快照都在会话内部,多会话之间互不共享。

会话入口使用临时票据,辅助连接也会做身份检查。

浏览器本地只为「恢复」保存会话身份(目标、名称、后端会话 ID),**不保存任何凭据**;超过 24 小时的记录会自动丢弃。保留窗口结束后要重新接回 shell,就必须重新认证一次。

### SSRF Protection

连接目标必须解析到允许访问的公网地址,并且会在建立连接前检查解析结果。

---

### 信任边界

EdgeSSH **不是一个端到端加密的 SSH Gateway**。

Worker 本身就是真正的 SSH Client,建立连接时必然要处理 SSH 凭据和会话数据。

所以:

> **请只把 EdgeSSH 部署在你自己信任、自己掌控的 Cloudflare 账户里。**

同时建议给服务器上的 SSH 用户,配置刚好够用的最小权限。

---

## 快速部署

最推荐的方式是:

### 01 · Fork

把 EdgeSSH Fork 到你自己的 GitHub 账号下。

### 02 · 选择认证方式

GitHub OAuth:

```text
AUTH_PROVIDER=github          # Variable
GH_CLIENT_ID=<Client ID>      # Variable
GH_CLIENT_SECRET=<Secret>     # Secret
GH_ADMIN=<GitHub 用户名>      # Variable
```

首次部署请按 [GitHub OAuth 五步完整教程](DEPLOYMENT.md#github-模式准备)操作：创建的是 **OAuth App**，Client ID 放 Variable，Client Secret 放 Secret，回调必须是正式入口加 `/auth/callback`。无需 Zero Trust、Access 权限或额外 GitHub PAT。

**旧版点击登录报“服务暂时不可用”**：请同步含 2026-10-07 Base64 解码修复的代码，再对最新 `main` 运行 Deploy。保留原 Worker、D1 和 `ENCRYPTION_KEY`；不是靠扩大 Token 权限或换密钥解决。新版 Deploy 会自动检查 GitHub 登录入口与工作区状态。

或者 Cloudflare Access:

```text
AUTH_PROVIDER=cloudflare      # Variable,默认值
ADMIN_EMAIL=<管理员邮箱>       # Variable
```

从旧版升级时,请将 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_ADMIN`、`GITHUB_ADMIN_ID`
分别迁移为 `GH_CLIENT_ID`、`GH_CLIENT_SECRET`、`GH_ADMIN`、`GH_ADMIN_ID`。GitHub 保留 `GITHUB_`
前缀,旧名称无法作为 Actions Variable 或 Secret 使用。

### 03 · 添加 Cloudflare Token

无论选择哪种认证方式,都要在 GitHub Actions Secrets 里加入 `CLOUDFLARE_API_TOKEN`。

### 04 · Run workflow

运行 `Deploy` Workflow。

剩下的交给 EdgeSSH 自动完成:

**Worker → Durable Object → D1 → Migration → Secrets → Deployment**

不用你手动去复制:

```text
D1 Database ID
Access AUD
Team Domain
Random Encryption Key
```

<div align="center">

### [查看完整部署指南 →](https://edgessh-docs.pages.dev/deploy/actions)

认证配置、API Token 权限、自定义域名、Preview Worker、升级与迁移,都在文档站里有详细说明。

</div>

---

## 当前支持

| 能力 | 支持情况 |
| --- | --- |
| SSH | SSH 2.0 / Shell / PTY / Resize / Keepalive |
| SFTP | SFTP v3 |
| Password | ✅ |
| keyboard-interactive | ✅ 单密码提示 |
| Ed25519 | ✅ |
| RSA | ✅ |
| ECDSA | ✅ P-256 / P-384 / P-521 |
| File Manager | ✅ |
| Process Monitor | ✅ |
| OS Detection | ✅ |
| Code Snippets | ✅ |
| HTTP Port Forward | ✅ |
| Multiple Sessions | ✅ 选项卡管理,同一主机 3 条 / 全局 10 条 |
| Session Resume | ✅ 页面重载后接管原 shell(保留窗口默认 5 分钟) |
| Globe & Flat Map | ✅ 双形态,支持按大洲聚焦 |
| Encrypted Private Keys | ✅ OpenSSH 口令加密私钥(bcrypt KDF) |
| Multiple Admins | ❌ |
| SCP | ❌ |
| ProxyJump | ❌ |
| SSH Agent | ❌ |

单一管理员工作区,最多可以保存 **200 台主机**。

同时最多保持 **10 条 SSH 会话**,其中到同一台主机最多 **3 条**。

SFTP 单文件上传和下载的上限是 **64 MiB**。

---

## 端口转发安全

EdgeSSH 的 Port Forward 提供两种模式。

### Trusted

直接走 EdgeSSH 主 Worker。

适用于:

> **你自己开发、自己部署、自己信得过的网页。**

这种模式和 EdgeSSH 管理界面共享浏览器 Origin,所以不建议用来打开不可信的站点。

### Isolated

通过独立的 Preview Worker 提供页面。

适用于:

> **没法完全信任的远程 Web 应用。**

Preview Worker 和 EdgeSSH 主界面运行在不同的 Origin 上,能减少被代理页面反过来调用管理 API 的风险。

完整的安全模型、生命周期、Cookie 处理和当前的代理兼容范围,请看:

**[EdgeSSH 文档站 →](https://edgessh-docs.pages.dev/)**

---

## 本地开发

Requirements:

```text
Node.js >= 22.12
npm
Cloudflare Wrangler
```

Clone:

```bash
git clone https://github.com/aozorae/EdgeSSH.git
cd EdgeSSH

npm ci
cp .env.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev
```

前端开发:

```bash
npm run dev:web
```

### 常用命令

| Command | Description |
| --- | --- |
| `npm run dev` | Build frontend and start local Worker |
| `npm run dev:web` | Start Vite frontend |
| `npm run build:web` | Build frontend |
| `npm run typecheck` | TypeScript check |
| `npm test` | Run tests |
| `npm run test:browser` | Browser regression tests |
| `npm run showcase` | Regenerate privacy-safe README screenshots with local Chrome |
| `npm run check` | Full validation |
| `npm run deploy` | Deploy to Cloudflare |

---

## 项目结构

```text
EdgeSSH/
├── .github/workflows/    GitHub Actions deployment
├── frontend/             Web workspace
│   └── src/              Session tabs, globe & flat map, workspace UI
├── src/
│   ├── accounts/         Authentication & encrypted storage
│   ├── backend/          Sessions, session retention, SFTP & system detection
│   ├── ssh/              SSH protocol implementation
│   └── worker.ts         Worker entry
├── migrations/           D1 migrations
├── tests/                Tests
├── DEPLOYMENT.md         Deployment documentation
└── wrangler.toml         Cloudflare configuration
```

前端与多会话、地图相关的几个模块:

| 模块 | 职责 |
| --- | --- |
| `frontend/src/session-manager.ts` | 持有全部会话,决定谁绑定到共享终端 DOM |
| `frontend/src/session-context.ts` | 单个会话的状态容器:连接、终端、凭据快照 |
| `frontend/src/session-tabs.ts` | 选项卡条(纯视图,不含业务决策) |
| `frontend/src/session-store.ts` | 刷新后恢复用的会话身份存储 |
| `src/backend/session-retention.ts` | Worker 侧的会话保留策略 |
| `frontend/src/globe.ts` | 球体 / 平铺双形态与大洲聚焦 |
| `frontend/src/continents.ts` | 国家码到大洲的判定与视图范围 |

---

## 上游项目

EdgeSSH 基于:

### [Worker Web SSH / CF-Workers-WebSSH](https://github.com/cmliu/CF-Workers-WebSSH)

持续开发而来。

在原有的 Cloudflare WebSSH 能力之上,EdgeSSH 又加上了:

**Host Management · Encrypted Storage · File Manager · Monitoring · GitHub OAuth · Port Forwarding · Code Snippets · Multi-session Tabs · Session Resume · Globe & Flat Map · Continent Focus**

感谢原作者 **CM / cmliu** 打下的这份开源基础。

### 与上游单会话模式的差异

上游形态是「一个页面 = 一条 SSH 连接」。本版本做了架构级改动:

| | 上游(单会话) | 本版本(多会话) |
| --- | --- | --- |
| 连接状态 | 全局唯一的模块级变量 | 每个会话一份 `SessionContext`,由 `SessionManager` 调度 |
| 终端 DOM | 与连接一一绑定 | 多会话共享,只有前台会话被 attach |
| 切换主机 | 断开重连 | 切走但不断开,后台继续运行 |
| 刷新页面 | 会话丢失 | 保留窗口内可接管同一个 shell |
| 文件 / 进程 / 转发 | 全局单例 | 跟随当前会话 |
| 并发 | 1 条 | 同一主机 3 条 / 全局 10 条 |

**升级时 Worker 与前端需要一起部署**:会话保留能力在 Worker 侧(`src/backend/session-retention.ts`),只更新前端会让恢复静默失效、回落成重新连接。

---

## 特别致谢

特别感谢 [Linux.do 社区](https://linux.do/) 对 EdgeSSH 推广的支持，让 EdgeSSH 有机会在社区内发帖分享与交流。

---

## Contributing

欢迎提交:

**Issues · Bug Reports · Pull Requests · Documentation Improvements**

提交代码前,请先跑一遍:

```bash
npm run check
```

涉及 SSH、SFTP 或 Port Forward 的改动,请用你自己拥有授权的服务器来测试。

提交 Issue 时,有一件事拜托一定注意:

> **请不要上传密码、SSH 私钥、Access Token,或是包含敏感信息的日志。**

---

## Acknowledgements

- [cmliu/CF-Workers-WebSSH](https://github.com/cmliu/CF-Workers-WebSSH) — EdgeSSH 的直接上游
- [huashengdun/webssh](https://github.com/huashengdun/webssh) — WebSSH 与前端 API 参考
- [newbietan/CloudSSH](https://github.com/newbietan/CloudSSH) — Cloudflare Workers SSH 实现参考
- [crazypeace/huashengdun-webssh](https://github.com/crazypeace/huashengdun-webssh) — WebSSH 二次开发参考

---

## License

EdgeSSH is licensed under the [Apache License 2.0](LICENSE).

使用、修改与分发时,请保留适用的许可证与版权声明。

---

<div align="center">

<p><strong>EdgeSSH · 你的个人 WebSSH 工作台</strong></p>

<p>SSH infrastructure doesn't need another server to manage it.</p>

**Your servers · Your credentials · Your Cloudflare · Your workspace**

<br />

**[Deploy EdgeSSH →](https://edgessh-docs.pages.dev/deploy/actions)** · [📚 完整文档](https://edgessh-docs.pages.dev/)

</div>
