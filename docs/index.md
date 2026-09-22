---
layout: home

hero:
  name: EdgeSSH
  text: 从 Fork 到上线，可逐项核对
  tagline: Cloudflare Access 或原生 GitHub 登录，二选一。填写对应变量，Action 自动部署；切换登录方式，主机资料不搬家。
  actions:
    - theme: brand
      text: 使用 Actions 部署
      link: /deploy/actions
    - theme: alt
      text: 先了解 EdgeSSH
      link: /guide/overview
---

<section class="home-workbench">
  <figure class="home-capture">
    <img src="/images/edgessh-dashboard-demo.png" alt="EdgeSSH 主机总览与地球视图" width="1600" height="1000" fetchpriority="high" />
    <figcaption>主机资料加密保存在 D1；从总览进入终端、SFTP 和进程面板。</figcaption>
  </figure>
  <div class="home-workbench__note">
    <strong>打开浏览器，连接你的服务器。</strong>
    <p>EdgeSSH 运行于 Cloudflare Workers。浏览器只连接 Worker，由独立 Durable Object 会话通过 TCP Socket 连接公网 SSH 服务。</p>
    <a class="home-link" href="/reference/security">查看安全边界</a>
  </div>
</section>

<section class="home-path">
  <h2>一条可以重复执行的部署路径</h2>
  <div class="deploy-track">
    <div>
      <span>01</span>
      <strong>准备 Cloudflare</strong>
      <p>创建 Workers/D1 部署 Token。自定义域名可选，默认使用 workers.dev。</p>
    </div>
    <div>
      <span>02</span>
      <strong>选择登录方式</strong>
      <p>AUTH_PROVIDER 二选一：Access 填管理员邮箱，GitHub 填 OAuth App 与管理员账号。</p>
    </div>
    <div>
      <span>03</span>
      <strong>运行 Deploy</strong>
      <p>自动配置所选认证、复用 D1、生成并保留密钥，执行迁移和部署。</p>
    </div>
    <div>
      <span>04</span>
      <strong>登录并验收</strong>
      <p>只有指定管理员可以访问；切换方式仍保留原有主机与凭据。</p>
    </div>
  </div>
</section>

<section class="home-boundary">
  <div>
    <h2>先明确边界，再保存凭据</h2>
  </div>
  <div>
    <p>EdgeSSH 面向单管理员，不提供本地注册或匿名 SSH。Cloudflare 模式验证 Access JWT，GitHub 模式验证指定账号并使用签名会话，两者不同时生效。它不是端到端加密：Worker 建立 SSH 会话时会处理明文凭据，因此云账户、部署权限和 Secret 都属于信任边界。</p>
    <a class="home-link" href="/deploy/actions">开始完整部署</a>
  </div>
</section>
