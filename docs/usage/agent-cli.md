---
description: 安装 EdgeSSH Agent CLI，通过 Cloudflare Access 登录，让本地 AI Agent 安全地执行远端命令、传输文件并完成多步骤任务。
---

# Agent CLI

EdgeSSH CLI 让本地 AI Agent 通过现有 EdgeSSH 工作区执行 SSH 命令和 SFTP 文件操作，复用网页已保存的主机与凭据。CLI 不内置 AI，也不是 MCP Server；Codex、Claude Code 等能执行本地命令的 Agent 可以直接调用它。

## 使用前准备

| 条件 | 要求 |
| --- | --- |
| EdgeSSH 服务端 | 基础 CLI 协议已合并 main；2 GiB 上传需部署[大文件上传版本（PR #14）](https://github.com/aozorae/EdgeSSH/pull/14) |
| 登录方式 | **Cloudflare Access**；暂不支持 EdgeSSH 的 GitHub OAuth 登录 |
| 本地运行时 | Node.js 22.12 或更新版本，npm 随 Node.js 安装 |
| Access 客户端 | 官方 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)，安装后能在终端运行 `cloudflared --version` |
| 主机 | 已在网页保存可用的 SSH 主机和凭据，并核实主机指纹 |

::: warning 权限与授权
CLI 与网页进入同一个管理员工作区，拥有相同的远端权限，不是只读沙箱。先约定允许操作的主机、目录和命令范围；覆盖文件、修改配置、重启服务和删除数据前需获得相应授权并做好备份。
:::

网站左侧的 **Agent CLI** 页面提供当前站点专属的登录命令、可复制的 Agent 指令及本页链接。接入时使用你自己的站点，不要照搬他人的域名。

## 安装与认证

### 1. 安装 npm 包

