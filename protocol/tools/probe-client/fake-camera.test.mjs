import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import * as commands from './commands.mjs';
import { parseTarget } from './http.mjs';
import { startFakeCamera } from './fake-camera.mjs';

async function withCamera(fn) {
  const cam = await startFakeCamera({});
  try {
    await fn(cam);
  } finally {
    await cam.close();
  }
}

const get = (cam, path, origin, method = 'GET') =>
  fetch(`http://${cam.host}${path}`, { method, headers: origin ? { origin } : {} });

const ALLOWED = [
  'http://localhost', 'http://localhost:3000', 'http://127.0.0.1', 'http://127.0.0.1:8765',
  'http://10.0.2.2', 'http://10.0.2.2:5173',
];
const DENIED = ['http://evil.example', 'https://localhost', 'http://localhost.evil.example', 'http://10.0.2.20', 'null'];

test('CORS /info: allowed origins (with or without a port) are echoed with Vary: Origin', () => withCamera(async (cam) => {
  for (const origin of ALLOWED) {
    const res = await get(cam, '/info', origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin, origin);
    assert.match(res.headers.get('vary'), /\bOrigin\b/, origin);
    assert.equal((await res.json()).cameraId, 'cam-1');
  }
}));

test('CORS /info: other origins and no Origin get no Access-Control-Allow-Origin', () => withCamera(async (cam) => {
  for (const origin of [...DENIED, undefined]) {
    const res = await get(cam, '/info', origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null, String(origin));
    await res.arrayBuffer();
  }
}));

test('CORS /frames: allowed origin echoed (GET, HEAD, 404), others get none', () => withCamera(async (cam) => {
  const ctx = { target: parseTarget(cam.host), clientId: randomUUID(), projectId: randomUUID(), log: () => {}, warn: () => {} };
  const { first } = await commands.capture(ctx);
  const path = `/frames/${first.frameId}/thumb.jpg`;

  const ok = await get(cam, path, 'http://localhost:3000');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.match(ok.headers.get('vary'), /\bOrigin\b/);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  await ok.arrayBuffer();

  const head = await get(cam, path, 'http://10.0.2.2', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('access-control-allow-origin'), 'http://10.0.2.2');

  const missing = await get(cam, '/frames/nope/play.jpg', 'http://127.0.0.1');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), 'http://127.0.0.1');
  await missing.arrayBuffer();

  for (const origin of ['http://evil.example', undefined]) {
    const res = await get(cam, path, origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null, String(origin));
    await res.arrayBuffer();
  }
}));

test('CORS is not added to other endpoints', () => withCamera(async (cam) => {
  const res = await get(cam, '/fake/state', 'http://localhost');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  await res.arrayBuffer();
}));

// ---- failure switches (/fake/...) ----

const CLIENT = '0b0e7a3c-1f0e-4f43-9a54-6b7c8d9e0f12';

/** A tiny control-socket client: hello, then request/response by reqId. */
async function control(cam) {
  const ws = new WebSocket(`ws://${cam.host}/ws/control`);
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'res') waiting.get(m.reqId)?.(m);
  };
  const closedP = new Promise((r) => { ws.onclose = () => r(); });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const req = (op, args = {}, reqId = randomUUID()) => new Promise((resolve) => {
    waiting.set(reqId, resolve);
    ws.send(JSON.stringify({ v: 1, t: 'req', reqId, op, args }));
  });
  const hello = await req('hello', { clientId: CLIENT, protocolVersion: 1 });
  return { ws, req, hello, closedP };
}

const capture = (c, reqId = randomUUID(), projectId = 'p1') => c.req('capture', { projectId, rotation: 180 }, reqId);
const sw = async (cam, path) => (await get(cam, `/fake/${path}`)).json();
const full = (cam, id) => get(cam, `/frames/${id}/full.jpg`);
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('switch restart: new bootId, sockets dropped, session gone, frames and cameraId kept', () => withCamera(async (cam) => {
  const c = await control(cam);
  const { bootId, cameraId } = c.hello.data;
  const shot = await capture(c);
  assert.equal(shot.ok, true);
  const out = await sw(cam, 'restart');
  assert.notEqual(out.bootId, bootId);
  assert.equal(out.cameraId, cameraId);
  await c.closedP;
  assert.equal((await (await get(cam, '/info')).json()).bootId, out.bootId);
  const c2 = await control(cam);
  assert.equal(c2.hello.data.bootId, out.bootId);
  assert.equal(c2.hello.data.cameraId, cameraId);
  assert.notEqual(c2.hello.data.sessionId, c.hello.data.sessionId);
  const list = await c2.req('listFrames', {});
  assert.deepEqual(list.data.frames.map((f) => f.frameId), [shot.data.frameId]);
  c2.ws.close();
}));

