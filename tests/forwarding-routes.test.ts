import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardingRoute, trustedForwardRoute } from '../src/forwarding/routes.ts';
import { ForwardingState } from '../src/forwarding/state.ts';

const sessionId = 'a'.repeat(64);

function makeEnv(previewOrigin?: string, appOrigin?: string) {
  const calls: Array<{ request: Request; id: string }> = [];
  const env = {
    PREVIEW_ORIGIN: previewOrigin,
    APP_ORIGIN: appOrigin,
    SSH_SESSIONS: {
      idFromString(id: string) { return id; },
      get(id: string) {
        return { fetch(request: Request) { calls.push({ request, id }); return Promise.resolve(new Response('ok')); } };
      },
    },
  } as never;
  return { env, calls };
}

test('GET reports preview availability only when configured', async () => {
  assert.deepEqual(await (await forwardingRoute(new Request('https://main.test/api/forward'), makeEnv().env, 'acct')).json(), { previewAvailable: false });
  assert.deepEqual(await (await forwardingRoute(new Request('https://main.test/api/forward'), makeEnv('https://preview.test').env, 'acct')).json(), { previewAvailable: true });
});

test('GET with a session queries the owned Durable Object', async () => {
  const state = makeEnv();
  const response = await forwardingRoute(new Request(`https://main.test/api/forward?session=${sessionId}`), state.env, 'acct');
  assert.equal(response.status, 200);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].id, sessionId);
  assert.equal(state.calls[0].request.method, 'GET');
  assert.equal(state.calls[0].request.headers.get('x-account-id'), 'acct');
  assert.equal((await forwardingRoute(new Request('https://main.test/api/forward?session=bad'), state.env, 'acct')).status, 400);
});

test('trusted POST requires explicit confirmation and forwards trusted mode', async () => {
  const missing = makeEnv();
  const rejected = await forwardingRoute(new Request(`https://main.test/api/forward?session=${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 80 }),
  }), missing.env, 'acct');
  assert.equal(rejected.status, 400); assert.equal(missing.calls.length, 0);

  const configured = makeEnv();
  const accepted = await forwardingRoute(new Request(`https://main.test/api/forward?session=${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 80, trusted: true }),
  }), configured.env, 'acct');
  assert.equal(accepted.status, 200); assert.equal(configured.calls.length, 1);
  assert.equal(await configured.calls[0].request.text(), JSON.stringify({ port: 80, mode: 'trusted' }));
  assert.equal(configured.calls[0].request.headers.get('x-preview-origin'), 'https://main.test');
});

test('isolated mode without preview configuration returns 503 and invalid mode returns 400', async () => {
  const isolated = makeEnv();
  const result = await forwardingRoute(new Request(`https://main.test/api/forward?session=${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 80, mode: 'isolated' }),
  }), isolated.env, 'acct');
  assert.equal(result.status, 503); assert.equal(isolated.calls.length, 0);
  const invalid = await forwardingRoute(new Request(`https://main.test/api/forward?session=${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 80, mode: 'other', trusted: true }),
  }), isolated.env, 'acct');
  assert.equal(invalid.status, 400);
});

test('DELETE works without preview configuration', async () => {
  const state = makeEnv();
  const result = await forwardingRoute(new Request(`https://main.test/api/forward?session=${sessionId}`, { method: 'DELETE' }), state.env, 'acct');
  assert.equal(result.status, 200); assert.equal(state.calls.length, 1);
});

test('trusted forwarding validates session, strips token, derives path, and preserves body', async () => {
  const state = makeEnv();
  // 传入可复用的字符串 body，避免 Node 对转发 ReadableStream 强制要求 duplex: half。
  const request = {
    method: 'POST', url: `https://main.test/_forward/${sessionId}/form?a=1`,
    headers: new Headers({ 'x-account-id': 'forged', 'x-preview-token': 'secret' }), body: 'payload',
  } as unknown as Request;
  assert.equal((await trustedForwardRoute(request, state.env, 'real-account')).status, 200);
  const forwarded = state.calls[0].request;
  assert.equal(forwarded.headers.get('x-account-id'), 'real-account');
  assert.equal(forwarded.headers.get('x-preview-token'), null);
  assert.equal(forwarded.headers.get('x-preview-path'), '/form?a=1');
  assert.equal(await forwarded.text(), 'payload');
  assert.equal((await trustedForwardRoute(new Request('https://main.test/_forward/not-hex/form'), state.env, 'acct')).status, 404);
  assert.equal((await trustedForwardRoute(new Request(`https://main.test/_forward/${sessionId}/form`, { headers: { 'Service-Worker': 'script' } }), state.env, 'acct')).status, 403);
});

function fakeSession() {
  let ready = true;
  return {
    isForwardReady: () => ready,
    openForward: async () => ({ close: async () => {} }),
    close: () => { ready = false; },
  } as never;
}

test('ForwardingState rejects cross-mode grants and clear invalidates both paths', async () => {
  const state = new ForwardingState();
  await state.create(fakeSession(), 80, 'https://main.test', sessionId, 'isolated');
  assert.equal((await state.trusted(new Request('https://main.test/'))).status, 410);
  state.clear();
  await state.create(fakeSession(), 80, 'https://main.test', sessionId, 'trusted');
  assert.equal((await state.preview(new Request('https://main.test/'))).status, 410);
  state.clear();
  assert.equal((await state.trusted(new Request('https://main.test/'))).status, 410);
  assert.equal((await state.preview(new Request('https://main.test/'))).status, 410);
});

test('ForwardingState reports restorable metadata and applies the retention deadline', async () => {
  const state = new ForwardingState();
  const session = fakeSession();
  const retainedUntil = Date.now() + 8 * 60_000;
  await state.create(session, 8080, 'https://main.test', sessionId, 'trusted', retainedUntil);
  assert.equal(state.owns(session), true);
  assert.deepEqual(state.status(retainedUntil), {
    active: true, port: 8080, mode: 'trusted', expiresAt: retainedUntil,
  });
  state.stop();
  assert.deepEqual(state.status(), { active: false });
});
