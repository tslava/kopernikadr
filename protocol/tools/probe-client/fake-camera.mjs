// Test-only fake camera: just enough of PROTOCOL.md (and the assumed /diag shapes) to drive the
// CLI commands and the remote-lite browser page end to end. Includes a minimal RFC 6455 server
// since there are no dependencies.
//
// As a dev server for remote-lite:
//   node fake-camera.mjs --serve ../../../camera-android/core/src/main/resources/remote-lite --port 8765
// then open http://localhost:8765/. Extra knobs (plain GETs, for manual failure tests):
//   /fake/kick          close every socket (the page must show "offline" and reconnect)
//   /fake/drop-capture  commit the next capture but never answer it (lost response)
//   /fake/fail-lock     the next lock request fails to confirm (mode "failed")
//   /fake/state         JSON dump of frames / controls / session

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3, 4, 0xff, 0xd9]);
const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_TTL_MS = 10_000;

class WsConn {
  #buf = Buffer.alloc(0);
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    socket.on('data', (d) => this.#read(d));
    socket.on('close', () => onClose?.());
    socket.on('error', () => {});
  }

  send(data) {
    const isText = typeof data === 'string';
    this.#frame(isText ? 1 : 2, isText ? Buffer.from(data) : Buffer.from(data));
  }

  close(code = 1000, reason = '') {
    if (this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#frame(8, p);
    setTimeout(() => this.socket.end(), 20);
  }

  #frame(opcode, payload) {
    if (this.socket.destroyed) return;
    let head;
    if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
    else if (payload.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  #read(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const masked = b[1] & 0x80;
      const mask = masked ? b.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.#buf = b.subarray(off + len);
      if (opcode === 8) {
        // echo the close only if we have not sent ours yet (a second close frame is a protocol error)
        if (!this.closeSent) { this.closeSent = true; this.#frame(8, payload.subarray(0, 2)); }
        this.socket.end();
        return;
      }
      if (opcode === 9) { this.#frame(10, payload); continue; }
      if (opcode === 1) this.onMessage(payload.toString('utf8'));
      else if (opcode === 2) this.onMessage(payload);
    }
  }
}

function previewFrame(header, jpeg = JPEG) {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, jpeg]);
}

/** The pictures in fake-frames/: a figure walking across a table, one step per capture. */
export function loadFakeImages(dir = join(HERE, 'fake-frames')) {
  const names = readdirSync(dir).filter((n) => /^step-\d+\.jpg$/.test(n)).sort();
  return {
    play: names.map((n) => readFileSync(join(dir, n))),
    thumb: names.map((n) => readFileSync(join(dir, n.replace('step-', 'thumb-')))),
  };
}

