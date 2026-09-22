# 配置 Cloudflare Zero Trust Access

本页仅适用于 `AUTH_PROVIDER=cloudflare`。启用 Zero Trust 后，在 Actions 填好 Token 与 `ADMIN_EMAIL` 即可；Action 会自动创建/复用应用、OTP、邮箱策略，并取得 Team Domain/AUD。以下控制台步骤仅供手工维护与排障。

使用原生 `AUTH_PROVIDER=github` 时无需本页配置，改看 [GitHub OAuth](/deploy/github-oauth)。不要把原生 GitHub 模式和 Access 中的 GitHub IdP 混为一谈。

::: warning 使用明确身份
推荐“明确邮箱 + Allow”。不要使用 `Everyone`、`Bypass`，也不要只按登录方式放行所有能够接收验证码的人。
:::

## 1. 准备登录方式

个人部署可以使用 One-time PIN 邮件验证码。若 Zero Trust 组织中没有该选项：

1. 进入 **Zero Trust → Integrations → Identity providers**。
2. 选择 **Add new identity provider**。
3. 添加 **One-time PIN** 并保存。

如果已经配置 Google、GitHub、Microsoft Entra ID 或其他身份提供程序，可以继续使用已有方式。

## 2. 创建 Self-hosted 应用

1. 进入 **Zero Trust → Access controls → Applications**。
2. 选择 **Create new application**。
3. 选择 **Self-hosted and private**。
4. 添加 Public hostname。
5. Application name 填写 `EdgeSSH`。
6. Public hostname 填实际入口；默认可用 `edgessh.<子域>.workers.dev`，有 `CUSTOM_DOMAIN` 时使用该自定义域名。

<ScreenshotPlaceholder
  title="EdgeSSH Access 应用"
  description="请截取应用名称、Self-hosted 类型和 Public hostname。隐藏 Team Domain 之外的组织信息。"
  filename="06-zero-trust-application.png"
  src="/screenshots/06-zero-trust-application.png"
  alt="Cloudflare Zero Trust 中的 EdgeSSH 自托管应用列表"
  caption="EdgeSSH Access 应用示例：确认目标域名、策略和自托管类型。"
/>

## 3. 添加 Allow 策略

在应用的 Access policies 中创建策略：

| 项目 | 推荐值 |
| --- | --- |
| Policy name | `EdgeSSH Admin` |
| Action | `Allow` |
| Rule type | `Include` |
| Selector | `Emails` |
| Value | 你的完整管理员邮箱 |

本项目只有一个管理员资料库，请只允许明确管理员。不要使用整域授权、Everyone 或 Bypass；增加可登录身份相当于授予其整个管理员资料库权限。

<ScreenshotPlaceholder
  title="仅允许管理员邮箱的 Access 策略"
  description="请截取 Action、Include、Emails 三项。邮箱地址请打码，只保留结构可辨认。"
  filename="07-zero-trust-policy.png"
  src="/screenshots/07-zero-trust-policy.png"
  alt="Cloudflare Access 中仅允许指定邮箱的管理策略"
  caption="Allow 策略示例：使用 Include 和 Emails 明确限制管理员邮箱。"
/>

## 4. 获取 Team Domain

Action 自动取得并保存 `ACCESS_TEAM_DOMAIN` 到 Worker Secret，不用复制回 GitHub。排障时可在 Zero Trust 设置找到 Team domain：

```text
my-team.cloudflareaccess.com
```

不要带 `https://`、路径或末尾斜杠。

## 5. 获取 Application Audience

1. 回到 **Access controls → Applications**。
2. 打开刚创建的 EdgeSSH 应用。
3. 在 Additional settings 中找到 **Application Audience (AUD) Tag**。
4. 核对当前应用的 AUD。Action 会自动将其写入 Worker `ACCESS_AUD` Secret，无需手工复制。

不要把应用 ID、Client ID 或策略 ID 当成 AUD。

## 6. 验证 Access 本身

在运行 `Deploy` workflow 前，也可以先访问自定义域名验证外层策略：

- 未登录时应先出现 Cloudflare Access 登录页。
- 不在 Allow 策略内的邮箱不能进入。
- 允许的邮箱能够完成认证。

<ScreenshotPlaceholder
  title="正式域名的 Access 登录页"
  description="请截取浏览器地址栏中的 EdgeSSH 自定义域名和 Access 登录界面。邮箱、验证码、Cookie 与重定向参数必须隐藏。"
  filename="09-access-login.png"
  src="/screenshots/09-access-login.png"
  alt="EdgeSSH 的 Cloudflare Access 登录页面"
  caption="EdgeSSH 入口受 Cloudflare Access 保护，允许的用户可通过身份提供程序或邮箱验证码登录。"
/>

## 常见问题

### One-time PIN 收不到邮件

先确认策略中的 Emails 与登录邮箱完全一致。Cloudflare 不会向未被策略允许的邮箱发送验证码，但页面可能仍显示已发送，避免泄露访问名单。

### 登录后提示 Access 登录已失效

通常是以下三项没有对应同一个应用：

- 正在访问的自定义域名。
- `ACCESS_TEAM_DOMAIN` 所属 Zero Trust 组织。
- `ACCESS_AUD` 所属 Self-hosted 应用。

### 页面没有出现 Access 登录

确认 Access 应用 Public hostname 与实际访问域名一致；workers.dev 和自定义域名均可作正式入口，但应保护实际使用的那个 hostname。
