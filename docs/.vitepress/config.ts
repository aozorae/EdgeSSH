import { defineConfig, type HeadConfig } from 'vitepress';

const repository = 'https://github.com/aozorae/EdgeSSH';
const siteUrl = 'https://edgessh-docs.pages.dev';
const productDescription = 'EdgeSSH 是运行在 Cloudflare Workers 上的开源 WebSSH 工作台，集成浏览器 SSH 终端、SFTP 文件管理、主机管理与进程监控。';

export default defineConfig({
  lang: 'zh-CN',
  title: 'EdgeSSH',
  description: productDescription,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: siteUrl,
    transformItems: (items) => items.filter((item) => item.url !== '404.html'),
  },
  // 统一指向正式站点，避免 Pages 预览地址与正式页面形成重复收录。
  transformHead({ page, title, description }) {
    if (page === '404.md') return [['meta', { name: 'robots', content: 'noindex' }]];

    const url = `${siteUrl}/${page.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`;
    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'EdgeSSH' }],
      ['meta', { property: 'og:locale', content: 'zh_CN' }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:image', content: `${siteUrl}/images/edgessh-dashboard-demo.png` }],
      ['meta', { property: 'og:image:alt', content: 'EdgeSSH WebSSH 主机总览与地球视图（脱敏演示数据）' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'twitter:image', content: `${siteUrl}/images/edgessh-dashboard-demo.png` }],
    ];
    // 只描述页面实际展示的产品，不编造评分、下载量或价格来争取富结果。
    if (page === 'index.md') {
      head.push(['script', { type: 'application/ld+json' }, JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'EdgeSSH',
        url: siteUrl,
        description,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        sameAs: repository,
        featureList: ['浏览器 SSH 终端', 'SFTP 文件管理', '加密主机库', '进程与资源监控'],
      })]);
    }
    return head;
  },
  head: [
    ['meta', { name: 'theme-color', content: '#f4511e' }],
    ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }],
  ],
  themeConfig: {
    siteTitle: 'EdgeSSH',
    logo: false,
    nav: [
      { text: '部署', link: '/deploy/actions', activeMatch: '^/deploy/' },
      { text: '使用', link: '/usage/hosts', activeMatch: '^/usage/' },
      { text: '参考', link: '/reference/configuration', activeMatch: '^/reference/' },
      { text: '开发', link: '/development/local' },
      { text: 'GitHub', link: repository },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '认识 EdgeSSH', link: '/guide/overview' },
          { text: '部署前准备', link: '/guide/requirements' },
        ],
      },
      {
        text: 'GitHub Actions 部署',
        items: [
          { text: '完整部署流程', link: '/deploy/actions' },
          { text: 'Cloudflare API Token', link: '/deploy/api-token' },
          { text: 'Zero Trust Access', link: '/deploy/zero-trust' },
          { text: 'GitHub OAuth', link: '/deploy/github-oauth' },
          { text: '切换登录方式', link: '/deploy/switch-login' },
          { text: 'Worker 运行时 Secret', link: '/deploy/runtime-secrets' },
          { text: '部署后验收', link: '/deploy/verification' },
          { text: '常见部署问题', link: '/deploy/troubleshooting' },
        ],
      },
      {
        text: '日常使用',
        items: [
          { text: '管理主机', link: '/usage/hosts' },
          { text: '终端与主机指纹', link: '/usage/terminal' },
          { text: '文件与进程', link: '/usage/files-and-processes' },
        ],
      },
      {
        text: '参考',
        items: [
          { text: '配置项', link: '/reference/configuration' },
          { text: '架构与安全边界', link: '/reference/security' },
          { text: '支持范围与限制', link: '/reference/limits' },
          { text: '截图清单', link: '/reference/screenshots' },
        ],
      },
      {
        text: '开发',
        items: [
          { text: '本地开发', link: '/development/local' },
          { text: '贡献指南', link: '/development/contributing' },
          { text: '文档站部署', link: '/development/docs-site' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repository }],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到相关内容',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
    outline: { level: [2, 3], label: '本页内容' },
    editLink: { pattern: `${repository}/edit/codex/docs-auth-providers/docs/:path`, text: '在 GitHub 上编辑此页' },
    lastUpdated: { text: '最后更新', formatOptions: { dateStyle: 'medium', timeStyle: 'short' } },
    docFooter: { prev: '上一页', next: '下一页' },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '文档目录',
    darkModeSwitchLabel: '切换主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    footer: {
      message: '面向个人管理员的 Cloudflare 边缘 SSH 工作台',
      copyright: 'Apache License 2.0',
    },
  },
});
