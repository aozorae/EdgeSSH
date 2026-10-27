import { test, expect, type Page } from '@playwright/test';

/**
 * Step 3 scope: the terminal page owns a session tab strip between the chrome
 * row and the terminal stage, and closing a tab tears the SSH connection down
 * with it. Multi-session semantics (several live tabs) land in later steps.
 */

const HOSTS = [{
  id: 'alpha',
  name: 'Tokyo production',
  host: '192.0.2.10',
  port: 22,
  username: 'root',
  group: '测试主机',
  authMethod: 'password',
  initialCommand: '',
  termType: 'xterm-256color',
  encoding: 'utf-8',
  fingerprint: '',
  location: null,
  system: null,
  hasCredential: true,
  updatedAt: Date.now(),
}];

async function fixture(page: Page) {
  const closes: Array<{ code: number; reason: string }> = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/hosts') return route.fulfill({ json: { hosts: HOSTS } });
    if (path.endsWith('/credentials')) return route.fulfill({ json: { password: 'test-only-password' } });
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId: 'step3-session' } });
    if (path === '/api/snippets') return route.fulfill({ json: { snippets: [] } });
    if (path === '/api/forwarding') return route.fulfill({ json: { available: false, trustedAvailable: true } });
    if (path === '/api/forward-rules') return route.fulfill({ json: { rules: [] } });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'connect') ws.send(JSON.stringify({ type: 'ready' }));
    });
    ws.onClose((code?: number, reason?: string) => closes.push({ code: code ?? -1, reason: String(reason ?? '') }));
  });
  await page.goto('/');
  await expect(page.locator('#host-list')).toContainText('Tokyo production');
  return { closes };
}

test('标签栏只在会话活跃时出现，且位于工具条与终端之间', async ({ page }) => {
  await fixture(page);
  const tabs = page.locator('#session-tabs');

  await expect(tabs).toBeHidden();

  await page.locator('.connect-host').first().click();
  await expect(tabs).toBeVisible();
  await expect(page.locator('.session-tab')).toHaveCount(1);
  await expect(page.locator('.session-tab-label')).toHaveText('root@192.0.2.10:22');
  await expect(page.locator('.session-tab-dot')).toHaveClass(/connected/);
  await expect(page.locator('.session-tab')).toHaveAttribute('aria-selected', 'true');

  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector('.terminal-toolbar')!.getBoundingClientRect();
    const strip = document.getElementById('session-tabs')!.getBoundingClientRect();
    const stage = document.getElementById('terminal-stage')!.getBoundingClientRect();
    return { toolbarBottom: toolbar.bottom, stripTop: strip.top, stripBottom: strip.bottom, stageTop: stage.top };
  });
  expect(geometry.stripTop).toBeGreaterThanOrEqual(geometry.toolbarBottom - 1);
  expect(geometry.stageTop).toBeGreaterThanOrEqual(geometry.stripBottom - 1);

  // 终端仍撑满剩余空间，且页面没有因为新增一行而产生横向溢出。
  await expect(page.locator('#terminal-stage')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('关闭标签页即断开该 SSH 会话', async ({ page }) => {
  const f = await fixture(page);

  await page.locator('.connect-host').first().click();
  await expect(page.locator('#session-tabs')).toBeVisible();

  await page.locator('.session-tab-close').click();
  await expect.poll(() => f.closes.length).toBe(1);
  expect(f.closes[0].code).toBe(1000);
  expect(f.closes[0].reason).toBe('Disconnected by user');

  await expect(page.locator('#session-tabs')).toBeHidden();
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'connect');
});

test('终端实例在标签栏之下仍然自适应且不遮挡空态', async ({ page }) => {
  await fixture(page);

  await page.locator('.connect-host').first().click();
  await expect(page.locator('#session-tabs')).toBeVisible();

  const host = page.locator('.term-instance');
  await expect(host).toHaveCount(1);
  // xterm 渲染出的画布必须落在 stage 的可见区域内：验证 fit() 生效而非 0 尺寸。
  const metrics = await page.evaluate(() => {
    const stage = document.getElementById('terminal-stage')!.getBoundingClientRect();
    const canvas = document.querySelector('.term-instance .xterm-rows')!.getBoundingClientRect();
    return { stageWidth: stage.width, stageHeight: stage.height, canvasWidth: canvas.width, canvasHeight: canvas.height };
  });
  expect(metrics.canvasWidth).toBeGreaterThan(0);
  expect(metrics.canvasHeight).toBeGreaterThan(0);
  expect(metrics.canvasHeight).toBeLessThanOrEqual(metrics.stageHeight);
  expect(metrics.canvasWidth).toBeLessThanOrEqual(metrics.stageWidth);
});
