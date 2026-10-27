import { test, expect, type Page } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

const READ_MTIME = 1_790_100_000;

/**
 * 把 window.confirm 换成可控 Promise：冲突弹窗不会阻塞页面，
 * 测试可以先断言「自动保存已暂停」，再决定保留哪一版。
 */
async function stubConfirm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __resolveConfirm?: (value: boolean) => void };
    state.__resolveConfirm = undefined;
    window.confirm = (() => new Promise<boolean>((resolve) => {
      state.__resolveConfirm = resolve;
    })) as unknown as typeof window.confirm;
  });
}

async function answerConfirm(page: Page, answer: boolean): Promise<void> {
  await page.evaluate((value) => {
    const state = window as unknown as { __resolveConfirm?: (value: boolean) => void };
    state.__resolveConfirm?.(value);
    state.__resolveConfirm = undefined;
  }, answer);
}


test('在线编辑器：打开、markdown 预览消毒、编辑并 Ctrl+S 保存', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await fileFixture(page);
  await connectFiles(page);
  const list = page.locator('.files-list');

  await list.getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.cm-content')).toContainText('# Edge SSH');
  await expect(page.locator('#file-edit')).toBeDisabled();

  // 预览：远端 md 里的 <script> 与 javascript: 链接必须被 DOMPurify 去掉。
  await editor.locator('[data-action="preview"]').click();
  const preview = editor.locator('.file-editor-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('h1')).toHaveText('Edge SSH');
  expect(await preview.locator('script').count()).toBe(0);
  expect(await preview.innerHTML()).not.toContain('javascript:');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('editor-preview.png') });

  await editor.locator('[data-action="preview"]').click();
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Saved by editor\n');
  await expect(editor.locator('.file-editor-state')).toHaveText('未保存');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');

  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ path: '/root/README.md', overwrite: true, expectedMtime: READ_MTIME });
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('# Saved by editor\n');
  expect(fixture.textFiles.get('/root/README.md')!.mtime).toBe(READ_MTIME + 1);
  await page.screenshot({ path: testInfo.outputPath('editor-saved.png') });
  expect(errors).toEqual([]);
});

test('mtime 冲突：先阻止覆盖，取消保留草稿，确认后才强制保存', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.locator('#file-edit').click();
  const editor = page.locator('.file-editor');
  await expect(editor).toBeVisible();

  // 模拟「打开之后别人改了远端文件」。
  fixture.textFiles.get('/root/README.md')!.mtime = READ_MTIME + 60;

  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Conflict draft\n');

  const cancelDialog = page.waitForEvent('dialog').then((dialog) => dialog.dismiss());
  await page.keyboard.press('ControlOrMeta+s');
  await cancelDialog;
  await expect(editor.locator('.file-editor-state')).toContainText('保存已取消');
  expect(fixture.textFiles.get('/root/README.md')!.content).toContain('<script>');

  // 有未保存改动时关闭编辑器必须先确认；取消则留在编辑器里。
  const keepEditing = page.waitForEvent('dialog').then((dialog) => dialog.dismiss());
  await editor.locator('[data-action="close"]').click();
  await keepEditing;
  await expect(editor).toBeVisible();
  await expect(editor).toHaveClass(/is-dirty/);
  await expect(editor.locator('[data-action="save"]')).toBeEnabled();

  // 再次保存并确认覆盖：这次不带 expectedMtime，写入成功。
  const overwriteDialog = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await page.keyboard.press('ControlOrMeta+s');
  await overwriteDialog;
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');
  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  // 两次带 expectedMtime 的尝试都被拒绝（第一次取消、第二次确认后强制覆盖），最后一条才真正写入。
  expect(starts.map((call) => call.expectedMtime)).toEqual([READ_MTIME, READ_MTIME, null]);
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('# Conflict draft\n');
});

