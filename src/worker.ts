import type { Env } from './types';
import { SSHSessionDO } from './backend/durable-object';
import { corsPreflightResponse, corsResponse, hasValidWebSocketOrigin, httpsRedirect, isProductionHttp, jsonError, secureResponse } from './http-security';
import { currentAccount } from './accounts/auth';
import { authRoute } from './accounts/auth-routes';
import { authProvider } from './accounts/auth-provider';
import { hostsRoute } from './accounts/hosts';
import { snippetsRoute } from './accounts/snippets';
import { keychainRoute } from './accounts/keychain';
import { forwardRulesRoute } from './accounts/forward-rules';
import { apiFailure, json } from './accounts/http';
import { locateHost } from './accounts/location';
import { forwardingRoute, trustedForwardRoute } from './forwarding/routes';

export { SSHSessionDO };

function clientAddress(request: Request): string {
  const value = request.headers.get('CF-Connecting-IP') ?? 'local';
  return /^[0-9A-Fa-f:.]{2,64}$/.test(value) ? value.toLowerCase() : 'unknown';
}

async function sessionTicket(request: Request, env: Env, accountId: string): Promise<Response> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return jsonError('Expected application/json', 415);
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 8192) return jsonError('Request body is too large', 413);
  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 8192) return jsonError('Request body is too large', 413);
    body = JSON.parse(text);
  } catch { return jsonError('Invalid JSON body', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Invalid JSON body', 400);
  const fields = Object.keys(body as Record<string, unknown>);
  if (fields.length > 0) return jsonError('Unsupported request field', 400);
  const id = env.SSH_SESSIONS.newUniqueId();
  const stub = env.SSH_SESSIONS.get(id);
  const response = await stub.fetch(new Request('https://session.internal/ticket', {
    method: 'POST',
    headers: { 'x-client-ip': clientAddress(request), 'x-account-id': accountId },
  }));
  if (!response.ok) return jsonError('Unable to create a session ticket', 503);
  const ticket = await response.json<{ ticket: string; expiresAt: number }>();
  return secureResponse(Response.json({ ...ticket, sessionId: id.toString() }, { headers: { 'Cache-Control': 'no-store' } }));
}

/**
 * Swap the ticket of a session this account already owns. This is how a reloaded
 * tab gets back to the shell it left behind: same Durable Object, same SSH
 * connection, fresh credential. Only the owner can ask, and nothing else about
 * the object changes — if the shell is gone, the reconnect simply fails.
 */
async function sessionTicketReissue(request: Request, env: Env, accountId: string): Promise<Response> {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 8192) return jsonError('Request body is too large', 413);
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 8192) return jsonError('Request body is too large', 413);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonError('Invalid JSON body', 400);
    body = parsed as Record<string, unknown>;
  } catch { return jsonError('Invalid JSON body', 400); }
  if (Object.keys(body).length !== 1) return jsonError('Unsupported request field', 400);
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{64}$/i.test(sessionId)) return jsonError('Invalid session identifier', 400);
  let id: DurableObjectId;
  try { id = env.SSH_SESSIONS.idFromString(sessionId); } catch { return jsonError('Invalid session identifier', 400); }
  const stub = env.SSH_SESSIONS.get(id);
  const response = await stub.fetch(new Request('https://session.internal/ticket/reissue', {
    method: 'POST',
    headers: { 'x-client-ip': clientAddress(request), 'x-account-id': accountId },
  }));
  if (!response.ok) return jsonError(response.status === 403 ? 'Session owner mismatch' : 'Unable to renew this session', response.status === 403 ? 403 : 503);
  const ticket = await response.json<{ ticket: string; expiresAt: number }>();
  return secureResponse(Response.json({ ...ticket, sessionId: id.toString() }, { headers: { 'Cache-Control': 'no-store' } }));
}

