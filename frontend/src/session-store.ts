// What survives a page reload.
//
// Only identity is stored: which Durable Object holds the shell, and how it was
// labelled. Deliberately no password and no private key — if the shell is gone
// the user has to type the credential again, which is exactly why picking the
// same shell back up is worth doing in the first place.

const STORAGE_KEY = 'edgessh.sessions.v1';
/**
 * A record older than this describes a session that cannot still be waiting:
 * the server holds a shell for minutes, not days, so stale entries are dropped
 * rather than shown as something that might come back.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RestorableSession {
  targetKey: string;
  targetLabel: string;
  backendSessionId: string;
  savedAt: number;
}

/** Anything with these fields can be asked for its shell again. */
export interface RestorableSnapshot {
  targetKey: string;
  targetLabel: string;
  backendSessionId: string;
  state: string;
}

function isRestorable(value: unknown): value is RestorableSession {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.backendSessionId === 'string' && record.backendSessionId.length > 0
    && typeof record.targetKey === 'string' && record.targetKey.length > 0
    && typeof record.targetLabel === 'string'
    && typeof record.savedAt === 'number' && Number.isFinite(record.savedAt);
}

export function loadRestorableSessions(): RestorableSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(isRestorable).filter((record) => now - record.savedAt < MAX_AGE_MS);
  } catch {
    return [];
  }
}

/** Overwrite the list with what is connected right now. Used whenever a session changes state. */
export function saveRestorableSessions(sessions: Iterable<RestorableSnapshot>): void {
  const records: RestorableSession[] = [];
  for (const session of sessions) {
    if (session.state !== 'connected' || !session.backendSessionId) continue;
    records.push({
      targetKey: session.targetKey,
      targetLabel: session.targetLabel,
      backendSessionId: session.backendSessionId,
      savedAt: Date.now(),
    });
  }
  write(records);
}

/** Forget one shell the server no longer has, without rewriting anything else. */
export function forgetRestorableSession(backendSessionId: string): void {
  write(loadRestorableSessions().filter((record) => record.backendSessionId !== backendSessionId));
}

function write(records: RestorableSession[]): void {
  try {
    if (records.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Private browsing or a full quota: resuming a shell is a convenience, and
    // losing it must never take the app down with it.
  }
}
