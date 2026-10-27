import { open, rename, rm, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { loadConfig, saveConfig } from './config.mjs';

export async function hostByName(client, selector) {
  const { hosts } = await client.request('/api/hosts');
  const exact = hosts.find(host => host.id === selector);
  const matches = exact ? [exact] : hosts.filter(host => host.name === selector);
  if (matches.length !== 1) throw new Error(matches.length ? 'Host name is ambiguous; use its ID' : `Host not found: ${selector}`);
  return matches[0];
}
export async function connect(client, host, options, mode, command) {
  const key = `${client.origin}|${host.host}:${host.port}`;
  const config = await loadConfig();
  const pinned = options.fingerprint || config.knownHosts?.[key] || host.fingerprint || undefined;
  const credential = await client.request(`/api/hosts/${host.id}/credentials`, {});
  const ticket = await client.request('/api/session', {});
  const channel = await client.open(`/api/ssh?session=${encodeURIComponent(ticket.sessionId)}&ticket=${encodeURIComponent(ticket.ticket)}`);
  channel.send({
    type: 'connect', host: host.host, port: host.port, username: host.username, authMethod: host.authMethod,
    ...credential, cols: Math.max(10, Math.min(1000, process.stdout.columns || 120)), rows: Math.max(5, Math.min(1000, process.stdout.rows || 40)),
    term: host.termType || 'xterm-256color', expectedFingerprint: pinned,
    ...(mode ? { mode } : {}), ...(command ? { command } : {}), timeoutMs: options.timeout * 1000,
  });
  const trust = async message => {
    if (message.type !== 'host_key') return;
    if (pinned && message.fingerprint !== pinned || message.expectedFingerprint && message.expectedFingerprint !== message.fingerprint) throw new Error(`Host key changed for ${host.name}: ${message.fingerprint}`);
    if (!pinned && !options['accept-new']) throw new Error(`Unknown host key for ${host.name}: ${message.fingerprint}. Verify it and pass --fingerprint <SHA256:...>, or explicitly use --accept-new`);
    if (!message.trusted) channel.send({ type: 'host_key_decision', accept: true, fingerprint: message.fingerprint });
    // Never store SSH passwords, keys or Access tokens in this config.
    const current = await loadConfig();
    current.knownHosts = { ...current.knownHosts, [key]: message.fingerprint };
    await saveConfig(current);
  };
  await channel.until('ready', trust);
  return channel;
}
export async function execute(channel, options) {
  let size = 0;
  const stdout = [], stderr = [];
  const result = await channel.until('exec_result', async message => {
    if (message.type !== 'exec_output') return;
    const bytes = Buffer.from(message.data, 'base64');
    size += bytes.length;
    if (size > options['max-output']) throw new Error('Command output limit exceeded; narrow the command or increase --max-output');
    if (options.json) (message.stream === 'stderr' ? stderr : stdout).push(bytes);
    else {
      const target = message.stream === 'stderr' ? process.stderr : process.stdout;
      if (!target.write(bytes)) await once(target, 'drain');
    }
  });
  // Missing SSH exit-status must not be reported as success.
  const exitCode = result.exitCode === null || result.signal ? 255 : result.exitCode;
  if (options.json) process.stdout.write(`${JSON.stringify({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal: result.signal })}\n`);
  return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : 255;
}
export async function terminal(channel) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('connect requires a terminal; agents should use exec');
  const raw = process.stdin.isRaw;
  process.stderr.write('Connected. Press Ctrl+] to disconnect.\n');
  let finished = false;
  const input = data => {
    if (data.includes(0x1d)) { finished = true; channel.close(); return; }
    for (let offset = 0; offset < data.length; offset += 64 * 1024) channel.send(data.subarray(offset, offset + 64 * 1024));
  };
  const resize = () => channel.send({ type: 'resize', cols: Math.max(10, Math.min(1000, process.stdout.columns || 120)), rows: Math.max(5, Math.min(1000, process.stdout.rows || 40)) });
  const end = () => { finished = true; channel.close(); };
  try {
    process.stdin.setRawMode(true);
    process.stdin.on('data', input); process.stdin.once('end', end); process.stdout.on('resize', resize); process.stdin.resume();
    for (;;) {
      const message = await channel.next();
      if (Buffer.isBuffer(message)) { if (!process.stdout.write(message)) await once(process.stdout, 'drain'); }
      else if (message.type === 'error') throw new Error(message.message);
      else if (message.type === 'status' && message.event === 'session_ended') return 0;
    }
  } catch (error) { if (!finished) throw error; return 0; }
  finally {
    process.stdin.off('data', input); process.stdin.off('end', end); process.stdout.off('resize', resize);
    process.stdin.setRawMode(raw); process.stdin.pause();
  }
}
export async function sftp(client, main) {
  const attachment = await main.until('sftp_attach');
  const channel = await client.open(attachment.url);
  channel.send({ type: 'sftp_init' });
  await channel.until('sftp_ready');
  return channel;
}
export async function download(channel, remote, local, force) {
  const temporary = `${local}.${randomUUID()}.part`;
  let file;
  try {
    // Keep the destination intact until the entire transfer succeeds.
    file = await open(temporary, 'wx', 0o600);
    channel.send({ type: 'sftp_download', requestId: 'cli', path: remote });
    let loaded = 0, expected;
    const result = await channel.until('sftp_download_done', async message => {
      if (message.type === 'sftp_download_start') expected = message.size;
      if (!Buffer.isBuffer(message)) return;
      if (loaded + message.length > 64 * 1024 * 1024) throw new Error('File exceeds 64 MiB');
      let offset = 0;
      while (offset < message.length) {
        const written = await file.write(message, offset, message.length - offset);
        if (!written.bytesWritten) throw new Error('Unable to write download');
        offset += written.bytesWritten;
      }
      loaded += message.length;
    });
    if (loaded !== result.size || expected !== undefined && loaded !== expected) throw new Error('Incomplete download');
    await file.close(); file = null;
    if (force) await rename(temporary, local);
    else { await link(temporary, local); await rm(temporary); }
    return { path: local, size: loaded };
  } finally { await file?.close(); await rm(temporary, { force: true }); }
}
export async function upload(channel, local, remote, force) {
  const file = await open(local, 'r');
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size > 64 * 1024 * 1024) throw new Error('File exceeds 64 MiB');
    channel.send({ type: 'sftp_upload_start', requestId: 'cli', path: remote, size, overwrite: force });
    await channel.until('sftp_upload_ready');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error('Local file changed during upload');
      channel.send(buffer.subarray(0, bytesRead));
      const progress = await channel.until('sftp_upload_progress');
      position += bytesRead;
      if (progress.loaded !== position) throw new Error('Upload acknowledgement mismatch');
    }
    channel.send({ type: 'sftp_upload_end', requestId: 'cli' });
    return await channel.until('sftp_upload_complete');
  } finally { await file.close(); }
}
