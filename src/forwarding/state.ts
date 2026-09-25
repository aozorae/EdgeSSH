import type { SSHSession } from '../backend/session.ts';
import { FORWARD_TTL_MS, LAUNCH_TTL_MS, PREVIEW_PREFIX, previewError } from './security.ts';
import { proxyHTTP } from './http.ts';
import { trustedBase, RUNTIME_PATH } from './mount.ts';
import { pathRuntime } from './runtime.ts';

interface Grant {
  session: SSHSession;
  port: number;
  origin: string;
  launchToken: string | null;
  launchExpires: number;
  token: string;
  expires: number;
  base: string;
  mode: 'trusted' | 'isolated';
}

export interface ForwardingStatus {
  active: boolean;
  port?: number;
  mode?: 'trusted' | 'isolated';
  expiresAt?: number;
}

/** 授权仅存在 SSH 会话内存里；DO 重启、远端 SSH 断线或显式停止都会让预览 Cookie 失效。 */
export class ForwardingState {
  private grant?: Grant;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;

  clear(): void {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.grant = undefined;
  }

  stop(): void {
    const session = this.grant?.session;
    this.clear();
    session?.close(true);
  }

  owns(session: SSHSession): boolean {
    return this.grant?.session === session && session.isForwardReady();
  }

  currentSession(): SSHSession | undefined {
    return this.grant?.session;
  }

  status(expiresAtLimit?: number): ForwardingStatus {
    const grant = this.grant;
    if (!grant || !grant.session.isForwardReady() || grant.expires <= Date.now()) return { active: false };
    return {
      active: true,
      port: grant.port,
      mode: grant.mode,
      expiresAt: Math.min(grant.expires, expiresAtLimit ?? grant.expires),
    };
  }

  async create(session: SSHSession, port: number, origin: string, sessionId: string,
    mode: 'trusted' | 'isolated' = 'isolated', expiresAtLimit?: number): Promise<Response> {
    this.clear();
    const revision = this.revision;
    // 创建时先探测 direct-tcpip 权限和监听端口，避免给用户一个必定失败的链接。
    const probe = await session.openForward(port);
    await probe.close();
    if (revision !== this.revision || !session.isForwardReady()) return previewError('转发已取消。', 409);
    const grant: Grant = {
      session, port, origin, launchToken: crypto.randomUUID(), launchExpires: Date.now() + LAUNCH_TTL_MS,
      token: crypto.randomUUID(), expires: Math.min(Date.now() + FORWARD_TTL_MS, expiresAtLimit ?? Number.MAX_SAFE_INTEGER),
      base: mode === 'trusted' ? trustedBase(sessionId) : '', mode,
    };
    this.grant = grant;
    this.timer = setTimeout(() => this.stop(), FORWARD_TTL_MS);
    return Response.json({
      url: grant.base ? `${origin}${grant.base}/` : `${origin}${PREVIEW_PREFIX}start#${sessionId}.${grant.launchToken}`,
      expiresAt: grant.expires,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async preview(request: Request): Promise<Response> {
    const grant = this.grant;
    if (!grant || grant.base || grant.expires <= Date.now() || !grant.session.isForwardReady()
      || request.headers.get('x-preview-origin') !== grant.origin) return previewError('转发已断开或过期，请回到 EdgeSSH 重新连接。', 410);
    const token = request.headers.get('x-preview-token');
    if (new URL(request.url).pathname === '/preview-launch') {
      if (request.method !== 'POST' || !grant.launchToken || token !== grant.launchToken || grant.launchExpires <= Date.now()) {
        return previewError('预览链接已使用或过期。', 401);
      }
      grant.launchToken = null;
      return Response.json({ token: grant.token, maxAge: Math.floor((grant.expires - Date.now()) / 1000) },
        { headers: { 'Cache-Control': 'no-store' } });
    }
    if (token !== grant.token) return previewError('预览授权无效。', 401);
    return this.serve(request, grant);
  }

  /** 主站已完成登录校验，DO 已核对 account-id；不能借此入口绕过隔离模式票据。 */
  async trusted(request: Request): Promise<Response> {
    const grant = this.grant;
    if (!grant?.base || grant.expires <= Date.now() || !grant.session.isForwardReady()
      || request.headers.get('x-preview-origin') !== grant.origin) return previewError('转发已断开或模式不匹配。', 410);
    if (request.headers.get('x-preview-path') === RUNTIME_PATH && request.method === 'GET') {
      return new Response(pathRuntime(grant.base, grant.port), { headers: {
        'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "worker-src 'none'",
      } });
    }
    return this.serve(request, grant);
  }

  private async serve(request: Request, grant: Grant): Promise<Response> {
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)
      || request.headers.has('Upgrade')) return previewError('此预览只支持 HTTP 请求，不支持 WebSocket 或 CONNECT。', 405);
    const origin = request.headers.get('Origin');
    if ((origin && origin !== grant.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site'
      || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin !== grant.origin)) {
      return previewError('不允许跨站访问预览。', 403);
    }
    try {
      const channel = await grant.session.openForward(grant.port);
      if (this.grant !== grant) { await channel.close(); return previewError('转发已停止。', 410); }
      return await proxyHTTP(channel, request, grant.port, grant.origin, grant.base);
    } catch { return previewError('无法访问远端 HTTP 服务，请检查端口、服务状态和 SSH 转发权限。', 502); }
  }
}
