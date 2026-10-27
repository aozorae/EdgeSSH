import { test, expect, type Page } from '@playwright/test';
import { sessionFixture } from './session-fixture';

/**
 * End-to-end proof that several sessions really are several sessions: each owns
 * a socket, an xterm host and its own share of the single set of widgets. The
 * per-view pieces live in their own specs (file-session, dashboard-sessions,
 * session-switch); this file covers what only emerges when they run together.
 */

const ALPHA = 'root@192.0.2.10:22';
const BETA = 'root@192.0.2.20:22';

async function backToOverview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '← 主机总览' }).click();
  await expect(page.locator('#hosts-heading')).toBeVisible();
}

async function connectIndex(page: Page, index: number): Promise<void> {
  await page.locator('.connect-host').nth(index).click();
  await expect(page.locator('#terminal-stage')).toBeVisible();
}

function tab(page: Page, label: string) {
  return page.locator('.session-tab').filter({ has: page.locator('.session-tab-label', { hasText: label }) });
}

async function bringToFront(page: Page, label: string): Promise<void> {
  await tab(page, label).locator('.session-tab-label').click();
  await expect(page.locator('.session-tab[aria-selected="true"] .session-tab-label')).toHaveText(label);
}

/** Types into whichever terminal the user is actually looking at. */
async function typeInFront(page: Page, text: string): Promise<void> {
  await page.locator('.term-instance:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
}

test('键盘输入只交给前台会话的那条通道', async ({ page }) => {
  const f = await sessionFixture(page);
  await connectIndex(page, 0);
  await backToOverview(page);
  await connectIndex(page, 1);
  await expect.poll(() => f.sockets.length).toBe(2);

  // 前台是 beta：按键只能出现在它的 socket 上。
  await typeInFront(page, 'pwd');
  await expect.poll(() => f.typed(1)).toContain('pwd');
  expect(f.typed(0)).toBe('');

  await bringToFront(page, ALPHA);
  await typeInFront(page, 'ls -l');
  await expect.poll(() => f.typed(0)).toContain('ls -l');
  expect(f.typed(1)).not.toContain('ls -l');
});

test('每个会话各占一个终端实例，切换只让前台那个可见', async ({ page }) => {
  const f = await sessionFixture(page);
  await connectIndex(page, 0);
  await backToOverview(page);
  await connectIndex(page, 1);
  await expect.poll(() => f.sockets.length).toBe(2);

  const instances = page.locator('.term-instance');
  await expect(instances).toHaveCount(2);
  await expect(page.locator('.term-instance:not([hidden])')).toHaveCount(1);
  await expect(tab(page, BETA)).toHaveAttribute('aria-selected', 'true');

  await bringToFront(page, ALPHA);
  // 还是两个实例——没有新建也没有销毁，只是前台换了人。
  await expect(instances).toHaveCount(2);
  await expect(page.locator('.term-instance:not([hidden])')).toHaveCount(1);
  await expect(tab(page, ALPHA)).toHaveAttribute('aria-selected', 'true');

  const canvas = await page.locator('.term-instance:not([hidden]) .xterm-rows').boundingBox();
  const stage = await page.locator('#terminal-stage').boundingBox();
  expect(canvas!.width).toBeGreaterThan(0);
  expect(canvas!.height).toBeGreaterThan(0);
  expect(canvas!.height).toBeLessThanOrEqual(stage!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('后台会话的服务端消息不会糊到共享事件日志上', async ({ page }) => {
  const f = await sessionFixture(page);
  await connectIndex(page, 0);
  await backToOverview(page);
  await connectIndex(page, 1);
  await expect.poll(() => f.sockets.length).toBe(2);

  const log = page.locator('#event-log');
  // alpha 现在是后台会话：它的状态更新没有资格改写用户正在看的那份日志。
  f.sockets[0].send(JSON.stringify({ type: 'status', message: '只有那条会话自己该看到' }));
  f.sockets[1].send(JSON.stringify({ type: 'status', message: '前台会话的可见消息' }));
  await expect(log).toContainText('前台会话的可见消息');
  await expect(log).not.toContainText('只有那条会话自己该看到');

  // 把它换到前台：同一通道此后的消息照常记录。
  await bringToFront(page, ALPHA);
  f.sockets[0].send(JSON.stringify({ type: 'status', message: '现在轮到前台会话说话' }));
  await expect(log).toContainText('现在轮到前台会话说话');
});

test('同一台主机开到第 3 条会话后，入口说明为什么不能再开', async ({ page }) => {
  const f = await sessionFixture(page);
  await connectIndex(page, 0);
  await backToOverview(page);

  const badge = page.locator('.host-row', { hasText: 'Tokyo production' }).locator('.host-session-badge');
  for (let round = 0; round < 2; round += 1) {
    await badge.click();
    await page.locator('.session-menu-new').click();
    await expect.poll(() => f.sockets.length).toBe(2 + round);
    await backToOverview(page);
  }

  await badge.click();
  const another = page.locator('.session-menu-new');
  await expect(another).toBeDisabled();
  await expect(another).toHaveAttribute('title', /该主机最多 3 个会话/);
  await page.keyboard.press('Escape');

  await expect.poll(() => f.sockets.length).toBe(3);
  await expect(page.locator('.host-row', { hasText: 'Tokyo production' }).locator('.host-session-badge')).toHaveText('3');
});

test('关掉一条会话后，同一台主机立刻又能开新的', async ({ page }) => {
  const f = await sessionFixture(page);
  await connectIndex(page, 0);
  await backToOverview(page);
  await page.locator('.host-row', { hasText: 'Tokyo production' }).locator('.host-session-badge').click();
  await page.locator('.session-menu-new').click();
  await expect.poll(() => f.sockets.length).toBe(2);

  // 前台那条正是刚开的第二条：关掉它，配额当场释放。
  await page.locator('.session-tab[aria-selected="true"] .session-tab-close').click();
  await expect.poll(() => f.closes.filter((code) => code !== undefined).length).toBe(1);
  await backToOverview(page);

  await page.locator('.host-row', { hasText: 'Tokyo production' }).locator('.host-session-badge').click();
  await expect(page.locator('.session-menu-new')).toBeEnabled();
  await page.locator('.session-menu-new').click();
  await expect.poll(() => f.sockets.length).toBe(3);
  expect(f.closes[0]).toBeUndefined();
});

test('会话总数到上限后拒绝新主机，并告诉用户先断开', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', '连满全局上限属于桌面才有的批量操作');
  const f = await sessionFixture(page, { hostCount: 12 });

  for (let index = 0; index < 10; index += 1) {
    await connectIndex(page, index);
    await backToOverview(page);
  }
  await expect.poll(() => f.sockets.length).toBe(10);
  await expect(page.locator('#sessions-count')).toHaveText('10');

  // 第 11 台：总数到顶。连接没成功就别把用户扔进空工作台，提示要留在总览上。
  await page.locator('.connect-host').nth(10).click();
  await expect(page.locator('#home-notice')).toContainText('会话总数已达上限（10）');
  await expect(page.locator('#hosts-heading')).toBeVisible();
  await expect(page.locator('#terminal-stage')).toBeHidden();
  await expect.poll(() => f.sockets.length).toBe(10);

  // 断开一条之后马上又有位置。
  await page.locator('#rail-sessions').click();
  await page.locator('.session-card').first().locator('[data-disconnect]').click();
  await page.locator('#session-disconnect-confirm').click();
  await expect.poll(() => f.closes.filter((code) => code !== undefined).length).toBe(1);
  await page.locator('#rail-overview').click();
  // 会话退出是异步的：等计数真的掉下来，才算腾出了配额。
  await expect(page.locator('#sessions-count')).toHaveText('9');
  await connectIndex(page, 10);
  await expect.poll(() => f.sockets.length).toBe(11);
});
