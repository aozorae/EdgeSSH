import assert from 'node:assert/strict';
import test from 'node:test';
import { UNKNOWN_MTIME, expectedMtimeFor, nextMtimeBaseline } from '../frontend/src/editor-mtime.ts';

const READ_MTIME = 1_790_100_000;

test('保存成功但 stat 失败（无 mtime）：基线转为未知，下次保存必须先确认覆盖', () => {
  // finishUpload 的 stat 失败 → sftp_upload_complete 不带 mtime。
  const baseline = nextMtimeBaseline(null);
  assert.equal(baseline, UNKNOWN_MTIME);
  // FileManager treats null as requiring explicit user confirmation.
  assert.equal(expectedMtimeFor(baseline), null);
});

test('下一次保存带回 mtime 后基线恢复，冲突校验重新生效', () => {
  const unknown = nextMtimeBaseline(null);
  assert.equal(expectedMtimeFor(unknown), null);

  const recovered = nextMtimeBaseline(READ_MTIME + 42);
  assert.equal(recovered, READ_MTIME + 42);
  assert.equal(expectedMtimeFor(recovered), READ_MTIME + 42);
});

test('正常带回 mtime 时基线就是新值，不做额外转换', () => {
  assert.equal(nextMtimeBaseline(READ_MTIME), READ_MTIME);
  assert.equal(expectedMtimeFor(READ_MTIME), READ_MTIME);
});
