import { test, expect, type Page } from '@playwright/test';
import { sessionFixture } from './session-fixture';

// The session UI has three responsive tiers (wide / tablet / narrow). They are
// asserted on the desktop engine only, so the mobile emulation does not get in
// the way of the viewport tiers being tested.
test.skip(({ isMobile }) => isMobile, '会话 UI 的三档断点统一在桌面引擎上验证');

const TIERS = [
  { label: '1440 宽屏', width: 1440, height: 900 },
  { label: '860 中档', width: 860, height: 1000 },
  { label: '375 窄屏', width: 375, height: 812 },
];

const ALPHA = 'Tokyo production';
const BETA = 'Singapore backup';

function alphaRow(page: Page) {
  return page.locator('.host-row', { hasText: ALPHA });
}

async function backToOverview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '← 主机总览' }).click();
  await expect(page.locator('#hosts-heading')).toBeVisible();
}

for (const tier of TIERS) {
  test.describe(`Dashboard 会话 UI · ${tier.label}`, () => {
    test.use({ viewport: { width: tier.width, height: tier.height } });

    test('主机行徽标与侧栏徽标都跟着会话数走', async ({ page }) => {
      const f = await sessionFixture(page);

      await page.locator('.connect-host').first().click();
      await expect.poll(() => f.sockets.length).toBe(1);
      await backToOverview(page);

      await expect(alphaRow(page).locator('.host-session-badge')).toHaveText('1');
      await expect(page.locator('#sessions-count')).toHaveText('1');

      // 第二台主机各自计数：总览里的徽标是「这台主机有几条会话」。
      await page.locator('.connect-host').nth(1).click();
      await expect.poll(() => f.sockets.length).toBe(2);
      await backToOverview(page);

      await expect(alphaRow(page).locator('.host-session-badge')).toHaveText('1');
      await expect(page.locator('.host-row', { hasText: BETA }).locator('.host-session-badge')).toHaveText('1');
      await expect(page.locator('#sessions-count')).toHaveText('2');
    });

    test('同一台主机可以再开一个会话，徽标随之累加', async ({ page }) => {
      const f = await sessionFixture(page);

      await page.locator('.connect-host').first().click();
      await expect.poll(() => f.sockets.length).toBe(1);
      await backToOverview(page);

      await alphaRow(page).locator('.host-session-badge').click();
      await expect(page.locator('.session-menu')).toBeVisible();
      await expect(page.locator('.session-menu-row')).toHaveCount(1);

      await page.locator('.session-menu-new').click();
      await expect.poll(() => f.connections.length).toBe(2);
      expect(f.connections[1].host).toBe('192.0.2.10');

      await backToOverview(page);
      await expect(alphaRow(page).locator('.host-session-badge')).toHaveText('2');
      await expect(page.locator('#session-tabs .session-tab')).toHaveCount(2);
    });

    test('下拉菜单切换前台会话，点到别处自动收起', async ({ page }) => {
      const f = await sessionFixture(page);

      await page.locator('.connect-host').first().click();
      await expect.poll(() => f.sockets.length).toBe(1);
      await backToOverview(page);

      const badge = alphaRow(page).locator('.host-session-badge');
      await badge.click();
      const menu = page.locator('.session-menu');
      await expect(menu).toBeVisible();
      await expect(badge).toHaveAttribute('aria-expanded', 'true');

      await menu.locator('[data-activate]').click();
      await expect(menu).toBeHidden();
      await expect(page.locator('#terminal-stage')).toBeVisible();

      // 菜单是浮层：点其它元素应该收起它，而不是盖住那台主机的操作。
      await backToOverview(page);
      await alphaRow(page).locator('.host-session-badge').click();
      await expect(page.locator('.session-menu')).toBeVisible();
      await page.locator('#hosts-heading').click();
      await expect(page.locator('.session-menu')).toBeHidden();
    });

    test('断开会话要走二次确认，取消或確認只影响那一条', async ({ page }) => {
      const f = await sessionFixture(page);

      await page.locator('.connect-host').first().click();
      await expect.poll(() => f.sockets.length).toBe(1);
      await backToOverview(page);
      await page.locator('.connect-host').nth(1).click();
      await expect.poll(() => f.sockets.length).toBe(2);
      await backToOverview(page);

      const dialog = page.locator('#session-disconnect-dialog');
      await alphaRow(page).locator('.host-session-badge').click();
      await page.locator('.session-menu').locator('[data-disconnect]').click();
      await expect(dialog).toBeVisible();

      // 取消就是取消：两条会话都还在。
      await page.locator('#session-disconnect-cancel').click();
      await expect(dialog).toBeHidden();
      expect(f.closes.filter((code) => code !== undefined)).toHaveLength(0);

      await alphaRow(page).locator('.host-session-badge').click();
      await page.locator('.session-menu').locator('[data-disconnect]').click();
      await page.locator('#session-disconnect-confirm').click();
      await expect.poll(() => f.closes.filter((code) => code !== undefined).length).toBe(1);
      // beta 是另一条会话，它不受影响。
      expect(f.closes[1]).toBeUndefined();
      await expect(page.locator('#sessions-count')).toHaveText('1');
      await expect(page.locator('.host-row', { hasText: BETA }).locator('.host-session-badge')).toHaveText('1');
    });

    test('会话中心列出全部会话并标出当前前台', async ({ page }) => {
      const f = await sessionFixture(page);

      await page.locator('.connect-host').first().click();
      await expect.poll(() => f.sockets.length).toBe(1);
      await backToOverview(page);
      await page.locator('.connect-host').nth(1).click();
      await expect.poll(() => f.sockets.length).toBe(2);

      await page.getByRole('button', { name: '← 主机总览' }).click();
      await page.locator('#rail-sessions').click();
      const pane = page.locator('#sessions-pane');
      await expect(pane).toBeVisible();
      await expect(page.locator('#sessions-total')).toHaveText('2 个会话');
      await expect(page.locator('.session-card')).toHaveCount(2);
      // 最后conn 的那条就是前台，会话中心要标出来。
      await expect(pane.locator('.session-card.current')).toContainText(BETA);

      // 切换前台：进一次工作台（这就是「切换」的意义），回来后徽标应挪到另一张卡上。
      await pane.locator('.session-card', { hasText: ALPHA }).getByRole('button', { name: /切换到会话/ }).click();
      await expect(page.locator('#terminal-stage')).toBeVisible();
      await page.getByRole('button', { name: '← 主机总览' }).click();
      await page.locator('#rail-sessions').click();
      await expect(pane.locator('.session-card.current')).toContainText(ALPHA);
      await expect(page.locator('#session-tabs .session-tab')).toHaveCount(2);
    });

    test('首页 logo 刷新首页，不把已有会话接回终端页', async ({ page }) => {
      const f = await sessionFixture(page);

      await page.locator('.connect-host').first().click();
      await expect.poll(() => f.sockets.length).toBe(1);
      await backToOverview(page);
      await expect(page.locator('#sessions-count')).toHaveText('1');

      // It has to be a button: a link here would reload "/", and the startup
      // session restore would then bounce the user straight into the terminal.
      const logo = page.locator('.home-brand');
      expect(await logo.evaluate((element) => element.tagName)).toBe('BUTTON');

      const before = f.requests.hosts;
      await logo.click();

      // Still on 首页, still showing the live session, and it really refetched.
      await expect(page.locator('#hosts-heading')).toBeVisible();
      await expect(page.locator('#terminal-stage')).toBeHidden();
      await expect(page.locator('#sessions-count')).toHaveText('1');
      await expect.poll(() => f.requests.hosts).toBeGreaterThan(before);
      await expect(page.locator('.connect-host').first()).toBeVisible();
    });

    test('会话 UI 在三档断点下都不产生横向溢出', async ({ page }) => {
      const f = await sessionFixture(page);

      await page.locator('.connect-host').first().click();
      await expect.poll(() => f.sockets.length).toBe(1);
      await page.getByRole('button', { name: '← 主机总览' }).click();

      await alphaRow(page).locator('.host-session-badge').click();
      await expect(page.locator('.session-menu')).toBeVisible();
      const noOverflow = async (): Promise<boolean> => page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      expect(await noOverflow()).toBeTruthy();

      await page.keyboard.press('Escape');
      await page.locator('#rail-sessions').click();
      await expect(page.locator('#sessions-pane')).toBeVisible();
      expect(await noOverflow()).toBeTruthy();
    });
  });
}