const CAPABILITIES = {
  aspect: '4:3',
  sizes: { full: { w: 3264, h: 2448 }, play: { w: 1440, h: 1080 }, thumb: { w: 256, h: 192 } },
  rotations: [0, 180],
  exposure: { lock: true, method: 'freeze', compensation: { supported: true, minSteps: -4, maxSteps: 4, stepEv: { num: 1, den: 2 } } },
  whiteBalance: { lock: true, method: 'freeze' },
  focusLock: { method: 'freeze' },
  focus: { modes: ['auto', 'locked'], minFocusDistanceDiopters: 10.0 },
  previewQualities: ['low', 'normal', 'high'],
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

/**
 * @param {{stallNexts?: number, probeSteps?: object[], diag?: boolean, downRequests?: number,
 *          images?: {play: Buffer[], thumb: Buffer[]}, serveDir?: string, port?: number, host?: string,
 *          rotation?: number, captureDelayMs?: number, confirmDelayMs?: number, previewIntervalMs?: number,
 *          statusIntervalMs?: number, replaceSessions?: boolean}} [opts]
 *   stallNexts: how many preview `next`s to ignore (to trigger the watchdog);
 *   probeSteps: RunStatus snapshots the probe walks through (one per GET /diag/runs);
 *   images: real JPEGs for preview and /frames (see loadFakeImages); a capture shows the current
 *     scene step and then advances the scene, like a kid moving a figure between frames;
 *   serveDir: serve this directory's static files on `/` (the remote-lite page);
 *   replaceSessions: a second hello from the same clientId closes the old sockets with 4001.
 */
export async function startFakeCamera(opts = {}) {
  const state = {
    session: null, frames: new Map(), captures: new Map(), seq: 0, previewSeq: 0,
    stallNexts: opts.stallNexts ?? 0, controls: [], continues: [], hellos: 0, probeArgs: null,
    runIndex: 0, downRequests: opts.downRequests ?? 0, step: 0, acked: new Set(),
    dropCaptures: 0, failNextLock: false, requests: [],
    ctl: {
      generation: 1, settling: false,
      exposure: { mode: 'auto', confirmed: true, exact: true, compensationSteps: 0, compensationEnabled: true },
      whiteBalance: { mode: 'auto', confirmed: true, exact: true },
      focus: { mode: 'auto', confirmed: true, focusOk: true },
      rotation: opts.rotation ?? 180, previewQuality: 'normal',
    },
  };
  const images = opts.images ?? null;
  const bootId = randomUUID();
  const cameraId = 'cam-1';
  const fullBytes = Buffer.concat([JPEG, Buffer.alloc(1000, 7)]);
  const runId = 'run-1';
  const steps = opts.probeSteps ?? [];
  const controlConns = new Set();
  const previewConns = new Set();
  const status = () => ({ batteryPct: 81 - Math.min(60, state.seq), charging: false, freeBytes: 41_234_567_890,
    spoolBytes: state.seq * 2_345_678, unackedCount: state.frames.size - state.acked.size, orphanCount: 0,
    integrityErrors: 0, thermal: 'none' });

  const json = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };
  const readBody = (req) => new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => resolve(s ? JSON.parse(s) : {}));
  });
  const currentRun = () => ({ runId, name: 'locks', ...steps[Math.min(state.runIndex, steps.length - 1)] });
  const broadcast = (name, data) => {
    for (const c of controlConns) if (c.sessionId === state.session?.sessionId) c.send(JSON.stringify({ v: 1, t: 'evt', name, data }));
  };
  const sessionLive = () => state.session && performance.now() - state.session.lastSeen < SESSION_TTL_MS;

  const serveStatic = async (res, p) => {
    if (!opts.serveDir) return false;
    const root = resolve(opts.serveDir);
    const file = resolve(root, '.' + decodeURIComponent(p === '/' ? '/index.html' : p));
    if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || !statSync(file).isFile()) return false;
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/info') return json(res, 200, { cameraId, name: 'G05', bootId, protocolVersions: { min: 1, max: 1 } });
    let m;
    if ((m = /^\/frames\/([^/]+)\/(full|play|thumb)\.jpg$/.exec(p))) {
      const frame = state.frames.get(m[1]);
      if (!frame) return json(res, 404, { error: 'unknown frame' });
      const body = images ? images[m[2] === 'thumb' ? 'thumb' : 'play'][frame.step] : fullBytes;
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length, 'cache-control': 'max-age=31536000, immutable' });
      return res.end(body);
    }
    if (p === '/fake/kick') {
      for (const c of [...controlConns, ...previewConns]) c.socket.destroy();
      return json(res, 200, { kicked: true });
    }
    if (p === '/fake/drop-capture') { state.dropCaptures++; return json(res, 200, { dropCaptures: state.dropCaptures }); }
    if (p === '/fake/fail-lock') { state.failNextLock = true; return json(res, 200, { failNextLock: true }); }
    if (p === '/fake/state') {
      return json(res, 200, { frames: [...state.frames.values()], controls: state.ctl, session: state.session, requests: state.requests.slice(-50) });
    }
    if (opts.diag === false && p.startsWith('/diag/')) return json(res, 404, {});
    if (p === '/diag/controls') { state.controls.push(await readBody(req)); return json(res, 200, {}); }
    if ((m = /^\/diag\/probe\/([\w-]+)$/.exec(p))) { state.probeArgs = await readBody(req); return json(res, 202, { runId }); }
    if (p === '/diag/runs') {
      if (state.downRequests > 0) { state.downRequests--; req.socket.destroy(); return; }
      const run = currentRun();
      if (!run.prompt) state.runIndex++;
      return json(res, 200, { runs: [run] });
    }
    if (p === '/diag/continue') {
      const body = await readBody(req);
      state.continues.push(body);
      state.runIndex++;
      return json(res, 200, { ok: true });
    }
    if (p === `/diag/report/${runId}`) return json(res, 200, { ...currentRun(), files: ['report.json', 'overlay-0.png', '../evil'] });
    if (p === `/diag/files/${runId}/overlay-0.png`) { res.writeHead(200, { 'content-length': 3 }); return res.end('PNG'); }
    if (req.method === 'GET' && await serveStatic(res, p)) return;
    json(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ws/preview' && url.searchParams.get('session') !== state.session?.sessionId) {
      socket.end('HTTP/1.1 409 Conflict\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (url.pathname === '/ws/control') {
      const conn = new WsConn(socket, (text) => onControl(conn, JSON.parse(text)), () => controlConns.delete(conn));
      controlConns.add(conn);
    } else if (url.pathname === '/ws/preview') {
      let pending = null;
      const conn = new WsConn(socket, (text) => {
        if (JSON.parse(text).t !== 'next') return;
        if (state.stallNexts > 0) { state.stallNexts--; return; }
        if (pending) return; // coalesce duplicate nexts
        pending = setTimeout(() => {
          pending = null;
          if (images) {
            const header = { seq: ++state.previewSeq, bootId, generation: state.ctl.generation, w: 640, h: 480, ts: Date.now(),
              locks: { exposure: state.ctl.exposure.mode, whiteBalance: state.ctl.whiteBalance.mode, focus: state.ctl.focus.mode } };
            conn.send(previewFrame(header, images.play[state.step % images.play.length]));
          } else {
            conn.send(previewFrame({ seq: ++state.previewSeq, bootId, generation: 1, w: 1280, h: 960, ts: Date.now(), locks: {} }));
          }
        }, opts.previewIntervalMs ?? 5);
      }, () => { clearTimeout(pending); previewConns.delete(conn); });
      conn.sessionId = url.searchParams.get('session');
      previewConns.add(conn);
    } else {
      socket.destroy();
    }
  });

  function frameInfo(rec) {
    return { frameId: rec.frameId, seq: rec.seq, projectId: rec.projectId, clientId: rec.clientId, rotation: rec.rotation,
      capturedAt: rec.capturedAt, full: rec.full, derived: { play: { w: 1440, h: 1080 }, thumb: { w: 256, h: 192 } } };
  }

  function setControl(args) {
    const c = state.ctl;
    const lockable = { exposure: c.exposure, whiteBalance: c.whiteBalance, focus: c.focus };
    if (args.control in lockable) {
      if (!['auto', 'locked'].includes(args.mode)) return { code: 'INVALID_VALUE', message: `mode ${args.mode}` };
      const target = lockable[args.control];
      target.mode = args.mode;
      target.confirmed = args.mode === 'auto';
      if (args.control === 'focus') target.focusOk = true;
      if (args.control === 'exposure') c.exposure.compensationEnabled = true; // freeze method would say false; keep sliders testable
      if (args.mode === 'locked') {
        const fail = state.failNextLock;
        state.failNextLock = false;
        const gen = c.generation + 1;
        setTimeout(() => {
          if (c.generation !== gen || target.mode !== 'locked') return;
          // like the real camera: focus has no "failed" mode, it stays locked + unconfirmed + focusOk:false
          if (fail && args.control === 'focus') target.focusOk = false;
          else if (fail) target.mode = 'failed';
          else target.confirmed = true;
          c.settling = false;
          broadcast('controls', c);
        }, opts.confirmDelayMs ?? 600);
        c.settling = true;
      }
    } else if (args.control === 'exposureCompensation') {
      if (!c.exposure.compensationEnabled) return { code: 'INVALID_VALUE', message: 'compensation disabled' };
      if (!Number.isInteger(args.steps) || args.steps < -4 || args.steps > 4) return { code: 'INVALID_VALUE', message: `steps ${args.steps}` };
      c.exposure.compensationSteps = args.steps;
    } else if (args.control === 'rotation') {
      if (![0, 180].includes(args.degrees)) return { code: 'INVALID_VALUE', message: `degrees ${args.degrees}` };
      c.rotation = args.degrees;
    } else if (args.control === 'previewQuality') {
      if (!['low', 'normal', 'high'].includes(args.value)) return { code: 'INVALID_VALUE', message: `value ${args.value}` };
      c.previewQuality = args.value;
    } else {
      return { code: 'UNSUPPORTED_CONTROL', message: String(args.control) };
    }
    c.generation++;
    return null;
  }

  function onControl(conn, msg) {
    const reply = (data) => conn.send(JSON.stringify({ v: 1, t: 'res', reqId: msg.reqId, ok: true, data }));
    const fail = (error) => conn.send(JSON.stringify({ v: 1, t: 'res', reqId: msg.reqId, ok: false, error: { retryable: false, ...error } }));
    state.requests.push(msg.op);
    if (msg.op === 'hello') {
      state.hellos++;
      if (sessionLive() && state.session.clientId !== msg.args.clientId) {
        const retryAfterMs = opts.replaceSessions
          ? Math.max(1, Math.round(SESSION_TTL_MS - (performance.now() - state.session.lastSeen))) : 10000;
        fail({ code: 'BUSY', message: 'another client holds the session', retryable: true, retryAfterMs });
        return conn.close(4003, 'busy');
      }
      if (opts.replaceSessions && state.session) {
        for (const c of [...controlConns, ...previewConns]) {
          if (c !== conn && c.sessionId === state.session.sessionId) c.close(4001, 'replaced');
        }
      }
      state.session = { sessionId: randomUUID(), clientId: msg.args.clientId, lastSeen: performance.now() };
      conn.sessionId = state.session.sessionId;
      return reply({ cameraId, bootId, sessionId: state.session.sessionId, name: 'G05', protocolVersion: 1,
        capabilities: CAPABILITIES, controls: state.ctl, status: status(), sessionTtlMs: SESSION_TTL_MS });
    }
    if (!conn.sessionId) {
      fail({ code: 'INVALID_ARGS', message: 'hello expected' });
      return conn.close(4000, 'protocol error');
    }
    if (conn.sessionId !== state.session?.sessionId) {
      fail({ code: 'LEASE_LOST', message: 'session replaced' });
      return conn.close(4002, 'lease lost');
    }
    state.session.lastSeen = performance.now();
    const clientId = state.session.clientId;
    const a = msg.args ?? {};
    switch (msg.op) {
      case 'ping': return reply({ serverTimeMs: Date.now() });
      case 'capture': {
        const key = `${clientId}/${msg.reqId}`;
        const known = state.captures.get(key);
        if (known) return known.done ? reply(frameInfo(known)) : fail({ code: 'CAPTURE_IN_PROGRESS', message: 'in flight', retryable: true });
        if (state.ctl.settling) return fail({ code: 'CAMERA_NOT_READY', message: 'controls settling', retryable: true });
        if (a.rotation !== state.ctl.rotation) {
          return fail({ code: 'GEOMETRY_MISMATCH', message: `capture rotation ${a.rotation} does not match the camera rotation ${state.ctl.rotation}` });
        }
        const step = images ? state.step % images.play.length : 0;
        const bytes = images ? images.play[step] : fullBytes;
        const seq = ++state.seq;
        const rec = { frameId: `01FRAME${String(seq).padStart(6, '0')}`, seq, projectId: a.projectId, clientId, rotation: a.rotation,
          capturedAt: new Date().toISOString(), step, done: false,
          full: { w: 3264, h: 2448, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
        state.captures.set(key, rec);
        const drop = state.dropCaptures > 0 && state.dropCaptures--;
        const commit = () => {
          rec.done = true;
          state.frames.set(rec.frameId, rec);
          if (images) state.step = (state.step + 1) % images.play.length;
          if (!drop) reply(frameInfo(rec));
          broadcast('status', status());
        };
        const delay = opts.captureDelayMs ?? 0;
        return delay ? setTimeout(commit, delay) : commit();
      }
      case 'getOperation': {
        const rec = state.captures.get(`${clientId}/${a.reqId}`);
        if (!rec) return reply({ state: 'unknown' });
        return reply(rec.done ? { state: 'done', result: frameInfo(rec) } : { state: 'pending' });
      }
      case 'listFrames': {
        const after = a.afterSeq ?? 0;
        const limit = Math.min(a.limit ?? 100, 500);
        const all = [...state.frames.values()].filter((f) => f.clientId === clientId && !state.acked.has(f.frameId) && f.seq > after)
          .sort((x, y) => x.seq - y.seq);
        return reply({ frames: all.slice(0, limit).map(frameInfo), hasMore: all.length > limit });
      }
      case 'ack': {
        const unknown = [];
        let acked = 0;
        for (const id of a.frameIds ?? []) {
          const f = state.frames.get(id);
          if (f?.clientId === clientId) { state.acked.add(id); acked++; } else unknown.push(id);
        }
        return reply({ acked, unknown });
      }
      case 'getControls': return reply(state.ctl);
      case 'setControl': {
        const err = setControl(a);
        if (err) return fail(err);
        reply(state.ctl);
        return broadcast('controls', state.ctl);
      }
      case 'getStatus': return reply(status());
      default: return fail({ code: 'UNKNOWN_OP', message: msg.op });
    }
  }

  const statusTimer = setInterval(() => broadcast('status', status()), opts.statusIntervalMs ?? 10_000);
  statusTimer.unref();

  await new Promise((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const { port } = server.address();
  return {
    state,
    host: `127.0.0.1:${port}`,
    port,
    fullBytes,
    close: () => new Promise((r) => { clearInterval(statusTimer); server.closeAllConnections(); server.close(r); }),
  };
}

// CLI: node fake-camera.mjs --serve <dir> [--port 8765] [--host 0.0.0.0] [--rotation 0]
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const cam = await startFakeCamera({
    images: loadFakeImages(),
    serveDir: flag('serve'),
    port: Number(flag('port', 8765)),
    host: flag('host', '127.0.0.1'),
    rotation: Number(flag('rotation', 0)),
    captureDelayMs: Number(flag('capture-delay', 350)),
    previewIntervalMs: 80,
    replaceSessions: true,
  });
  console.log(`fake camera on http://${flag('host', '127.0.0.1')}:${cam.port}/ ${flag('serve') ? `serving ${flag('serve')}` : '(no --serve dir)'}`);
}