test('全屏：同一个容器切换，内容与 undo 栈保留，Esc 先退全屏', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fileFixture(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  const content = editor.locator('.cm-content');
  await expect(editor).toBeVisible();

  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('fullscreen probe');
  // 在 CodeMirror 的 DOM 节点上打标记，证明全屏没有销毁重建编辑器。
  await content.evaluate((element) => {
    (element as unknown as { __sameNode?: boolean }).__sameNode = true;
  });

  const before = await editor.boundingBox();
  await editor.locator('[data-action="fullscreen"]').click();
  await expect(editor).toHaveClass(/is-fullscreen/);
  await expect(editor.locator('[data-action="fullscreen"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
  const expanded = await editor.boundingBox();
  expect(expanded!.width).toBeGreaterThanOrEqual(before!.width);
  expect(expanded!.height).toBeGreaterThan(before!.height);
  expect(expanded!.width).toBeGreaterThanOrEqual((await page.evaluate(() => innerWidth)) - 1);
  await expect(content).toHaveText('fullscreen probe');
  expect(await content.evaluate((element) => (element as unknown as { __sameNode?: boolean }).__sameNode)).toBe(true);

  // Esc 只退出全屏，不触发关闭确认。
  await page.keyboard.press('Escape');
  await expect(editor).not.toHaveClass(/is-fullscreen/);
  await expect(editor).toBeVisible();

  // 键盘快捷键同样能切换，按钮再还原。
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(editor).toHaveClass(/is-fullscreen/);
  await editor.locator('[data-action="fullscreen"]').click();
  await expect(editor).not.toHaveClass(/is-fullscreen/);

  // 光标也在原位：继续输入仍追加在末尾，不会被全屏切换重置。
  await expect(content).toHaveText('fullscreen probe');
  await page.keyboard.type('!');
  await expect(content).toHaveText('fullscreen probe!');

  // undo 栈还在：撤销能改回切换前的内容。
  await page.keyboard.press('ControlOrMeta+z');
  await expect(content).not.toHaveText('fullscreen probe!');
  expect(errors).toEqual([]);
});

test('自动保存：停止输入 3 秒后写入远端，连续输入合并为一次', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  const content = editor.locator('.cm-content');
  const badge = editor.locator('.file-editor-autosave');
  await expect(editor).toBeVisible();

  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('autosave-one');
  await expect(badge).toHaveText('等待自动保存');
  await expect(editor.locator('.file-editor-state')).toHaveText('未保存');

  // 1.5 秒后再输入：防抖重新计时，不会提前保存。
  await page.waitForTimeout(1_500);
  await page.keyboard.insertText('-two');
  await page.waitForTimeout(1_200);
  expect(fixture.calls.filter((call) => call.type === 'sftp_upload_start')).toHaveLength(0);

  await expect(editor.locator('.file-editor-state')).toHaveText('已保存', { timeout: 6_000 });
  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ path: '/root/README.md', expectedMtime: READ_MTIME });
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('autosave-one-two');
});

test('关闭编辑器前自动保存未提交的修改', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  await expect(editor).toBeVisible();

  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('saved on close');
  // 立即关闭（远早于 3 秒防抖），关闭流程必须先保存。
  await editor.locator('[data-action="close"]').click();
  await expect(editor).toBeHidden();

  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ path: '/root/README.md', expectedMtime: READ_MTIME });
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('saved on close');
});

