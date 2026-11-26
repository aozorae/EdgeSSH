import assert from 'node:assert/strict';
import test from 'node:test';
import { LinuxCPUSampler, parseLinuxCPUCounters } from '../src/backend/linux-cpu-sampler.ts';

const cpu = (...values: (number | bigint)[]) => `cpu ${values.join(' ')}\ncpu0 999 0 0 1`;

test('first Linux CPU sample is null; interval calculation counts iowait as idle', () => {
  const sampler = new LinuxCPUSampler();
  assert.equal(sampler.sample(cpu(100, 20, 50, 800, 10, 4, 6, 10)), null);
  // busy +20 (user/system/irq/softirq/steal), idle +80 (idle/iowait)
  assert.equal(sampler.sample(cpu(110, 20, 55, 870, 20, 5, 7, 13)), 20);
});

test('guest counters are not added twice or treated as independent reset counters', () => {
  const sampler = new LinuxCPUSampler();
  sampler.sample(cpu(100, 20, 50, 800, 10, 0, 0, 0, 50, 10));
  assert.equal(sampler.sample(cpu(120, 20, 50, 880, 10, 0, 0, 0, 70, 10)), 20);
  assert.equal(sampler.sample(cpu(140, 20, 50, 960, 10, 0, 0, 0, 0, 0)), 20);
});

test('zero delta returns null and subsequent valid interval recovers', () => {
  const sampler = new LinuxCPUSampler();
  sampler.sample(cpu(100, 0, 0, 100));
  assert.equal(sampler.sample(cpu(100, 0, 0, 100)), null);
  assert.equal(sampler.sample(cpu(100, 0, 0, 200)), 0);
  assert.equal(sampler.sample(cpu(200, 0, 0, 200)), 100);
});

test('counter reset rebaselines including individual regression despite increasing total', () => {
  const sampler = new LinuxCPUSampler();
  sampler.sample(cpu(100, 0, 0, 100));
  assert.equal(sampler.sample(cpu(1, 0, 0, 1)), null);
  assert.equal(sampler.sample(cpu(11, 0, 0, 91)), 10);
  assert.equal(sampler.sample(cpu(10, 0, 0, 200)), null);
  assert.equal(sampler.sample(cpu(20, 0, 0, 290)), 10);
});

test('invalid or missing sample breaks continuity and reset requires a fresh baseline', () => {
  const sampler = new LinuxCPUSampler();
  sampler.sample(cpu(100, 0, 0, 100));
  assert.equal(sampler.sample(''), null);
  assert.equal(sampler.sample(cpu(200, 0, 0, 200)), null);
  assert.equal(sampler.sample('cpu 200 0 NaN 201'), null);
  assert.equal(sampler.sample(cpu(300, 0, 0, 300)), null);
  sampler.reset();
  assert.equal(sampler.sample(cpu(400, 0, 0, 400)), null);
});

test('uses bigint counters above Number.MAX_SAFE_INTEGER without losing small deltas', () => {
  const sampler = new LinuxCPUSampler();
  const large = 900719925474099300000n;
  sampler.sample(cpu(large, 0, 0, large));
  assert.equal(sampler.sample(cpu(large + 1n, 0, 0, large + 3n)), 25);
});

test('parses only aggregate CPU, supports older short format, rejects malformed counters', () => {
  assert.deepEqual(parseLinuxCPUCounters('cpu 1 2 3 4'), [1n, 2n, 3n, 4n, 0n, 0n, 0n, 0n]);
  for (const raw of ['cpu0 1 2 3 4', 'cpu 1 2 3', 'cpu 1 2 3 -4', 'cpu 1 2 3 4.5', 'cpu 1 2 3 4 bad']) {
    assert.equal(parseLinuxCPUCounters(raw), null, raw);
  }
});
