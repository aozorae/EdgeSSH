import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'docs', 'images', 'showcase');
const baseURL = process.env.EDGESSH_SHOWCASE_URL ?? 'http://127.0.0.1:4178';
const demoFingerprint = (seed) => `SHA256:${createHash('sha256').update(seed).digest('base64').replace(/=$/, '')}`;
const fingerprint = demoFingerprint('edgessh-showcase-pinned-host');
const firstSeenFingerprint = demoFingerprint('edgessh-showcase-first-seen-host');

const hosts = [
  {
    id: 'tokyo-edge', name: 'Tokyo Edge Gateway', group: '生产集群', host: '192.0.2.10', port: 22,
    username: 'deploy', authMethod: 'password', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint, hasCredential: true, updatedAt: Date.now(),
    location: { ip: '192.0.2.10', city: '东京', region: 'Tokyo', country: 'Japan', countryCode: 'JP', latitude: 35.6762, longitude: 139.6503 },
    system: { family: 'linux', distribution: 'ubuntu', name: 'Ubuntu', version: '24.04 LTS', architecture: 'x86_64' },
  },
  {
    id: 'frankfurt-api', name: 'Frankfurt API', group: '生产集群', host: '198.51.100.24', port: 22,
    username: 'ops', authMethod: 'publickey', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint, hasCredential: true, updatedAt: Date.now(),
    location: { ip: '198.51.100.24', city: '法兰克福', region: 'Hesse', country: 'Germany', countryCode: 'DE', latitude: 50.1109, longitude: 8.6821 },
    system: { family: 'linux', distribution: 'debian', name: 'Debian GNU/Linux', version: '12', architecture: 'aarch64' },
  },
  {
    id: 'singapore-db', name: 'Singapore Database', group: '数据服务', host: '203.0.113.42', port: 2222,
    username: 'dba', authMethod: 'password', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint, hasCredential: true, updatedAt: Date.now(),
    location: { ip: '203.0.113.42', city: '新加坡', country: 'Singapore', countryCode: 'SG', latitude: 1.3521, longitude: 103.8198 },
    system: { family: 'linux', distribution: 'alpine', name: 'Alpine Linux', version: '3.22', architecture: 'x86_64' },
  },
  {
    id: 'sydney-build', name: 'Sydney Build Runner', group: '开发测试', host: '192.0.2.86', port: 22,
    username: 'builder', authMethod: 'publickey', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint, hasCredential: true, updatedAt: Date.now(),
    location: { ip: '192.0.2.86', city: '悉尼', region: 'New South Wales', country: 'Australia', countryCode: 'AU', latitude: -33.8688, longitude: 151.2093 },
    system: { family: 'darwin', distribution: '', name: 'macOS', version: '15.6', architecture: 'arm64' },
  },
];

const snippets = [
  ['查看服务健康状态', 'systemctl --no-pager --full status edge-api'],
  ['跟踪应用日志', 'journalctl -u edge-api -f -n 120'],
  ['查看容器资源', 'docker stats --no-stream'],
  ['检查监听端口', 'ss -tulpen'],
  ['查看磁盘与 inode', 'df -h && df -ih'],
  ['检查系统负载', 'uptime && free -h'],
  ['最近登录记录', 'last -n 12'],
  ['查看失败服务', 'systemctl --failed --no-pager'],
].map(([name, command], index) => ({ id: `snippet-${index + 1}`, name, command, updatedAt: Date.now() - index * 60_000 }));

const directories = new Map([
  ['/', [directory('srv'), directory('var'), directory('etc')]],
  ['/srv', [directory('edge-api'), directory('backups')]],
  ['/srv/edge-api', [
    directory('releases'), directory('shared'), file('compose.yaml', 3_842, '0640'),
    file('.env.example', 1_284, '0640'), file('README.md', 8_726), file('package-lock.json', 182_430),
    file('healthcheck.sh', 1_036, '0755'), file('deploy.log', 48_912),
  ]],
  ['/srv/edge-api/releases', [directory('2026-09-26_0915'), directory('2026-09-25_2204')]],
  ['/srv/edge-api/shared', [directory('logs'), directory('uploads')]],
]);

function directory(name) {
  return entry(name, 'directory', 0, '0755');
}

function file(name, size, permissions = '0644') {
  return entry(name, 'file', size, permissions);
}

function entry(name, type, size, permissions) {
  return { name, type, size, permissions, mtime: 1_790_431_200, owner: 'deploy', group: 'edge' };
}

