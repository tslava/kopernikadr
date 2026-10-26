import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
