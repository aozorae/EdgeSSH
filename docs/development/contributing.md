# 贡献指南

欢迎通过 Issue 反馈问题，或通过 Pull Request 提交改进。

## 提交前

运行完整检查：

```bash
npm run check
```

如果修改了文档，在独立文档源码分支启动预览并构建检查；应用 main 不包含文档构建命令：

```bash
npm run docs:dev
npm run docs:build
```

## 变更范围

- 一个文件尽量承担单一职责。
- 优先沿用现有模块、类型与错误响应结构。
- 对外接口返回统一错误，不暴露堆栈、源码或内部数据。
- Worker 请求链路中的 I/O 必须异步等待，避免阻塞计算。
- 数据库迁移只追加必要 schema，不在普通部署中清空生产数据。

## 测试真实功能

涉及 SSH、SFTP、进程面板或操作系统探测时，使用你有权访问的测试服务器。Pull Request 中明确写出已验证的范围；没有真实目标时，不要声称真实连接已通过。

涉及认证时，应覆盖所选模式互斥、未授权账号拒绝、OAuth state/PKCE、Cookie 到期与退出，以及切换后旧资料可解密。模拟 OAuth API 测试不能替代真实 GitHub 授权验收。

## 安全报告

Issue 和 Pull Request 中不要上传：

- 密码或私钥。
- Cloudflare API Token 或 Worker Secret。
- Access JWT、Cookie、AUD 或 Team Domain。
- 未脱敏的服务器 IP、域名或完整日志。

## 上游与许可证

EdgeSSH 基于 [Worker Web SSH](https://github.com/cmliu/CF-Workers-WebSSH) 深度开发，采用 Apache License 2.0。修改与分发时请保留适用的版权和许可证声明。