async function sshUpgrade(request: Request, env: Env, accountId: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonError('WebSocket upgrade required', 426);
  const url = new URL(request.url);
  if (!hasValidWebSocketOrigin(request)) return jsonError('WebSocket origin is not allowed', 403);
  const ticket = url.searchParams.get('ticket');
  const sessionId = url.searchParams.get('session');
  if (!ticket || !sessionId) return jsonError('Missing session ticket', 401);
  let id: DurableObjectId;
  try { id = env.SSH_SESSIONS.idFromString(sessionId); } catch { return jsonError('Invalid session identifier', 401); }
  const headers = new Headers(request.headers);
  headers.set('x-account-id', accountId);
  headers.delete('Cookie');
  headers.delete('Authorization');
  const sftpAttachToken = crypto.randomUUID();
  const processAttachToken = crypto.randomUUID();
  const sftpAttachUrl = new URL('/api/sftp', 'https://session.invalid');
  sftpAttachUrl.searchParams.set('session', id.toString());
  sftpAttachUrl.searchParams.set('token', sftpAttachToken);
  const processAttachUrl = new URL('/api/processes', 'https://session.invalid');
  processAttachUrl.searchParams.set('session', id.toString());
  processAttachUrl.searchParams.set('token', processAttachToken);
  headers.set('x-session-ticket', ticket);
  headers.set('x-client-ip', clientAddress(request));
  headers.set('x-sftp-attach-token', sftpAttachToken);
  headers.set('x-sftp-attach-url', `${sftpAttachUrl.pathname}${sftpAttachUrl.search}`);
  headers.set('x-process-attach-token', processAttachToken);
  headers.set('x-process-attach-url', `${processAttachUrl.pathname}${processAttachUrl.search}`);
  const response = await env.SSH_SESSIONS.get(id).fetch(new Request('https://session.internal/connect', { headers }));
  if (response.status === 401) return jsonError('Invalid, expired, or already used session ticket', 401);
  return response;
}

async function sftpUpgrade(request: Request, env: Env, accountId: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonError('WebSocket upgrade required', 426);
  if (!hasValidWebSocketOrigin(request)) return jsonError('WebSocket origin is not allowed', 403);
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  const token = url.searchParams.get('token');
  if (!sessionId || !token) return jsonError('Missing SFTP attachment authorization', 401);
  let id: DurableObjectId;
  try { id = env.SSH_SESSIONS.idFromString(sessionId); } catch { return jsonError('Invalid session identifier', 401); }
  const headers = new Headers(request.headers);
  headers.set('x-account-id', accountId);
  headers.delete('Cookie');
  headers.delete('Authorization');
  headers.delete('x-session-ticket');
  headers.delete('x-client-ip');
  headers.delete('x-sftp-attach-url');
  headers.set('x-sftp-attach-token', token);
  const response = await env.SSH_SESSIONS.get(id).fetch(new Request('https://session.internal/sftp', {
    method: 'GET',
    headers,
  }));
  if (response.status === 401) return jsonError('Invalid, expired, or already used SFTP attachment token', 401);
  return response;
}

