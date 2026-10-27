/**
 * 自动保存的防抖 / 合并 / 暂停状态机。
 *
 * 只负责「什么时候该保存」，不碰编辑器与网络：真正的保存动作由 `save` 回调执行，
 * 执行方在保存开始、成功、失败时回报状态。计时器可注入，node 单测无需真实等待。
 *
 * 状态流转：
 *   idle ──schedule──▶ pending ──(到点)──▶ saving
 *   saving ──succeed──▶ idle（保存期间又有输入则重新 pending）
 *   saving ──fail(conflict)──▶ paused（不静默重试；人工覆盖成功或重新载入后 resume）
 *   saving ──fail(other)──▶ idle（等下一次输入或人工保存）
 */

export type AutosavePhase = 'idle' | 'pending' | 'saving' | 'paused';

export const AUTOSAVE_DELAY_MS = 3_000;
export const LARGE_TEXT_LENGTH = 128 * 1024;

// Document length is available in O(1); do not encode the whole file on input.
export const editorAutosaveDelay = (length: number): number => length >= LARGE_TEXT_LENGTH ? 15_000 : AUTOSAVE_DELAY_MS;
export const editorAutosaveInterval = (length: number): number => length >= LARGE_TEXT_LENGTH ? 30_000 : 10_000;

export interface AutosaveTimerHost {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

export interface AutosaveOptions {
  /** 到点后执行的保存动作，必须是幂等的：内容未变时自行跳过。 */
  save: () => void;
  onPhaseChange?: (phase: AutosavePhase) => void;
  delayMs?: number | (() => number);
  minIntervalMs?: number | (() => number);
  now?: () => number;
  timers?: AutosaveTimerHost;
}

const defaultTimers: AutosaveTimerHost = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
  clear: (handle) => globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
};

export class AutosaveController {
  private readonly options: AutosaveOptions;
  private readonly timers: AutosaveTimerHost;
  private lastStarted = -Infinity;
  private phase: AutosavePhase = 'idle';
  private timer: number | null = null;
  /** saving 期间是否又收到过输入：成功后用它决定是否再存一次。 */
  private changedDuringSave = false;

  constructor(options: AutosaveOptions) {
    this.options = options;
    this.timers = options.timers ?? defaultTimers;
  }

  get current(): AutosavePhase {
    return this.phase;
  }

  /** 内容变化：重置防抖计时；保存进行中的输入合并到下一次保存。 */
  schedule(): void {
    if (this.phase === 'paused') return;
    if (this.phase === 'saving') {
      this.changedDuringSave = true;
      return;
    }
    this.arm();
  }

  /** 保存（自动或手动）真正开始。 */
  beginSaving(): void {
    this.lastStarted = this.now();
    this.clearTimer();
    this.changedDuringSave = false;
    this.setPhase('saving');
  }

  /** 保存成功：有合并输入则再排一次，否则回到 idle（同时解除 paused）。 */
  succeed(): void {
    const followUp = this.changedDuringSave;
    this.changedDuringSave = false;
    this.clearTimer();
    this.setPhase('idle');
    if (followUp) this.arm();
  }

  /** 这次触发暂时无法保存（例如另有传输进行中）：稍后重新计时。 */
  defer(): void {
    this.changedDuringSave = false;
    this.arm();
  }

  /**
   * 保存失败。`conflict` 表示远端 mtime 校验拒绝：自动保存必须暂停，
   * 绝不静默覆盖；其他失败回到 idle，等用户下一次输入或手动保存。
   */
  fail(conflict: boolean): void {
    this.clearTimer();
    this.changedDuringSave = false;
    this.setPhase(conflict ? 'paused' : 'idle');
  }

  /** 远端已变更但还没决定保留哪版：暂停自动保存。 */
  pause(): void {
    this.clearTimer();
    this.changedDuringSave = false;
    this.setPhase('paused');
  }

  /** 冲突已解决（强制覆盖成功 / 以远端为准）：恢复自动保存。 */
  resume(): void {
    if (this.phase !== 'paused') return;
    this.setPhase('idle');
  }

  /** 编辑器关闭或连接重置：丢弃计时器，不发保存。 */
  cancel(): void {
    this.clearTimer();
    this.changedDuringSave = false;
    this.setPhase('idle');
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private arm(): void {
    this.clearTimer();
    this.setPhase('pending');
    const delay = typeof this.options.delayMs === 'function' ? this.options.delayMs() : this.options.delayMs ?? AUTOSAVE_DELAY_MS;
    const interval = typeof this.options.minIntervalMs === 'function' ? this.options.minIntervalMs() : this.options.minIntervalMs ?? 0;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.phase !== 'pending') return;
      this.changedDuringSave = false;
      this.setPhase('saving');
      this.lastStarted = this.now();
      this.options.save();
    }, Math.max(delay, interval - (this.now() - this.lastStarted)));
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private setPhase(phase: AutosavePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhaseChange?.(phase);
  }
}
