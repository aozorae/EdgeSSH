import { test, expect, type Page } from '@playwright/test';

const host = {
  id: 'alpha', name: 'Tokyo production', host: '192.0.2.10', port: 2222, username: 'deploy',
  group: '生产环境', authMethod: 'publickey', initialCommand: 'tmux attach', termType: 'xterm-256color',
  encoding: 'utf-8', fingerprint: `SHA256:${'A'.repeat(43)}`, location: null, system: null,
  hasCredential: true, updatedAt: Date.now(),
};

async function dashboardFixture(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    }
    if (path === '/api/hosts') return route.fulfill({ json: { hosts: [host] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
}

test('侧栏仅保留总览主机入口，切换后仍可搜索和添加主机', async ({ page }) => {
  await dashboardFixture(page);

  const navigation = page.getByRole('navigation', { name: '主导航' });
  const overview = navigation.getByRole('button', { name: '总览', exact: true });
  await expect(overview).toHaveCount(1);
  await expect(navigation.getByRole('button', { name: '主机', exact: true })).toHaveCount(0);
  await expect(page.locator('#rail-hosts')).toHaveCount(0);
  await expect(overview).toHaveAttribute('aria-current', 'page');

  await navigation.getByRole('button', { name: '文件管理', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'files');
  await overview.click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'dashboard');
  await expect(overview).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('#host-list')).toContainText(host.name);

  const search = page.getByRole('searchbox', { name: '搜索主机' });
  await search.fill('no-matching-host');
  await expect(page.locator('#host-list')).toContainText('没有匹配的主机');
  await search.fill('Tokyo');
  await expect(page.locator('#host-list')).toContainText(host.name);
  await page.getByRole('button', { name: '＋ 添加主机', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加主机' })).toBeVisible();
});

test('主机列表编辑打开正确弹窗并回填资料', async ({ page }) => {
  await dashboardFixture(page);

  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();

  const editor = page.getByRole('dialog', { name: '编辑主机' });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('名称')).toHaveValue(host.name);
  await expect(editor.getByLabel('主机地址')).toHaveValue(host.host);
  await expect(editor.getByLabel('SSH 用户名')).toHaveValue(host.username);
  await expect(editor.getByLabel('端口')).toHaveValue(String(host.port));
  await expect(editor.locator('select[name="authMethod"]')).toHaveValue(host.authMethod);
  await expect(editor.locator('textarea[name="privateKey"]')).toHaveValue('');
  await expect(page.locator('dialog[aria-labelledby="forward-key-heading"]')).not.toHaveAttribute('open', '');

  await editor.getByRole('button', { name: '取消' }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  await expect(editor).toBeVisible();
});
