// Test-only fake camera: just enough of PROTOCOL.md (and the assumed /diag shapes) to drive the
// CLI commands end to end. Includes a minimal RFC 6455 server since there are no dependencies.

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3, 4, 0xff, 0xd9]);

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
      if (opcode === 8) { this.#frame(8, payload.subarray(0, 2)); this.socket.end(); return; }
      if (opcode === 9) { this.#frame(10, payload); continue; }
      if (opcode === 1) this.onMessage(payload.toString('utf8'));
      else if (opcode === 2) this.onMessage(payload);
    }
  }
}

function previewFrame(header) {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, JPEG]);
}

/**
 * @param {{stallNexts?: number, probeSteps?: object[], diag?: boolean}} [opts]
 *   stallNexts: how many preview `next`s to ignore (to trigger the watchdog);
 *   probeSteps: RunStatus snapshots the probe walks through (one per GET /diag/runs).
 */
export async function startFakeCamera(opts = {}) {
  const state = {
    session: null, frames: new Map(), captures: new Map(), seq: 0, previewSeq: 0,
    stallNexts: opts.stallNexts ?? 0, controls: [], continues: [], hellos: 0, probeArgs: null,
    runIndex: 0, downRequests: opts.downRequests ?? 0,
  };
  const bootId = randomUUID();
  const fullBytes = Buffer.concat([JPEG, Buffer.alloc(1000, 7)]);
  const runId = 'run-1';
  const steps = opts.probeSteps ?? [];

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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/info') return json(res, 200, { cameraId: 'cam-1', name: 'G05', bootId, protocolVersions: { min: 1, max: 1 } });
    let m;
    if ((m = /^\/frames\/([^/]+)\/(full|play|thumb)\.jpg$/.exec(p))) {
      if (!state.frames.has(m[1])) return json(res, 404, { error: 'unknown frame' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': fullBytes.length });
      return res.end(fullBytes);
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
      const conn = new WsConn(socket, (text) => onControl(conn, JSON.parse(text)));
    } else if (url.pathname === '/ws/preview') {
      const conn = new WsConn(socket, (text) => {
        if (JSON.parse(text).t !== 'next') return;
        if (state.stallNexts > 0) { state.stallNexts--; return; }
        setTimeout(() => conn.send(previewFrame({ seq: ++state.previewSeq, bootId, generation: 1, w: 1280, h: 960, ts: Date.now(), locks: {} })), 5);
      });
    } else {
      socket.destroy();
    }
  });

  function onControl(conn, msg) {
    const reply = (data) => conn.send(JSON.stringify({ v: 1, t: 'res', reqId: msg.reqId, ok: true, data }));
    const fail = (error) => conn.send(JSON.stringify({ v: 1, t: 'res', reqId: msg.reqId, ok: false, error }));
    if (msg.op === 'hello') {
      state.hellos++;
      if (state.session && state.session.clientId !== msg.args.clientId) {
        fail({ code: 'BUSY', message: 'another client holds the session', retryable: true, retryAfterMs: 10000 });
        return conn.close(4003, 'busy');
      }
      state.session = { sessionId: randomUUID(), clientId: msg.args.clientId };
      return reply({ cameraId: 'cam-1', bootId, sessionId: state.session.sessionId, name: 'G05', protocolVersion: 1,
        capabilities: {}, controls: { rotation: 180 }, status: {}, sessionTtlMs: 10000 });
    }
    if (msg.op === 'ping') return reply({ serverTimeMs: Date.now() });
    if (msg.op === 'capture') {
      const key = `${state.session.clientId}/${msg.reqId}`;
      if (!state.captures.has(key)) {
        const frameId = `01FRAME${++state.seq}`;
        state.frames.set(frameId, true);
        state.captures.set(key, { frameId, seq: state.seq, projectId: msg.args.projectId, rotation: msg.args.rotation,
          full: { w: 3264, h: 2448, bytes: fullBytes.length, sha256: createHash('sha256').update(fullBytes).digest('hex') } });
      }
      return reply(state.captures.get(key));
    }
    fail({ code: 'UNKNOWN_OP', message: msg.op });
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state,
    host: `127.0.0.1:${port}`,
    fullBytes,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
