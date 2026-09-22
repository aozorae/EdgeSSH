import { defineConfig } from 'vitepress';

const repository = 'https://github.com/aozorae/EdgeSSH';

export default defineConfig({
  lang: 'zh-CN',
  title: 'EdgeSSH',
  description: 'EdgeSSH 部署、配置与使用文档',
  cleanUrls: true,
  lastUpdated: true,
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
