// Owns every live SessionContext and decides which one is bound to the shared
// terminal DOM. Step 1 of the multi-session roadmap keeps exactly one context
// alive, so behaviour is unchanged; the limits below simply describe the
// target policy that later steps will actually reach.

import { SessionContext, type ConnectionState } from './session-context';

/** Maximum simultaneous sessions to one target (`user@host:port`). */
export const MAX_SESSIONS_PER_TARGET = 3;
/** Maximum simultaneous sessions across every target. */
export const MAX_SESSIONS_TOTAL = 10;

export const SESSION_EVENT = 'ssh-sessions-changed';

export interface SessionSummary {
  id: string;
  targetKey: string;
  label: string;
  state: ConnectionState;
  startedAt: number;
}

export type SessionLimit = 'ok' | 'target' | 'total';

export class SessionManager {
  private readonly sessions = new Map<string, SessionContext>();
  private activeId: string | null = null;
  private sequence = 0;

  get size(): number {
    return this.sessions.size;
  }

  get active(): SessionContext | null {
    return this.activeId ? this.sessions.get(this.activeId) ?? null : null;
  }

  get activeIdOrNull(): string | null {
    return this.activeId;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((context) => ({
      id: context.id,
      targetKey: context.targetKey,
      label: context.targetLabel,
      state: context.state,
      startedAt: context.startedAt,
    }));
  }

  get(id: string): SessionContext | null {
    return this.sessions.get(id) ?? null;
  }

  /** Live contexts, oldest first. */
  all(): SessionContext[] {
    return [...this.sessions.values()];
  }

  /** Re-emit the change event after this context's state or label moved. */
  touch(id: string): void {
    if (this.sessions.has(id)) this.changed();
  }

  /** Live contexts dialled to a given target, oldest first. */
  forTarget(targetKey: string): SessionContext[] {
    if (!targetKey) return [];
    return [...this.sessions.values()].filter((context) => context.targetKey === targetKey);
  }

  countForTarget(targetKey: string): number {
    return this.forTarget(targetKey).length;
  }

  /**
   * Gate used before dialling a new session. Keeps the two configured ceilings
   * (`MAX_SESSIONS_PER_TARGET`, `MAX_SESSIONS_TOTAL`) from being crossed.
   */
  checkLimit(targetKey: string): SessionLimit {
    if (this.sessions.size >= MAX_SESSIONS_TOTAL) return 'total';
    if (targetKey && this.countForTarget(targetKey) >= MAX_SESSIONS_PER_TARGET) return 'target';
    return 'ok';
  }

  create(): SessionContext {
    this.sequence += 1;
    const context = new SessionContext({ id: `session-${this.sequence}` });
    this.sessions.set(context.id, context);
    if (!this.activeId) this.activeId = context.id;
    this.changed();
    return context;
  }

  remove(id: string): void {
    if (!this.sessions.delete(id)) return;
    if (this.activeId === id) this.activeId = this.sessions.keys().next().value ?? null;
    this.changed();
  }

  activate(id: string): void {
    if (!this.sessions.has(id) || this.activeId === id) return;
    this.activeId = id;
    this.changed();
  }

  private changed(): void {
    window.dispatchEvent(new CustomEvent(SESSION_EVENT));
  }
}
