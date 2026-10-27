import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSE_PAGE_UNLOAD,
  DEFAULT_SESSION_RETENTION_MS,
  MAX_SESSION_RETENTION_MS,
  sessionRetentionMs,
  shouldRetainSession,
} from '../src/backend/session-retention.ts';

test('只有用户主动断开（1000）才立刻拆掉会话', () => {
  assert.equal(shouldRetainSession(1000), false);
});

test('连接中断、页面卸载与未知关闭码都保留会话等待重连', () => {
  assert.equal(shouldRetainSession(CLOSE_PAGE_UNLOAD), true);
  // A reload never asks the browser politely; the socket simply disappears.
  assert.equal(shouldRetainSession(1006), true);
  assert.equal(shouldRetainSession(1001), true);
  assert.equal(shouldRetainSession(undefined), true);
  assert.equal(shouldRetainSession(NaN), true);
});

test('客户端已经判定失败的关闭码不再占用服务端资源', () => {
  // 4000 session error, 4001 auth defect, 4002 protocol error: never salvageable.
  for (const code of [4000, 4001, 4002]) assert.equal(shouldRetainSession(code), false);
});

test('保留窗口有默认值，也拒绝被配置成无限期', () => {
  assert.equal(sessionRetentionMs(undefined), DEFAULT_SESSION_RETENTION_MS);
  assert.equal(sessionRetentionMs(''), DEFAULT_SESSION_RETENTION_MS);
  assert.equal(sessionRetentionMs('not-a-number'), DEFAULT_SESSION_RETENTION_MS);
  assert.equal(sessionRetentionMs('-5'), DEFAULT_SESSION_RETENTION_MS);
  assert.equal(sessionRetentionMs('120000'), 120_000);
  // One mistyped zero must not turn into a session billed forever.
  assert.equal(sessionRetentionMs('3600000000'), MAX_SESSION_RETENTION_MS);
});
