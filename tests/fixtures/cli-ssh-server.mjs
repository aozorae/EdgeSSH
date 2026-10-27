// Independent SSH/SFTP implementation for CLI integration tests; no privileged daemon.
import ssh2 from '../../cli/node_modules/ssh2/lib/index.js';
const { Server, utils } = ssh2;
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

export async function sshFixture(hostKey, directory) {
  const clients = new Set();
  const children = new Set();
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'publickey' ? context.accept() : context.reject(['publickey']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec();
        const command = spawn('/bin/sh', ['-c', info.command], { detached: true });
        children.add(command);
        command.stdout.pipe(channel, { end: false }); command.stderr.pipe(channel.stderr, { end: false });
        channel.pipe(command.stdin); command.stdin.on('error', () => {});
        command.on('close', (code, signal) => { children.delete(command); channel.exit(code ?? 128, signal); channel.end(); });
        client.once('close', () => { if (children.has(command)) { try { process.kill(-command.pid, 'SIGTERM'); } catch {} } });
      });
      session.on('sftp', acceptSFTP => {
        const stream = acceptSFTP();
        const handles = new Map(); let next = 1;
        const path = value => resolve(directory, value);
        const attrs = info => ({ mode: info.mode, size: info.size, uid: info.uid, gid: info.gid, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) });
        const status = (id, error) => stream.status(id, error ? error.code === 'ENOENT' ? 2 : 4 : 0, error?.message);
        const handle = (id, entry) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(next++); handles.set(buffer.toString('hex'), entry); stream.handle(id, buffer); };
        const entry = buffer => handles.get(buffer.toString('hex'));
        const task = (name, operation) => stream.on(name, (id, ...args) => { Promise.resolve().then(() => operation(id, ...args)).catch(error => status(id, error)); });
        task('REALPATH', async (id, value) => { const filename = await fs.realpath(path(value)); stream.name(id, [{ filename, longname: filename, attrs: attrs(await fs.stat(filename)) }]); });
        for (const name of ['STAT', 'LSTAT']) task(name, async (id, value) => stream.attrs(id, attrs(await fs.stat(path(value)))));
        task('OPEN', async (id, value, flags) => handle(id, { file: await fs.open(path(value), utils.sftp.flagsToString(flags)) }));
        task('CLOSE', async (id, buffer) => { const value = entry(buffer); await value.file?.close(); handles.delete(buffer.toString('hex')); status(id); });
        task('READ', async (id, buffer, offset, length) => { const result = Buffer.alloc(length); const { bytesRead } = await entry(buffer).file.read(result, 0, length, offset); if (bytesRead) stream.data(id, result.subarray(0, bytesRead)); else stream.status(id, 1); });
        task('WRITE', async (id, buffer, offset, bytes) => { await entry(buffer).file.write(bytes, 0, bytes.length, offset); status(id); });
        task('OPENDIR', async (id, value) => {
          const location = path(value), names = await fs.readdir(location);
          const entries = await Promise.all(names.map(async filename => ({ filename, longname: filename, attrs: attrs(await fs.stat(resolve(location, filename))) })));
          handle(id, { entries });
        });
        task('READDIR', async (id, buffer) => { const value = entry(buffer); if (value.entries.length) { stream.name(id, value.entries); value.entries = []; } else stream.status(id, 1); });
        task('MKDIR', async (id, value) => { await fs.mkdir(path(value)); status(id); });
        task('RMDIR', async (id, value) => { await fs.rmdir(path(value)); status(id); });
        task('REMOVE', async (id, value) => { await fs.unlink(path(value)); status(id); });
        task('RENAME', async (id, oldPath, newPath) => { await fs.rename(path(oldPath), path(newPath)); status(id); });
        stream.on('close', () => { for (const value of handles.values()) void value.file?.close().catch(() => {}); handles.clear(); });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: async () => { for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); } };
}
