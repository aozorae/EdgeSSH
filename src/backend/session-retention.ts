// Keeping a shell alive after its browser tab went away.
//
// An SSH session used to die together with the WebSocket that opened it: reload
// the page, lose Wi‑Fi for a second, or follow a link and come back, and
// whatever was running was gone. Retention delays that teardown — the Durable
// Object holds the uplink for a short window so a client that comes back can
// take the same shell over instead of dialling (and authenticating) again.
//
// This module is deliberately free of Durable Object imports: the policy below
// is the part worth testing on its own.

/** Normal close: the user pressed disconnect, so there is nothing to keep. */
export const CLOSE_SESSION_ENDED = 1000;
/**
 * The client announced it is unloading (reload, navigation, tab close). Sent by
 * `beforeunload` so the difference from an intentional disconnect is explicit
 * instead of inferred from whichever code the browser picked.
 */
export const CLOSE_PAGE_UNLOAD = 4003;

/**
 * Application close codes that already mean "this attempt is unsalvageable":
 * 4000 client-side session error, 4001 authentication defect, 4002 protocol
 * error. Retaining any of them would keep a dead shell paid for and idle.
 */
const TERMINAL_CLIENT_CODES = [4000, 4001, 4002];

/**
 * Default holding window. The session stays billed for every second of it, so
 * it is long enough to cover a reload or a tunnel blip and short enough that a
 * forgotten tab is not expensive.
 */
export const DEFAULT_SESSION_RETENTION_MS = 5 * 60_000;
/** Upper bound regardless of configuration, to keep a typo from billing forever. */
export const MAX_SESSION_RETENTION_MS = 30 * 60_000;

export function sessionRetentionMs(configured?: string): number {
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SESSION_RETENTION_MS;
  return Math.min(MAX_SESSION_RETENTION_MS, Math.floor(value));
}

/**
 * Should losing this WebSocket keep the SSH uplink alive?
 *
 * Only an orderly close tears the session down immediately. Everything else —
 * `1001 going away`, an abrupt `1006`, a missing code, or the explicit
 * "I am unloading" code — describes a client that did not ask to disconnect and
 * may well come back.
 */
export function shouldRetainSession(code?: number): boolean {
  if (code === undefined || code === null || Number.isNaN(code)) return true;
  if (code === CLOSE_SESSION_ENDED) return false;
  return !TERMINAL_CLIENT_CODES.includes(code);
}
