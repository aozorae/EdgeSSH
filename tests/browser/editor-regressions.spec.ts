import { test, expect } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

test('leaving waits for a save; a failed save keeps the connected workspace visible', async ({ page }) => {
  const options = { saveError: true };
  const fixture = await fileFixture(page, options);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('draft before navigation');
  await page.locator('#rail-overview').click();
  await expect(editor.locator('.file-editor-state')).toHaveText('Permission denied');
  await expect(page.locator('body')).toHaveAttribute('data-view', 'files');
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  expect(fixture.calls.some((call) => call.type === 'sftp_close')).toBe(false);
  options.saveError = false;
  await page.locator('#rail-overview').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'dashboard');
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('draft before navigation');
  expect(fixture.calls.some((call) => call.type === 'sftp_close')).toBe(true);
});

test('editing preserves CRLF and does not refresh the whole directory after save', async ({ page }) => {
  const fixture = await fileFixture(page);
  fixture.textFiles.get('/root/nginx.conf')!.content = 'one\r\ntwo\r\n';
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'nginx.conf', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  await expect(editor).not.toHaveClass(/is-dirty/);
  const lists = fixture.calls.filter((call) => call.type === 'sftp_list').length;
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('three');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');
  expect(fixture.textFiles.get('/root/nginx.conf')!.content).toBe('one\r\ntwo\r\nthree');
  expect(fixture.calls.filter((call) => call.type === 'sftp_list')).toHaveLength(lists);
});

test('2 MiB editing never serializes the full document on keystrokes; in-flight edits remain dirty', async ({ page }) => {
  await fileFixture(page);
  const result = await page.evaluate(async () => {
    // Exercise the real lazy module, outside the file manager fixture.
    const { FileEditor } = await import('/src/file-editor.ts');
    const editor = await FileEditor.create({ localize: (copy: { en: string }) => copy.en, requestClose: () => {}, requestSave: () => 'started' },
      { name: 'large.txt', path: '/large.txt', content: 'line\n'.repeat(400_000), mtime: 1 });
    document.body.append(editor.element);
    const view = (editor as any).view;
    const proto = Object.getPrototypeOf(view.state.doc);
    const original = proto.toString;
    let serializations = 0;
    proto.toString = function () { if (this.length > 1_000_000) serializations++; return original.call(this); };
    const start = performance.now();
    try {
      for (let i = 0; i < 40; i++) view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length, insert: String(i % 10) } });
      const editingMs = performance.now() - start;
      editor.markSaving();
      const sent = editor.content();
      view.dispatch({ changes: { from: 0, insert: 'new' } });
      editor.markSaved(sent, 2);
      const dirtyDuringSave = editor.isDirty();
      editor.markSaving();
      editor.markSaved(editor.content(), 3);
      return { serializations, editingMs, dirtyDuringSave, cleanAfterSave: !editor.isDirty() };
    } finally { proto.toString = original; editor.destroy(); }
  });
  expect(result.serializations).toBe(0);
  expect(result.dirtyDuringSave).toBe(true);
  expect(result.cleanAfterSave).toBe(true);
  console.log('large-editor-regression', result);
});


test('a failed text stream releases the transfer channel and permits another editor read', async ({ page }) => {
  const options = { readError: true };
  await fileFixture(page, options);
  await connectFiles(page);
  const row = page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true });
  await row.dblclick();
  await expect(page.locator('#file-manager-error')).toHaveText('Read interrupted');
  await expect(page.locator('#file-edit')).toBeEnabled();
  options.readError = false;
  await page.locator('#file-edit').click();
  await expect(page.locator('.file-editor .cm-content')).toContainText('Edge SSH');
  await expect(page.locator('#file-manager-error')).toBeHidden();
});