const processSnapshot = (networkOffset = 0) => ({
  type: 'process_snapshot',
  metrics: {
    cpuPercent: 27.4,
    loadAverage: [0.62, 0.48, 0.39],
    memory: { usedBytes: 3_865_470_566, totalBytes: 8_589_934_592, percent: 45.0 },
    swap: { usedBytes: 134_217_728, totalBytes: 2_147_483_648, percent: 6.25 },
    network: [{ iface: 'eth0', rxBytes: 8_420_000_000 + networkOffset, txBytes: 2_180_000_000 + networkOffset / 3 }],
  },
  processes: [
    { pid: 1842, user: 'deploy', memoryBytes: 824_180_736, memoryPercent: 9.6, cpuPercent: 18.7, state: 'S', time: '12:44.31', command: 'node /srv/edge-api/current/server.js' },
    { pid: 921, user: 'postgres', memoryBytes: 418_381_824, memoryPercent: 4.9, cpuPercent: 4.8, state: 'S', time: '48:12.09', command: 'postgres: edge edge_api 127.0.0.1 idle' },
    { pid: 1164, user: 'www-data', memoryBytes: 96_468_992, memoryPercent: 1.1, cpuPercent: 2.1, state: 'S', time: '04:28.62', command: 'nginx: worker process' },
    { pid: 742, user: 'root', memoryBytes: 71_303_168, memoryPercent: 0.8, cpuPercent: 0.9, state: 'S', time: '02:19.45', command: '/usr/bin/cloudflared tunnel run edge-api' },
    { pid: 658, user: 'root', memoryBytes: 54_525_952, memoryPercent: 0.6, cpuPercent: 0.3, state: 'S', time: '01:42.18', command: '/usr/lib/systemd/systemd-journald' },
    { pid: 2077, user: 'deploy', memoryBytes: 39_845_888, memoryPercent: 0.5, cpuPercent: 0.2, state: 'S', time: '00:14.92', command: 'bash' },
  ],
  timestamp: Date.now(),
});

function terminalTranscript() {
  return [
    '\u001b[38;5;208mEdgeSSH secure session\u001b[0m  \u001b[2mvia Cloudflare Workers\u001b[0m',
    'Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0-79-generic x86_64)',
    '',
    '\u001b[38;5;75mdeploy@edge-gateway\u001b[0m:\u001b[38;5;110m~\u001b[0m$ uptime',
    ' 09:26:18 up 41 days,  7:13,  1 user,  load average: 0.62, 0.48, 0.39',
    '\u001b[38;5;75mdeploy@edge-gateway\u001b[0m:\u001b[38;5;110m~\u001b[0m$ systemctl is-active edge-api nginx postgresql',
    '\u001b[38;5;82mactive\nactive\nactive\u001b[0m',
    '\u001b[38;5;75mdeploy@edge-gateway\u001b[0m:\u001b[38;5;110m~\u001b[0m$ docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
    'NAMES             STATUS                  PORTS',
    'edge-api          Up 18 days (healthy)    127.0.0.1:8080->8080/tcp',
    'edge-cache        Up 18 days (healthy)    6379/tcp',
    '\u001b[38;5;75mdeploy@edge-gateway\u001b[0m:\u001b[38;5;110m~\u001b[0m$ ',
  ].join('\r\n');
}

async function installDemoRoutes(page, options = {}) {
  const demoHosts = options.firstSeen ? hosts.map((host) => ({ ...host, fingerprint: '' })) : hosts;
  let forwardingActive = false;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Demo Admin' }, provider: 'cloudflare' } });
    if (pathname === '/api/hosts') return route.fulfill({ json: { hosts: demoHosts } });
    if (pathname === '/api/snippets') return route.fulfill({ json: { snippets } });
    if (pathname.endsWith('/credentials')) return route.fulfill({ json: { password: 'showcase-only-password' } });
    if (pathname.endsWith('/system')) return route.fulfill({ json: { host: demoHosts[0] } });
    if (pathname === '/api/session') return route.fulfill({ json: { ticket: 'showcase-ticket', sessionId: 'a'.repeat(64) } });
    if (pathname === '/api/forwarding' && request.method() === 'GET') {
      if (url.searchParams.has('session')) {
        return route.fulfill({ json: forwardingActive
          ? { active: true, port: 8080, mode: 'isolated', expiresAt: Date.now() + 480_000 }
          : { active: false } });
      }
      return route.fulfill({ json: { previewAvailable: true } });
    }
    if (pathname === '/api/forwarding' && request.method() === 'POST') {
      forwardingActive = true;
      return route.fulfill({ json: { url: 'https://preview.example.invalid/__edgessh/start#demo', expiresAt: Date.now() + 3_600_000 } });
    }
    if (pathname === '/api/forwarding' && request.method() === 'DELETE') {
      forwardingActive = false;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: {} });
  });

  await page.routeWebSocket('**/api/ssh?*', (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const message = JSON.parse(raw);
      if (message.type !== 'connect') return;
      if (options.firstSeen) {
        socket.send(JSON.stringify({
          type: 'host_key', fingerprint: firstSeenFingerprint,
          keyType: 'ssh-ed25519', trusted: false,
        }));
        return;
      }
      socket.send(JSON.stringify({ type: 'host_key', fingerprint, expectedFingerprint: fingerprint, keyType: 'ssh-ed25519', trusted: true }));
      socket.send(JSON.stringify({ type: 'ready', message: 'Interactive shell ready' }));
      socket.send(JSON.stringify({ type: 'system_info', system: hosts[0].system }));
      socket.send(JSON.stringify({ type: 'sftp_attach', url: '/api/sftp?session=showcase&token=demo' }));
      socket.send(JSON.stringify({ type: 'process_attach', url: '/api/processes?session=showcase&token=demo' }));
      if (message.mode !== 'forward') setTimeout(() => socket.send(Buffer.from(terminalTranscript())), 120);
    });
  });

  await page.routeWebSocket('**/api/sftp?*', (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const message = JSON.parse(raw);
      if (message.type === 'sftp_init') socket.send(JSON.stringify({ type: 'sftp_ready', cwd: '/srv/edge-api', version: 3 }));
      if (message.type === 'sftp_list') {
        socket.send(JSON.stringify({
          type: 'sftp_list_result', requestId: message.requestId, path: message.path,
          entries: directories.get(message.path) ?? [],
        }));
      }
    });
  });

  await page.routeWebSocket('**/api/processes?*', (socket) => {
    socket.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const message = JSON.parse(raw);
      if (message.type !== 'process_start') return;
      socket.send(JSON.stringify({ type: 'process_ready' }));
      socket.send(JSON.stringify(processSnapshot()));
      setTimeout(() => socket.send(JSON.stringify(processSnapshot(4_800_000))), 180);
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function capture(page, name) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.body.scrollTo(0, 0);
    document.querySelector('#toast-region')?.replaceChildren();
  });
  await page.screenshot({ path: path.join(outputDirectory, name), animations: 'disabled' });
  console.log(`Created docs/images/showcase/${name}`);
}

