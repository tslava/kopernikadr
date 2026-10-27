// Contract tests: remote-core against the shared wire fixtures in protocol/fixtures/ (the Kotlin
// side checks the same files). A new fixture fails `every fixture is covered` until a test here
// (or the explicit not-for-the-client list) takes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient, ProtocolError, PROTOCOL_VERSION, isLockFailed } from '../src/protocol.js';
import { CameraConnection } from '../src/connection.js';
import { PreviewLoop } from '../src/preview.js';
import { parsePreviewFrame } from '../src/preview-frame.js';
import { Backoff } from '../src/backoff.js';
import { fixture, fixtureNames } from './support.mjs';

/** Fixtures remote-core does not consume over the control socket (HTTP `/info` is read by the apps). */
const NOT_CONTROL = ['info.json'];
const PREVIEW = ['preview.header.json', 'preview.next.json'];

const reqs = () => fixtureNames().filter((n) => n.endsWith('.req.json'));
const evts = () => fixtureNames().filter((n) => n.endsWith('.evt.json'));
/** `res` fixtures: `<op>.res.json`, `<op>.res.<case>.json`, `<op>.err.json`, `<op>.<error case>.json`. */
const ress = () => fixtureNames().filter((n) => !NOT_CONTROL.includes(n) && !PREVIEW.includes(n)
  && !n.endsWith('.req.json') && !n.endsWith('.evt.json'));
const opOf = (name) => name.split('.')[0];

/** A socket that records what the client sends and lets the test push messages in. */
function stubSocket() {
  const listeners = {};
  const sent = [];
  return {
    sent,
    send: (s) => sent.push(JSON.parse(s)),
    close() {},
    addEventListener: (n, fn) => { (listeners[n] ??= []).push(fn); },
    push: (msg) => { for (const fn of listeners.message ?? []) fn({ data: JSON.stringify(msg) }); },
    emit: (n, e) => { for (const fn of listeners[n] ?? []) fn(e); },
  };
}

const sortedKeys = (o) => Object.keys(o ?? {}).sort();

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

test('every fixture is covered by a contract test (or listed as not for the control client)', () => {
  const covered = new Set([...reqs(), ...evts(), ...ress(), ...NOT_CONTROL, ...PREVIEW]);
  assert.deepEqual(fixtureNames().filter((n) => !covered.has(n)), []);
  assert.ok(reqs().length >= 4 && ress().length >= 8 && evts().length >= 2, 'fixtures found');
  for (const r of ress()) assert.ok(reqs().includes(`${opOf(r)}.req.json`), `${r} has a matching request fixture`);
});

test('ControlClient builds every *.req fixture exactly (same reqId, op and args)', () => {
  for (const name of reqs()) {
    const fx = fixture(name);
    const sock = stubSocket();
    const c = new ControlClient(sock, { timeoutMs: 1000 });
    c.request(fx.op, fx.args, { reqId: fx.reqId }).catch(() => {});
    assert.equal(sock.sent.length, 1, name);
    assert.deepEqual(sortedKeys(sock.sent[0]), sortedKeys(fx), `${name}: envelope keys`);
    assert.deepEqual(sock.sent[0], fx, name);
    assert.equal(fx.v, PROTOCOL_VERSION);
    c.abort();
  }
});

test('ControlClient resolves every *.res fixture for its pending request; errors reject with the code', async () => {
  for (const name of ress()) {
    const res = fixture(name);
    const req = fixture(`${opOf(name)}.req.json`);
    assert.equal(res.reqId, req.reqId, `${name} answers ${opOf(name)}.req.json`);
    const sock = stubSocket();
    const c = new ControlClient(sock, { timeoutMs: 1000 });
    const p = c.request(req.op, req.args, { reqId: req.reqId });
    sock.push({ ...res, reqId: 'someone-else' }); // a foreign reqId is ignored
    assert.equal(c.pendingCount, 1, `${name}: foreign reqId left the request pending`);
    sock.push(res);
    if (res.ok) {
      assert.deepEqual(await p, res.data, name);
    } else {
      await assert.rejects(p, (e) => {
        assert.ok(e instanceof ProtocolError, name);
        assert.equal(e.code, res.error.code, name);
        assert.equal(e.op, req.op, name);
        assert.equal(e.local, false, name);
        assert.equal(e.retryable, Boolean(res.error.retryable), name);
        if (res.error.retryAfterMs != null) assert.equal(e.retryAfterMs, res.error.retryAfterMs, name);
        return true;
      });
    }
    assert.equal(c.pendingCount, 0, name);
    c.abort();
  }
});

