# EdgeSSH CLI

让 Codex 等本地 Agent 复用 EdgeSSH 的主机、凭据和 SSH/SFTP 通道。需要 Node.js 22.12+，Access 登录另需官方 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)。

## 安装与登录

服务端须先部署包含 CLI 协议的版本（当前为 [PR #10](https://github.com/aozorae/EdgeSSH/pull/10)），再在本机执行：

```sh
npm install --global @aozorae/edgessh
edgessh login --url https://ssh.example.com
edgessh hosts
```

不全局安装时，用 `npx --yes @aozorae/edgessh <命令>` 替代 `edgessh <命令>`。源码开发仍可在仓库根目录执行 `npm --prefix cli ci` 后用 `node cli/bin.mjs`，或执行 `npm install --global ./cli` 从本地安装。

`login` 调用 `cloudflared access login`，自动打开系统浏览器。用户完成原来的 Access 登录后，cloudflared 安全接收并缓存应用令牌。后续命令通过 `cloudflared access token` 获取缓存令牌，同时携带同源 `Origin`、Access header/cookie 访问现有接口。令牌不会输出到 CLI 的标准输出，也不会复制到 CLI 配置。

这是 Access 的官方用户登录流程：[Cloudflare 文档](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)。不需要 Service Token、额外回调服务或 Access Bypass。Access 应用应覆盖 EdgeSSH 整个域名，保护 `/api/*` 和 WebSocket。当前版本支持 `AUTH_PROVIDER=cloudflare`，不支持 EdgeSSH 的 GitHub OAuth 登录模式。

令牌到期时命令直接报错，用户重新执行 `edgessh login`。Agent 调用普通命令不会自动弹浏览器、重试登录或重复执行远端命令。

需要 HTTP(S) 环境代理时，使用 Node.js 24.5+，设置 `HTTPS_PROXY`（以及按需设置 `HTTP_PROXY`、`NO_PROXY`），再启用 `NODE_USE_ENV_PROXY=1`。也可从源码运行 `node --use-env-proxy cli/bin.mjs <命令>`；HTTP 和 WebSocket 均沿用 Node 全局代理，不会自行改变系统网络配置。只使用可信代理。

## 常用命令

主机参数可以是完整 ID 或唯一的主机名；重名时必须使用 ID。

```sh
edgessh hosts
edgessh status
edgessh exec "日本服务器" --json -- 'uname -a; df -h'
edgessh exec "日本服务器" -- 'systemctl status nginx'
edgessh connect "日本服务器"
edgessh ls "日本服务器" /var/log
edgessh get "日本服务器" /var/log/nginx/error.log ./error.log
edgessh put "日本服务器" ./config.json /opt/app/config.json --force
edgessh mkdir "日本服务器" /opt/app/new-directory
edgessh mv "日本服务器" /tmp/old.txt /tmp/new.txt
edgessh rm "日本服务器" /tmp/new.txt
edgessh rmdir "日本服务器" /opt/app/new-directory
```

`exec` 的命令是一个完整参数；在 Shell 中用引号包裹，用 `--` 隔开 CLI 选项。按 SSH 服务器默认 Shell 解释，不在本地执行。`exec` 不申请 PTY，stdin 立即 EOF，适合一次性 Agent 调用；需要多条依赖当前目录或变量的命令时放在同一次调用内。`connect` 提供前台交互终端，`Ctrl+]` 退出，`Ctrl+C` 发送给远端。它只在交互式终端中可用。

`--json` 的执行结果示例：

```json
{"stdout":"Linux\n","stderr":"","exitCode":0,"signal":null}
```

CLI 进程退出码跟随远端命令（0..255）；SSH 未提供退出码、收到退出信号或超出该范围时进程返回 255。JSON 中保留远端数值以供诊断。CLI/认证/超时/输出限制错误返回 1，错误写到 stderr；`--json` 时 stderr 为 `{"error":"..."}`。SIGINT/SIGTERM 返回 130/143。主机列表、文件列表和文件操作结果始终是 JSON。

## 主机指纹和本地状态

CLI 优先使用显式 `--fingerprint`、本地保存的指纹、网页已保存的指纹。首次未知指纹会报错并显示实际指纹；核对后指定：

```sh
edgessh exec "日本服务器" --fingerprint 'SHA256:这里替换为核实后的指纹' -- 'uname -a'
```

也可以明确选择首次信任：

```sh
edgessh exec "日本服务器" --accept-new -- 'uname -a'
```

接受后会保存指纹；`--accept-new` 不接受已知主机的指纹变化。已知指纹变化需要先核实，再显式传入新指纹。支持网页保存的密码、OpenSSH 私钥和密钥链引用，沿用现有凭据解密和 SSH 认证逻辑；不会在主机列表中输出秘密，也不会把 SSH 凭据写入本地。

CLI 配置默认位于 `$XDG_CONFIG_HOME/edgessh/config.json`，未设置时为 `~/.config/edgessh/config.json`，仅保存站点和主机指纹，文件权限为 0600（Unix）。可用 `EDGESSH_CONFIG` 指定路径。

`edgessh logout` 清除 CLI 站点和指纹配置，**不删除 cloudflared 的共享令牌缓存，也不撤销已签发的 Access 令牌**。需要立即撤销时使用 Access 管理端的会话撤销功能，或网页原有的退出功能（会撤销整个工作区会话）。

自动化环境可通过 `EDGESSH_ACCESS_TOKEN` 注入有效的用户 Access JWT；它只在进程内使用。CLI 和网页进入同一个管理员工作区，拥有相同的远端权限。

## 资源消耗与连接释放

- CLI 是本地程序，不调用模型 API，不常驻、不轮询主机、不自动重连。
- `hosts` 只调用现有主机列表 API，不建立 SSH 连接。该接口原有的缺失地理信息回填逻辑保持不变。
- 一次远端操作通常调用主机列表、凭据读取、会话票据三个 HTTP 接口，再创建一个 SSH WebSocket / Durable Object。SFTP 在同一 SSH TCP 连接上附加一个文件 WebSocket 和 SFTP 子通道。
- `exec` 和 SFTP 模式不打开 PTY、Shell、系统信息探测或进程监控。交互式 `connect` 沿用网页终端行为。
- 成功、错误、超时、SIGINT/SIGTERM 都会关闭本地 WebSocket，复用 Durable Object 原有的关闭清理释放 SSH TCP。SSH 命令结束也会主动关闭服务端会话。
- `exec` 默认最长 60 秒；文件和交互连接默认最长 600 秒。`--timeout 1..600` 可调整。服务端同样执行会话期限，客户端强制退出或断网时也有最长存活边界。SSH 的握手、加密、传输依然消耗 Workers/DO 资源；大文件、密集命令和长期交互不会免费。
- CLI 默认最多接收 1 MiB 命令输出，`--max-output` 可调整到 16 MiB；服务端另有 16 MiB 硬上限。超限会报错并断开，不把截断结果标成成功。Agent 应优先用 `tail`、`head` 等缩小输出。
- 文件沿用现有单文件 64 MiB 限制，流式处理、上传逐块确认。下载成功后才原子落到目标路径，失败删除 `.part` 临时文件。上传下载默认拒绝覆盖，显式 `--force` 才允许。

上传覆盖要求服务器支持 `posix-rename@openssh.com` v1（OpenSSH 支持）。不支持时会报错并清理上传临时文件，保留原目标，不会先删除原文件。

这些上限限制 EdgeSSH 连接的存活时间，不保证终止远端通过 `nohup`、`systemd` 或其他方式脱离 SSH 的进程。此类远端任务由用户通过后续命令管理。

## 给 Agent 的使用约定

在 Agent 项目指令中加入：

> 通过 `edgessh hosts` 获取主机 ID，使用 `edgessh exec <id> --json -- '<command>'` 执行命令，使用 `ls/get/put` 处理文件。先缩小输出范围，按需查询。认证失效时提示用户手动执行 `edgessh login --url <site>`。未知指纹交给用户确认，不自行使用 `--accept-new`。不要读取或展示本地 Access 令牌。修改和删除远端内容遵循用户当前授权范围。

CLI 本身不带 MCP Server，也不内置 AI。Agent 使用它已有的本地命令执行工具调用即可。

## 开发与测试

```sh
npm ci
npm --prefix cli ci
npm run typecheck
npm test
npm run test:cli
npm run test:cli:ssh
npm run build:web
npx wrangler deploy --dry-run
```

`test:cli:ssh` 在 Unix 上使用临时密钥、独立的 ssh2 SSH/SFTP 服务器与真实 EdgeSSH `SSHSession`，验证命令输出/退出码、二进制文件往返、覆盖保护、指纹、超时、SIGTERM、输出上限和 TCP 释放。需要系统有 `ssh-keygen`，不需要 root。HTTP/Access 网关在测试中模拟；实际域名上的 Cloudflare Access 浏览器登录仍需部署后人工验收。

生产仅新增 `ws` 一个 CLI 依赖；`ssh2` 只用于开发测试，不进入 Worker 或 CLI 生产安装。后端只扩展现有 `connect` 消息的 `mode: exec|sftp`、`command`、`timeoutMs` 与 `exec_output`/`exec_result` 响应，不新增 D1 表或 API 路由；网页原有连接消息继续兼容。
