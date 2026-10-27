import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseConnectMessage } from '../src/types.ts';

const bundle = await build({ stdin: { contents: "export * from './src/backend/session.ts';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', write: false });
const { SSHSession } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const base = { type: 'connect', host: 'example.com', port: 22, username: 'root', authMethod: 'password', password: 'test' };
function fixture(mode: string, extra = {}) {
  const messages: any[] = [], sent: Uint8Array[] = [];
  let closed = false;
  const config = parseConnectMessage({ ...base, mode, ...extra });
  const ws = { readyState: WebSocket.OPEN, send: (value: string) => messages.push(JSON.parse(value)), close() {} };
  const socket = { close() { closed = true; }, writable: new WritableStream(), readable: new ReadableStream() };
  const session = new SSHSession(ws, socket, config);
  session.sendEncrypted = async (payload: Uint8Array) => { sent.push(payload); };
  session.phase = 'auth'; session.authRequestSent = true;
  return { session, messages, sent, closed: () => closed };
}
function frame(type: number, values: number[] = []) {
  const result = new Uint8Array(1 + values.length * 4); result[0] = type;
  values.forEach((value, i) => new DataView(result.buffer).setUint32(1 + i * 4, value));
  return result;
}
function data(type: number, value: string) {
  const bytes = new TextEncoder().encode(value);
  const header = type === 95 ? frame(type, [0, 1, bytes.length]) : frame(type, [0, bytes.length]);
  return new Uint8Array([...header, ...bytes]);
}

test('CLI modes require bounded lifetimes and an exec command only for exec', () => {
  assert.equal(parseConnectMessage({ ...base, mode: 'exec', command: 'true' }).timeoutMs, 60_000);
  assert.equal(parseConnectMessage({ ...base, mode: 'sftp' }).timeoutMs, 600_000);
  assert.equal(parseConnectMessage(base).timeoutMs, undefined);
  for (const extra of [{ mode: 'exec' }, { mode: 'sftp', command: 'true' }, { timeoutMs: 0 }, { timeoutMs: 600_001 }, { mode: 'exec', command: '\0' }]) assert.throws(() => parseConnectMessage({ ...base, ...extra }));
});
test('exec uses no PTY/probe, separates streams, reads exit status, and closes TCP', async () => {
  const f = fixture('exec', { command: 'printf hello; exit 7' });
  await f.session.handleAuth(52, new Uint8Array([52]));
  assert.equal(f.sent[0][0], 90);
  await f.session.handleChannel(91, frame(91, [0, 42, 2 * 1024 * 1024, 32768]));
  assert.ok(new TextDecoder().decode(f.sent[1]).includes('exec'));
  assert.ok(!new TextDecoder().decode(f.sent[1]).includes('pty-req'));
  await f.session.handleChannel(99, frame(99, [0]));
  assert.equal(f.session.systemProbe, null);
  assert.equal(f.sent.at(-1)![0], 96);
  await f.session.handleChannel(94, data(94, 'hello'));
  await f.session.handleChannel(95, data(95, 'error'));
  const name = new TextEncoder().encode('exit-status');
  const request = new Uint8Array([...frame(98, [0, name.length]), ...name, 0, ...frame(0, [7]).subarray(1)]);
  await f.session.handleChannel(98, request);
  await f.session.handleChannel(97, frame(97, [0]));
  assert.deepEqual(f.messages.filter(m => m.type === 'exec_output').map(m => [m.stream, Buffer.from(m.data, 'base64').toString()]), [['stdout', 'hello'], ['stderr', 'error']]);
  assert.deepEqual(f.messages.find(m => m.type === 'exec_result'), { type: 'exec_result', exitCode: 7, signal: null });
  assert.equal(f.closed(), true);
  assert.equal(f.session.keepaliveTimer, null);
});
test('SFTP-only authentication opens no shell or monitoring channel', async () => {
  const f = fixture('sftp'); f.session.setSFTPAttachUrl('/api/sftp?session=test&token=test');
  await f.session.handleAuth(52, new Uint8Array([52]));
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.messages, [{ type: 'ready' }, { type: 'sftp_attach', url: '/api/sftp?session=test&token=test' }]);
  await assert.rejects(f.session.handleClientMessage(new ArrayBuffer(1)), /disabled/);
  f.session.close(true);
});
test('server lifetime deadline closes an abandoned CLI connection and clears timers', async () => {
  const f = fixture('sftp', { timeoutMs: 1000 });
  await f.session.start();
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(f.closed(), true);
  assert.equal(f.messages.at(-1).event, 'session_timeout');
  assert.equal(f.session.lifetimeTimer, null);
});
