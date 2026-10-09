import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const dist = fileURLToPath(new URL('../docs/.vitepress/dist/', import.meta.url));
const origin = 'https://edgessh-docs.pages.dev';
const home = readFileSync(path.join(dist, 'index.html'), 'utf8');
const sitemap = readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
const pages = readdirSync(dist, { recursive: true })
  .filter((file) => file.endsWith('.html') && file !== '404.html');

// 验证实际静态产物，而不是只检查配置字符串，避免 SEO 信息仅在浏览器运行后出现。
test('首页静态 HTML 以产品用途为主，并提供真实产品结构化数据', () => {
  assert.match(home, /<title>EdgeSSH - 开源 WebSSH 在线终端与 SFTP 文件管理<\/title>/);
  assert.match(home, /浏览器里的 SSH 终端与 SFTP 工作台/);
  assert.doesNotMatch(home, /从 Fork 到上线|一条可以重复执行的部署路径/);
  assert.equal([...home.matchAll(/<h1(?:\s|>)/g)].length, 1);
  const schema = JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema['@type'], 'SoftwareApplication');
  assert.equal(schema.name, 'EdgeSSH');
  assert.equal(schema.url, origin);
  assert.equal(schema.aggregateRating, undefined);
  assert.equal(schema.offers, undefined);
  assert.equal(schema.featureList.length, 4);
});

test('各页面有独立规范链接、匹配的分享标题与描述，且包含在站点地图中', () => {
  assert.ok(pages.length > 10);
  const canonicals = new Set();
  for (const file of pages) {
    const html = readFileSync(path.join(dist, file), 'utf8');
    const head = html.split('</head>')[0];
    const canonical = head.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    const route = file.replaceAll('\\', '/').replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '');
    assert.equal(canonical, `${origin}/${route}`, file);
    assert.equal([...head.matchAll(/rel="canonical"/g)].length, 1, file);
    assert.equal(canonicals.has(canonical), false, file);
    canonicals.add(canonical);
    const title = head.match(/<title>(.*?)<\/title>/)[1];
    const description = head.match(/<meta name="description" content="([^"]+)"/)[1];
    assert.ok(head.includes(`property="og:title" content="${title}"`), file);
    assert.ok(head.includes(`property="og:description" content="${description}"`), file);
    assert.ok(head.includes(`property="og:url" content="${canonical}"`), file);
    assert.match(head, /name="twitter:card" content="summary_large_image"/);
    assert.ok(sitemap.includes(`<loc>${canonical}</loc>`), file);
  }
});

test('robots 提供 sitemap，404 不参与收录，分享图存在', () => {
  const robots = readFileSync(path.join(dist, 'robots.txt'), 'utf8');
  assert.match(robots, /User-agent: \*\nAllow: \//);
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
  assert.doesNotMatch(sitemap, /404(?:\.html)?</);
  const notFound = readFileSync(path.join(dist, '404.html'), 'utf8');
  assert.match(notFound, /name="robots" content="noindex"/);
  assert.doesNotMatch(notFound, /rel="canonical"/);
  assert.ok(existsSync(path.join(dist, 'images/edgessh-dashboard-demo.png')));
});

test('首页站内入口及片段锚点均指向已构建页面', () => {
  for (const [, href] of home.matchAll(/<a\b[^>]*href="(\/[^"]*)"/g)) {
    const url = new URL(href, origin);
    if (url.pathname.startsWith('/assets/')) continue;
    const route = url.pathname === '/' ? 'index' : url.pathname.slice(1);
    const target = path.join(dist, `${route}.html`);
    assert.ok(existsSync(target), href);
    if (url.hash) {
      const html = readFileSync(target, 'utf8');
      assert.ok(html.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), href);
    }
  }
});