test('stage-1 fixtures have the shapes the JS side relies on (same key sets as the shared models)', () => {
  const frameKeys = sortedKeys(fixture('capture.res.json').data);
  const page = fixture('listFrames.res.json').data;
  assert.deepEqual(sortedKeys(page), ['frames', 'hasMore']);
  assert.ok(page.frames.length > 0 && typeof page.hasMore === 'boolean');
  for (const f of page.frames) assert.deepEqual(sortedKeys(f).filter((k) => k !== 'exposure'), frameKeys.filter((k) => k !== 'exposure'));
  assert.deepEqual(sortedKeys(fixture('listFrames.req.json').args), ['afterSeq', 'limit']);
  const ack = fixture('ack.res.json').data;
  assert.deepEqual(sortedKeys(ack), ['acked', 'unknown']);
  assert.ok(Number.isInteger(ack.acked) && Array.isArray(ack.unknown));
  assert.ok(fixture('ack.req.json').args.frameIds.every((id) => typeof id === 'string'));
  assert.deepEqual(sortedKeys(fixture('getStatus.res.json').data), sortedKeys(fixture('status.evt.json').data));
  assert.deepEqual(fixture('getStatus.req.json').args, {});
  // setControl answers with the full Controls object; its error is a plain protocol error
  const controls = sortedKeys(fixture('controls.evt.json').data);
  assert.deepEqual(sortedKeys(fixture('setControl.res.json').data), controls);
  assert.deepEqual(sortedKeys(fixture('controls.focusFailed.evt.json').data), controls);
  const set = fixture('setControl.req.json').args;
  assert.equal(set.control, 'exposure');
  assert.ok(!('args' in set) && !('value' in set && 'mode' in set), 'setControl args are flat');
  assert.equal(fixture('setControl.err.json').error.code, 'UNSUPPORTED_CONTROL');
});

test('isLockFailed: focus has no failed mode on the wire; the focusFailed fixture is the failed lock', () => {
  const failedFocus = fixture('controls.focusFailed.evt.json').data;
  assert.equal(isLockFailed('focus', failedFocus.focus), true);
  assert.equal(isLockFailed('exposure', failedFocus.exposure), false);
  for (const name of ['controls.evt.json', 'setControl.res.json']) {
    const c = fixture(name).data;
    for (const key of ['exposure', 'whiteBalance', 'focus']) assert.equal(isLockFailed(key, c[key]), false, `${name} ${key}`);
  }
  const hello = fixture('hello.res.json').data.controls;
  for (const key of ['exposure', 'whiteBalance', 'focus']) assert.equal(isLockFailed(key, hello[key]), false);
  assert.equal(isLockFailed('exposure', { mode: 'failed', confirmed: false }), true);
  assert.equal(isLockFailed('whiteBalance', { mode: 'failed' }), true);
  assert.equal(isLockFailed('focus', { mode: 'locked', confirmed: true, focusOk: false }), false);
  assert.equal(isLockFailed('focus', undefined), false);
});

test('ControlClient routes every *.evt fixture to onEvent(name, data)', () => {
  for (const name of evts()) {
    const evt = fixture(name);
    const sock = stubSocket();
    const got = [];
    const c = new ControlClient(sock, { onEvent: (n, d) => got.push([n, d]) });
    sock.push(evt);
    assert.deepEqual(got, [[evt.name, evt.data]], name);
    c.abort();
  }
});

