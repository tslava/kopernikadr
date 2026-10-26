// CameraConnection + PreviewLoop against the fake camera (protocol/tools/probe-client/fake-camera.mjs),
// using Node's global WebSocket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, FAKE_CAMERA, REMOTE_LITE_DIR } from './paths.mjs';

const { CameraConnection } = await import(L('connection.js'));
const { PreviewLoop } = await import(L('preview.js'));
const { uuid } = await import(L('protocol.js'));
const { Backoff } = await import(L('backoff.js'));
const { startFakeCamera, loadFakeImages } = await import(FAKE_CAMERA);

const fast = () => new Backoff({ minMs: 20, maxMs: 50 });

function waitFor(pred, ms = 3000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try { v = pred(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function withCam(opts, fn) {
  const cam = await startFakeCamera({ images: loadFakeImages(), replaceSessions: true, rotation: 0, ...opts });
  const conns = [];
  const mk = (extra = {}) => {
    const c = new CameraConnection({ url: `ws://${cam.host}/ws/control`, clientId: uuid(), backoff: fast(), ...extra });
    conns.push(c);
    return c;
  };
  try {
    await fn(cam, mk);
  } finally {
    for (const c of conns) c.stop();
    await cam.close();
  }
}

test('connects, captures, lists frames, sets a control and gets the confirmation event', () => withCam({ confirmDelayMs: 50 }, async (cam, mk) => {
  const c = mk();
  const states = [];
  c.on('state', (s) => states.push(s));
  const controls = [];
  c.on('controls', (x) => controls.push(structuredClone(x)));
  c.start();
  await waitFor(() => c.online, 3000, 'online');
  assert.equal(c.session.capabilities.aspect, '4:3');
  assert.equal(c.controls.rotation, 0);

  const projectId = uuid();
  const f1 = await c.request('capture', { projectId, rotation: 0 });
  const f2 = await c.request('capture', { projectId, rotation: 0 });
  assert.ok(f2.seq > f1.seq);
  await assert.rejects(c.request('capture', { projectId, rotation: 180 }), (e) => e.code === 'GEOMETRY_MISMATCH');

  const page = await c.request('listFrames', { afterSeq: 0, limit: 1 });
  assert.equal(page.frames.length, 1);
  assert.equal(page.hasMore, true);
  const op = await c.request('getOperation', { reqId: uuid() });
  assert.equal(op.state, 'unknown');

  const res = await c.request('setControl', { control: 'exposure', mode: 'locked' });
  assert.equal(res.exposure.confirmed, false);
  await waitFor(() => controls.some((x) => x.exposure.mode === 'locked' && x.exposure.confirmed), 2000, 'lock confirmed');
  assert.deepEqual(states, ['online']);

  const img = await fetch(`http://${cam.host}/frames/${f1.frameId}/thumb.jpg`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
}));

test('goes offline when the camera drops the sockets and comes back by itself', () => withCam({}, async (cam, mk) => {
  const c = mk();
  const sessions = [];
  c.on('session', (s) => sessions.push(s.sessionId));
  c.start();
  await waitFor(() => c.online);
  await fetch(`http://${cam.host}/fake/kick`);
  await waitFor(() => c.state === 'offline', 2000, 'offline');
  await waitFor(() => c.online && sessions.length === 2, 3000, 'back online');
  assert.notEqual(sessions[0], sessions[1]);
}));

test('ping timeout → offline (camera stops answering)', () => withCam({}, async (cam, mk) => {
  const c = mk({ pingIntervalMs: 50, offlineAfterMs: 200, connectTimeoutMs: 300 });
  c.start();
  await waitFor(() => c.online);
  // a server that swallows everything: point the next connections at a black hole
  cam.state.session.lastSeen = performance.now();
  const realSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function () {};
  try {
    await waitFor(() => c.state === 'offline', 2000, 'offline after missed pongs');
  } finally {
    WebSocket.prototype.send = realSend;
  }
  await waitFor(() => c.online, 3000, 'online again');
}));

test('a second client gets BUSY with retryAfterMs and takes over once the first one leaves', () => withCam({}, async (cam, mk) => {
  const a = mk();
  a.start();
  await waitFor(() => a.online);
  const b = mk();
  let busyDetail = null;
  b.on('state', (s, d) => { if (s === 'busy') busyDetail = d; });
  b.start();
  await waitFor(() => b.state === 'busy', 2000, 'busy');
  assert.ok(busyDetail.retryAfterMs > 0 && busyDetail.retryAfterMs <= 10000);
  a.stop();
  cam.state.session.lastSeen = -1e9; // expire the lease without waiting 10 s
  b.reconnectNow();
  await waitFor(() => b.online, 3000, 'b online');
}));

test('preview loop pulls real JPEG frames, survives a stall and a new session', () => withCam({ stallNexts: 1 }, async (cam, mk) => {
  const c = mk();
  c.start();
  await waitFor(() => c.online);
  const headers = [];
  const loop = new PreviewLoop({
    urlFor: (sid) => `ws://${cam.host}/ws/preview?session=${sid}`,
    onFrame: (h, jpeg) => { assert.equal(jpeg[0], 0xff); headers.push(h); },
    watchdogMs: 150,
    reopenDelayMs: 10,
  });
  loop.setSession(c.session.sessionId);
  loop.start();
  await waitFor(() => headers.length >= 5, 3000, 'frames after the stall');
  assert.equal(loop.reopens >= 1, true, 'watchdog reopened the socket');
  assert.equal(headers[0].w, 640);
  c.reconnectNow();
  await waitFor(() => c.online && c.session.sessionId !== headers.sid, 3000);
  const before = headers.length;
  loop.setSession(c.session.sessionId);
  await waitFor(() => headers.length > before + 3, 3000, 'frames on the new session');
  loop.stop();
}));

test('fake camera serves the remote-lite page and its modules', () => withCam({ serveDir: REMOTE_LITE_DIR }, async (cam) => {
  const html = await fetch(`http://${cam.host}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<script type="module" src="app\.js"><\/script>/);
  const js = await fetch(`http://${cam.host}/lib/store.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`http://${cam.host}/..%2f..%2fbuild.gradle.kts`)).status, 404);
}));
