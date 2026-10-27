import { test, expect, type Page } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

/** Connecting lands the user in the workspace, where only the back button is a route home. */
async function backToOverview(page: Page): Promise<void> {
  const back = page.getByRole('button', { name: '← 主机总览' });
  if (await back.isVisible()) await back.click();
  else await page.locator('#rail-overview').click();
  await expect(page.locator('#hosts-heading')).toBeVisible();
}

async function showFiles(page: Page): Promise<void> {
  await backToOverview(page);
  await page.locator('#rail-files').click();
  await expect(page.locator('#files-heading')).toBeVisible();
}

test('文件页跟随前台会话：SFTP 请求只走被选中会话自己的通道', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page, 'alpha');
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');

  await backToOverview(page);
  await page.locator('.host-row', { hasText: 'Singapore backup' }).locator('.connect-host').click();
  await expect.poll(() => fixture.sshSockets.length).toBe(2);
  await expect.poll(() => fixture.sftpSockets.length).toBe(2);

  await showFiles(page);
  const picker = page.locator('#files-session');
  await expect(page.locator('#files-session-field')).toBeVisible();
  await expect(picker.locator('option')).toHaveCount(2);
  // 前台是刚连上的 Singapore，选择器要跟着它。
  await expect(picker.locator('option:checked')).toHaveText('root@192.0.2.20:22');

  // beta 在前台：这次导航必须落在它自己的通道上。
  await page.locator('.files-list').getByRole('treeitem', { name: 'backups', exact: true }).dblclick();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');
  await expect.poll(() => fixture.sftpCalls[1].some((call) => call.type === 'sftp_list' && call.path === '/root/backups')).toBe(true);
  expect(fixture.sftpCalls[0].some((call) => call.type === 'sftp_list' && call.path === '/root/backups')).toBe(false);

  // 切回 alpha：每条会话记得自己的目录位置，且不必重拉列表。
  await picker.selectOption({ index: 0 });
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  await page.locator('.files-list').getByRole('treeitem', { name: 'deploy', exact: true }).dblclick();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/deploy');
  await expect.poll(() => fixture.sftpCalls[0].some((call) => call.type === 'sftp_list' && call.path === '/root/deploy')).toBe(true);
  expect(fixture.sftpCalls[1].some((call) => call.type === 'sftp_list' && call.path === '/root/deploy')).toBe(false);

  // beta 期间的路径没有被 alpha 的活动覆盖。
  await picker.selectOption({ index: 1 });
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');
});

test('同一台主机两个会话时，文件页的选择器能区分它们', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page, 'alpha');
  await backToOverview(page);

  await page.locator('.host-row', { hasText: 'Tokyo production' }).locator('.host-session-badge').click();
  await page.locator('.session-menu-new').click();
  await expect.poll(() => fixture.sshSockets.length).toBe(2);

  await showFiles(page);
  const options = page.locator('#files-session option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveText('root@192.0.2.10:22');
  await expect(options.nth(1)).toHaveText('root@192.0.2.10:22 #2');
  await expect(page.locator('#files-session option:checked')).toHaveText('root@192.0.2.10:22 #2');
});

test('wssh.connect 只在同一目标已有连接时拒绝，其它主机照常另开', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page, 'alpha');
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');

  await expect(page.evaluate(() => window.wssh.connect({
    host: '192.0.2.10', port: 22, username: 'root', password: 'once',
  }))).rejects.toThrow(/该目标已有活动的 SSH 连接/);
  expect(fixture.sshSockets).toHaveLength(1);

  await page.evaluate(() => window.wssh.connect({
    host: '192.0.2.20', port: 22, username: 'root', password: 'twice',
  }));
  await expect.poll(() => fixture.sshSockets.length).toBe(2);
});

test('事件日志在多会话时标注来源会话，单会话时不加噪声', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page, 'alpha');
  await page.locator('#files-terminal').click();
  await expect(page.locator('#terminal-card')).toBeVisible();
  // 第一条 ready 事件当时只有一条会话在册，不该挂标签。
  await expect(page.locator('#event-log .event-session')).toHaveCount(0);

  await backToOverview(page);
  await page.locator('.host-row', { hasText: 'Singapore backup' }).locator('.connect-host').click();
  await expect.poll(() => fixture.sshSockets.length).toBe(2);
  await expect(page.locator('#event-log .event-session').last()).toHaveText('root@192.0.2.20:22');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