test('CameraConnection: hello and ping it sends have the key sets of hello.req / ping.req; hello.res brings it online', async () => {
  const helloFx = fixture('hello.req.json');
  const pingFx = fixture('ping.req.json');
  const helloRes = fixture('hello.res.json');
  const pingRes = fixture('ping.res.json');
  const sockets = [];
  class Ws {
    constructor(url) {
      this.url = url;
      this.s = stubSocket();
      sockets.push(this);
      setTimeout(() => this.s.emit('open', {}), 1);
    }
    addEventListener(n, fn) { this.s.addEventListener(n, fn); }
    send(text) {
      const m = JSON.parse(text);
      this.s.send(text);
      const fx = m.op === 'hello' ? helloRes : pingRes;
      setTimeout(() => this.s.push({ ...fx, reqId: m.reqId }), 1);
    }
    close() {}
  }
  const c = new CameraConnection({ url: 'ws://cam/ws/control', clientId: helloFx.args.clientId, WebSocketImpl: Ws,
    pingIntervalMs: 20, backoff: new Backoff({ minMs: 5, maxMs: 10 }) });
  try {
    c.start();
    await waitFor(() => c.online && sockets[0].s.sent.some((m) => m.op === 'ping'), 2000, 'online + a ping');
    const [hello] = sockets[0].s.sent;
    const ping = sockets[0].s.sent.find((m) => m.op === 'ping');
    assert.deepEqual(sortedKeys(hello), sortedKeys(helloFx));
    assert.deepEqual(sortedKeys(hello.args), sortedKeys(helloFx.args));
    assert.deepEqual(hello.args.protocolVersions, helloFx.args.protocolVersions);
    assert.equal(hello.args.clientId, helloFx.args.clientId);
    assert.deepEqual(sortedKeys(ping), sortedKeys(pingFx));
    assert.deepEqual(ping.args, pingFx.args);
    assert.deepEqual(c.session, helloRes.data);
    assert.deepEqual(c.controls, helloRes.data.controls);
    assert.deepEqual(c.status, helloRes.data.status);
  } finally {
    c.stop();
  }
});

/** A binary preview frame as the camera sends it: u32 BE header length, header JSON, JPEG. */
function previewFrame(header, jpeg = [0xff, 0xd8, 0xff, 0xd9]) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const buf = new Uint8Array(4 + h.length + jpeg.length);
  new DataView(buf.buffer).setUint32(0, h.length, false);
  buf.set(h, 4);
  buf.set(jpeg, 4 + h.length);
  return buf.buffer;
}

test('parsePreviewFrame parses a frame built from preview.header.json', () => {
  const header = fixture('preview.header.json');
  const r = parsePreviewFrame(previewFrame(header));
  assert.deepEqual(r.header, header);
  assert.deepEqual([...r.jpeg], [0xff, 0xd8, 0xff, 0xd9]);
});

test('PreviewLoop sends preview.next.json and hands the fixture header to onFrame', async () => {
  const header = fixture('preview.header.json');
  const next = fixture('preview.next.json');
  const sockets = [];
  class Ws {
    constructor(url) {
      this.url = url;
      this.s = stubSocket();
      this.raw = [];
      sockets.push(this);
      setTimeout(() => this.s.emit('open', {}), 1);
    }
    addEventListener(n, fn) { this.s.addEventListener(n, fn); }
    send(text) {
      this.raw.push(JSON.parse(text));
      if (this.raw.length === 1) setTimeout(() => this.s.emit('message', { data: previewFrame(header) }), 1);
    }
    close() {}
  }
  const got = [];
  const loop = new PreviewLoop({ urlFor: (sid) => `ws://cam/ws/preview?session=${sid}`, onFrame: (h) => got.push(h), WebSocketImpl: Ws });
  try {
    loop.setSession('s1');
    loop.start();
    await waitFor(() => got.length === 1 && sockets[0].raw.length === 2, 2000, 'a frame and the next request');
    assert.deepEqual(sockets[0].raw, [next, next]);
    assert.deepEqual(got[0], header);
  } finally {
    loop.stop();
  }
});
