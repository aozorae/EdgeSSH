import { test, expect, type Page } from '@playwright/test';
import { sessionFixture } from './session-fixture';

/**
 * What happens when the page itself goes away. A session used to be exactly as
 * mortal as its tab: reload, a navigation, a dropped network — all of them took
 * the running shell with them. These are the cases where it should not.
 */

const ALPHA = 'root@192.0.2.10:22';
const BETA = 'root@192.0.2.20:22';

function tab(page: Page, label: string) {
  return page.locator('.session-tab').filter({ has: page.locator('.session-tab-label', { hasText: label }) });
}

async function backToOverview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '← 主机总览' }).click();
  await expect(page.locator('#hosts-heading')).toBeVisible();
}

/** A successful dial collapses the connection panel, so open it before touching its controls. */
async function openPanel(page: Page): Promise<void> {
  const toggle = page.locator('#panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function typeInFront(page: Page, text: string): Promise<void> {
  await page.locator('.term-instance:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
}

test('刷新页面后回到同一个 shell：不重新认证，终端立刻可用', async ({ page }) => {
  const f = await sessionFixture(page);
  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.connections.length).toBe(1);
  const sessionId = new URL(f.sockets[0].url()).searchParams.get('session');
  expect(sessionId).toBeTruthy();

  await page.reload();

  // The tab comes back on its own, asking for the shell it had — not a new one.
  await expect(page.locator('#session-tabs .session-tab')).toHaveCount(1);
  await expect.poll(() => f.restoreCalls.length).toBe(1);
  expect(f.restoreCalls[0]).toBe(sessionId);

  // No second dial, no credentials sent again. Just "give me my shell back".
  await expect.poll(() => f.frames[1].length).toBeGreaterThan(0);
  expect(f.frames[1][0].type).toBe('resume');
  expect(f.connections).toHaveLength(1);

  await expect(page.locator('.session-tab-label')).toHaveText(ALPHA);
  // And it really is the restored uplink that receives what is typed now.
  await typeInFront(page, 'pwd');
  await expect.poll(() => f.typed(1)).toContain('pwd');
  expect(f.typed(0)).not.toContain('pwd');
});

test('多条会话一起回来，各自还走自己的通道', async ({ page }) => {
  const f = await sessionFixture(page);
  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.connections.length).toBe(1);
  await backToOverview(page);
  await page.locator('.connect-host').nth(1).click();
  await expect.poll(() => f.sockets.length).toBe(2);

  await page.reload();

  // Both survive, each under its own host.
  await expect(page.locator('#session-tabs .session-tab')).toHaveCount(2);
  await expect(page.locator('.session-tab-label').nth(0)).toHaveText(ALPHA);
  await expect(page.locator('.session-tab-label').nth(1)).toHaveText(BETA);
  await expect.poll(() => f.restoreCalls.length).toBe(2);

  await tab(page, BETA).locator('.session-tab-label').click();
  await typeInFront(page, 'whoami');
  // Only the newest sockets (the restored ones) see the keystrokes.
  await expect.poll(() => f.typed(2) + f.typed(3)).toContain('whoami');
  expect(f.typed(0) + f.typed(1)).not.toContain('whoami');
});

test('服务端已经不再持有这个 shell 时，说明会话已结束，并且不再反复重试', async ({ page }) => {
  const f = await sessionFixture(page);
  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.connections.length).toBe(1);

  // The retention window ran out while the tab was away: nothing left to resume.
  f.resumable.clear();

  await page.reload();
  await expect(page.locator('#host-list')).toContainText('Tokyo production');

  // Fail politely: say what happened, stay on the overview, invent no session.
  await expect(page.locator('#event-log')).toContainText('会话已结束');
  await expect(page.locator('.session-tab')).toHaveCount(0);
  await expect.poll(() => f.restoreCalls.length).toBe(1);

  // And do not keep asking for something the server no longer has.
  await page.reload();
  await expect(page.locator('#host-list')).toContainText('Tokyo production');
  await expect(page.locator('.session-tab')).toHaveCount(0);
  expect(f.restoreCalls).toHaveLength(1);
});

test('主动断开的会话不会被悄悄接回来', async ({ page }) => {
  const f = await sessionFixture(page);
  await page.locator('.connect-host').first().click();
  await expect.poll(() => f.connections.length).toBe(1);

  // An intentional disconnect ends everything, retention included.
  await openPanel(page);
  await page.locator('#connect-button').click();
  await expect.poll(() => f.closes.filter((code) => code !== undefined).length).toBe(1);

  await page.reload();
  await expect(page.locator('#host-list')).toContainText('Tokyo production');
  await expect(page.locator('.session-tab')).toHaveCount(0);
  expect(f.restoreCalls).toHaveLength(0);
});
