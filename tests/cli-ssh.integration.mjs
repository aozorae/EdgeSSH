// SSH protocol integration against an independent ssh2 server (Unix + ssh-keygen).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { build } from 'esbuild';
import { sshFixture } from './fixtures/cli-ssh-server.mjs';
import { WebSocketServer } from '../cli/node_modules/ws/wrapper.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({ stdin: { contents: "export * from './src/backend/session.ts'; export { parseConnectMessage } from './src/types.ts';", resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', write: false });
const { SSHSession, parseConnectMessage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('CLI against real SSH: command results, SFTP, trust, limits and cleanup', { skip: process.platform === 'win32', timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'edgessh-cli-'));
  const key = join(directory, 'user-key'), hostKey = join(directory, 'host-key');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' });
  execFileSync('ssh-keygen', ['-t', 'ecdsa', '-b', '256', '-N', '', '-f', hostKey], { stdio: 'ignore' });
  const sshServer = await sshFixture(await readFile(hostKey), directory);
  const sshPort = sshServer.port;
  const privateKey = await readFile(key, 'utf8');
  const id = 'a1111111-1111-4111-8111-111111111111';
  const host = { id, name: 'fixture', host: '127.0.0.1', port: sshPort, username: 'root', authMethod: 'publickey', termType: 'xterm', fingerprint: '', hasCredential: true };
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers.cookie, 'CF_Authorization=test.token.value');
    response.setHeader('content-type', 'application/json');
    const value = request.url === '/api/hosts' ? { hosts: [host] }
      : request.url === `/api/hosts/${id}/credentials` ? { privateKey }
      : request.url === '/api/session' ? { sessionId: 'test', ticket: 'test' }
      : { account: { id: 'test', username: 'test@example.com' }, provider: 'cloudflare' };
    response.end(JSON.stringify(value));
  });
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map(); const tcp = new Set();
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => {
    if (request.url.startsWith('/api/sftp')) {
      const session = sessions.get('test'); assert.ok(session);
      session.attachSFTPWebSocket(ws);
      ws.on('message', (value, binary) => { void session.handleSFTPClientMessage(binary ? Uint8Array.from(value).buffer : value.toString()); });
      ws.on('close', () => session.detachSFTPWebSocket(ws));
      return;
    }
    let session;
    ws.on('message', async (value, binary) => {
      try {
        if (session) return await session.handleClientMessage(binary ? Uint8Array.from(value).buffer : value.toString());
        const config = parseConnectMessage(JSON.parse(value.toString()));
        const connection = createConnection(sshPort, '127.0.0.1'); tcp.add(connection); connection.on('close', () => tcp.delete(connection));
        await once(connection, 'connect');
        session = new SSHSession(ws, { readable: Readable.toWeb(connection), writable: Writable.toWeb(connection), close() { connection.destroy(); } }, config);
        session.setSFTPAttachUrl('/api/sftp?session=test&token=test');
        sessions.set('test', session);
        await session.start();
      } catch (error) { ws.send(JSON.stringify({ type: 'error', message: error.message })); ws.close(); }
    });
    ws.on('close', () => { session?.close(true); sessions.delete('test'); });
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const environment = { ...process.env, EDGESSH_CONFIG: join(directory, 'cli.json'), EDGESSH_ACCESS_TOKEN: 'test.token.value' };
  async function cli(...args) {
    const child = spawn(process.execPath, [join(root, 'cli/bin.mjs'), '--url', origin, ...args], { env: environment });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const [code] = await once(child, 'close');
    // Every operation must release its TCP socket, even on error.
    for (let i = 0; tcp.size && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(tcp.size, 0, `leaked SSH socket after ${args[0]}: ${stderr}`);
    return { code, stdout, stderr };
  }
  try {
    await t.test('list omits credentials and opens no SSH socket', async () => {
      const result = await cli('hosts'); assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hosts.length, 1); assert.ok(!result.stdout.includes('PRIVATE KEY'));
    });
    await t.test('unknown host fails; explicit first trust then persists', async () => {
      const first = await cli('exec', 'fixture', '--json', '--', 'true'); assert.equal(first.code, 1); assert.match(first.stderr, /Unknown host key/);
      const result = await cli('exec', 'fixture', '--json', '--accept-new', '--', 'printf hello; printf problem >&2; exit 7');
      assert.equal(result.code, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { stdout: 'hello', stderr: 'problem', exitCode: 7, signal: null });
      const config = await readFile(environment.EDGESSH_CONFIG, 'utf8'); assert.ok(!config.includes('PRIVATE KEY')); assert.ok(!config.includes('test.token.value'));
      const next = await cli('exec', 'fixture', '--json', '--', "printf '中文'"); assert.equal(next.code, 0, next.stderr);
      assert.equal(JSON.parse(next.stdout).stdout, '中文');
    });
    await t.test('binary file round trip, directory operations and overwrite protection', async () => {
      const remoteDir = join(directory, 'remote folder');
      let result = await cli('mkdir', 'fixture', remoteDir); assert.equal(result.code, 0, result.stderr);
      const source = join(directory, 'source'), destination = join(directory, 'download');
      const content = Buffer.alloc(256 * 1024 + 7); for (let i = 0; i < content.length; i++) content[i] = i % 256;
      await writeFile(source, content);
      const remote = join(remoteDir, 'file.bin');
      result = await cli('put', 'fixture', source, remote); assert.equal(result.code, 0, result.stderr);
      result = await cli('ls', 'fixture', remoteDir); assert.equal(result.code, 0, result.stderr); assert.ok(result.stdout.includes('file.bin'));
      result = await cli('get', 'fixture', remote, destination); assert.equal(result.code, 0, result.stderr); assert.deepEqual(await readFile(destination), content);
      result = await cli('get', 'fixture', remote, destination); assert.equal(result.code, 1); assert.deepEqual(await readFile(destination), content);
      result = await cli('put', 'fixture', source, remote); assert.equal(result.code, 1);
      await writeFile(source, 'replacement');
      // ssh2 测试服务不公告原子覆盖扩展，拒绝后必须保留原文件。
      result = await cli('put', 'fixture', source, remote, '--force'); assert.equal(result.code, 1); assert.match(result.stderr, /atomic overwrite/);
      result = await cli('get', 'fixture', remote, destination, '--force'); assert.equal(result.code, 0, result.stderr); assert.deepEqual(await readFile(destination), content);
      const moved = join(remoteDir, 'moved');
      result = await cli('mv', 'fixture', remote, moved); assert.equal(result.code, 0, result.stderr);
      result = await cli('rm', 'fixture', moved); assert.equal(result.code, 0, result.stderr);
      result = await cli('rmdir', 'fixture', remoteDir); assert.equal(result.code, 0, result.stderr);
    });
    await t.test('timeout and output cap fail and release the SSH socket', async () => {
      const timeout = await cli('exec', 'fixture', '--json', '--timeout', '1', '--', 'sleep 10'); assert.equal(timeout.code, 1); assert.match(timeout.stderr, /timed out/);
      const output = await cli('exec', 'fixture', '--json', '--max-output', '10', '--', 'printf 12345678901'); assert.equal(output.code, 1); assert.match(output.stderr, /output limit/);
    });
    await t.test('SIGTERM releases the active SSH socket', async () => {
      const child = spawn(process.execPath, [join(root, 'cli/bin.mjs'), '--url', origin, 'exec', 'fixture', '--json', '--', 'sleep 10'], { env: environment });
      let stderr = ''; child.stderr.on('data', value => { stderr += value; }); child.stdout.resume();
      for (let attempt = 0; !tcp.size && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(tcp.size, 1);
      child.kill('SIGTERM');
      const [code] = await once(child, 'close'); assert.equal(code, 143, stderr);
      for (let i = 0; tcp.size && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(tcp.size, 0);
    });
    await t.test('changed key is rejected even with accept-new', async () => {
      const config = JSON.parse(await readFile(environment.EDGESSH_CONFIG, 'utf8'));
      config.knownHosts[`${origin}|127.0.0.1:${sshPort}`] = `SHA256:${'A'.repeat(43)}`;
      await writeFile(environment.EDGESSH_CONFIG, JSON.stringify(config));
      const result = await cli('exec', 'fixture', '--json', '--accept-new', '--', 'true'); assert.equal(result.code, 1); assert.match(result.stderr, /Host key changed/);
    });
  } finally {
    for (const socket of wss.clients) socket.terminate();
    for (const socket of tcp) socket.destroy();
    wss.close(); server.close(); await sshServer.close(); await rm(directory, { recursive: true, force: true });
  }
});
