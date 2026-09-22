# 截图清单

历史截图仅说明界面入口，当前变量名称、必填项和部署步骤以最新版文字表格为准。部分通用截图仅留存，不再作为新认证流程的操作依据；仍需补齐标记为“待补”的项目。

| 状态 | 文件名 | 页面 | 画面重点 |
| --- | --- | --- | --- |
| 留存 | `01-fork-repository.png` | 历史素材 | Fork 入口 |
| 已复用 | `02-cloudflare-api-token-permissions.png` | API Token | Token 模板入口 |
| 留存 | `03-github-actions-variables.png` | 历史素材 | Secrets and variables 入口 |
| 留存 | `04-run-deploy-workflow.png` | 历史素材 | Run workflow 与 main 分支 |
| 已补 | `05-deploy-success.png` | Actions 部署 | EdgeSSH 绿色成功状态与关键步骤 |
| 已补 | `06-zero-trust-application.png` | Zero Trust | EdgeSSH Self-hosted 类型与域名 |
| 已补 | `07-zero-trust-policy.png` | Zero Trust | Allow、Include、Emails |
| 留存 | `08-github-actions-secrets.png` | 历史素材 | Repository secrets 入口 |
| 已补 | `09-access-login.png` | Zero Trust | EdgeSSH 正式域名与登录页 |
| 已有 | `10-edgessh-host-list.png` | 验收 | 使用保留地址的主机总览演示 |
| 待补 | `11-pages-custom-domain.png` | 文档站部署 | Pages 自定义域名入口 |

## 截图规范

- 使用 1440px 或更宽的桌面视口，保留关键面包屑和页面标题。
- 只截与当前步骤有关的区域，不截完整桌面。
- API Token、Secret、Access AUD、Cookie、邮箱、真实 IP 和仓库私密信息必须打码。
- 不要用模糊覆盖关键按钮；敏感值可以使用纯色实块遮盖。
- 使用 PNG，保持界面文字清晰。
- Cloudflare 或 GitHub 改版后，优先保证概念与字段名可辨认，不要求像素级复刻旧界面。

## 接入示例

原占位：

```md
<ScreenshotPlaceholder
  title="Fork 仓库"
  description="说明截图范围"
  filename="01-fork-repository.png"
/>
```

添加图片后：

```md
<ScreenshotPlaceholder
  title="Fork 仓库"
  description="说明截图范围"
  filename="01-fork-repository.png"
  src="/screenshots/01-fork-repository.png"
  alt="GitHub 上的 EdgeSSH Fork 页面"
/>
```

提交前运行 `npm run docs:build`，确认没有断链或资源错误。