test('自动保存冲突：暂停并提示，选择以远端为准后重新载入并恢复', async ({ page }) => {
  const fixture = await fileFixture(page);
  await stubConfirm(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  const content = editor.locator('.cm-content');
  await expect(editor).toBeVisible();

  // 模拟打开之后别人改了远端文件。
  fixture.textFiles.get('/root/README.md')!.mtime = READ_MTIME + 60;
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('draft against conflict');

  // 等待自动保存被 mtime 校验拒绝：暂停、提示，绝不静默覆盖。
  await expect(editor).toHaveAttribute('data-autosave', 'paused', { timeout: 15_000 });
  await expect(editor.locator('.file-editor-autosave')).toHaveText('自动保存已暂停 · 请确认远端版本');
  expect(fixture.textFiles.get('/root/README.md')!.content).toContain('<script>');

  // 放弃我的修改 → 以远端为准重新读取，自动保存恢复。
  await answerConfirm(page, false);
  await expect(editor.locator('.file-editor-state')).toHaveText('无修改');
  await expect(content).toContainText('<script>');
  await expect(editor).toHaveAttribute('data-autosave', 'idle');

  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('after remote reload');
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存', { timeout: 15_000 });
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('after remote reload');
});

test('自动保存冲突：强制覆盖成功后自动保存恢复', async ({ page }) => {
  const fixture = await fileFixture(page);
  await stubConfirm(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  const content = editor.locator('.cm-content');
  await expect(editor).toBeVisible();

  fixture.textFiles.get('/root/README.md')!.mtime = READ_MTIME + 60;
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('keep my version');
  await expect(editor).toHaveAttribute('data-autosave', 'paused', { timeout: 15_000 });

  // 保留我的版本 → expectedMtime 置 null 强制覆盖。
  await answerConfirm(page, true);
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('keep my version');
  await expect(editor).toHaveAttribute('data-autosave', 'idle');

  // 覆盖成功后自动保存恢复：再改一次，无需再次确认即可保存。
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('second autosave');
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存', { timeout: 15_000 });
  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  // [0] 冲突被拒 → [1] 强制覆盖（不带 expectedMtime）→ [2] 恢复后的自动保存。
  expect(starts).toHaveLength(3);
  expect(starts[0].expectedMtime).toBe(READ_MTIME);
  expect(starts[1].expectedMtime).toBeNull();
  expect(starts[2].expectedMtime).toBe(READ_MTIME + 61);
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('second autosave');
});

test('预览态下 Ctrl/Cmd+S 仍然保存', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  const content = editor.locator('.cm-content');
  await expect(editor).toBeVisible();

  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('# Saved from preview\n');
  await editor.locator('[data-action="preview"]').click();
  const preview = editor.locator('.file-editor-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('h1')).toHaveText('Saved from preview');
  // 预览层自己拿着焦点（CodeMirror 被 hidden），快捷键仍由编辑器容器拦下。
  await expect(preview).toBeFocused();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');

  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ path: '/root/README.md', expectedMtime: READ_MTIME });
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('# Saved from preview\n');
});

test('missing save mtime pauses autosave and requires explicit overwrite', async ({ page }) => {
  const fixture = await fileFixture(page, { omitUploadMtime: true });
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('first save');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(editor).toHaveAttribute('data-autosave', 'paused');
  await page.keyboard.insertText(' again');
  await page.waitForTimeout(3_100);
  expect(fixture.calls.filter((call) => call.type === 'sftp_upload_start')).toHaveLength(1);
  const dialog = page.waitForEvent('dialog').then((event) => event.accept());
  await page.keyboard.press('ControlOrMeta+s');
  await dialog;
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');
  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  expect(starts.map((call) => call.expectedMtime)).toEqual([READ_MTIME, null]);
});

test('非全屏 Esc 关闭编辑器，连接面板不被连带关掉', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  // 在工作台里打开文件 dock 与编辑器。
  await page.locator('#files-terminal').click();
  await page.locator('#file-manager-tab').click();
  await page.locator('#file-table-body tr').filter({ hasText: 'README.md' }).dblclick();
  const editor = page.locator('.file-editor');
  await expect(editor).toBeVisible();

  // 展开连接面板：此时 panelOpen 为 true，document 上的 Esc 处理器才会动作。
  await page.locator('#panel-toggle').click();
  const panel = page.locator('#connection-panel');
  await expect(panel).toHaveClass(/open/);
  await expect(panel).toHaveAttribute('aria-hidden', 'false');

  // 面板展开后指针被 scrim 挡住：模拟键盘用户把焦点放回编辑器再按 Esc。
  await page.evaluate(() => document.querySelector<HTMLElement>('.file-editor .cm-content')?.focus());
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  // 关键回归：Esc 只关编辑器，不会冒泡到 document 连带收起连接面板或把它设成 inert。
  await expect(panel).toHaveClass(/open/);
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-expanded', 'true');

  // 面板仍然可用：再按一次 Esc，它照常收起。
  await page.keyboard.press('Escape');
  await expect(panel).not.toHaveClass(/open/);
  expect(fixture.textFiles.get('/root/README.md')!.content).toContain('<script>');
});
