import { test, expect } from '@playwright/test';

/**
 * The home map has two shapes: the spinning globe and the unrolled map. The
 * unrolled one shows every meridian at once, so it must hold still — no spin,
 * no drag, nothing left to pause.
 */

const base = {
  id: 'x', name: '', host: '192.0.2.1', port: 22, username: 'root', group: '测试',
  authMethod: 'password', initialCommand: '', termType: 'xterm-256color', encoding: 'utf-8',
  fingerprint: '', system: null, hasCredential: true, updatedAt: Date.now(),
};

const place = (lat: number, lon: number, city: string, country: string, cc: string) => ({
  latitude: lat, longitude: lon, city, country, countryCode: cc,
});

/** Ordered north-to-south, which also happens to be west-to-east. */
const hosts = [
  { ...base, id: 'c', name: 'Frankfurt edge', location: place(50.11, -122.68, '法兰克福', '德国', 'DE') },
  { ...base, id: 'e', name: 'Oregon build', location: place(45.52, -46.63, '波特兰', '美国', 'US') },
  { ...base, id: 'a', name: 'Tokyo production', location: place(35.68, 8.68, '东京', '日本', 'JP') },
  { ...base, id: 'b', name: 'Singapore backup', location: place(1.35, 103.82, '新加坡', '新加坡', 'SG') },
  { ...base, id: 'd', name: 'São Paulo cache', location: place(-23.55, 139.69, '圣保罗', '巴西', 'BR') },
];

/** Drawn extents read straight off the canvas pixels, in CSS pixels. */
const extents = (selector: string) => {
  const canvas = document.querySelector<HTMLCanvasElement>(selector)!;
  const { width, height } = canvas;
  // Wide rather than square: the globe measures itself against the short side,
  // the unrolled map against the width.
  const css = canvas.clientWidth, cssH = canvas.clientHeight;
  const scale = width / css;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { css, cssH, short: Math.min(css, cssH), x: minX / scale, y: minY / scale, w: (maxX - minX + 1) / scale, h: (maxY - minY + 1) / scale };
};

/**
 * Pixel checksum. Sampled rather than toDataURL(): the encoder occasionally hands
 * back an empty string under mobile emulation, which would look like a repaint.
 */
const fingerprint = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>('#host-globe canvas')!;
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i += 97) hash = ((hash ^ data[i]) * 16777619) >>> 0;
  return `${width}x${height}:${hash}`;
});

/**
 * Median gap between neighbouring dots in three latitude bands, in CSS pixels.
 * Each scanline only walks short hops — oceans read as much wider gaps and are
 * skipped — so what is left is the lattice pitch. The globe's rows thin towards
 * the poles (equal area on a sphere), which unrolled into visible streaks before
 * the map got a lattice of its own: even in one direction means even in the other
 * on a 2:1 projection.
 */
const dotPitch = (selector: string) => {
  const canvas = document.querySelector<HTMLCanvasElement>(selector)!;
  const { width, height } = canvas;
  const scale = width / canvas.clientWidth;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const dot = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return data[i + 3] > 40 && data[i] - data[i + 2] > 22; // 橙色圆点；纸面是中性的
  };
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!dot(x, y)) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const band = (from: number, to: number) => {
    const gaps: number[] = [];
    for (let y = Math.round(from); y < Math.round(to); y += 2) {
      let previous = -1, open = false;
      for (let x = minX; x <= maxX; x += 1) {
        if (!dot(x, y)) { open = false; continue; }
        if (!open && previous >= 0 && x - previous < 20) gaps.push(x - previous);
        if (!open) previous = x;
        open = true;
      }
    }
    gaps.sort((a, b) => a - b);
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] / scale : 0;
  };
  return {
    top: band(minY + 2, minY + (maxY - minY) * 0.2),
    middle: band(minY + (maxY - minY) * 0.45, minY + (maxY - minY) * 0.55),
    bottom: band(maxY - (maxY - minY) * 0.2, maxY - 2),
  };
};

