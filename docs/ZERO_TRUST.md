# 登录方式配置指南

本页保留旧文档地址，配置说明已统一到部署章节：

- [GitHub Actions 完整部署流程](/deploy/actions)：`AUTH_PROVIDER=cloudflare|github` 二选一。
- [Cloudflare Zero Trust Access](/deploy/zero-trust)：仅 Cloudflare 模式；应用、OTP 与邮箱策略可由 Action 自动配置。
- [原生 GitHub OAuth](/deploy/github-oauth)：无需 Zero Trust，直接通过 GitHub 验证唯一管理员。
- [切换登录方式](/deploy/switch-login)：沿用同一份主机资料和加密密钥，不维护两套账号绑定。
- [Worker Secret](/deploy/runtime-secrets)：自动生成、持久化与灾备规则。

完整部署流程优先推荐配置 `CUSTOM_DOMAIN`；没有自定义域名时仍可使用 `workers.dev`。不要再按旧教程要求手工复制 Team Domain/AUD 或准备所有模式的 Secret。
