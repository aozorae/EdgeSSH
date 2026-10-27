import WebSocket from 'ws';
import http from 'node:http';
import https from 'node:https';

export class Channel {
  constructor(ws, signal) {
    this.ws = ws;
    this.queue = [];
    this.bytes = 0;
    this.waiter = null;
    this.failure = null;
    ws.on('message', (data, binary) => {
      let value;
      try { value = binary ? Buffer.from(data) : JSON.parse(data.toString()); }
      catch { this.fail(new Error('Invalid EdgeSSH WebSocket message')); this.close(); return; }
      if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve(value); }
      else {
        this.bytes += data.length;
        if (this.bytes > 32 * 1024 * 1024) { this.fail(new Error('WebSocket receive buffer exceeded')); this.close(); }
        else { this.queue.push({ value, size: data.length }); if (this.bytes > 4 * 1024 * 1024) ws.pause(); }
      }
    });
    ws.on('error', () => this.fail(new Error('WebSocket transport failed')));
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      this.fail(new Error(`WebSocket authentication/upgrade failed (HTTP ${response.statusCode}); run edgessh login if expired`));
      ws.terminate();
    });
    ws.on('close', code => { clearInterval(this.heartbeat); signal?.removeEventListener('abort', this.abort); this.fail(new Error(`Connection closed before completion (${code})`)); });
    this.abort = () => { this.fail(signal.reason || new Error('Interrupted')); this.close(); };
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
    let alive = true;
    ws.on('pong', () => { alive = true; });
    this.heartbeat = setInterval(() => {
      if (!alive) { this.fail(new Error('WebSocket heartbeat timed out')); return this.close(); }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25_000);
    this.heartbeat.unref();
  }
  fail(error) { this.failure ||= error; if (this.waiter) { this.waiter.reject(this.failure); this.waiter = null; } }
  next() {
    const item = this.queue.shift();
    if (item) { this.bytes -= item.size; if (this.bytes < 1024 * 1024) this.ws.resume(); return Promise.resolve(item.value); }
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  send(value) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('Connection is closed');
    this.ws.send(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
  close() {
    clearInterval(this.heartbeat);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'CLI operation finished');
      const timer = setTimeout(() => this.ws.terminate(), 1000); timer.unref();
      this.ws.once('close', () => clearTimeout(timer));
    } else if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
  }
  async until(type, onMessage) {
    for (;;) {
      const message = await this.next();
      if (message.type === 'error' || message.type === 'sftp_error') throw new Error(message.message || 'EdgeSSH operation failed');
      if (message.type === type) return message;
      await onMessage?.(message);
    }
  }
}
export class Client {
  constructor(origin, token, signal) {
    this.origin = origin;
    this.signal = signal;
    this.headers = { Origin: origin, Cookie: `CF_Authorization=${token}`, 'cf-access-token': token };
    this.channels = [];
  }
  async request(path, body) {
    const response = await fetch(`${this.origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...this.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status >= 300 && response.status < 400 || response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new Error('Access login is required or expired; run edgessh login --url <site>');
    }
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new Error('Expected an EdgeSSH JSON response; check the site URL and Access policy'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  async open(path) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !['/api/ssh', '/api/sftp'].includes(url.pathname)) throw new Error('Invalid WebSocket attachment URL');
    // ws 自带 createConnection；显式使用全局 Agent，才能沿用 Node 配置的环境代理。
    const agent = url.protocol === 'https:' ? https.globalAgent : http.globalAgent;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, { agent, headers: this.headers, followRedirects: false, handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 });
    const channel = new Channel(ws, this.signal);
    this.channels.push(channel);
    await new Promise((resolve, reject) => {
      const opened = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); reject(channel.failure || new Error('WebSocket connection failed')); };
      const cleanup = () => { ws.off('open', opened); ws.off('error', error); ws.off('close', error); };
      ws.once('open', opened); ws.once('error', error); ws.once('close', error);
    });
    return channel;
  }
  close() { for (const channel of this.channels.reverse()) channel.close(); }
}
