import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PROCESS_MONITOR_COMMAND, PROCESS_SNAPSHOT_MARKER } from '../src/backend/process-monitor-command.ts';

const result = await build({
  stdin: {
    contents: "export * from './src/backend/session.ts'; export * from './src/backend/process-snapshot-sampler.ts';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const { SSHSession, ProcessSnapshotSampler } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);
const top = `%Cpu(s): 100.0 us, 0.0 sy, 0.0 id
MiB Mem : 100 total, 80 free, 20 used, 0 buff/cache
 PID USER %CPU %MEM RES S TIME+ COMMAND
 42 root 1.0 2.0 2m S 0:01 test-command
`;
const linux = (user: number, idle: number) => `${top}__CF_WEBSSH_LINUX_CPU__\ncpu ${user} 0 0 ${idle} 0 0 0 0 0 0\n__CF_WEBSSH_NETWORK__\neth0 100 200\n`;

function fixture() {
  const session = new SSHSession(
    { readyState: WebSocket.OPEN, send() {}, close() {} },
    { readable: new ReadableStream(), close() {} },
    { host: '192.0.2.1', port: 22, username: 'test', authMethod: 'password', password: 'test-only' },
  );
  const messages: any[] = [];
  session.phase = 'ready';
  session.processWebSocket = {};
  session.sendProcessJson = (message: unknown) => messages.push(message);
  session.sendEncrypted = async () => {};
  return { session, messages };
}

test('Linux overrides false top 100%, while keeping process list, memory and network', () => {
  const sampler = new ProcessSnapshotSampler();
  const first = sampler.parse(linux(100, 900), 123);
  assert.equal(first.metrics.cpuPercent, null);
  assert.equal(first.timestamp, 123);
  assert.equal(first.processes[0].pid, 42);
  assert.equal(first.metrics.memory.percent, 20);
  assert.deepEqual(first.metrics.network, [{ iface: 'eth0', rxBytes: 100, txBytes: 200 }]);
  assert.equal(sampler.parse(linux(101, 999)).metrics.cpuPercent, 1);
  assert.equal(sampler.parse(linux(102, 1098)).metrics.cpuPercent, 1);
});

test('missing Linux counters yield null instead of top fallback and force rebaseline', () => {
  const sampler = new ProcessSnapshotSampler();
  sampler.parse(linux(100, 900));
  assert.equal(sampler.parse(`${top}__CF_WEBSSH_LINUX_CPU__\n\n`).metrics.cpuPercent, null);
  assert.equal(sampler.parse(linux(101, 999)).metrics.cpuPercent, null);
  assert.equal(sampler.parse(top).metrics.cpuPercent, null);
  assert.equal(sampler.parse(linux(102, 1098)).metrics.cpuPercent, null);
  assert.equal(sampler.parse(linux(103, 1197)).metrics.cpuPercent, 1);
});

test('non-Linux top CPU remains available and channel reset clears Linux state', () => {
  const sampler = new ProcessSnapshotSampler();
  assert.equal(sampler.parse('CPU: 2% user, 3% system, 95% idle').metrics.cpuPercent, 5);
  sampler.parse(linux(100, 900));
  sampler.reset();
  assert.equal(sampler.parse('CPU usage: 2% user, 1% sys, 97% idle').metrics.cpuPercent, 3);
  assert.equal(sampler.parse(linux(200, 1800)).metrics.cpuPercent, null);
});

test('session frames fragmented output and flushes last interval once at EOF', () => {
  const { session, messages } = fixture();
  const raw = PROCESS_SNAPSHOT_MARKER + '\n' + linux(100, 900) + PROCESS_SNAPSHOT_MARKER + '\n' + linux(101, 999);
  const bytes = new TextEncoder().encode(raw);
  for (let i = 0; i < bytes.length; i += 7) session.consumeProcessOutput(bytes.slice(i, i + 7));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].cpuPercent, undefined);
  assert.equal(messages[0].metrics.cpuPercent, null);
  session.flushProcessBuffer();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].metrics.cpuPercent, 1);
  session.flushProcessBuffer();
  assert.equal(messages.length, 2);
});

test('session process stop/start resets baseline, separate sessions never share counters', async () => {
  const { session, messages } = fixture();
  session.emitProcessSnapshot(linux(100, 900));
  session.emitProcessSnapshot(linux(101, 999));
  assert.equal(messages.at(-1).metrics.cpuPercent, 1);
  await session.closeProcessChannel();
  await session.openProcessChannel();
  session.clearPendingProcessChannelOpen();
  session.emitProcessSnapshot(linux(200, 1800));
  assert.equal(messages.at(-1).metrics.cpuPercent, null);
  const other = fixture();
  other.session.emitProcessSnapshot(linux(300, 2700));
  assert.equal(other.messages[0].metrics.cpuPercent, null);
  session.close(true);
});

test('monitor shell is syntactically valid and keeps Linux top fallbacks plus platform branches', () => {
  execFileSync('sh', ['-n', '-c', PROCESS_MONITOR_COMMAND]);
  assert.match(PROCESS_MONITOR_COMMAND, /read -r CPU_LINE < \/proc\/stat/);
  assert.match(PROCESS_MONITOR_COMMAND, /Linux\)/);
  assert.match(PROCESS_MONITOR_COMMAND, /FreeBSD\) top -b -a -d 1/);
  assert.match(PROCESS_MONITOR_COMMAND, /Darwin\) top -l 1/);
  assert.match(PROCESS_MONITOR_COMMAND, /top -b -c -n 1 -w 0/);
  assert.match(PROCESS_MONITOR_COMMAND, /\/sys\/class\/net/);
  // Literal delimiters must not appear in top's process command column.
  assert.doesNotMatch(PROCESS_MONITOR_COMMAND, /__CF_WEBSSH_/);
});
