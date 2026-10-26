// The control-socket close policy (moved from remote-lite's reliability.test.mjs).
// Run: npm test -w @kopernikadr/remote-core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraConnection, closeAction } from '../src/connection.js';
import { Backoff } from '../src/backoff.js';
import { uuid } from '../src/protocol.js';
import { startFakeCamera, loadFakeImages } from './support.mjs';

// ---------- control socket close codes ----------

class StubSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    StubSocket.all.push(this);
    setTimeout(() => this.#emit('open', {}), 1);
  }
  addEventListener(n, fn) { (this.listeners[n] ??= []).push(fn); }
  #emit(n, e) { for (const fn of this.listeners[n] ?? []) fn(e); }
  send(text) {
    const m = JSON.parse(text);
    const data = m.op === 'hello'
      ? { cameraId: 'cam', bootId: 'b', sessionId: `s${StubSocket.all.indexOf(this)}`, capabilities: {}, controls: null, status: null }
      : { serverTimeMs: 0 };
    setTimeout(() => { if (!this.closed) this.#emit('message', { data: JSON.stringify({ v: 1, t: 'res', reqId: m.reqId, ok: true, data }) }); }, 1);
  }
  close(code = 1000, reason = '') { this.serverClose(code, reason); }
  serverClose(code, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.#emit('close', { code, reason });
  }
}

function waitFor(pred, ms = 2000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('connection: close policy — 4001 stops, everything else reconnects', () => {
  assert.equal(closeAction(4001), 'stop');
  for (const code of [4002, 4000, 4003, 1006, 1000, undefined]) assert.equal(closeAction(code), 'reconnect');
});

test('connection: 4001 replaced → no reconnect (not even on page resume) until takeOver()', async () => {
  StubSocket.all = [];
  const c = new CameraConnection({ url: 'ws://x/ws/control', clientId: 'c', WebSocketImpl: StubSocket, backoff: new Backoff({ minMs: 5, maxMs: 10 }), pingIntervalMs: 50 });
  try {
    c.start();
    await waitFor(() => c.online, 2000, 'online');
    StubSocket.all[0].serverClose(4001, 'replaced');
    assert.equal(c.state, 'replaced');
    await pause(150);
    c.reconnectNow();
    await pause(50);
    assert.equal(StubSocket.all.length, 1, 'no new socket after 4001');
    assert.equal(c.state, 'replaced');
    c.takeOver();
    await waitFor(() => c.online, 2000, 'online after takeover');
    assert.equal(StubSocket.all.length, 2);
  } finally {
    c.stop();
  }
});

test('connection: 4002 lease lost and a network drop → reconnect by itself', async () => {
  StubSocket.all = [];
  const c = new CameraConnection({ url: 'ws://x/ws/control', clientId: 'c', WebSocketImpl: StubSocket, backoff: new Backoff({ minMs: 5, maxMs: 10 }), pingIntervalMs: 50 });
  try {
    c.start();
    await waitFor(() => c.online);
    StubSocket.all[0].serverClose(4002, 'lease lost');
    assert.equal(c.state, 'offline');
    await waitFor(() => c.online && StubSocket.all.length === 2, 2000, 'reconnected after 4002');
    StubSocket.all[1].serverClose(1006, '');
    await waitFor(() => c.online && StubSocket.all.length === 3, 2000, 'reconnected after a drop');
  } finally {
    c.stop();
  }
});

test('connection + fake camera: a second tab with the same clientId takes over; the first one stays put', async () => {
  const cam = await startFakeCamera({ images: loadFakeImages(), replaceSessions: true, rotation: 0 });
  const clientId = uuid();
  const mk = () => new CameraConnection({ url: `ws://${cam.host}/ws/control`, clientId, backoff: new Backoff({ minMs: 20, maxMs: 50 }) });
  const a = mk();
  const b = mk();
  try {
    a.start();
    await waitFor(() => a.online, 3000, 'a online');
    b.start();
    await waitFor(() => b.online && a.state === 'replaced', 3000, 'b took over');
    const hellos = cam.state.hellos;
    await pause(300);
    assert.equal(cam.state.hellos, hellos, 'no reconnect fight');
    assert.ok(b.online);
    a.takeOver();
    await waitFor(() => a.online && b.state === 'replaced', 3000, 'explicit takeover back');
  } finally {
    a.stop();
    b.stop();
    await cam.close();
  }
});
