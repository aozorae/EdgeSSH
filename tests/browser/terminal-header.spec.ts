import { test, expect } from '@playwright/test';
import { sessionFixture } from './session-fixture';

/**
 * The terminal header answers "which host am I on", and it answers it the way the
 * host list does — flag, saved name, address on one line, shell state on the
 * next. Sitting next to each other, the two had no business reading differently.
 */

const tokyo = { latitude: 35.68, longitude: 139.69, city: '东京', country: '日本', countryCode: 'JP' };

const connectFirst = async (page: import('@playwright/test').Page) => {
  await page.locator('.connect-host').first().click();
  await expect(page.locator('#terminal-stage')).toBeVisible();
};

test('终端顶栏沿用主机列表的国旗与名称，第二行留给 shell 状态', async ({ page }) => {
  await sessionFixture(page, { locations: [tokyo] });
  await connectFirst(page);

  await expect(page.locator('#session-title')).toHaveText('Tokyo production · root@192.0.2.10:22');
  await expect(page.locator('#session-subtitle')).toHaveText('交互式 Shell 已就绪');

  const flag = page.locator('#session-flag');
  await expect(flag).toBeVisible();
  await expect(flag.locator('img')).toHaveAttribute('src', /jp\.svg$/);
  await expect(flag).toHaveAttribute('aria-label', '东京 · 日本');
});

test('主机没有位置信息时，国旗整块让位而不是留个占位地球', async ({ page }) => {
  await sessionFixture(page);
  await connectFirst(page);
  await expect(page.locator('#session-title')).toHaveText('Tokyo production · root@192.0.2.10:22');
  await expect(page.locator('#session-flag')).toBeHidden();
});