async function connectToTokyo(page) {
  const row = page.locator('.host-row').filter({ hasText: 'Tokyo Edge Gateway' });
  await row.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('body[data-view="workspace"]').waitFor();
}

async function generate() {
  await mkdir(outputDirectory, { recursive: true });
  const externalServer = Boolean(process.env.EDGESSH_SHOWCASE_URL);
  const server = externalServer ? null : spawn(process.execPath, [
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(root, 'vite.config.ts'), '--host', '127.0.0.1', '--port', '4178', '--strictPort',
  ], { cwd: root, stdio: 'ignore' });

  let browser;
  try {
    await waitForServer(baseURL);
    browser = await chromium.launch({
      headless: true,
      channel: process.env.EDGESSH_SHOWCASE_BROWSER ?? 'chrome',
    });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await installDemoRoutes(page);
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('#host-globe canvas').waitFor();
    await page.waitForTimeout(500);
    await capture(page, '01-dashboard.png');

    await connectToTokyo(page);
    await page.locator('#session-title').filter({ hasText: 'deploy@192.0.2.10:22' }).waitFor();
    await page.locator('#process-table-body tr').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(500);
    const snippetBody = page.locator('#snippet-panel-body');
    if (await snippetBody.isVisible()) await page.getByRole('button', { name: '收起代码片段' }).click();
    if (await page.locator('#command-editor').isVisible()) await page.locator('#command-editor-close').click();
    await capture(page, '02-ssh-terminal.png');

    await page.locator('#command-editor-toggle').click();
    await page.locator('#command-editor-input').fill('cd /srv/edge-api/current\ndocker compose pull\ndocker compose up -d\ncurl -fsS http://127.0.0.1:8080/health');
    if (await snippetBody.isHidden()) await page.getByRole('button', { name: '展开代码片段' }).click();
    await capture(page, '03-terminal-command-workflow.png');

    await page.locator('#process-manager-tab').click();
    await page.locator('#process-manager-panel:not([hidden])').waitFor();
    await capture(page, '04-process-monitor.png');

    await page.locator('.topbar-actions .home-back').filter({ hasText: '文件管理' }).click();
    await page.locator('body[data-view="files"]').waitFor();
    await page.locator('.files-list').waitFor();
    await page.waitForTimeout(350);
    await capture(page, '05-sftp-file-manager.png');

    await page.locator('#rail-snippets').click();
    await page.locator('#snippets-page .snippet-card').first().waitFor();
    await capture(page, '06-command-library.png');

    await page.locator('#rail-forward').click();
    await page.locator('.forward-page select[name="host"]').selectOption('tokyo-edge');
    await page.locator('.forward-page select[name="mode"]').selectOption('isolated');
    await page.locator('.forward-page input[name="port"]').fill('8080');
    await page.evaluate(() => { window.open = () => null; });
    await page.locator('.forward-page button[type="submit"]').click();
    await page.locator('.forward-page [data-status]').filter({ hasText: '已转发 127.0.0.1:8080' }).waitFor();
    await capture(page, '07-isolated-web-preview.png');

    const securityPage = await context.newPage();
    await securityPage.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await installDemoRoutes(securityPage, { firstSeen: true });
    await securityPage.goto(baseURL, { waitUntil: 'networkidle' });
    await connectToTokyo(securityPage);
    await securityPage.locator('#host-key-dialog[open]').waitFor();
    await capture(securityPage, '08-host-key-verification.png');
    await context.close();
  } finally {
    await browser?.close();
    server?.kill('SIGTERM');
  }
}

await generate();
