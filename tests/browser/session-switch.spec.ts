import { test, expect, type Page } from '@playwright/test';
import { sessionFixture } from './session-fixture';

/**
 * Switching between live sessions. The old single-connection world asked "is
 * anyone connected?"; every question here is "does *this* host have a session?",
 * and switching must move the front without disturbing what stays behind.
 */

const ALPHA = 'root@192.0.2.10:22';
const BETA = 'root@192.0.2.20:22';

/** A successful dial collapses the side panel, so open it before touching the host list. */
async function openPanel(page: Page): Promise<void> {
  const toggle = page.locator('#panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function backToOverview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '← 主机总览' }).click();
  await expect(page.locator('#hosts-heading')).toBeVisible();
}

function tab(page: Page, label: string) {
  return page.locator('.session-tab').filter({ has: page.locator('.session-tab-label', { hasText: label }) });
}

async function bringToFront(page: Page, label: string): Promise<void> {
  await tab(page, label).locator('.session-tab-label').click();
  await expect(page.locator('.session-tab[aria-selected="true"] .session-tab-label')).toHaveText(label);
}

async function typeInFront(page: Page, text: string): Promise<void> {
  await page.locator('.term-instance:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
}

test('连接按钮说的是“这台主机有没有会话”，而不是“全局有没有连接”', async ({ page }) => {
  const f = await sessionFixture(page);
  const button = page.locator('#connect-button');

  await page.locator('.connect-host').first().click();
  await expect(button).toHaveAttribute('data-action', 'disconnect');
  await expect.poll(() => f.connections.length).toBe(1);
  expect(f.connections[0].host).toBe('192.0.2.10');

  // 切到另一台主机：本机会话来自第一台，按钮应该回到“连接”。
  await openPanel(page);
  await page.locator('[data-profile-id="beta"]').click();
  await expect(button).toHaveAttribute('data-action', 'connect');
  await expect(page.locator('#host')).toHaveValue('192.0.2.20');
  await expect.poll(() => f.connections.length).toBe(1);

  // 点下去是给 beta 单开一条会话，alpha 继续在线。
  await button.click();
  await expect.poll(() => f.connections.length).toBe(2);
  expect(f.connections[1].host).toBe('192.0.2.20');
  await expect.poll(() => f.sockets.length).toBe(2);
  expect(f.closes[0]).toBeUndefined();
  await expect(button).toHaveAttribute('data-action', 'disconnect');
});

test('已在通话的主机重新选中显示“断开”，且不会重复拨号', async ({ page }) => {
  const f = await sessionFixture(page);
  const button = page.locator('#connect-button');

  await page.locator('.connect-host').first().click();
  await expect(button).toHaveAttribute('data-action', 'disconnect');

  await openPanel(page);
  await page.locator('[data-profile-id="alpha"]').click();
  await expect(button).toHaveAttribute('data-action', 'disconnect');
  await button.click();
  await expect.poll(() => f.connections.length).toBe(1);
});

test('返回主机总览只是 detach：回到同一台主机继续原来的 shell', async ({ page }) => {
  const f = await sessionFixture(page);
  const button = page.locator('#connect-button');

  await page.locator('.connect-host').first().click();
  await expect(button).toHaveAttribute('data-action', 'disconnect');
  await expect.poll(() => f.connections.length).toBe(1);

  // socket 保持打开，不会有新的握手。
  await backToOverview(page);
  await expect.poll(() => f.connections.length).toBe(1);
  await expect.poll(() => f.sockets.length).toBe(1);

  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.connections.length).toBe(1);
  await expect.poll(() => f.sockets.length).toBe(1);
  await expect(button).toHaveAttribute('data-action', 'disconnect');
});

test('切到另一台主机会新开一条会话，旧的那个原封不动', async ({ page }) => {
  const f = await sessionFixture(page);

  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.connections.length).toBe(1);
  await backToOverview(page);
  await page.locator('.connect-host').nth(1).click();
  await expect.poll(() => f.connections.length).toBe(2);
  expect(f.connections[1].host).toBe('192.0.2.20');
  await expect.poll(() => f.sockets.length).toBe(2);
  expect(f.closes[0]).toBeUndefined();
  await expect(page.locator('#session-tabs .session-tab')).toHaveCount(2);
});

test('在标签之间来回切换只换前台，不重连任何一条会话', async ({ page }) => {
  const f = await sessionFixture(page);

  await page.locator('.connect-host').first().click();
  await backToOverview(page);
  await page.locator('.connect-host').nth(1).click();
  await expect.poll(() => f.sockets.length).toBe(2);

  for (const label of [ALPHA, BETA, ALPHA]) await bringToFront(page, label);

  // 换前台不该有任何网络代价：还是两条 socket，两次握手，零关闭。
  await expect.poll(() => f.sockets.length).toBe(2);
  expect(f.connections).toHaveLength(2);
  expect(f.closes.filter((code) => code !== undefined)).toHaveLength(0);

  // 表单跟着前台走：按钮与后续操作说的必须是用户正在看的那条会话。
  await expect(page.locator('#host')).toHaveValue('192.0.2.10');
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'disconnect');
});

test('关闭其中一个会话标签，另一个会话继续存活', async ({ page }) => {
  const f = await sessionFixture(page);

  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.connections.length).toBe(1);
  await backToOverview(page);
  await page.locator('.connect-host').nth(1).click();
  await expect.poll(() => f.sockets.length).toBe(2);
  await expect(page.locator('.session-tab')).toHaveCount(2);

  // 关掉后台那条 alpha：只有它的 socket 收到客户端关闭。
  await tab(page, ALPHA).locator('.session-tab-close').click();
  await expect.poll(() => f.closes.filter((code) => code !== undefined).length).toBe(1);
  expect(f.closes[0]).toBe(1000);
  expect(f.closes[1]).toBeUndefined();

  await expect(page.locator('.session-tab')).toHaveCount(1);
  await expect(page.locator('.session-tab-label')).toHaveText(BETA);
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'disconnect');
});

test('关掉正在看的那条会话后，剩下的那条接管工作台', async ({ page }) => {
  const f = await sessionFixture(page);

  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.sockets.length).toBe(1);
  await backToOverview(page);
  await page.locator('.connect-host').nth(1).click();
  await expect.poll(() => f.sockets.length).toBe(2);

  // 被关闭的正是前台 beta：终端、面板与状态都要交给还在的 alpha。
  await page.locator('.session-tab[aria-selected="true"] .session-tab-close').click();
  await expect(page.locator('.session-tab')).toHaveCount(1);
  await expect(page.locator('.session-tab-label')).toHaveText(ALPHA);
  await expect(page.locator('.session-tab[aria-selected="true"] .session-tab-label')).toHaveText(ALPHA);
  expect(f.closes[1]).toBe(1000);
  expect(f.closes[0]).toBeUndefined();

  // 接管要落到实处：此后敲键盘必须进了 alpha 的通道。
  await typeInFront(page, 'pwd');
  await expect.poll(() => f.typed(0)).toContain('pwd');
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'disconnect');
});
