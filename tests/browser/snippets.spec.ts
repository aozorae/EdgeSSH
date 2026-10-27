import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_SNIPPETS, type Snippet } from '../../src/accounts/snippet-data';
import { connectFiles, fileFixture } from './file-fixture';

async function fixture(page: Page) {
  const files = await fileFixture(page);
  let items: Snippet[] = DEFAULT_SNIPPETS.map((item) => ({ ...item, id: crypto.randomUUID(), updatedAt: Date.now() }));
  await page.route('**/api/snippets**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split('/')[3];
    if (request.method() === 'GET') return route.fulfill({ json: { snippets: items } });
    if (request.method() === 'DELETE') {
      items = items.filter((item) => item.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    const snippet = { ...request.postDataJSON(), id: id ?? crypto.randomUUID(), updatedAt: Date.now() };
    items = [snippet, ...items.filter((item) => item.id !== id)];
    return route.fulfill({ json: { snippet } });
  });
  return files;
}

test('主页片段库支持十条默认命令、搜索、新建、多行编辑、删除及刷新持久化', async ({ page }, testInfo) => {
  await fixture(page);
  await page.locator('#rail-snippets').click();
  const library = page.locator('#snippets-page');
  await expect(library.locator('.snippet-card')).toHaveCount(10);
  await expect(page.locator('#rail-snippets')).toHaveAttribute('aria-current', 'page');
  await library.getByRole('searchbox').fill('磁盘');
  await expect(library.locator('.snippet-card')).toHaveCount(1);
  await library.getByRole('searchbox').fill('');
  await library.getByRole('button', { name: '＋ 新建片段' }).click();
  const dialog = page.getByRole('dialog', { name: '新建代码片段' });
  await dialog.getByLabel('名称').fill('部署检查 <script>');
  await dialog.getByLabel('命令', { exact: true }).fill('echo first\npwd');
  await dialog.getByRole('button', { name: '保存片段' }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(11);
  await library.getByRole('button', { name: '编辑 部署检查 <script>', exact: true }).click();
  await page.getByRole('dialog').getByLabel('命令', { exact: true }).fill('echo second\nls -lah');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await page.reload();
  await page.locator('#rail-snippets').click();
  await expect(library.locator('.snippet-card').filter({ hasText: '部署检查 <script>' }).locator('pre')).toHaveText('echo second\nls -lah');
  page.once('dialog', (dialog) => dialog.accept());
  await library.getByRole('button', { name: '删除 查看当前目录', exact: true }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(10);
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.getByRole('heading', { name: '查看当前目录', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('snippet-library.png'), fullPage: true });
});

test('顶栏下拉收放自如；填入草稿而不执行，编辑与管理页同步', async ({ page }, testInfo) => {
  const files = await fixture(page);
  await connectFiles(page);
  await page.locator('#files-terminal').click();
  const toggle = page.locator('#snippet-toggle');
  const panel = page.locator('#snippet-panel');
  // 它不再常驻在终端上方：默认收起，点开才出现。
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.snippet-card')).toHaveCount(10);
  await panel.getByRole('button', { name: '使用 查看磁盘空间', exact: true }).click();
  await expect(page.locator('#command-editor-input')).toHaveValue('df -h');
  expect(files.calls.filter((call) => call.type === 'input')).toHaveLength(0);
  await page.locator('#command-editor-send').click();
  await expect.poll(() => files.calls.filter((call) => call.type === 'input').at(-1)?.data).toBe('df -h\r');
  // 点别处收起，再点回来展开，最后 Esc 也能收。
  await page.locator('#session-title').click();
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await panel.getByRole('button', { name: '编辑 查看磁盘空间', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称').fill('磁盘概况');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await panel.getByRole('button', { name: '管理快捷命令指令', exact: true }).click();
  await expect(page.locator('#snippets-page').getByRole('heading', { name: '磁盘概况', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开 SSH 终端 ↗', exact: true }).click();
  expect(files.calls.filter((call) => call.type === 'connect')).toHaveLength(1);
  await toggle.click();
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('snippet-terminal.png'), fullPage: true });
});

test('下拉片段使用两行紧凑布局、可访问图标和完整命令，触屏按钮可点击', async ({ page }, testInfo) => {
  await fixture(page);
  const longName = '部署前检查磁盘空间与服务状态 deployment preflight check';
  const longCommand = `echo ${'deployment-check-'.repeat(30)}\nprintf 'first\\nsecond\\n'\npwd`;
  await page.route('**/api/snippets', (route) => route.fulfill({ json: { snippets: [
    { ...DEFAULT_SNIPPETS[0], id: 'compact-short', name: '磁盘空间', command: 'df -h', updatedAt: Date.now() },
    { ...DEFAULT_SNIPPETS[0], id: 'compact-long', name: longName, command: longCommand, updatedAt: Date.now() },
  ] } }));
  await connectFiles(page);
  await page.locator('#files-terminal').click();
  const panel = page.locator('#snippet-panel');
  await page.locator('#snippet-toggle').click();
  const cards = panel.locator('.snippet-card');
  await expect(cards).toHaveCount(2);
  const buttons = cards.first().locator('.snippet-actions button');
  await expect(buttons).toHaveCount(4);
  for (const button of await buttons.all()) {
    await expect(button).toHaveText('');
    await expect(button).toHaveAttribute('title', /\S/);
    await expect(button).toHaveAttribute('aria-label', /\S/);
    await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(testInfo.project.name === 'mobile' ? 44 : 28);
    expect(box.height).toBeGreaterThanOrEqual(testInfo.project.name === 'mobile' ? 44 : 28);
  }
  // 检查实际几何位置，防止按钮重新挤成独立一行或长命令撑宽浮窗。
  for (const card of await cards.all()) {
    const layout = await card.evaluate((element) => {
      const name = element.querySelector('h3')!.getBoundingClientRect();
      const actions = element.querySelector('.snippet-actions')!.getBoundingClientRect();
      const command = element.querySelector('pre')!.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      return {
        nameCenter: name.y + name.height / 2, actionsCenter: actions.y + actions.height / 2,
        commandTop: command.top, headerBottom: Math.max(name.bottom, actions.bottom),
        commandWidth: command.width, rowWidth: row.width,
        overflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(Math.abs(layout.nameCenter - layout.actionsCenter)).toBeLessThanOrEqual(1);
    expect(layout.commandTop).toBeGreaterThanOrEqual(layout.headerBottom);
    expect(layout.commandWidth).toBeLessThan(layout.rowWidth);
    expect(layout.overflow).toBe(false);
  }
  expect((await cards.first().boundingBox())!.height).toBeLessThanOrEqual(testInfo.project.name === 'mobile' ? 84 : 68);
  await expect(cards.last().locator('h3')).toHaveAttribute('title', longName);
  await expect(cards.last().locator('pre')).toHaveText(longCommand);
  await expect(cards.last().locator('pre')).toHaveAttribute('title', longCommand);
  const use = cards.first().getByRole('button', { name: '使用 磁盘空间', exact: true });
  await use.focus();
  await expect(use).toBeFocused();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (value: string) => { document.body.dataset.copiedCommand = value; },
  } }));
  await cards.last().getByRole('button', { name: `复制 ${longName}`, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('命令已复制。');
  await expect(page.locator('body')).toHaveAttribute('data-copied-command', longCommand);
  expect(await panel.locator('#snippet-panel-body').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath('snippet-compact-dark.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await panel.screenshot({ path: testInfo.outputPath('snippet-compact-light.png') });
});

test('加载与保存错误可重试，不丢失草稿；空列表不补回默认命令', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/snippets', (route) => route.fulfill({ status: 500, json: { error: '片段服务暂时不可用' } }));
  await page.locator('#rail-snippets').click();
  const library = page.locator('#snippets-page');
  await expect(library.getByRole('status')).toContainText('片段服务暂时不可用');
  await page.unroute('**/api/snippets');
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(10);
  await library.getByRole('button', { name: '＋ 新建片段' }).click();
  await page.getByRole('dialog').getByLabel('名称').fill('保留草稿');
  await page.getByRole('dialog').getByLabel('命令', { exact: true }).fill('echo safe');
  await page.route('**/api/snippets', (route) => route.fulfill({ status: 500, json: { error: '保存失败，请重试。' } }));
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('保存失败');
  await expect(page.getByRole('dialog').getByLabel('命令', { exact: true })).toHaveValue('echo safe');
  await page.unroute('**/api/snippets');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.route('**/api/snippets', (route) => route.fulfill({ json: { snippets: [] } }));
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.locator('.snippet-empty')).toContainText('把常用命令留在手边');
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(0);
});

test('多行片段保留换行且不直接发送；取消覆盖保留旧草稿，登出清空片段', async ({ page }) => {
  const files = await fixture(page);
  await page.locator('#rail-snippets').click();
  await page.locator('#snippets-page').getByRole('button', { name: '＋ 新建片段' }).click();
  await page.getByRole('dialog').getByLabel('名称').fill('多行脚本');
  await page.getByRole('dialog').getByLabel('命令', { exact: true }).fill('echo a\n# 注释\necho b');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await page.getByRole('button', { name: '打开 SSH 终端 ↗', exact: true }).click();
  const panel = page.locator('#snippet-panel');
  await page.locator('#snippet-toggle').click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '使用 多行脚本', exact: true }).click();
  await expect(page.locator('#command-editor-input')).toHaveValue('echo a\n# 注释\necho b');
  // 窄屏上一取用就收起让位给终端，宽屏保留；这里只保证入口随时可再打开。
  if (await panel.isHidden()) await page.locator('#snippet-toggle').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await panel.getByRole('button', { name: '使用 查看当前目录', exact: true }).click();
  await expect(page.locator('#command-editor-input')).toHaveValue('echo a\n# 注释\necho b');
  expect(files.calls.filter((call) => call.type === 'input')).toHaveLength(0);
  await page.evaluate(() => window.dispatchEvent(new Event('auth-required')));
  await expect(page.locator('#snippet-panel .snippet-card')).toHaveCount(0);
  await expect(page.locator('#snippets-page .snippet-card')).toHaveCount(0);
});

test('下拉在调整尺寸后仍完整可见，并适配浅色及减少动态效果', async ({ page }, testInfo) => {
  await fixture(page);
  await connectFiles(page);
  await page.locator('#files-terminal').click();
  const toggle = page.locator('#snippet-toggle');
  const panel = page.locator('#snippet-panel');
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel.locator('#snippet-panel-body')).toBeVisible();
  await page.setViewportSize({ width: 667, height: 375 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // 贴着按钮下方展开，整体留在视口内：不再会长到屏幕外找不着。
  const anchor = (await toggle.boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(anchor.y + anchor.height - 1);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(668);
  expect(box.y + box.height).toBeLessThanOrEqual(376);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel.locator('#snippet-panel-body')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('snippet-landscape-light.png'), fullPage: true });
});