async function openHome(page: import('@playwright/test').Page) {
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

/**
 * Drag the canvas at a point no marker occupies — markers are buttons stacked
 * over the canvas, and pressing one would just connect to that host.
 */
const dragMap = async (page: import('@playwright/test').Page) => {
  const origin = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#host-globe canvas')!;
    const box = canvas.getBoundingClientRect();
    const markers = [...document.querySelectorAll('.globe-marker')].map((node) => node.getBoundingClientRect());
    for (let ry = 0.15; ry <= 0.85; ry += 0.1) {
      for (let rx = 0.15; rx <= 0.85; rx += 0.1) {
        const x = box.x + box.width * rx, y = box.y + box.height * ry;
        const clear = markers.every((m) => x < m.left - 40 || x > m.right + 40 || y < m.top - 40 || y > m.bottom + 40);
        if (clear) return { x, y };
      }
    }
    throw new Error('no marker-free point on the map');
  });
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 80, origin.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
};

test.describe('地图两种形态', () => {
  test('球体自转且可拖动', async ({ page }) => {
    await openHome(page);
    const shape = await page.evaluate(extents, '#host-globe canvas');
    expect(Math.abs(shape.w - shape.h)).toBeLessThan(3);
    // 0.81 of the shorter side is the circle's diameter; allow for its 0.8px stroke.
    expect(shape.w / shape.short).toBeGreaterThan(0.8);
    expect(shape.w / shape.short).toBeLessThan(0.83);

    const before = await fingerprint(page);
    await page.waitForTimeout(700);
    expect(await fingerprint(page)).not.toBe(before);

    await dragMap(page);
    expect(await fingerprint(page)).not.toBe(before);
  });

  test('平铺态静止、不可拖动，且所有浮标可见', async ({ page }) => {
    await openHome(page);
    await page.locator('#globe-view').click();
    await expect(page.locator('#globe-view')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1200);

    const shape = await page.evaluate(extents, '#host-globe canvas');
    // The globe used the middle 81% of the canvas and unrolled into a strip of
    // the same width; the map takes the column's full width instead — about a
    // quarter more map than the sphere could ever offer — keeping 2:1 and the
    // vertical centring. Allow for its 0.8px stroke.
    expect(shape.w / shape.css).toBeGreaterThan(0.98);
    expect(shape.w / shape.css).toBeLessThan(1.01);
    expect(shape.h / shape.w).toBeCloseTo(0.5, 1);
    expect(Math.abs(shape.y - (shape.cssH - shape.h) / 2)).toBeLessThan(3);

    // Even spacing everywhere, equator included: one step in both directions.
    const pitch = await page.evaluate(dotPitch, '#host-globe canvas');
    expect(Math.abs(pitch.top - pitch.middle)).toBeLessThan(2);
    expect(Math.abs(pitch.bottom - pitch.middle)).toBeLessThan(2);

    const settled = await fingerprint(page);
    await page.waitForTimeout(800);
    expect(await fingerprint(page)).toBe(settled); // no frame loop left running
    await dragMap(page);
    expect(await fingerprint(page)).toBe(settled);

    // Still on 首页 — a stray marker click would have pulled us into a session.
    await expect(page.locator('#dashboard')).toBeVisible();
    // Nothing spins, so there is nothing to pause.
    await expect(page.locator('#pause-globe')).toBeHidden();
    await expect(page.locator('#globe-view')).toBeVisible();

    const boxes = await page.locator('.globe-marker:visible').evaluateAll((nodes) =>
      nodes.map((node) => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y }; }));
    expect(boxes).toHaveLength(5);
    // North is up and east is right: both orderings follow the host list.
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y);
      expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x);
    }
  });

  test('形态选择会被记住', async ({ page }) => {
    await openHome(page);
    await page.locator('#globe-view').click();
    await expect(page.locator('#globe-view')).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.locator('#host-globe canvas')).toBeVisible();
    await expect(page.locator('#globe-view')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#globe-view')).toHaveText('收回球体');
    await page.waitForTimeout(500);
    const shape = await page.evaluate(extents, '#host-globe canvas');
    expect(shape.h / shape.w).toBeCloseTo(0.5, 1);
  });
});
