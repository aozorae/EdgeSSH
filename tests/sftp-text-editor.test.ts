import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 与 Worker 构建一样解析扩展名省略的导入，在内存中测试真实 SFTPHandler。
const result = await build({
  stdin: {
    contents: "export * from './src/backend/sftp-handler.ts'; export { SFTPStatusError, SFTP_OPEN_FLAGS } from './src/ssh/sftp.ts';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const { SFTPHandler, SFTPStatusError, SFTP_OPEN_FLAGS } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;

class FakeClient {
  attrs: { size?: number | string; mtime?: number; permissions?: number } = { size: 12, mtime: 1000, permissions: 0o100644 };
  statError: Error | null = null;
  content: Uint8Array = new TextEncoder().encode('hello world\n');
  readonly statCalls: string[] = [];
  readonly opened: Array<{ path: string; flags: number; attrs?: { permissions?: number } }> = [];
  readonly writes: Array<{ offset: number; length: number }> = [];
  readonly renames: Array<[string, string]> = [];
  readonly removed: string[] = [];

  async stat(path: string) {
    this.statCalls.push(path);
    if (this.statError) throw this.statError;
    return this.attrs;
  }

  async openFile(path: string, flags: number, attrs?: { permissions?: number }) {
    this.opened.push({ path, flags, attrs });
    return new Uint8Array([1, 2, 3]);
  }

  async readFile(_handle: Uint8Array, offset: number, length: number) {
    const slice = this.content.subarray(offset, offset + length);
    return slice.length === 0 ? null : slice.slice();
  }

  async writeFile(_handle: Uint8Array, offset: number, data: Uint8Array) {
    this.writes.push({ offset, length: data.length });
  }

  async closeHandle() { /* no-op */ }

  async removeFile(path: string) {
    this.removed.push(path);
  }

  async rename(from: string, to: string) {
    this.renames.push([from, to]);
  }

  dispose() { /* no-op */ }
}

function setup() {
  const client = new FakeClient();
  const messages: Array<Record<string, any>> = [];
  const binary: Uint8Array[] = [];
  const handler = new SFTPHandler(
    {} as any,
    async () => { /* channel data unused */ },
    (message: Record<string, any>) => messages.push(message),
    (data: Uint8Array) => binary.push(data),
  );
  // 私有字段在运行时就是普通属性；直接注入假客户端，避免真正建 SFTP 会话。
  (handler as any).client = client;
  (handler as any).ready = true;
  return { client, messages, binary, handler };
}

test('editor read uses bounded binary chunks and small control messages', async () => {
  const { client, messages, binary, handler } = setup();
  client.content = new TextEncoder().encode('a'.repeat(MAX_TEXT_FILE_SIZE));
  client.attrs.size = client.content.length;
  await handler.readText('r1', '/root/app.ts');
  assert.equal(messages[0].type, 'sftp_read_text_start');
  const message = messages.at(-1)!;
  assert.equal(message.type, 'sftp_read_text_result');
  assert.equal(message.requestId, 'r1');
  assert.equal(message.content, undefined);
  assert.equal(message.size, MAX_TEXT_FILE_SIZE);
  assert.equal(message.mtime, 1000);
  assert.equal(binary.length, 32);
  assert.ok(binary.every((chunk) => chunk.length <= 64 * 1024));
  assert.ok(messages.every((item) => JSON.stringify(item).length < 1024));
  assert.deepEqual(Buffer.concat(binary), Buffer.from(client.content));
  assert.equal(client.opened[0].flags, SFTP_OPEN_FLAGS.READ);
});

test('超过 2 MiB 的文件直接拒绝，不打开文件', async () => {
  const { client, messages, handler } = setup();
  client.attrs = { size: MAX_TEXT_FILE_SIZE + 1, mtime: 1, permissions: 0o100644 };
  await handler.readText('r2', '/root/huge.log');
  assert.equal(client.opened.length, 0);
  assert.equal(messages[0].type, 'sftp_error');
  assert.equal(messages[0].reason, 'too-large');
  assert.match(messages[0].message, /2 MiB/);
});

test('前 8 KiB 含 NUL 的文件按二进制拒绝', async () => {
  const { client, messages, handler } = setup();
  client.content = new Uint8Array([0x68, 0x69, 0x00, 0x21]);
  client.attrs = { size: 4, mtime: 1, permissions: 0o100644 };
  await handler.readText('r3', '/root/blob.txt');
  assert.equal(messages.at(-1)!.type, 'sftp_error');
  assert.equal(messages.at(-1)!.reason, 'binary');
});

test('严格 UTF-8 解码失败的文件被拒绝', async () => {
  const { client, messages, handler } = setup();
  client.content = new Uint8Array([0xff, 0xfe, 0x41]);
  client.attrs = { size: 3, mtime: 1, permissions: 0o100644 };
  await handler.readText('r4', '/root/latin.txt');
  assert.equal(messages.at(-1)!.type, 'sftp_error');
  assert.equal(messages.at(-1)!.reason, 'encoding');
});

test('expectedMtime 不一致时拒绝写入，且不创建临时文件', async () => {
  const { client, messages, handler } = setup();
  client.attrs = { size: 5, mtime: 2000, permissions: 0o100600 };
  await handler.startUpload('u1', '/root/app.ts', 5, true, 1000);
  assert.equal(messages[0].type, 'sftp_error');
  assert.equal(messages[0].conflict, true);
  assert.equal(messages[0].operation, 'upload');
  assert.equal(client.opened.length, 0);
  assert.equal(client.renames.length, 0);
  assert.equal(client.removed.length, 0);
  assert.equal(client.writes.length, 0);
});

test('expectedMtime 一致时以原权限位创建临时文件并 rename', async () => {
  const { client, messages, handler } = setup();
  client.attrs = { size: 5, mtime: 2000, permissions: 0o100640 };
  await handler.startUpload('u2', '/root/app.ts', 5, true, 2000);
  assert.equal(messages[0].type, 'sftp_upload_ready');
  assert.equal(client.opened.length, 1);
  const opened = client.opened[0];
  assert.notEqual(opened.path, '/root/app.ts');
  assert.match(opened.path, /\.cf-webssh-upload-/);
  assert.equal(opened.attrs?.permissions, 0o640);

  await handler.uploadChunk(new TextEncoder().encode('hello'));
  assert.equal(client.writes.length, 1);

  await handler.finishUpload('u2');
  assert.deepEqual(client.renames, [[opened.path, '/root/app.ts']]);
  const complete = messages.find((message) => message.type === 'sftp_upload_complete');
  assert.ok(complete);
  assert.equal(complete.size, 5);
  assert.equal(complete.mtime, 2000);
});

test('目标文件已被删除时 expectedMtime 校验报冲突', async () => {
  const { client, messages, handler } = setup();
  client.statError = new SFTPStatusError(2, 7, 'No such file');
  await handler.startUpload('u3', '/root/app.ts', 3, true, 1000);
  assert.equal(messages[0].type, 'sftp_error');
  assert.equal(messages[0].conflict, true);
  assert.equal(client.opened.length, 0);
});

test('不带 expectedMtime 时保持现有覆盖行为，并沿用原权限位', async () => {
  const { client, messages, handler } = setup();
  client.attrs = { size: 5, mtime: 9999, permissions: 0o100755 };
  await handler.startUpload('u4', '/root/app.sh', 5, true);
  assert.equal(messages[0].type, 'sftp_upload_ready');
  assert.equal(client.opened.length, 1);
  assert.equal(client.opened[0].attrs?.permissions, 0o755);
});

test('不带 expectedMtime 且目标不存在时照常上传（新文件按 umask 默认权限）', async () => {
  const { client, messages, handler } = setup();
  client.statError = new SFTPStatusError(2, 8, 'No such file');
  await handler.startUpload('u5', '/root/new.txt', 5, true);
  assert.equal(messages[0].type, 'sftp_upload_ready');
  assert.equal(client.opened.length, 1);
  assert.equal(client.opened[0].attrs, undefined);
});

test('非 overwrite 上传不 stat 目标、不建临时文件', async () => {
  const { client, messages, handler } = setup();
  await handler.startUpload('u6', '/root/new.txt', 5, false);
  assert.equal(messages[0].type, 'sftp_upload_ready');
  assert.equal(client.statCalls.length, 0);
  assert.equal(client.opened[0].path, '/root/new.txt');
});

test('remote changes during upload are rechecked before rename', async () => {
  const { client, messages, handler } = setup();
  await handler.startUpload('race', '/root/app.ts', 1, true, 1000);
  await handler.uploadChunk(new Uint8Array([65]));
  client.attrs.mtime = 1001;
  await handler.finishUpload('race');
  assert.equal(messages.at(-1)!.conflict, true);
  assert.equal(client.renames.length, 0);
  assert.equal(client.removed.length, 1);
});

test('ordinary uploads do not request editor-only post-write metadata', async () => {
  const { client, messages, handler } = setup();
  await handler.startUpload('plain', '/root/new.txt', 1, false);
  await handler.uploadChunk(new Uint8Array([65]));
  await handler.finishUpload('plain');
  assert.equal(client.statCalls.length, 0);
  assert.equal(messages.at(-1)!.type, 'sftp_upload_complete');
  assert.equal(messages.at(-1)!.mtime, undefined);
});

test('explicit forced editor save still reports a new mtime', async () => {
  const { messages, handler } = setup();
  await handler.startUpload('force', '/root/app.ts', 1, true, null);
  await handler.uploadChunk(new Uint8Array([65]));
  await handler.finishUpload('force');
  assert.equal(messages.at(-1)!.mtime, 1000);
});

test('truncated text is not presented as a complete editable document', async () => {
  const { client, messages, handler } = setup();
  client.attrs.size = 100;
  await handler.readText('short', '/root/app.ts');
  assert.equal(messages.at(-1)!.type, 'sftp_error');
  assert.ok(!messages.some((item) => item.type === 'sftp_read_text_result'));
});
