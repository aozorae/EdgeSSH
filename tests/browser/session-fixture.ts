import { expect, type Page, type WebSocketRoute } from '@playwright/test';

/** One host with credentials; the dashboard row and the session targetKey both come from this. */
export const sshHost = (id: string, name: string, address: string, location: object | null = null) => ({
  id, name, host: address, port: 22, username: 'root', group: '测试主机',
  authMethod: 'password', initialCommand: '', termType: 'xterm-256color',
  encoding: 'utf-8', fingerprint: '', location, system: null,
  hasCredential: true, updatedAt: Date.now(),
});

export interface SessionFixtureOptions {
  /** How many saved hosts to expose; the first two keep the names existing specs assert on. */
  hostCount?: number;
  /** Per-host location, in list order: the profile row and the terminal header both draw their flag from it. */
  locations?: (object | null)[];
}

/**
 * Host list, a stubbed SSH uplink and a way to tell which socket did what.
 * `closes` is indexed exactly like `sockets`, so a background session staying
 * alive reads as `closes[0] === undefined`; `frames` keeps every frame each
 * socket received, which is how tests prove a keystroke reached exactly one
 * session instead of whichever one happens to own the terminal DOM.
 */
export async function sessionFixture(page: Page, options: SessionFixtureOptions = {}) {
  const count = options.hostCount ?? 2;
  const hosts = Array.from({ length: count }, (_, index) => sshHost(
    index === 0 ? 'alpha' : index === 1 ? 'beta' : `host-${index + 1}`,
    index === 0 ? 'Tokyo production' : index === 1 ? 'Singapore backup' : `Host ${index + 1}`,
    `192.0.2.${(index + 1) * 10}`,
    options.locations?.[index] ?? null,
  ));
  const connections: any[] = [];
  const sockets: WebSocketRoute[] = [];
  const closes: (number | undefined)[] = [];
  const frames: Array<Array<Record<string, any>>> = [];
  /** Serverside shells still held open after their tab vanished — what makes resuming possible. */
  const resumable = new Set<string>();
  const restoreCalls: string[] = [];
  /** Counter for /api/hosts round trips — how a test proves the dashboard really reloaded. */
  const requests = { hosts: 0 };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    }
    if (path === '/api/hosts') { requests.hosts += 1; return route.fulfill({ json: { hosts } }); }
    if (path.endsWith('/credentials')) return route.fulfill({ json: { password: 'test-only-password' } });
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId: crypto.randomUUID() } });
    if (path === '/api/session/restore') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      restoreCalls.push(String(body.sessionId ?? ''));
      // The reference implementation hands back a ticket only while the shell is
      // still being held; anything else is "it is gone, dial again".
      if (!resumable.has(String(body.sessionId))) return route.fulfill({ status: 410, json: { error: 'This session has already ended' } });
      return route.fulfill({ json: { ticket: 'resumed-ticket', expiresAt: Date.now() + 60_000, sessionId: body.sessionId } });
    }
    if (path === '/api/snippets') return route.fulfill({ json: { snippets: [] } });
    if (path === '/api/forwarding') return route.fulfill({ json: { available: false, trustedAvailable: true } });
    if (path === '/api/forward-rules') return route.fulfill({ json: { rules: [] } });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    const index = sockets.length;
    sockets.push(ws);
    const mine: Array<Record<string, any>> = [];
    frames.push(mine);
    const sessionId = new URL(ws.url()).searchParams.get('session') ?? '';
    ws.onClose((code?: number) => {
      closes[index] = code ?? -1;
      // Only a deliberate disconnect ends a session. Every other close leaves the
      // shell held on the server, waiting for the tab that may come back for it.
      if ((code ?? -1) === 1000) resumable.delete(sessionId);
    });
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      mine.push(message);
      if (message.type === 'connect') {
        connections.push(message);
        resumable.add(sessionId);
        ws.send(JSON.stringify({ type: 'ready' }));
        return;
      }
      if (message.type === 'resume') {
        if (!resumable.has(sessionId)) {
          ws.close(4000, 'This session has already ended');
          return;
        }
        ws.send(JSON.stringify({ type: 'ready', resumed: true }));
      }
    });
  });
  await page.goto('/');
  await expect(page.locator('#host-list')).toContainText('Tokyo production');
  /** Everything the client pushed down one socket, concatenated — enough to read keystrokes back. */
  const typed = (index: number): string => frames[index]
    .filter((frame) => frame.type === 'input')
    .map((frame) => String(frame.data ?? ''))
    .join('');
  return { hosts, connections, sockets, closes, frames, typed, resumable, restoreCalls, requests };
}
