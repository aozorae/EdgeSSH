# 原生 GitHub OAuth 登录

选择 `AUTH_PROVIDER=github` 后，EdgeSSH 直接与 GitHub 完成 OAuth；**不经过 Cloudflare Access，不要求启用 Zero Trust**。应用本身仍部署到 Cloudflare Workers。

## 1. 创建 OAuth App

在 GitHub 个人设置中进入：

```text
设置（Settings）→ 开发者设置（Developer settings）→ OAuth 应用（OAuth Apps）→ 新建 OAuth 应用（New OAuth App）
```

填写：

| 字段 | 示例 |
| --- | --- |
| 应用名称（Application name） | `My EdgeSSH` |
| 主页 URL（Homepage URL） | `https://ssh.example.com` |
| 授权回调 URL（Authorization callback URL） | `https://ssh.example.com/auth/callback` |

这里优先使用 `CUSTOM_DOMAIN` 对应的正式入口。协议、hostname 和路径必须与实际入口一致，不要只填首页；使用 `workers.dev` 时再换成部署摘要给出的地址。

::: tip 首次还不知道访问地址？
可以先为 OAuth App 使用占位 URL，填好 Client ID/Secret 后运行 Action。部署摘要会给出正式入口与回调地址，复制回 OAuth App 设置后再登录。默认 Worker 名为 `edgessh`，设置 `WORKER_NAME` 时地址也会改变。
:::

OAuth App 需用户在 GitHub 创建；普通 GitHub Token 没有官方创建 OAuth App 的 REST 接口。工作流不会索要账号密码来代建。

## 2. 保存 Client ID 和 Secret

在 OAuth App 页面复制 **客户端 ID（Client ID）**，点击 **生成新的客户端密钥（Generate a new client secret）**。然后进入 Fork 仓库 **设置（Settings）→ 机密和变量（Secrets and variables）→ Actions**：

| 名称 | 位置 | 填什么 |
| --- | --- | --- |
| `AUTH_PROVIDER` | Variables | `github` |
| `CUSTOM_DOMAIN` | Variables | 推荐填正式主机名，如 `ssh.example.com`；使用 `workers.dev` 时留空 |
| `GITHUB_CLIENT_ID` | Variables | 刚创建的 OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | Secrets | 同一 OAuth App 的 Client Secret |
| `GITHUB_ADMIN` | Variables | 你允许登录的个人 GitHub 用户名 |
| `CLOUDFLARE_API_TOKEN` | Secrets | Workers/D1 部署 Token，不要求 Access 权限 |

`GITHUB_ADMIN` 不是邮箱、组织名或 Client ID。例如 GitHub 个人主页为 `github.com/example-user`，就填 `example-user`。只有这个管理员可以进入实例，不是任何 GitHub 用户都能登录。

## 3. 运行与登录

运行 **Actions → Deploy → 运行工作流（Run workflow）**，管理员邮箱框留空。Action 会解析管理员数字 ID、部署应用并输出回调地址。

打开 EdgeSSH，点击右上角 **登录**，在 GitHub 确认授权。成功后回到主机总览。登录只使用公开身份，不申请仓库、组织或私人邮箱权限。

GitHub 模式只接受自身的签名会话，不接受 Access 请求头或 Cookie；Cloudflare 模式反过来也不会接受 GitHub 会话。

## 会话与退出

- state 绑定当前浏览器，PKCE 使用 S256。
- 会话 Cookie 使用 Secure、HttpOnly、SameSite=Lax，有效期 8 小时。
- 退出会清除本浏览器的 EdgeSSH Cookie，不会退出 GitHub 网站账号。
- GitHub access token 仅用于本次身份核验，不持久保存。
- Client Secret 更新后，在 Actions 更新同名 Secret 并重跑部署。

## 常见问题

- **回调地址错误**：将 Action 摘要的完整回调地址原样填回 OAuth App。
- **不是管理员**：确认登录的是 `GITHUB_ADMIN` 指定的个人账号；更改 GitHub 用户名后也要更新 Actions 配置。
- **仍弹 Cloudflare Access**：这是旧域名的网关保护，先按[切换登录方式](/deploy/switch-login)解除，不要叠加两层登录。
- **登录取消、过期或失败**：回到首页重新点击登录，不重复打开旧 callback 链接，不分享包含 code/state 的 URL。