async function processUpgrade(request: Request, env: Env, accountId: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return jsonError('WebSocket upgrade required', 426);
  if (!hasValidWebSocketOrigin(request)) return jsonError('WebSocket origin is not allowed', 403);
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  const token = url.searchParams.get('token');
  if (!sessionId || !token) return jsonError('Missing process attachment authorization', 401);
  let id: DurableObjectId;
  try { id = env.SSH_SESSIONS.idFromString(sessionId); } catch { return jsonError('Invalid session identifier', 401); }
  const headers = new Headers(request.headers);
  headers.set('x-account-id', accountId);
  headers.delete('Cookie');
  headers.delete('Authorization');
  headers.delete('x-session-ticket');
  headers.delete('x-client-ip');
  headers.delete('x-process-attach-url');
  headers.set('x-process-attach-token', token);
  const response = await env.SSH_SESSIONS.get(id).fetch(new Request('https://session.internal/processes', {
    method: 'GET',
    headers,
  }));
  if (response.status === 401) return jsonError('Invalid, expired, or already used process attachment token', 401);
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isApiRequest = url.pathname.startsWith('/api/');
    const isForwardRequest = url.pathname.startsWith('/_forward/');
    try {
      if (isProductionHttp(request)) {
        if (isApiRequest) return corsResponse(jsonError('HTTPS is required', 403));
        if (request.method === 'GET' || request.method === 'HEAD') return httpsRedirect(request);
        return jsonError('HTTPS is required', 403);
      }
      // Cookie 认证只接受同源请求；写操作必须有 Origin，阻断跨站表单与 CSRF。
      const origin = request.headers.get('Origin');
      if ((isApiRequest || isForwardRequest) && ((origin && origin !== url.origin)
        || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin !== url.origin)
        || request.headers.get('Sec-Fetch-Site') === 'cross-site')) return jsonError('不允许跨站请求。', 403);
      if (isApiRequest && request.method === 'OPTIONS') {
        return corsResponse(corsPreflightResponse());
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return corsResponse(secureResponse(Response.json({ status: 'ok', runtime: 'cloudflare-workers', ssh: true }, { headers: { 'Cache-Control': 'no-store' } })));
      }
      const authentication = await authRoute(request, env);
      if (authentication) return secureResponse(authentication);
      if (url.hostname.endsWith('.workers.dev') && url.pathname === '/api/diagnostics/location' && request.method === 'GET') {
        const location = await locateHost('8.8.8.8');
        if (!location) return corsResponse(jsonError('位置服务暂时不可用。', 503));
        return corsResponse(json({ status: 'ok', sample: '8.8.8.8', location }));
      }
      const account = isApiRequest || isForwardRequest ? await currentAccount(request, env) : null;
      if ((isApiRequest || isForwardRequest) && !account) return jsonError('请先登录。', 401);
      // 转发返回目标网站自己的 CSP，不套主应用 CSP；此路径仍必须先通过管理员认证。
      if (isForwardRequest) return await trustedForwardRoute(request, env, account!.id);
      if (url.pathname === '/api/auth/me' && request.method === 'GET') return json({ account, provider: authProvider(env) });
      if (url.pathname.startsWith('/api/hosts')) return await hostsRoute(request, env, account!.id, url.pathname);
      if (url.pathname.startsWith('/api/snippets')) return await snippetsRoute(request, env, account!.id, url.pathname);
      if (url.pathname.startsWith('/api/keychain')) return await keychainRoute(request, env, account!.id, url.pathname);
      if (url.pathname.startsWith('/api/forward-rules')) return await forwardRulesRoute(request, env, account!.id, url.pathname);
      if (url.pathname === '/api/forwarding') return await forwardingRoute(request, env, account!.id);
      if (url.pathname === '/api/session') {
        if (request.method !== 'POST') return corsResponse(jsonError('Method not allowed', 405));
        return corsResponse(await sessionTicket(request, env, account!.id));
      }
      if (url.pathname === '/api/session/restore') {
        if (request.method !== 'POST') return corsResponse(jsonError('Method not allowed', 405));
        return corsResponse(await sessionTicketReissue(request, env, account!.id));
      }
      if (url.pathname === '/api/ssh') {
        if (request.method !== 'GET') return corsResponse(jsonError('Method not allowed', 405));
        // 成功时 sshUpgrade 返回 101 WebSocket 升级响应，corsResponse 内部会原样
        // 放行（不重新包装）；失败时返回 JSON 错误，正常附加 CORS 头。
        return corsResponse(await sshUpgrade(request, env, account!.id));
      }
      if (url.pathname === '/api/sftp') {
        if (request.method !== 'GET') return corsResponse(jsonError('Method not allowed', 405));
        return corsResponse(await sftpUpgrade(request, env, account!.id));
      }
      if (url.pathname === '/api/processes') {
        if (request.method !== 'GET') return corsResponse(jsonError('Method not allowed', 405));
        return corsResponse(await processUpgrade(request, env, account!.id));
      }
      if (isApiRequest) return corsResponse(jsonError('Not found', 404));
      if (!env.ASSETS) return jsonError('Static assets binding is not configured', 503);
      return secureResponse(await env.ASSETS.fetch(request));
    } catch (error) {
      const response = apiFailure(error);
      return isApiRequest ? corsResponse(response) : response;
    }
  },
};
