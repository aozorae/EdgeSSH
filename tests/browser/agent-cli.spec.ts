import { test, expect } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

test('Agent CLI 页面提供站点专属接入命令，可复制且不会读取凭据', async ({ page, baseURL }) => {
  const copied: string[] = [];
  await page.exposeFunction('recordCliCopy', (value: string) => copied.push(value));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (value: string) => (window as any).recordCliCopy(value) } });
  });
  const credentials: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/credentials')) credentials.push(request.url()); });
  await fileFixture(page);
  await page.locator('#rail-agent-cli').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'agent-cli');
  await expect(page.locator('#rail-agent-cli')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#agent-cli-heading')).toBeFocused();
  await expect(page.locator('[data-command="install"]')).toHaveText('npm install --global @aozorae/edgessh');
  await expect(page.locator('[data-command="login"]')).toContainText(`edgessh login --url ${new URL(baseURL!).origin}`);
  await page.locator('[data-copy="login"]').click();
  await expect(page.locator('.agent-cli-copy-status')).toHaveText('已复制。');
  expect(copied[0]).toBe(await page.locator('[data-command="login"]').textContent());
  await page.locator('[data-copy="agent"]').click();
  expect(copied[1]).toContain('do not use --accept-new on your own');
  await expect(page.locator('.agent-cli-page [data-docs]')).toHaveAttribute('href', 'https://edgessh-docs.pages.dev/usage/agent-cli');
  await expect(page.locator('[data-provider-warning]')).toBeHidden();
  expect(credentials).toEqual([]);
  await page.locator('#rail-snippets').click();
  await expect(page.locator('.agent-cli-page')).toBeHidden();
});

test('切换到 Agent CLI 不断开 SSH，返回文件页仍使用原会话', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  await page.locator('#rail-agent-cli').click();
  await expect(page.locator('.agent-cli-page')).toBeVisible();
  await page.locator('#rail-files').click();
  await expect(page.locator('.agent-cli-page')).toBeHidden();
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  expect(fixture.calls.filter((call) => call.type === 'connect')).toHaveLength(1);
  expect(fixture.calls.some((call) => call.type === 'sftp_close')).toBe(false);
});

test('文件传输期间拒绝离页会保留当前视图', async ({ page }) => {
  await fileFixture(page, { holdUpload: true });
  await connectFiles(page);
  // 文件输入不会等待 SFTP 就绪，需先等上传按钮启用，避免上传被直接忽略。
  await expect(page.locator('#file-upload')).toBeEnabled();
  await page.locator('#file-upload-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
  await expect(page.locator('#file-manager-progress')).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#rail-agent-cli').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'files');
  await expect(page.locator('.agent-cli-page')).toBeHidden();
});

test('查看接入办法再返回文件页，不丢失未保存的编辑器草稿', async ({ page }) => {
  const fixture = await fileFixture(page, { saveError: true });
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('unsaved agent-cli navigation fixture');
  await page.locator('#rail-agent-cli').click();
  await expect(page.locator('.agent-cli-page')).toBeVisible();
  await page.locator('#rail-files').click();
  await expect(editor.locator('.cm-content')).toContainText('unsaved agent-cli navigation fixture');
  await expect(editor).toHaveClass(/is-dirty/);
  expect(fixture.calls.filter((call) => call.type === 'connect')).toHaveLength(1);
});

test('GitHub 登录站点明确提示不支持，剪贴板失败可手动复制', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } });
  });
  await fileFixture(page);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'github' } }));
  await page.reload();
  await expect(page.locator('#auth-provider-label')).toHaveText('GitHub');
  await page.locator('#rail-agent-cli').click();
  await expect(page.locator('[data-provider-warning]')).toContainText('CLI 暂不支持');
  await page.locator('[data-copy="install"]').click();
  await expect(page.locator('.agent-cli-copy-status')).toContainText('剪贴板不可用');
});

test('英文首屏正确，语言切换后仍可访问 Agent CLI', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('workers-webssh.language', 'en'));
  await fileFixture(page);
  await page.locator('#rail-agent-cli').click();
  await expect(page.locator('#agent-cli-install')).toHaveText('01 Install');
  await expect(page.locator('[data-copy="login"]')).toHaveAttribute('title', 'Copy sign-in commands');
  await page.locator('#rail-files').click();
  await page.locator('#files-terminal').click();
  await page.locator('#language-toggle').click();
  await page.getByRole('button', { name: '文件管理', exact: true }).click();
  await page.locator('#rail-agent-cli').click();
  await expect(page.locator('#agent-cli-install')).toHaveText('01 安装');
});