官方包为 [@aozorae/edgessh](https://www.npmjs.com/package/@aozorae/edgessh)，安装后命令名为 `edgessh`。

```sh
npm install --global @aozorae/edgessh
```

不希望全局安装时，用 `npx --yes @aozorae/edgessh <命令>` 替代 `edgessh <命令>`。仍然需要本机安装 Node.js 和 cloudflared。

### 2. 由用户完成 Access 登录

将下列域名换成你的 EdgeSSH 正式入口，只填写 origin，不加路径、查询参数或令牌：

```sh
edgessh login --url https://ssh.example.com
edgessh status
edgessh hosts
```

`login` 调用 `cloudflared access login`，打开系统默认浏览器。用户完成与网页相同的 Access 验证后，cloudflared 接收并缓存应用令牌。浏览器已有登录状态不等于 CLI 已认证，仍需执行这一步。

后续普通命令使用缓存令牌，不弹浏览器、不自动重新登录、不自动重试远端命令。认证过期时由用户重新执行 `login`。无需 Service Token、Access Bypass 或额外回调服务，也不要复制浏览器 Cookie 或把令牌贴进 Agent 对话。

`status` 返回当前站点、登录身份与 provider；`hosts` 返回主机元数据，不输出密码或私钥。两者成功后即可接入 Agent。

### 3. 加入 Agent 项目指令

将下面的站点替换为实际入口，再加入 Agent 的项目指令文件或当前任务约定：

```text
通过 EdgeSSH CLI 访问 https://ssh.example.com 的工作区。
先执行 edgessh hosts 获取主机 ID；使用 edgessh exec HOST_ID --json -- 'command' 执行远端命令。
用 edgessh ls/get/put 处理文件，按需缩小输出并检查退出码。
认证失效时请用户手动运行 edgessh login --url https://ssh.example.com，不自动重新登录。
未知或变化的主机指纹交给用户核实，不自行使用 --accept-new。
不读取、展示或复制本地 Access 令牌及 SSH 私钥。
只修改已授权的路径，覆盖前备份，修改后核验，结束后清理本次测试文件。
不要自动重试远端命令；失败后先核对实际状态，避免重复写入或重复执行。
```

CLI 在执行它的同一台机器上运行；远端或云端 Agent 不能直接使用你本机的 cloudflared 缓存。需要在该执行环境单独配置并认证，不能把个人令牌提交到仓库。

## 常用操作

主机参数可用完整 ID 或唯一名称；同名主机必须用 ID。以下 `HOST_ID` 均需替换。路径有空格时使用引号。

### 命令执行与结构化结果

```sh
edgessh exec HOST_ID --json -- 'uname -a; df -h'
edgessh exec HOST_ID --json --timeout 120 --max-output 2097152 -- 'tail -n 200 /var/log/app.log'
```

`--` 后是**一个完整命令参数**，按远端用户默认 Shell 解释，不在本地执行。每次 `exec` 都是新的 SSH 连接，不保留上次的 `cd`、变量或 Shell 状态。依赖同一上下文的步骤放进同一个命令，例如 `cd /opt/app && ./check.sh`。

`exec` 不申请 PTY，stdin 立即 EOF，适合 Agent 非交互调用。命令必须为单行，UTF-8 编码后最多 4096 字节，不接受 NUL、回车或换行；多行或较长的脚本先通过 `put` 上传，再执行脚本文件。不适用于需要输入密码、确认或持续从 stdin 读取内容的程序。交互式 `edgessh connect HOST_ID` 仅供用户在真实终端使用，`Ctrl+]` 退出。

```json
{"stdout":"Linux\n","stderr":"","exitCode":0,"signal":null}
```

- CLI 进程退出码跟随远端命令（0..255）；缺失 SSH 退出码或收到远端信号时返回 255。
- CLI、认证、超时和输出上限错误返回 1；`--json` 时 stderr 为 `{"error":"..."}`。
- `--json` 需要等命令结束后输出完整结果；不用 `--json` 时 stdout/stderr 流式输出。
- SIGINT/SIGTERM 返回 130/143，并关闭本地连接。

### 文件管理

```sh
edgessh ls HOST_ID /var/log
edgessh get HOST_ID /var/log/app.log ./app.log
edgessh mkdir HOST_ID /tmp/my-agent-task
edgessh put HOST_ID ./config.json /tmp/my-agent-task/config.json
edgessh mv HOST_ID /tmp/my-agent-task/config.json /tmp/my-agent-task/config.saved.json
edgessh rm HOST_ID /tmp/my-agent-task/config.saved.json
edgessh rmdir HOST_ID /tmp/my-agent-task
```

每次 `get/put` 传输一个文件，不是目录同步工具。文件操作结果为 JSON。`rmdir` 只删除空目录，`mv` 不覆盖已存在的目标。

上传与下载**默认拒绝覆盖**。确认目标内容已备份后，显式传 `--force` 才覆盖：

```sh
edgessh put HOST_ID ./config.json /tmp/my-agent-task/config.json --force
edgessh get HOST_ID /tmp/my-agent-task/config.json ./config.json --force
```

覆盖上传使用隐藏临时文件和 OpenSSH `posix-rename@openssh.com` v1 原子落位；服务器不支持时拒绝覆盖并保留原文件，不先删除目标。下载完成并核对长度后才落到目标文件，失败清理本地 `.part` 文件。

### 大文件上传

CLI **0.2.0+** 和更新后的网页都支持单文件 **2 GiB** 上传；服务端也需更新到配套版本。旧 CLI 0.1.0 仍限制 64 MiB，新 CLI 的长传输期限不兼容旧服务端。先更新服务端，再升级 CLI：

```sh
npm install --global @aozorae/edgessh
edgessh put HOST_ID ./backup.tar /tmp/backup.tar
edgessh put HOST_ID ./backup.tar /tmp/backup.tar --timeout 86400
```

网页端在文件管理中选择目标目录后上传即可，无需把文件整体载入内存。两端都按 64 KiB 分块，最多 8 块（512 KiB）在途；进度以远端确认写入的字节为准，全部确认后才提交。

`get/put` 默认时限为 **6 小时**，可用 `--timeout` 调到最多 **24 小时**，包含认证与建连时间。网页上传请保持页面、连接和设备运行；关闭页面、休眠或断网可能中断传输。**暂不支持断点续传或自动重试**，中断后先检查远端是否有半文件或覆盖上传的临时文件，再决定清理或重新上传。下载上限仍为 **64 MiB**，与上传上限不同。

2 GiB 是应用的单文件限制，不绕过远端磁盘、权限及 SSH 策略；当前 SSH 会话不支持 rekey，服务端主动要求重新密钥交换时仍可能中断，需重新连接。

## 多步骤任务示例

以下是给 Agent 的任务约定示例，不会自动执行，也不代表 CLI 自带发布事务或回滚引擎：

```text
在已授权主机的 /tmp 下创建本次唯一测试目录，不改现有服务。
1. 先只读检查可用工具、空间与权限。
2. 上传脚本、配置和样例文件，逐个校验 SHA-256。
3. 用 exec 在该目录运行检查脚本，验证 stdout、stderr 和退出码。
4. 备份配置，上传新配置，再验证；若校验失败，显式恢复备份并复验。
5. 将本次产物归档，通过 get 下载，在本地验证归档内容与哈希。
6. 删除本次独立目录与临时文件，确认路径已不存在，汇报结果。
中途出现超时或网络错误时先检查远端实际状态，不自动重放写操作。
```

建议使用 `set -eu`、`&&` 和明确的工作目录组织 POSIX Shell 任务。不要把不可信内容直接拼入命令；复杂数据先上传文件，再由远端脚本按结构化格式读取。PowerShell 与 POSIX Shell 的本地变量/引号规则不同，复杂脚本优先用文件传输。

## 指纹、凭据与本地状态

CLI 按“显式 `--fingerprint` → 本地已保存指纹 → 网页保存指纹”选择预期值。首次未知指纹会报错并给出实际值，应通过可信渠道核对后再执行：

```sh
edgessh exec HOST_ID --fingerprint 'SHA256:替换为已核实的指纹' --json -- 'uname -a'
```

`--accept-new` 仅用于用户明确选择首次信任，不接受已知指纹变化，Agent 不应自行开启。主机指纹变化需重新核实，不能以“让命令成功”为由跳过验证。

支持网页保存的密码、OpenSSH 私钥与密钥链引用。主机凭据仍经 Worker 解密并用于 SSH 认证，不落 CLI 配置；这不是端到端加密，安全边界见[架构与安全边界](../reference/security)。

配置默认在 `$XDG_CONFIG_HOME/edgessh/config.json`，未设置时为 `~/.config/edgessh/config.json`，仅保存站点和主机指纹；可用 `EDGESSH_CONFIG` 指定独立配置。Access JWT 由 cloudflared 缓存，不保存在该配置中。

`edgessh logout` 仅清理 CLI 的站点和指纹配置，**不删除 cloudflared 共享缓存，也不撤销已签发令牌**。需要立即撤销时，使用 Cloudflare Access 会话撤销，或网页的退出功能（会撤销整个 EdgeSSH 工作区会话）。

## 限制与资源

| 项目 | 行为 |
| --- | --- |
| 认证 | 当前仅 Cloudflare Access；不支持 GitHub OAuth |
| 时限 | exec 默认 60 秒，交互/其他默认 600 秒，最多 600 秒；get/put 默认 21600 秒，最多 86400 秒 |
| 命令长度 | 单行且 UTF-8 最多 4096 字节；较长或多行脚本先上传再执行 |
| 命令输出 | 默认 1 MiB；`--max-output` 最多 16 MiB，超限报错而非成功截断 |
| 文件大小 | 上传最多 2 GiB，下载最多 64 MiB；64 KiB 分块，上传最多 512 KiB 在途；无批量同步或断点续传 |
| 连接 | 每个操作建立独立 SSH，SFTP 复用该连接；成功/失败后释放 |
| 后台任务 | 断开 SSH 不保证终止 `nohup`、systemd 等脱离会话的进程 |
| 使用成本 | CLI 不调用模型 API；SSH 握手、加密、流量及 DO 仍消耗 Cloudflare 资源 |

## 常见问题

### 提示 cloudflared 不存在

安装[官方客户端](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)，确认它在 Agent 进程的 PATH 中。新装后可能需要重新打开终端或 Agent。

### 网页能登录，但 CLI 认证失败

确认使用同一正式 origin、服务端为 Cloudflare Access，并手动执行 `edgessh login --url ...`。Access 应用需覆盖整个域名及 `/api/*` 和 WebSocket；不要为修复 CLI 而放开 Bypass。GitHub OAuth 站点当前无法使用 CLI。

### 使用代理时 HTTP 成功、WebSocket 失败

使用 Node.js 24.5+，显式启用 Node 环境代理支持，HTTP 和 WebSocket 会共同使用全局 Agent。代理必须可信，按需配置 `NO_PROXY`。

::: code-group
```sh [POSIX Shell]
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
export NODE_USE_ENV_PROXY=1
edgessh status
```

```powershell [PowerShell]
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:NODE_USE_ENV_PROXY = '1'
edgessh status
```
:::

### 超时或输出超限

用 `tail/head` 缩小输出，或在限制内提高 `--timeout/--max-output`。操作失败后核对文件、进程和命令的实际状态；连接被关闭不代表远端副作用已回滚。

## 开发者生产验收

最新应用源码提供显式运行的复杂场景测试，不在普通单测中连接真实主机：

```sh
npm run test:cli:production -- --origin https://ssh.example.com --host HOST_ID
```

需先完成该执行环境的 Access 登录与指纹核实。目标应有 `python3`、`tar`、`sha256sum` 及可写 `/tmp`；本地需 `tar`。可重复指定 `--host` 测试多台主机，用 `--cli /path/to/bin.mjs` 指向已安装 npm 包的入口。

测试会在每台主机创建唯一 `/tmp/edgessh-agent-scenario-UUID` 目录，验证多文件发布、二进制往返、特殊路径、配置更新与回滚、并发命令、归档还原及失败处理，最后清理并确认目录不存在。它不会修改现有服务或主机记录，但会消耗 SSH/Cloudflare 资源。只在已获授权的主机执行；如输出 `CLEANUP REQUIRED`，按提示的精确路径核查，不能将测试视为已完成清理。
