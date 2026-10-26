// Export frame loading, outstanding captures and the control-socket close policy.
// Run: cd camera-android/core/src/test/remote-lite && node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L, FAKE_CAMERA } from './paths.mjs';

const { loadFrame, imageAttempt, FrameLoadError, EXPORT_POLICY, VIEW_POLICY } = await import(L('frame-loader.js'));
const { runExport } = await import(L('export-core.js'));
const { CaptureTracker, OutstandingStore, OUTSTANDING_KEY } = await import(L('captures.js'));
const { CameraConnection, closeAction } = await import(L('connection.js'));
const { Backoff } = await import(L('backoff.js'));
const { uuid } = await import(L('protocol.js'));
const { startFakeCamera, loadFakeImages } = await import(FAKE_CAMERA);

// ---------- helpers ----------

/** Virtual time: timers fire only when run() finds nothing else to do, and then instantly. */
class VirtualClock {
  t = 0;
  #timers = new Map();
  #id = 0;
  delays = [];
  now = () => this.t;
  setTimeout = (fn, ms) => {
    const id = ++this.#id;
    this.#timers.set(id, { fn, due: this.t + Math.max(0, ms), ms });
    return id;
  };
  clearTimeout = (id) => { this.#timers.delete(id); };
  async run(promise) {
    let done = false;
    let value;
    let error;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
    for (let idle = 0; !done; ) {
      await new Promise((r) => setImmediate(r));
      if (done) break;
      if (!this.#timers.size) {
        if (++idle > 200) throw new Error('stalled: nothing pending and no timers');
        continue;
      }
      idle = 0;
      const [id, tm] = [...this.#timers].sort((a, b) => a[1].due - b[1].due)[0];
      this.#timers.delete(id);
      this.t = Math.max(this.t, tm.due);
      this.delays.push(tm.ms);
      tm.fn();
    }
    if (error) throw error;
    return value;
  }
}

const urlFor = (id, variant) => `/frames/${id}/${variant}.jpg`;
const response = (status, body = 'jpeg') => ({ ok: status >= 200 && status < 300, status, blob: async () => new Blob([body]) });

/**
 * fetch stub: `plan(url, n)` → a status, 'hang' (never answers, honours abort) or a body string.
 * `n` counts calls per path (query stripped). Records every URL.
 */
function stubFetch(plan) {
  const calls = [];
  const counts = new Map();
  const fetchImpl = (url, { signal } = {}) => {
    calls.push(url);
    const path = url.split('?')[0];
    const n = counts.get(path) ?? 0;
    counts.set(path, n + 1);
    const r = plan(path, n);
    if (r === 'hang') {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return Promise.resolve(typeof r === 'number' ? response(r) : response(200, r));
  };
  return { fetchImpl, calls };
}

// ---------- frame loader ----------

test('loader: a frame that fails twice then succeeds is loaded (play), with backoff between tries', async () => {
  const clock = new VirtualClock();
  const { fetchImpl, calls } = stubFetch((path, n) => (n < 2 ? 503 : `pic:${path}`));
  const r = await clock.run(loadFrame('f1', { urlFor, fetchImpl, clock, decode: async (b) => b.text() }));
  assert.equal(r.variant, 'play');
  assert.equal(r.tries, 3);
  assert.equal(r.value, 'pic:/frames/f1/play.jpg');
  assert.deepEqual(calls, ['/frames/f1/play.jpg', '/frames/f1/play.jpg?retry=1', '/frames/f1/play.jpg?retry=2']);
  assert.deepEqual(clock.delays, [500, 1500], 'two backoff sleeps, no timeout fired');
});

test('loader: play 404 → full at once; play timing out → full after the retries', async () => {
  let clock = new VirtualClock();
  let s = stubFetch((path) => (path.endsWith('play.jpg') ? 404 : 'full'));
  const decoded = [];
  let r = await clock.run(loadFrame('f2', { urlFor, fetchImpl: s.fetchImpl, clock, decode: async (b, v) => { decoded.push(v); return v; } }));
  assert.equal(r.variant, 'full');
  assert.deepEqual(s.calls, ['/frames/f2/play.jpg', '/frames/f2/full.jpg']);
  assert.deepEqual(decoded, ['full'], 'the full picture is decoded as full (scaled down by decodeFrame)');
  assert.deepEqual(clock.delays, [], 'no wait after a 404');

  clock = new VirtualClock();
  s = stubFetch((path) => (path.endsWith('play.jpg') ? 'hang' : 'full'));
  r = await clock.run(loadFrame('f3', { urlFor, fetchImpl: s.fetchImpl, clock }));
  assert.equal(r.variant, 'full');
  assert.equal(r.tries, EXPORT_POLICY.attempts + 1);
  assert.equal(clock.delays.filter((d) => d === EXPORT_POLICY.timeoutMs).length, EXPORT_POLICY.attempts, 'each play try timed out at 20 s');
});

test('loader: a frame that never loads → FrameLoadError after bounded tries; a decode failure counts as a failure', async () => {
  const clock = new VirtualClock();
  const { fetchImpl, calls } = stubFetch(() => 500);
  await assert.rejects(clock.run(loadFrame('bad', { urlFor, fetchImpl, clock })), (e) => {
    assert.ok(e instanceof FrameLoadError);
    assert.equal(e.code, 'FRAME_LOAD_FAILED');
    assert.equal(e.tries, EXPORT_POLICY.attempts + EXPORT_POLICY.fullAttempts);
    return true;
  });
  assert.equal(calls.length, 6);

  const c2 = new VirtualClock();
  let decodes = 0;
  const s2 = stubFetch(() => 'x');
  const r = await c2.run(loadFrame('d', { urlFor, fetchImpl: s2.fetchImpl, clock: c2, decode: async () => { if (++decodes < 2) throw new Error('corrupt'); return 'ok'; } }));
  assert.equal(r.value, 'ok');
  assert.equal(r.tries, 2);
});

test('loader: cancel stops at once without more requests', async () => {
  const clock = new VirtualClock();
  const ac = new AbortController();
  const { fetchImpl, calls } = stubFetch(() => { ac.abort(); return 503; });
  await assert.rejects(clock.run(loadFrame('f', { urlFor, fetchImpl, clock, signal: ac.signal })), (e) => e.name === 'AbortError');
  assert.equal(calls.length, 1);
});

test('loader: <img> retry plan (onion skin, viewer): a few play tries, then full, then give up', () => {
  const plan = [];
  for (let n = 0; ; n++) {
    const a = imageAttempt(urlFor, 'f', n);
    if (!a) break;
    plan.push([a.url, a.delayMs]);
  }
  assert.equal(plan.length, VIEW_POLICY.attempts + VIEW_POLICY.fullAttempts);
  assert.deepEqual(plan[0], ['/frames/f/play.jpg', 0]);
  assert.deepEqual(plan[1], ['/frames/f/play.jpg?retry=1', 400]);
  assert.equal(plan.at(-1)[0], '/frames/f/full.jpg');
});

// ---------- export loop ----------

function fakeSink() {
  const log = [];
  let started = false;
  return {
    log,
    get started() { return started; },
    draw: (pic) => log.push(['draw', pic.id]),
    start: () => { started = true; log.push(['start']); },
    requestFrame: () => log.push(['frame']),
    pause: () => log.push(['pause']),
    resume: () => log.push(['resume']),
    finish: async () => { log.push(['finish']); return new Blob(['movie']); },
    cancel: () => log.push(['cancel']),
  };
}

/** prepare/load built on the real loader over a stub fetch; pictures are {id, close}. */
function exportDeps(plan) {
  const clock = new VirtualClock();
  const { fetchImpl, calls } = stubFetch(plan);
  const closed = [];
  const decode = async (blob, variant) => {
    const id = await blob.text();
    return { id, variant, close: () => closed.push(id) };
  };
  return {
    clock, calls, closed,
    prepare: (id, o) => loadFrame(id, { urlFor, fetchImpl, clock, ...o }),
    load: (id, o) => loadFrame(id, { urlFor, fetchImpl, clock, decode, ...o }),
  };
}

const ids = (n) => Array.from({ length: n }, (_, i) => `f${i + 1}`);
const frameOf = (path) => /\/frames\/([^/]+)\//.exec(path)[1];

test('export: every frame drawn once in order, a flaky frame is retried, the blob is delivered', async () => {
  const d = exportDeps((path, n) => (frameOf(path) === 'f3' && n < 2 ? 503 : frameOf(path)));
  const sink = fakeSink();
  const progress = [];
  const r = await d.clock.run(runExport({ frameIds: ids(5), fps: 8, prepare: d.prepare, load: d.load, sink, clock: d.clock,
    onProgress: (p) => progress.push(`${p.phase}:${p.i}`) }));
  assert.equal(r.frames, 5);
  assert.equal(await r.blob.text(), 'movie');
  const draws = sink.log.filter((x) => x[0] === 'draw').map((x) => x[1]);
  assert.deepEqual(draws, ['f1', 'f2', 'f3', 'f4', 'f5', 'f5'], 'first picture before start, then f2..f5, then the held last one');
  assert.equal(sink.log.filter((x) => x[0] === 'frame').length, 6);
  assert.ok(sink.log.findIndex((x) => x[0] === 'draw') < sink.log.findIndex((x) => x[0] === 'start'));
  assert.equal(sink.log.at(-1)[0], 'finish');
  assert.ok(!sink.log.some((x) => x[0] === 'cancel'));
  assert.equal(progress[0], 'prepare:0');
  assert.ok(progress.includes('prepare:5') && progress.at(-1) === 'record:5');
  assert.deepEqual(d.closed.sort(), ['f1', 'f2', 'f3', 'f4', 'f5'], 'every decoded picture is closed');
});

test('export: a frame that always fails aborts before recording; no blob, recorder never finished', async () => {
  const d = exportDeps((path) => (frameOf(path) === 'f3' ? 503 : frameOf(path)));
  const sink = fakeSink();
  await assert.rejects(d.clock.run(runExport({ frameIds: ids(5), fps: 8, prepare: d.prepare, load: d.load, sink, clock: d.clock })), (e) => {
    assert.equal(e.code, 'FRAME_LOAD_FAILED');
    assert.equal(e.index, 2);
    assert.equal(e.frameId, 'f3');
    return true;
  });
  assert.equal(sink.started, false);
  assert.ok(!sink.log.some((x) => x[0] === 'finish'));
  assert.ok(sink.log.some((x) => x[0] === 'cancel'));
});

test('export: a frame lost after the prepare step aborts the recording too (cancel, no finish)', async () => {
  let prepared = false;
  const d = exportDeps((path, n) => {
    if (frameOf(path) === 'f4' && prepared) return 503;
    if (frameOf(path) === 'f5' && n === 0) prepared = true; // f5 is the last frame prepared
    return frameOf(path);
  });
  const sink = fakeSink();
  await assert.rejects(d.clock.run(runExport({ frameIds: ids(5), fps: 8, prepare: d.prepare, load: d.load, sink, clock: d.clock,
    prepareConcurrency: 1 })), (e) => e.code === 'FRAME_LOAD_FAILED' && e.index === 3);
  assert.equal(sink.started, true);
  assert.ok(!sink.log.some((x) => x[0] === 'finish'));
  assert.equal(sink.log.at(-1)[0], 'cancel');
  const draws = sink.log.filter((x) => x[0] === 'draw').map((x) => x[1]);
  assert.deepEqual(draws, ['f1', 'f2', 'f3'], 'nothing is drawn in place of the missing frame');
});

test('export: play 404 → the frame is prepared and recorded from full; a slow frame pauses the recorder', async () => {
  const d = exportDeps((path, n) => {
    const f = frameOf(path);
    if (f === 'f2' && path.endsWith('play.jpg')) return 404;
    if (f === 'f5' && path.endsWith('play.jpg') && (n === 1 || n === 2)) return 503; // the recording-phase GET is slow (fails twice)
    return f;
  });
  const sink = fakeSink();
  const r = await d.clock.run(runExport({ frameIds: ids(5), fps: 8, prepare: d.prepare, load: d.load, sink, clock: d.clock }));
  assert.equal(r.frames, 5);
  assert.equal(r.variants[1], 'full');
  assert.ok(d.calls.filter((u) => u === '/frames/f2/full.jpg').length === 2, 'prepare and record both used full');
  assert.equal(d.calls.filter((u) => u.startsWith('/frames/f2/play.jpg')).length, 1, 'record went straight to full');
  const i = sink.log.findIndex((x) => x[0] === 'pause');
  assert.ok(i > 0, 'paused while waiting');
  assert.deepEqual(sink.log[i + 1], ['resume']);
  assert.deepEqual(sink.log[i + 2], ['draw', 'f5']);
});

test('export: cancel → AbortError, recorder cancelled', async () => {
  const ac = new AbortController();
  const d = exportDeps((path) => { if (frameOf(path) === 'f2') ac.abort(); return frameOf(path); });
  const sink = fakeSink();
  await assert.rejects(d.clock.run(runExport({ frameIds: ids(3), fps: 8, prepare: d.prepare, load: d.load, sink, clock: d.clock, signal: ac.signal })),
    (e) => e.name === 'AbortError');
  assert.ok(sink.log.some((x) => x[0] === 'cancel'));
});

// ---------- outstanding captures ----------

function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

const frameInfo = (reqId, n) => ({ frameId: `F${n}`, seq: n, projectId: 'p', rotation: 0, req: reqId });

/** A camera stub for the tracker: `ops[reqId]` = list of getOperation answers (last one repeats). */
function trackerRig({ online = true } = {}) {
  const storage = memStorage();
  const rig = {
    storage, online, now: 1_000_000, ops: {}, captureReply: null, sent: [], frames: [], failed: [], changes: 0, timers: [],
  };
  let n = 0;
  rig.make = () => new CaptureTracker({
    store: new OutstandingStore(storage),
    request: async (op, args, opts) => {
      rig.sent.push([op, op === 'capture' ? opts.reqId : args.reqId]);
      if (!rig.online) throw Object.assign(new Error('closed'), { code: 'CLOSED', local: true });
      if (op === 'capture') return rig.captureReply(opts.reqId);
      if (op === 'getOperation') {
        const list = rig.ops[args.reqId] ?? [{ state: 'unknown' }];
        return list.length > 1 ? list.shift() : list[0];
      }
      throw new Error(op);
    },
    isOnline: () => rig.online,
    newId: () => `req-${++n}`,
    now: () => rig.now,
    setTimer: (fn, ms) => { rig.timers.push({ fn, ms }); return rig.timers.length; },
    clearTimer: () => {},
    onFrame: (info, rec, o) => rig.frames.push([info.frameId, rec.reqId, o.direct]),
    onFailed: (rec, err) => rig.failed.push([rec.reqId, err.code]),
    onChange: () => { rig.changes++; },
  });
  return rig;
}

test('captures: recorded before sending; a direct answer resolves only that reqId', async () => {
  const rig = trackerRig();
  const tr = rig.make();
  tr.cameraId = 'cam';
  rig.captureReply = (reqId) => {
    assert.ok(JSON.parse(rig.storage.getItem(OUTSTANDING_KEY))[reqId], 'durably recorded before the request');
    return frameInfo(reqId, 1);
  };
  const r = await tr.capture({ projectId: 'p', rotation: 0 });
  assert.equal(r.kind, 'done');
  assert.deepEqual(rig.frames, [['F1', 'req-1', true]]);
  assert.equal(tr.busy, false);
  assert.equal(rig.storage.getItem(OUTSTANDING_KEY), null);
});

test('captures: an outstanding capture survives a reconnect (and a reload) and is cleared only by its own reqId', async () => {
  const rig = trackerRig();
  let tr = rig.make();
  tr.cameraId = 'cam';
  // the socket drops while the capture is in flight
  rig.captureReply = () => { rig.online = false; throw Object.assign(new Error('closed'), { code: 'CLOSED', local: true }); };
  const r = await tr.capture({ projectId: 'p', rotation: 0 });
  assert.equal(r.kind, 'pending');
  assert.equal(tr.busy, true, 'the Capture button stays disabled');
  assert.deepEqual(await tr.capture({ projectId: 'p', rotation: 0 }), { kind: 'blocked' }, 'a second click is refused');

  // another record from an earlier visit, already dismissed, for the same camera
  tr.store.add({ reqId: 'other', projectId: 'p', rotation: 0, cameraId: 'cam', at: rig.now - 1000, dismissed: true });

  // page reload: a new tracker over the same storage still has both
  tr = rig.make();
  tr.cameraId = 'cam';
  assert.deepEqual(tr.store.list().map((x) => x.reqId).sort(), ['other', 'req-1']);

  // reconnect: req-1 is still pending on the camera, then done; "other" stays pending throughout
  rig.online = true;
  rig.ops['req-1'] = [{ state: 'pending' }, { state: 'done', result: frameInfo('req-1', 7) }];
  rig.ops.other = [{ state: 'pending' }];
  await tr.reconcile();
  assert.deepEqual(tr.store.list().map((x) => x.reqId).sort(), ['other', 'req-1']);
  assert.equal(rig.timers.length, 1, 'keeps polling while something is outstanding');
  await tr.reconcile();
  assert.deepEqual(rig.frames, [['F7', 'req-1', false]]);
  assert.deepEqual(tr.store.list().map((x) => x.reqId), ['other'], 'only req-1 was cleared');
  assert.equal(tr.busy, false, 'a dismissed record does not block');
  assert.equal(rig.sent.filter(([op]) => op === 'capture').length, 1, 'never re-sent');
});

test('captures: CAPTURE_IN_PROGRESS does not drop the outstanding record (nor its own until the camera says so)', async () => {
  const rig = trackerRig();
  const tr = rig.make();
  tr.cameraId = 'cam';
  rig.captureReply = () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT', local: true }); };
  rig.ops['req-1'] = [{ state: 'pending' }];
  assert.equal((await tr.capture({ projectId: 'p', rotation: 0 })).kind, 'pending');
  // 60 s later: stuck → "Spróbuj ponownie" only re-enables the button
  assert.equal(tr.stuck, false);
  rig.now += 60_000;
  assert.equal(tr.stuck, true);
  tr.dismiss();
  assert.equal(tr.busy, false);
  assert.ok(tr.store.get('req-1'), 'still outstanding after dismiss');

  // the next capture is refused because req-1 is still running on the camera
  rig.captureReply = () => { throw Object.assign(new Error('busy'), { code: 'CAPTURE_IN_PROGRESS', retryable: true }); };
  rig.ops['req-2'] = [{ state: 'pending' }, { state: 'failed', error: { code: 'CAPTURE_IN_PROGRESS' } }];
  const r2 = await tr.capture({ projectId: 'p', rotation: 0 });
  assert.equal(r2.kind, 'pending', 'the camera has not settled req-2 yet');
  assert.ok(tr.store.get('req-1') && tr.store.get('req-2'));
  await tr.reconcile();
  assert.equal(tr.store.get('req-2'), null, 'req-2 cleared by its own terminal answer');
  assert.ok(tr.store.get('req-1'), 'req-1 untouched');
  assert.deepEqual(rig.failed, [['req-2', 'CAPTURE_IN_PROGRESS']]);

  // req-1 finally lands; listFrames would also bring it, getOperation clears the record
  rig.ops['req-1'] = [{ state: 'done', result: frameInfo('req-1', 3) }];
  await tr.reconcile();
  assert.equal(tr.store.size, 0);
  assert.deepEqual(rig.frames, [['F3', 'req-1', false]]);
});

test('captures: a camera error answer settles the reqId; unknown/failed from getOperation too; legacy record migrates', async () => {
  const rig = trackerRig();
  const tr = rig.make();
  rig.captureReply = () => { throw Object.assign(new Error('geo'), { code: 'GEOMETRY_MISMATCH' }); };
  const r = await tr.capture({ projectId: 'p', rotation: 180 });
  assert.equal(r.kind, 'failed');
  assert.equal(r.error.code, 'GEOMETRY_MISMATCH');
  assert.equal(tr.store.size, 0);

  const legacy = memStorage();
  legacy.setItem(OUTSTANDING_KEY, JSON.stringify({ reqId: 'old', projectId: 'p', cameraId: 'cam', at: 5 }));
  const st = new OutstandingStore(legacy);
  assert.deepEqual(st.list().map((x) => x.reqId), ['old']);
  st.add({ reqId: 'b', at: 6 });
  assert.deepEqual(Object.keys(JSON.parse(legacy.getItem(OUTSTANDING_KEY))).sort(), ['b', 'old']);
  assert.ok(st.remove('old'));
  assert.equal(st.remove('old'), false);
  st.remove('b');
  assert.equal(legacy.getItem(OUTSTANDING_KEY), null);
});

test('captures: records bound to another camera neither block nor get asked', async () => {
  const rig = trackerRig();
  const tr = rig.make();
  tr.cameraId = 'cam-B';
  tr.store.add({ reqId: 'x', projectId: 'p', rotation: 0, cameraId: 'cam-A', at: rig.now });
  assert.equal(tr.busy, false);
  await tr.reconcile();
  assert.equal(rig.sent.length, 0);
  assert.ok(tr.store.get('x'));
});

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

// ---------- fake camera knobs + the real loader over HTTP ----------

test('fake camera: fail-play / slow-play knobs, and the export loader gets every frame through them', async () => {
  const cam = await startFakeCamera({ images: loadFakeImages(), replaceSessions: true, rotation: 0 });
  const c = new CameraConnection({ url: `ws://${cam.host}/ws/control`, clientId: uuid(), backoff: new Backoff({ minMs: 20, maxMs: 50 }) });
  const base = `http://${cam.host}`;
  const httpUrl = (id, v) => `${base}${urlFor(id, v)}`;
  const policy = { ...EXPORT_POLICY, timeoutMs: 2000, backoffMs: [10, 20] };
  try {
    c.start();
    await waitFor(() => c.online, 3000);
    const projectId = uuid();
    const f1 = await c.request('capture', { projectId, rotation: 0 });

    await fetch(`${base}/fake/fail-play?count=2`);
    let r = await loadFrame(f1.frameId, { urlFor: httpUrl, policy });
    assert.equal(r.variant, 'play');
    assert.equal(r.tries, 3);

    await fetch(`${base}/fake/fail-play?count=1&status=404`);
    r = await loadFrame(f1.frameId, { urlFor: httpUrl, policy });
    assert.equal(r.variant, 'full');

    await fetch(`${base}/fake/fail-play?count=99&full=1&frame=${f1.frameId}`);
    await assert.rejects(loadFrame(f1.frameId, { urlFor: httpUrl, policy }), (e) => e.code === 'FRAME_LOAD_FAILED');

    await fetch(`${base}/fake/fail-play?count=0`);
    await fetch(`${base}/fake/slow-play?ms=150`);
    const f2 = await c.request('capture', { projectId, rotation: 0 });
    const f3 = await c.request('capture', { projectId, rotation: 0 });
    const t0 = performance.now();
    r = await loadFrame(f3.frameId, { urlFor: httpUrl, policy });
    const waited = performance.now() - t0;
    assert.equal(r.variant, 'play');
    assert.ok(waited >= 250, `f3 waits for f2 and itself to be generated (${Math.round(waited)} ms)`);
    const t1 = performance.now();
    await loadFrame(f2.frameId, { urlFor: httpUrl, policy });
    assert.ok(performance.now() - t1 < 100, 'f2 was ready by then');
    const st = await (await fetch(`${base}/fake/state`)).json();
    assert.ok(st.frameRequests.some((x) => x.endsWith('play.jpg?retry=1')));
  } finally {
    c.stop();
    await cam.close();
  }
});
