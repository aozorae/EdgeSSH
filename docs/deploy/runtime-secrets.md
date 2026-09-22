# Worker 运行时 Secret

普通用户只需在 Actions 保存 Cloudflare API Token，以及 GitHub 模式所需的 OAuth Client Secret。运行时其余机密由 Action 自动管理，**不用复制回 GitHub，也不用在 Worker 控制台重复填写**。

| Secret | 适用模式 | 来源 |
| --- | --- | --- |
| `ENCRYPTION_KEY` | 两种模式 | 首次安全随机生成；后续保留原值 |
| `ACCESS_TEAM_DOMAIN` | Cloudflare | 自动读取 Zero Trust 组织 |
| `ACCESS_AUD` | Cloudflare | 自动读取对应 Access 应用 |
| `GITHUB_CLIENT_SECRET` | GitHub | 从 GitHub Actions 同名 Secret 同步 |

Secret 只通过标准输入交给 Wrangler，不写入文件、命令行参数或构建 artifact。部署后核对当前模式必需的 Secret 名称，而不是要求两种模式的 Secret 同时存在。

## 加密密钥不能随着登录方式切换

`ENCRYPTION_KEY` 用于 AES-256-GCM 加密主机资料。切换 Cloudflare/GitHub 时不替换它，也不改 D1 或资料归属，因此不需要重新导入主机。

- 已有 Worker 密钥始终优先，即使 Actions 中遗留一个旧值也不会覆盖。
- D1 已有主机密文但 Worker 没有密钥时，部署停止，要求恢复原密钥。
- Cloudflare 不提供 Worker Secret 的明文读回；不要删除 Worker 或 Secret。
- 当前不支持直接轮换加密密钥。丢失后无法解密旧资料。

## 需要独立灾备时

可在**首次部署之前**自行生成 32 字节安全随机数的 Base64，保存在可信密码管理器，并作为 Actions `ENCRYPTION_KEY` Secret 提供：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

这是高级可选步骤，不是普通部署前置条件。不要为已经有数据的实例生成替代密钥，不要使用在线生成器、普通密码或 UUID。

GitHub 会话签名通过 HKDF 从现有密钥派生独立用途的签名密钥；不需要再配置 `SESSION_SECRET`，GitHub access token 不写入浏览器或数据库。
