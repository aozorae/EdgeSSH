# 切换登录方式，资料不用搬家

EdgeSSH 设计为**一个管理员、一份主机库**。Cloudflare 与 GitHub 是两种可替换的身份验证入口，不是两个独立账号系统。

## 常规切换

1. 修改 Actions Variable `AUTH_PROVIDER` 为 `cloudflare` 或 `github`。
2. 填好目标方式对应的变量与 Secret。
3. 保持 Worker、D1 与加密密钥不变，运行 Deploy。
4. 用新的方式登录，核对原主机列表与凭据。

不需要绑定两个账号、修改主机记录或重加密。Action 会读取旧库的唯一资料所有者并沿用其 ID；新库使用固定 `admin`。如果旧库实际有多个所有者，部署会停止，要求先明确归属，不会擅自合并。

## Cloudflare → GitHub 的域名网关

只改 Worker 内的登录变量，无法取消已经部署在域名前面的 Access 网关。

若入口原先有 Access 应用，请先在 Zero Trust 控制台解除**这个入口 hostname** 的 Access 保护，再运行 GitHub 模式部署。不要删除 Worker、D1 或 `ENCRYPTION_KEY`。解除网关后，在新版本发布前，旧 Worker 的受保护 API 仍要求有效 Access JWT，不会降级为匿名 SSH；建议在维护窗口执行切换。

部署脚本发现入口仍跳转 Access 时会停止，并提示解除旧保护。它不会自动删除用户的安全策略，更不会保留一个必须“先 Access、再 GitHub”的双重登录流程。

## GitHub → Cloudflare

先启用 Zero Trust，准备带 Access/IdP 权限的 Token 和 `ADMIN_EMAIL`，再把模式改为 `cloudflare`。Action 创建或复用 Access 应用并部署。旧 GitHub Cookie 不再被接受。

## 什么会保留

- 同一个 D1 和所有已有主机。
- 同一个资料所有者 ID，以及密文使用的 AAD。
- 同一个 `ENCRYPTION_KEY`。

旧方式的 Worker Secret 可以暂时保留，但代码只读取当前方式的认证凭据，它们不是第二套有效授权状态。

不要通过改数据库名、更换 Worker 或生成新密钥来“切换登录”，这些操作会改变存储边界，而不是仅更换登录方式。