test('switch restart: a pending capture stays pending across the restart', () => withCamera(async (cam) => {
  await sw(cam, 'pending-forever');
  const c = await control(cam);
  const reqId = randomUUID();
  void capture(c, reqId);
  await sw(cam, 'restart');
  await c.closedP;
  const c2 = await control(cam);
  assert.deepEqual((await c2.req('getOperation', { reqId })).data, { state: 'pending' });
  c2.ws.close();
}));

test('switch camera-id: new cameraId and bootId in /info and hello; id is required', () => withCamera(async (cam) => {
  const before = await (await get(cam, '/info')).json();
  assert.equal((await get(cam, '/fake/camera-id')).status, 400);
  const out = await sw(cam, 'camera-id?id=cam-2');
  assert.equal(out.cameraId, 'cam-2');
  const info = await (await get(cam, '/info')).json();
  assert.equal(info.cameraId, 'cam-2');
  assert.notEqual(info.bootId, before.bootId);
  const c = await control(cam);
  assert.equal(c.hello.data.cameraId, 'cam-2');
  assert.equal(c.hello.data.bootId, info.bootId);
  c.ws.close();
  assert.equal((await sw(cam, 'restart?cameraId=cam-3')).cameraId, 'cam-3');
}));

test('switch storage-low: the next capture fails STORAGE_LOW without a record, then it works again', () => withCamera(async (cam) => {
  const c = await control(cam);
  await sw(cam, 'storage-low');
  const reqId = randomUUID();
  const bad = await capture(c, reqId);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'STORAGE_LOW');
  assert.equal(bad.error.retryable, false);
  assert.deepEqual((await c.req('getOperation', { reqId })).data, { state: 'unknown' });
  assert.equal((await c.req('listFrames', {})).data.frames.length, 0);
  assert.equal((await capture(c)).ok, true);
  c.ws.close();
}));

test('switch missing-full: full.jpg of that frame is 404, others and play/thumb are served, off restores', () => withCamera(async (cam) => {
  const c = await control(cam);
  const a = (await capture(c)).data.frameId;
  const b = (await capture(c)).data.frameId;
  await sw(cam, `missing-full?frame=${a}`);
  const gone = await full(cam, a);
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), { error: 'unknown frame' });
  assert.equal((await full(cam, b)).status, 200);
  assert.equal((await get(cam, `/frames/${a}/play.jpg`)).status, 200);
  assert.equal((await get(cam, '/fake/missing-full')).status, 400);
  await sw(cam, `missing-full?frame=${a}&off=1`);
  assert.equal((await full(cam, a)).status, 200);
  c.ws.close();
}));

test('switch corrupt-full: same length as listed, sha256 differs; other frames intact', () => withCamera(async (cam) => {
  const c = await control(cam);
  const a = (await capture(c)).data;
  const b = (await capture(c)).data;
  await sw(cam, `corrupt-full?frame=${a.frameId}`);
  const bad = await full(cam, a.frameId);
  const bytes = Buffer.from(await bad.arrayBuffer());
  assert.equal(bad.status, 200);
  assert.equal(Number(bad.headers.get('content-length')), a.full.bytes);
  assert.equal(bytes.length, a.full.bytes);
  assert.notEqual(sha(bytes), a.full.sha256);
  assert.equal(sha(Buffer.from(await (await full(cam, b.frameId)).arrayBuffer())), b.full.sha256);
  await sw(cam, `corrupt-full?frame=${a.frameId}&off=1`);
  assert.equal(sha(Buffer.from(await (await full(cam, a.frameId)).arrayBuffer())), a.full.sha256);
  c.ws.close();
}));

test('switch pending-forever: the next capture never answers, stays pending, retry is CAPTURE_IN_PROGRESS; one shot', () => withCamera(async (cam) => {
  const c = await control(cam);
  await sw(cam, 'pending-forever');
  const reqId = randomUUID();
  let answered = false;
  void capture(c, reqId).then(() => { answered = true; });
  assert.deepEqual((await c.req('getOperation', { reqId })).data, { state: 'pending' });
  const again = await capture(c, reqId);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'CAPTURE_IN_PROGRESS');
  assert.equal(answered, false);
  assert.equal((await c.req('listFrames', {})).data.frames.length, 0);
  assert.equal((await capture(c)).ok, true); // the switch was one shot
  assert.deepEqual((await c.req('getOperation', { reqId })).data, { state: 'pending' });
  c.ws.close();
}));

test('switch reclaim: acked frames lose every variant (404), unacked ones stay', () => withCamera(async (cam) => {
  const c = await control(cam);
  const a = (await capture(c)).data.frameId;
  const b = (await capture(c)).data.frameId;
  await c.req('ack', { frameIds: [a] });
  assert.equal((await full(cam, a)).status, 200); // acked frames are still served until reclaim
  assert.deepEqual((await sw(cam, 'reclaim')).reclaimed, [a]);
  for (const v of ['full', 'play', 'thumb']) assert.equal((await get(cam, `/frames/${a}/${v}.jpg`)).status, 404);
  assert.equal((await full(cam, b)).status, 200);
  c.ws.close();
}));
