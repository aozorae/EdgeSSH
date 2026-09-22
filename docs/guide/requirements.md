# 部署前准备

## 两种方式都需要

- GitHub 账户，用于 Fork 仓库与运行 Actions。
- 能使用 Workers、Durable Objects 与 D1 的 Cloudflare 账户和部署 API Token。
- 一台你有权访问的公网 SSH 服务器。

应用部署不要求 Cloudflare Pages，也不要求自定义域名。默认使用账户的 `workers.dev` 地址；仅当选择 `CUSTOM_DOMAIN` 时，才需要同账户管理的域名和对应 Zone 权限。

## 按登录方式额外准备

| 选择 | 额外准备 | 不需要 |
| --- | --- | --- |
| `AUTH_PROVIDER=cloudflare` | 已启用 Zero Trust；管理员邮箱；Token 的 Access/IdP 权限 | GitHub OAuth App |
| `AUTH_PROVIDER=github` | GitHub OAuth App 的 Client ID、Client Secret；管理员 GitHub 用户名 | Zero Trust、Team Domain、AUD、OTP |

不想开通 Zero Trust 的用户可选择 GitHub 登录。它绕开的是 Zero Trust 的开户流程，不代表绕过 Cloudflare Workers 自身的账户要求、配额或收费规则。

::: tip 不需要在本机部署
只使用 Actions 时无需安装 Node.js。开发时才需要 Node.js 22.12.0 或更高版本。
:::

## SSH 目标

主机必须解析到公网 IP；私有、回环、链路本地地址不允许。准备低权限 SSH 测试账号、受支持的密码或未加密 OpenSSH 私钥，并从可信渠道确认服务器指纹。

## 不需要提前做

- 不必创建 D1 或手写数据库 ID，Action 会创建或复用。
- 不必生成加密密钥，首次部署自动生成，后续保留。
- Cloudflare 模式不必手工创建 Access 应用/OTP、复制 Team Domain/AUD。
- 不要把 Secret 写入源码、Variable、截图或 Issue。

下一步：[GitHub Actions 完整部署流程](/deploy/actions)。
