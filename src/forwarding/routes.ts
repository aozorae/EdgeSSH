import type { Env } from '../types.ts';
import { jsonError } from '../http-security.ts';
import { previewOrigin } from './security.ts';
import { readBoundedText } from './body.ts';
import { TRUSTED_PREFIX } from './mount.ts';

/** 只有主站的认证 API 能创建或撤销转发；预览站没有 SSH 控制接口。 */
export async function forwardingRoute(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const session = url.searchParams.get('session');
    if (session) {
      if (!/^[a-f0-9]{64}$/.test(session)) return jsonError('Invalid session identifier', 400);
      return env.SSH_SESSIONS.get(env.SSH_SESSIONS.idFromString(session)).fetch(new Request('https://session.internal/forward', {
        headers: { 'x-account-id': accountId },
      }));
    }
    let previewAvailable = false;
    try {
      previewOrigin(env.PREVIEW_ORIGIN, new URL(request.url).origin);
      if (env.APP_ORIGIN) previewOrigin(env.PREVIEW_ORIGIN, env.APP_ORIGIN);
      previewAvailable = true;
    } catch { /* 未启用隔离预览不影响默认标准转发 */ }
    return Response.json({ previewAvailable }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST' && request.method !== 'DELETE') return jsonError('Method not allowed', 405);
  const session = url.searchParams.get('session');
  if (!session || !/^[a-f0-9]{64}$/.test(session)) return jsonError('Invalid session identifier', 400);
  let origin = url.origin;
  const headers = new Headers({
    'x-account-id': accountId, 'Content-Type': 'application/json',
  });
  let body: string | undefined;
  if (request.method === 'POST') {
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return jsonError('Expected application/json', 415);
    let text: string;
    try { text = await readBoundedText(request, 1024); }
    catch { return jsonError('Request body is too large', 413); }
    let input: { port?: unknown; mode?: unknown; trusted?: unknown };
    try { input = JSON.parse(text); } catch { return jsonError('Invalid JSON body', 400); }
    if (!input || !Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) {
      return jsonError('端口必须是 1–65535 的整数。', 400);
    }
    const mode = input.mode ?? 'trusted';
    if (mode !== 'trusted' && mode !== 'isolated') return jsonError('Invalid forwarding mode', 400);
    if (mode === 'trusted' && input.trusted !== true) return jsonError('标准转发仅适用于可信网站，请先确认风险。', 400);
    if (mode === 'isolated') {
      try {
        origin = previewOrigin(env.PREVIEW_ORIGIN, url.origin);
        if (env.APP_ORIGIN) previewOrigin(origin, env.APP_ORIGIN);
      } catch { return jsonError('隔离预览尚未启用，请先运行“部署预览 Worker”工作流。', 503); }
    }
    body = JSON.stringify({ port: input.port, mode });
  }
  headers.set('x-preview-origin', origin);
  return env.SSH_SESSIONS.get(env.SSH_SESSIONS.idFromString(session)).fetch(new Request('https://session.internal/forward', {
    method: request.method, headers, body,
  }));
}

export async function trustedForwardRoute(request: Request, env: Env, accountId: string): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/_forward\/([a-f0-9]{64})(\/.*)?$/.exec(url.pathname);
  if (!match) return jsonError('Not found', 404);
  if (request.headers.has('Service-Worker')) return jsonError('Service workers are disabled in forwarding pages', 403);
  if (!match[2]) return new Response(null, { status: 307, headers: { Location: `${TRUSTED_PREFIX}${match[1]}/${url.search}`, 'Cache-Control': 'no-store' } });
  const headers = new Headers(request.headers);
  // 覆盖所有内部路由信息；不能相信网页发送的目标、模式、账户或 preview token。
  headers.set('x-account-id', accountId);
  headers.set('x-preview-origin', url.origin);
  headers.set('x-preview-path', match[2] + url.search);
  headers.delete('x-preview-token');
  return env.SSH_SESSIONS.get(env.SSH_SESSIONS.idFromString(match[1])).fetch(new Request('https://session.internal/forward-http', {
    method: request.method, headers, body: request.body, signal: request.signal,
  }));
}
