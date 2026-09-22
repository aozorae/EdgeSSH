# 支持范围与限制

部署前先核对下表。未支持的能力不会因为调整 Cloudflare 权限或增大超时而出现。

## 当前支持

| 类别 | 支持情况 |
| --- | --- |
| SSH | SSH 2.0、交互式 Shell、PTY、窗口尺寸同步、Keepalive |
| 密码认证 | password 与单密码提示 keyboard-interactive |
| 私钥 | 未加密 OpenSSH Ed25519、RSA、ECDSA P-256/P-384/P-521 |
| 文件 | SFTP v3，单文件上传与下载上限 64 MiB |
| 目录 | 浏览、新建、重命名、删除空目录 |
| 主机管理 | 单管理员最多 200 台，切换登录方式共用同一份资料 |
| 终端编码 | UTF-8、GB18030、Big5，取决于浏览器支持 |
| 网络目标 | 公网地址；Cloudflare Workers 不允许出站 TCP 25 |

## 暂不支持

- 带 passphrase 的加密私钥。
- PEM 或 PKCS#8 私钥。
- SSH Agent。
- 多因素或多轮 keyboard-interactive。
- SCP。
- 端口转发。
- ProxyJump。
- SSH 压缩。
- 会话内 rekey。
- 团队共享主机库。
- 本地账号、密码找回或匿名访问。
- 递归删除非空目录。

## 行为边界

- 地球位置不表示在线状态，也不显示伪造的延迟或在线数。
- 同一城市的多个点位可能接近，主机列表始终是完整入口。
- Worker 处理明文 SSH 凭据，因此不是端到端加密。
- `workers.dev` 和自定义域名均可作为正式入口，使用所选模式的认证保护。
- 同一个固定来源 IP 白名单通常不适用于 Cloudflare Workers 出站连接。

需要新能力时，先在 GitHub 提交具体使用场景。不要通过删除公网地址校验、Access 校验或主机指纹确认来实现快捷绕过。
