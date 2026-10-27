// Single source for "which target is this session about".
//
// A session is identified by `user@host:port` only — nothing else. `main.ts`
// derives that from the connection form while the dashboard derives it from a
// `CloudHost` row, and the two must agree or a running session would not match
// the host card it belongs to (no badge, and the host switch check would dial a
// second connection instead of activating the live one). Owned here so neither
// side can drift: `history.ts` lower-cases the host, `applyProfile()` already
// trims the username, and IPv6 literals arrive wrapped in brackets.

import { historyKey, historyLabel } from './history';

export function normalizeHostAddress(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

/** Session identity for a target, whichever side of the UI describes it. */
export function sessionTargetKey(host: string, port: number, username: string): string {
  return historyKey(normalizeHostAddress(host), port, username.trim());
}

/** Readable counterpart of `sessionTargetKey`. */
export function sessionTargetLabel(host: string, port: number, username: string): string {
  return historyLabel(normalizeHostAddress(host), port, username.trim());
}
