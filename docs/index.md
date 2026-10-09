---
layout: home
title: EdgeSSH - 开源 WebSSH 在线终端与 SFTP 文件管理
titleTemplate: false
description: EdgeSSH 是部署在你自己 Cloudflare 账户中的开源 WebSSH 工作台，集成浏览器 SSH 终端、SFTP 文件管理、主机管理与进程监控，无需额外维护 SSH 中转服务器。

hero:
  name: EdgeSSH
  text: 浏览器里的 SSH 终端与 SFTP 工作台
  tagline: 在一个页面管理主机、连接终端、传输文件、查看进程。开源 WebSSH，部署在你自己的 Cloudflare 账户，无需额外维护 SSH 中转服务器。
  actions:
    - theme: brand
      text: 部署你的工作台
      link: /deploy/actions
    - theme: alt
      text: 了解产品功能
      link: /guide/overview
---

<section class="home-workbench">
  <figure class="home-capture">
    <img src="/images/edgessh-dashboard-demo.png" alt="EdgeSSH WebSSH 工作台：服务器主机列表与地球视图" width="1600" height="1000" fetchpriority="high" />
    <figcaption>主机总览与地球视图 · 图中为脱敏演示数据，不对应真实服务器。</figcaption>
  </figure>
  <div class="home-workbench__note">
    <h2>你的服务器，一处管理。</h2>
    <p>从 VPS 到云主机，只要能够通过公网 SSH 访问，就能纳入你的个人工作台。在不同设备的浏览器中访问同一份主机库，不必重复整理连接信息。</p>
    <a class="home-link" href="/usage/hosts">了解主机管理</a>
  </div>
</section>

<section class="home-features">
  <h2>从 SSH 连接到日常运维，不用来回切换工具</h2>
  <div class="feature-grid">
    <div>
      <span>SSH TERMINAL</span>
      <h3>浏览器 SSH 终端</h3>
      <p>基于 xterm.js 的交互式终端，支持密码与未加密 OpenSSH 私钥认证、全屏和多种终端编码。首次连接先确认主机指纹。</p>
      <a class="home-link" href="/usage/terminal">了解终端功能</a>
    </div>
    <div>
      <span>SFTP FILES</span>
      <h3>SFTP 文件管理</h3>
      <p>浏览远程目录，上传、下载、重命名文件与新建文件夹。文件管理和终端共用 SSH 连接，切换操作无需重新登录服务器。</p>
      <a class="home-link" href="/usage/files-and-processes">了解文件管理</a>
    </div>
    <div>
      <span>SERVER MONITOR</span>
      <h3>进程与资源监控</h3>
      <p>在 SSH 会话中查看 CPU、负载、内存、Swap 与进程列表，识别操作系统和架构，无需在目标服务器额外安装监控 Agent。</p>
      <a class="home-link" href="/usage/files-and-processes#进程面板">了解进程面板</a>
    </div>
    <div>
      <span>ENCRYPTED HOSTS</span>
      <h3>加密主机库</h3>
      <p>搜索与管理服务器，用地球视图查看大致位置。主机资料与凭据通过 AES-256-GCM 加密存入 D1，浏览器不长期保存 SSH 凭据。</p>
      <a class="home-link" href="/reference/security">了解安全设计</a>
    </div>
  </div>
</section>

<section class="home-boundary">
  <div>
    <h2>开源自托管，运行在你的 Cloudflare 上</h2>
  </div>
  <div>
    <p>EdgeSSH 将 WebSSH 客户端、界面和加密资料库部署在 Cloudflare Workers、Durable Objects 与 D1 上。无需单独维护中转 VPS，使用 GitHub OAuth 或 Cloudflare Access 保护你的单管理员工作区。</p>
    <p>它不是端到端加密：Worker 建立 SSH 会话时会处理明文凭据。请部署到自己信任的账户，使用前阅读<a href="/reference/security">安全边界</a>与<a href="/reference/limits">支持范围</a>。</p>
    <a class="home-link" href="/deploy/actions">查看完整部署指南</a>
  </div>
</section>
