import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOSAVE_DELAY_MS,
  LARGE_TEXT_LENGTH, editorAutosaveDelay, editorAutosaveInterval,
  AutosaveController,
  type AutosavePhase,
  type AutosaveTimerHost,
} from '../frontend/src/autosave.ts';

/** 可控时钟：只跑已注册的定时器，按到期时间顺序推进。 */
class FakeTimers {
  now = 0;
  private sequence = 0;
  private readonly callbacks = new Map<number, { at: number; run: () => void }>();

  readonly host: AutosaveTimerHost = {
    set: (callback, delayMs) => {
      const id = ++this.sequence;
      this.callbacks.set(id, { at: this.now + delayMs, run: callback });
      return id;
    },
    clear: (id) => { this.callbacks.delete(id); },
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.callbacks.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.callbacks.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
    }
    this.now = target;
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

function createController(timers: FakeTimers) {
  const saves: Array<{ phase: AutosavePhase; content: string }> = [];
  let content = '';
  const phases: AutosavePhase[] = [];
  const controller = new AutosaveController({
    timers: timers.host,
    save: () => saves.push({ phase: controller.current, content }),
    onPhaseChange: (phase) => phases.push(phase),
  });
  return {
    controller,
    saves,
    phases,
    type(value: string) {
      content = value;
      controller.schedule();
    },
  };
}

test('停顿 3 秒才保存：连续输入只触发一次，计时从最后一次输入重新算', () => {
  const timers = new FakeTimers();
  const harness = createController(timers);
  assert.equal(AUTOSAVE_DELAY_MS, 3_000);

  harness.type('a');
  timers.advance(2_000);
  harness.type('ab');
  timers.advance(2_999);
  assert.equal(harness.saves.length, 0);
  assert.equal(harness.controller.current, 'pending');

  timers.advance(1);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0]!.content, 'ab');
  assert.equal(harness.controller.current, 'saving');
});

test('保存进行中的输入会合并成一次后续保存，不丢字也不并发', () => {
  const timers = new FakeTimers();
  const harness = createController(timers);
  harness.type('one');
  timers.advance(3_000);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.controller.current, 'saving');

  // 保存还没完成时继续输入：不新开保存，只记下「完成后再存一次」。
  harness.type('one-two');
  harness.type('one-two-three');
  timers.advance(10_000);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.controller.current, 'saving');

  harness.controller.succeed();
  assert.equal(harness.controller.current, 'pending');
  timers.advance(3_000);
  assert.equal(harness.saves.length, 2);
  assert.equal(harness.saves[1]!.content, 'one-two-three');
});

test('没有合并输入时保存成功直接回到 idle，并解除暂停', () => {
  const timers = new FakeTimers();
  const harness = createController(timers);
  harness.type('x');
  timers.advance(3_000);
  harness.controller.succeed();
  assert.equal(harness.controller.current, 'idle');
  assert.equal(timers.pending, 0);

  harness.controller.fail(true);
  assert.equal(harness.controller.current, 'paused');
  harness.controller.resume();
  assert.equal(harness.controller.current, 'idle');
});

test('冲突后自动保存暂停：输入不再触发，恢复后才继续', () => {
  const timers = new FakeTimers();
  const harness = createController(timers);
  harness.controller.pause();
  assert.equal(harness.controller.current, 'paused');

  harness.type('while-paused');
  timers.advance(30_000);
  assert.equal(harness.saves.length, 0);
  assert.equal(timers.pending, 0);

  harness.controller.resume();
  assert.equal(harness.controller.current, 'idle');
  harness.type('after-resume');
  timers.advance(3_000);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0]!.content, 'after-resume');
});

test('非冲突失败回到 idle，下一次输入重新计时；defer 会重新排期', () => {
  const timers = new FakeTimers();
  const harness = createController(timers);
  harness.type('a');
  timers.advance(3_000);
  harness.controller.fail(false);
  assert.equal(harness.controller.current, 'idle');

  harness.type('b');
  timers.advance(3_000);
  assert.equal(harness.saves.length, 2);

  // 保存回调发现通道被占用：defer 后仍会再试一次。
  harness.controller.defer();
  assert.equal(harness.controller.current, 'pending');
  timers.advance(3_000);
  assert.equal(harness.saves.length, 3);
});

test('cancel 清掉计时器，关闭编辑器后不会再有迟到的保存', () => {
  const timers = new FakeTimers();
  const harness = createController(timers);
  harness.type('pending');
  assert.equal(timers.pending, 1);
  harness.controller.cancel();
  assert.equal(harness.controller.current, 'idle');
  timers.advance(60_000);
  assert.equal(harness.saves.length, 0);
});

test('large-file autosave has a 15s debounce and 30s minimum start interval', () => {
  const timers = new FakeTimers();
  let length = LARGE_TEXT_LENGTH;
  const starts: number[] = [];
  const controller = new AutosaveController({
    timers: timers.host, now: () => timers.now,
    delayMs: () => editorAutosaveDelay(length),
    minIntervalMs: () => editorAutosaveInterval(length),
    save: () => { starts.push(timers.now); controller.beginSaving(); },
  });
  controller.schedule();
  timers.advance(14_999);
  assert.deepEqual(starts, []);
  timers.advance(1);
  controller.succeed();
  controller.schedule();
  timers.advance(29_999);
  assert.deepEqual(starts, [15_000]);
  timers.advance(1);
  assert.deepEqual(starts, [15_000, 45_000]);
  controller.succeed();
  length = 1;
  controller.schedule();
  timers.advance(9_999);
  assert.equal(starts.length, 2);
  timers.advance(1);
  assert.deepEqual(starts, [15_000, 45_000, 55_000]);
  controller.cancel();
  timers.advance(120_000);
  assert.equal(starts.length, 3);
});

test('manual saves bypass the timer but still rate-limit the next autosave', () => {
  const timers = new FakeTimers();
  let saves = 0;
  const controller = new AutosaveController({
    timers: timers.host, now: () => timers.now,
    minIntervalMs: 30_000, save: () => { saves++; },
  });
  controller.schedule();
  timers.advance(100);
  controller.beginSaving();
  controller.schedule();
  controller.succeed();
  timers.advance(29_999);
  assert.equal(saves, 0);
  timers.advance(1);
  assert.equal(saves, 1);
});
