import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The chips next to the map heading count hosts per continent and frame one on
 * the map: the globe turns to it and holds still, the unrolled map crops down
 * to it. Nothing about the shape of the world changes — only what is framed.
 */

const base = {
  id: 'x', name: '', host: '192.0.2.1', port: 22, username: 'root', group: '测试',
  authMethod: 'password', initialCommand: '', termType: 'xterm-256color', encoding: 'utf-8',
  fingerprint: '', system: null, hasCredential: true, updatedAt: Date.now(),
};

const place = (latitude: number, longitude: number, city: string, countryCode: string) =>
  ({ latitude, longitude, city, country: city, countryCode });

const hosts = [
  { ...base, id: 'a', name: 'Tokyo production', location: place(35.68, 139.69, '东京', 'JP') },
  { ...base, id: 'b', name: 'Singapore backup', location: place(1.35, 103.82, '新加坡', 'SG') },
  { ...base, id: 'c', name: 'Frankfurt edge', location: place(50.11, 8.68, '法兰克福', 'DE') },
  { ...base, id: 'd', name: 'Oregon build', location: place(45.52, -122.68, '波特兰', 'US') },
  { ...base, id: 'e', name: 'São Paulo cache', location: place(-23.55, -46.63, '圣保罗', 'BR') },
  { ...base, id: 'f', name: 'Homelab without a place', location: null },
];

async function openHome(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/hosts') return route.fulfill({ json: { hosts } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await expect(page.locator('#host-globe canvas')).toBeVisible();
  await page.waitForTimeout(800);
}

const chip = (page: Page, label: string) => page.locator('#globe-stats .globe-stat', { hasText: label }).first();

/** Pixel checksum — any movement at all changes it. */
const fingerprint = (page: Page) => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>('#host-globe canvas')!;
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i += 97) hash = ((hash ^ data[i]) * 16777619) >>> 0;
  return `${width}x${height}:${hash}`;
});

const visibleMarkers = (page: Page) => page.locator('.globe-marker:visible');

/** One marker's own visibility, by the host name inside its aria-label. */
const marker = (page: Page, name: string) => page.locator(`.globe-marker[aria-label*="${name}"]`);

test('每个有主机的大洲各一个统计，位置未知只计数不可点', async ({ page }) => {
  await openHome(page);
  await expect(page.locator('#globe-stats .globe-stat')).toHaveCount(5);
  await expect(page.locator('#globe-stats .globe-stat')).toHaveText(['亚洲：2', '欧洲：1', '北美洲：1', '南美洲：1', '位置未知：1']);
  // There is nowhere to turn towards for a host that never resolved.
  await expect(chip(page, '位置未知')).toBeDisabled();
  await expect(chip(page, '亚洲')).toBeEnabled();
});

test('选中大洲后地球停在它上面，取消后恢复自转', async ({ page }) => {
  await openHome(page);
  const spinning = await fingerprint(page);
  await page.waitForTimeout(700);
  expect(await fingerprint(page)).not.toBe(spinning); // 默认自转

  await chip(page, '亚洲').click();
  await expect(chip(page, '亚洲')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1400); // 转过去的时间
  const held = await fingerprint(page);
  await page.waitForTimeout(800);
  expect(await fingerprint(page)).toBe(held); // 转到位后不再有帧

  // 亚洲的两台转到了正面，南北美洲已经转到背面。
  await expect(marker(page, 'Tokyo')).toBeVisible();
  await expect(marker(page, 'Singapore')).toBeVisible();
  await expect(marker(page, 'Oregon')).toBeHidden();
  await expect(marker(page, 'São Paulo')).toBeHidden();

  await chip(page, '亚洲').click(); // 再点一次就是放开
  await expect(chip(page, '亚洲')).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(1400);
  const released = await fingerprint(page);
  await page.waitForTimeout(700);
  expect(await fingerprint(page)).not.toBe(released); // 重新开始自转
});

test('平铺地图上聚焦大洲时只画它，取消后回到世界地图', async ({ page }) => {
  await openHome(page);
  await page.locator('#globe-view').click();
  await expect(page.locator('#globe-view')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1200);
  await expect(visibleMarkers(page)).toHaveCount(5); // 未知的那台没有地理位置，也没有位置就没有标记

  await chip(page, '欧洲').click();
  await page.waitForTimeout(1400); // 放大到欧洲，画布上只剩它
  await expect(visibleMarkers(page)).toHaveCount(1);
  await expect(visibleMarkers(page)).toContainText('Frankfurt');
  await expect(marker(page, 'Tokyo')).toBeHidden();
  await expect(marker(page, 'Oregon')).toBeHidden();
  await expect(marker(page, 'São Paulo')).toBeHidden();

  await chip(page, '欧洲').click();
  await page.waitForTimeout(1400);
  await expect(visibleMarkers(page)).toHaveCount(5);
});

test('带着选中的大洲切换形态时，新形态仍框住它', async ({ page }) => {
  await openHome(page);
  await chip(page, '亚洲').click();
  await expect(chip(page, '亚洲')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1400);

  await page.locator('#globe-view').click(); // 展开成平铺
  await expect(page.locator('#globe-view')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1400);
  await expect(marker(page, 'Tokyo')).toBeVisible();
  await expect(marker(page, 'Singapore')).toBeVisible();
  await expect(marker(page, 'Oregon')).toBeHidden();
  await expect(marker(page, 'São Paulo')).toBeHidden();

  await page.locator('#globe-view').click(); // 收回球体，依然对着亚洲且不转
  await expect(page.locator('#globe-view')).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(1400);
  const held = await fingerprint(page);
  await page.waitForTimeout(800);
  expect(await fingerprint(page)).toBe(held);
  await expect(marker(page, 'Singapore')).toBeVisible();
});

test('点位置未知不会改变地图', async ({ page }) => {
  await openHome(page);
  await page.locator('#globe-view').click(); // 平铺态是静止的，像素指纹才可比
  await expect(page.locator('#globe-view')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(1200);
  const before = await fingerprint(page);
  const unknown = chip(page, '位置未知');
  await expect(unknown).toBeDisabled();
  await unknown.click({ force: true, trial: true });
  await expect(unknown).toHaveAttribute('aria-pressed', 'false');
  expect(await fingerprint(page)).toBe(before);
});
