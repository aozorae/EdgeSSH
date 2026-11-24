import { test, expect, type Page } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

async function terminalFixture(page: Page) {
  await page.addInitScript(() => {
    const state = { writes: [] as string[], deny: false, fallback: true, legacy: [] as string[] };
    (window as any).__clipboardTest = state;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (state.deny) throw new DOMException('denied', 'NotAllowedError');
        state.writes.push(text);
      },
    } });
    document.execCommand = (command: string) => {
      if (command !== 'copy' || !state.fallback) return false;
      state.legacy.push((document.activeElement as HTMLTextAreaElement).value);
      return true;
    };
  });
  const fixture = await fileFixture(page);
  await expect(page.locator('#files-host')).toBeEnabled();
  await expect(page.locator('#files-host option[value="alpha"]')).toHaveCount(1);
  await connectFiles(page);
  await page.locator('#files-terminal').click();
  // Keep this test focused on terminal hit testing, not the floating snippets UI.
  await page.addStyleTag({ content: '#snippet-panel { display: none !important; }' });
  await expect.poll(() => fixture.calls.some((call) => call.type === 'connect')).toBe(true);
  await expect(page.locator('#terminal-tools')).toBeVisible();
  fixture.sshSockets[0].send(Buffer.from('clipboard-regression-output\r\n'));
  await expect(page.locator('.xterm-rows')).toContainText('clipboard-regression-output');
  return fixture;
}

async function selectAll(page: Page) {
  await page.locator('.xterm-screen').click({ button: 'right', position: { x: 25, y: 10 } });
  await page.getByRole('menuitem', { name: '全选', exact: true }).click();
}

const clipboard = (page: Page) => page.evaluate(() => (window as any).__clipboardTest);

test('终端不同位置右键均可复制，输出及焦点变化不丢失菜单选区', async ({ page }) => {
  const fixture = await terminalFixture(page);
  await selectAll(page);
  const screen = page.locator('.xterm-screen');
  const bounds = (await screen.boundingBox())!;
  for (const position of [{ x: 5, y: 5 }, { x: bounds.width / 2, y: 18 }, { x: bounds.width - 8, y: bounds.height - 8 }]) {
    await screen.click({ button: 'right', position });
    await expect(page.getByRole('menuitem', { name: '复制', exact: true })).toBeEnabled();
    fixture.sshSockets[0].send(Buffer.from('live output\r\n'));
    await page.getByRole('menuitem', { name: '复制', exact: true }).click();
    expect((await clipboard(page)).writes.at(-1)).toContain('clipboard-regression-output');
    await selectAll(page);
  }
  // No selected output or right-button mouse report is sent back to the server.
  expect(fixture.calls.filter((call) => call.type === 'input')).toEqual([]);
});

test('鼠标拖选文本后右键一次即可复制', async ({ page }) => {
  await terminalFixture(page);
  const row = page.locator('.xterm-rows > div').filter({ hasText: 'clipboard-regression-output' }).first();
  const bounds = (await row.boundingBox())!;
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 140, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.locator('.xterm-screen').click({ button: 'right', position: { x: 10, y: 45 } });
  await expect(page.getByRole('menuitem', { name: '复制', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  expect((await clipboard(page)).writes.at(-1)).toMatch(/^clipboard/);
});

test('Ctrl+C/Ctrl+Insert 复制选区，无选区 Ctrl+C 保留中断', async ({ page }) => {
  const fixture = await terminalFixture(page);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  await expect.poll(() => fixture.calls.filter((call) => call.type === 'input').map((call) => call.data)).toEqual(['\x03']);
  await selectAll(page);
  for (const key of ['Control+c', 'Control+Insert', 'Control+Shift+C', 'Meta+c']) {
    await page.keyboard.press(key);
  }
  await expect.poll(async () => (await clipboard(page)).writes.length).toBe(4);
  expect((await clipboard(page)).writes.every((text: string) => text.includes('clipboard-regression-output'))).toBe(true);
  expect(fixture.calls.filter((call) => call.type === 'input').map((call) => call.data)).toEqual(['\x03']);
});

test('全屏终端的菜单在全屏容器内可见', async ({ page }) => {
  await terminalFixture(page);
  await page.locator('#fullscreen-terminal').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('terminal-card');
  await selectAll(page);
  await page.locator('.xterm-screen').click({ button: 'right', position: { x: 20, y: 15 } });
  await expect(page.locator('#terminal-card .terminal-context-menu')).toBeVisible();
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  expect((await clipboard(page)).writes.at(-1)).toContain('clipboard-regression-output');
});

test('菜单边缘定位、关闭及剪贴板降级和失败提示', async ({ page }) => {
  await terminalFixture(page);
  await selectAll(page);
  await page.evaluate(() => { (window as any).__clipboardTest.deny = true; });
  await page.locator('.xterm-screen').click({ button: 'right', position: { x: 8, y: 8 } });
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).legacy.length).toBe(1);
  expect((await clipboard(page)).legacy[0]).toContain('clipboard-regression-output');
  await page.evaluate(() => { (window as any).__clipboardTest.fallback = false; });
  await selectAll(page);
  const screen = page.locator('.xterm-screen');
  const bounds = (await screen.boundingBox())!;
  await screen.click({ button: 'right', position: { x: bounds.width - 2, y: bounds.height - 2 } });
  const menu = page.getByRole('menu');
  const menuBounds = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await screen.click({ button: 'right', position: { x: 12, y: 12 } });
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await expect(page.getByText('复制失败，请检查浏览器剪贴板权限。', { exact: true })).toBeVisible();
});
