import type { Page, WebSocketRoute } from '@playwright/test';

const fingerprint = `SHA256:${'A'.repeat(43)}`;
const host = (id: string, name: string, address: string) => ({
  id, name, host: address, port: 22, username: 'root', group: '测试主机',
  authMethod: 'password', initialCommand: 'echo should-not-run-in-files',
  termType: 'xterm-256color', encoding: 'utf-8', fingerprint,
  location: null, system: null, hasCredential: true, updatedAt: Date.now(),
});
const entry = (name: string, type = 'file', size = 12) => ({
  name, type, size, mtime: 1_790_100_000, permissions: type === 'directory' ? '0755' : '0644', owner: 'root', group: 'root',
});

// 只在测试浏览器内模拟 API/协议，不访问真实主机、不增加生产认证绕过。
export async function fileFixture(page: Page, options: { firstSeen?: boolean; credentialError?: boolean; noHosts?: boolean; holdUpload?: boolean; omitUploadMtime?: boolean; saveError?: boolean; readError?: boolean } = {}) {
  const hosts = options.noHosts ? [] : [host('alpha', 'Tokyo production', '192.0.2.10'), host('beta', 'Singapore backup', '192.0.2.20')];
  const directories = new Map([
    ['/', [entry('root', 'directory')]],
    ['/root', [entry('backups', 'directory'), entry('deploy', 'directory'), entry('README.md'), entry('nginx.conf', 'file', 2480)]],
    ['/root/backups', []],
    ['/root/deploy', []],
  ]);
  const calls: Array<Record<string, any>> = [];
  const sshSockets: WebSocketRoute[] = [];
  const sftpSockets: WebSocketRoute[] = [];
  const uploaded: Buffer[] = [];
  // 在线编辑器读取/保存的远端文本文件；mtime 用于冲突校验，测试可直接改它模拟他人修改。
  const textFiles = new Map([
    ['/root/README.md', { content: '# Edge SSH\n\n<script>window.__xss = 1</script>\n\n[bad](javascript:alert(1))\n', mtime: 1_790_100_000 }],
    ['/root/nginx.conf', { content: 'server {\n  listen 80;\n}\n', mtime: 1_790_100_000 }],
  ]);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId: crypto.randomUUID() } });
    if (path.endsWith('/credentials')) {
      return route.fulfill(options.credentialError
        ? { status: 500, json: { error: '读取凭据失败，请重试。' } }
        : { json: { password: 'test-only-password' } });
    }
    if (path === '/api/hosts') return route.fulfill({ json: { hosts } });
    if (path === '/api/snippets') return route.fulfill({ json: { snippets: [] } });
    return route.fulfill({ json: { host: hosts.find((item) => path.includes(item.id)) ?? hosts[0] } });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    sshSockets.push(ws);
    const ready = () => {
      ws.send(JSON.stringify({ type: 'ready' }));
      ws.send(JSON.stringify({ type: 'sftp_attach', url: '/api/sftp?session=test&token=test' }));
    };
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') { calls.push({ type: 'terminal-input', data: raw.toString() }); return; }
      const message = JSON.parse(raw);
      calls.push(message);
      if (message.type === 'connect') {
        if (options.firstSeen) {
          // 返回变化指纹，确保仍需真实 UI 确认，而不是由测试直接放行。
          ws.send(JSON.stringify({ type: 'host_key', fingerprint: `SHA256:${'B'.repeat(43)}`, expectedFingerprint: fingerprint, keyType: 'ssh-ed25519', trusted: false }));
        } else ready();
      }
      if (message.type === 'host_key_decision' && message.accept) ready();
    });
  });
  await page.routeWebSocket('**/api/sftp?*', (ws) => {
    sftpSockets.push(ws);
    let upload: { requestId: string; path: string; size: number } | undefined;
    const send = (data: object) => ws.send(JSON.stringify(data));
    const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
    const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') {
        uploaded.push(Buffer.from(raw));
        send({ type: 'sftp_upload_progress', requestId: upload!.requestId, loaded: uploaded.reduce((sum, chunk) => sum + chunk.length, 0) });
        return;
      }
      const message = JSON.parse(raw);
      calls.push(message);
      const { type, requestId, path } = message;
      if (type === 'sftp_init') send({ type: 'sftp_ready', cwd: '/root', version: 3 });
      if (type === 'sftp_list') {
        if (path === '/forbidden') send({ type: 'sftp_error', requestId, message: 'Permission denied' });
        else send({ type: 'sftp_list_result', requestId, path, entries: directories.get(path) ?? [] });
      }
      if (type === 'sftp_mkdir') {
        directories.get(parent(path))!.push(entry(name(path), 'directory'));
        directories.set(path, []);
      }
      if (type === 'sftp_rename') {
        directories.get(parent(message.oldPath))!.find((item) => item.name === name(message.oldPath))!.name = name(message.newPath);
      }
      if (type === 'sftp_delete' || type === 'sftp_rmdir') {
        directories.set(parent(path), directories.get(parent(path))!.filter((item) => item.name !== name(path)));
      }
      if (['sftp_mkdir', 'sftp_rename', 'sftp_delete', 'sftp_rmdir'].includes(type)) send({ type: `${type}_result`, requestId });
      if (type === 'sftp_read_text') {
        const file = textFiles.get(path);
        if (!file) send({ type: 'sftp_error', requestId, operation: 'read', message: 'No such file' });
        else {
          const bytes = Buffer.from(file.content);
          send({ type: 'sftp_read_text_start', requestId, path });
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) ws.send(bytes.subarray(offset, offset + 64 * 1024));
          if (options.readError) { send({ type: 'sftp_error', requestId, operation: 'read', message: 'Read interrupted' }); return; }
          send({ type: 'sftp_read_text_result', requestId, path, size: bytes.length, mtime: file.mtime });
        }
      }
      if (type === 'sftp_upload_start') {
        if (options.saveError) { send({ type: 'sftp_error', requestId, operation: 'upload', message: 'Permission denied' }); return; }
        const target = textFiles.get(path);
        if (typeof message.expectedMtime === 'number' && (!target || target.mtime !== message.expectedMtime)) {
          send({ type: 'sftp_error', requestId, operation: 'upload', conflict: true, message: 'The remote file changed since it was opened' });
          return;
        }
        upload = message;
        uploaded.length = 0;
        if (!options.holdUpload) send({ type: 'sftp_upload_ready', requestId });
      }
      if (type === 'sftp_upload_end') {
        const list = directories.get(parent(upload!.path))!;
        const existing = list.find((item) => item.name === name(upload!.path));
        if (existing) existing.size = upload!.size;
        else list.push(entry(name(upload!.path), 'file', upload!.size));
        const target = textFiles.get(upload!.path);
        if (target) {
          target.content = Buffer.concat(uploaded).toString('utf8');
          target.mtime += 1;
        }
        // omitUploadMtime 模拟后端 finishUpload 的 stat 失败：结果里没有 mtime。
        send({
          type: 'sftp_upload_complete', requestId, size: upload!.size,
          ...(options.omitUploadMtime ? {} : { mtime: target?.mtime }),
        });
      }
      if (type === 'sftp_download') {
        const data = Buffer.from('hello files\n');
        send({ type: 'sftp_download_start', requestId, size: data.length });
        ws.send(data);
        send({ type: 'sftp_download_done', requestId, size: data.length });
      }
    });
  });
  await page.goto('/');
  await page.locator('#rail-files').click();
  return { hosts, calls, sshSockets, sftpSockets, uploaded, directories, textFiles };
}

export async function connectFiles(page: Page, id = 'alpha') {
  await page.locator('#files-host').selectOption(id);
  await page.locator('#files-connect').click();
}
