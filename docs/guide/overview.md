# 认识 EdgeSSH

EdgeSSH 是运行在 Cloudflare Workers 上的个人 SSH 工作台。部署完成后，你可以从浏览器管理主机、打开交互终端、使用 SFTP 管理文件，并查看远端进程与系统资源。

## 它解决什么问题

传统 WebSSH 通常还要维护一台中转服务器。EdgeSSH 把前端静态资源、身份校验、主机资料和 SSH 客户端放在 Cloudflare 边缘运行：

```text
浏览器
  ├─ 主机总览与地球视图
  ├─ xterm.js 交互终端
  ├─ SFTP 文件管理
  └─ 进程与系统信息
        │ HTTPS / WebSocket
        ▼
所选登录方式 → Worker → Durable Object → TCP Socket → SSH 服务器
                         │
                         └─ D1：单管理员的加密主机资料
```

浏览器不会直接连接 SSH 服务器。每个连接会话由 Durable Object 隔离，Worker 通过 Cloudflare TCP Sockets 连接目标的公网 SSH 端口。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 主机管理 | 保存地址、端口、用户名、分组和认证信息；支持搜索、编辑与删除 |
| 地球视图 | 根据公网 IP 显示主机位置；位置不代表在线状态 |
| 浏览器终端 | 交互式 Shell、窗口尺寸同步、全屏、会话日志与多种终端编码 |
| SFTP | 浏览目录、上传、下载、新建目录、重命名与删除空目录 |
| 进程面板 | 查看 CPU、负载、内存、Swap 与进程列表 |
| 系统识别 | 通过 SSH 探测操作系统、版本与架构 |

## 凭据怎样保存

主机资料通过 AES-256-GCM 加密后写入 D1。密文绑定固定管理员 ID 与记录 ID，切换 Access/GitHub 不改变归属；列表接口不会返回密码或私钥，建立连接时才解密。

::: warning 这不是端到端加密
Worker 是实际的 SSH 客户端，会在会话内处理明文凭据。只把 EdgeSSH 部署到你信任的 Cloudflare 账户，并为 SSH 使用最小权限账号或密钥。
:::

## 推荐阅读顺序

1. 阅读[部署前准备](/guide/requirements)，确认账户、域名和目标服务器都满足条件。
2. 按[GitHub Actions 完整部署流程](/deploy/actions)完成首次发布。
3. 按[部署后验收](/deploy/verification)检查 Access、主机 API 和真实 SSH 连接。
4. 使用前阅读[支持范围与限制](/reference/limits)，避免把未支持的认证方式当作配置问题。
