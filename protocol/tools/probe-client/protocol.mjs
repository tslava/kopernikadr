// Control WebSocket client (PROTOCOL.md §4–§6).
import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const CLOSE_LABELS = { 4001: 'replaced', 4002: 'lease lost' };

export function describeClose(code, reason) {
  const label = CLOSE_LABELS[code];
  return [code, label, reason && reason !== label ? `"${reason}"` : ''].filter(Boolean).join(' ');
}

export function buildRequest(op, args = {}, reqId = randomUUID()) {
  return { v: PROTOCOL_VERSION, t: 'req', reqId, op, args };
}

/** A `res` with `ok:false`, or a local failure (`TIMEOUT`, `CLOSED`) with `local: true`. */
export class ProtocolError extends Error {
  constructor(op, error = {}, { local = false } = {}) {
    const code = error.code ?? 'UNKNOWN';
    const retryAfterMs = error.retryAfterMs ?? error.data?.retryAfterMs;
    const extra = retryAfterMs != null ? ` (retry after ${retryAfterMs} ms)` : '';
    super(`${op}: ${code}${error.message ? ` - ${error.message}` : ''}${extra}`);
    this.name = 'ProtocolError';
    this.op = op;
    this.code = code;
    this.retryable = Boolean(error.retryable);
    this.retryAfterMs = retryAfterMs;
    this.local = local;
    this.details = error;
  }
}

/**
 * Wraps an open WebSocket-like object (`send`, `close`, `addEventListener`).
 * Requests are correlated by `reqId`; `evt` messages go to `onEvent(name, data)`.
 */
export class ControlClient {
  #socket;
  #pending = new Map();
  #pingTimer = null;
  #closedByClient = false;
  #opts;

  /**
   * @param {object} socket
   * @param {{onEvent?: Function, onClose?: Function, onPing?: Function, onPingError?: Function,
   *          timeoutMs?: number, pingIntervalMs?: number}} [opts]
   */
  constructor(socket, opts = {}) {
    this.#socket = socket;
    this.#opts = { timeoutMs: 10_000, pingIntervalMs: 2_000, ...opts };
    this.session = null;
    this.closeInfo = null;
    socket.addEventListener('message', (e) => this.#onMessage(e.data));
    socket.addEventListener('close', (e) => this.#onClose(e.code, e.reason));
  }

  /** Opens `url` and resolves once the socket is open. */
  static connect(url, opts = {}) {
    return openWebSocket(url, opts.connectTimeoutMs).then((ws) => new ControlClient(ws, opts));
  }

  get pendingCount() {
    return this.#pending.size;
  }

  request(op, args = {}, { reqId, timeoutMs = this.#opts.timeoutMs } = {}) {
    const msg = buildRequest(op, args, reqId);
    if (this.closeInfo) {
      return Promise.reject(new ProtocolError(op, { code: 'CLOSED', message: `socket closed (${describeClose(this.closeInfo.code, this.closeInfo.reason)})` }, { local: true }));
    }
    if (this.#pending.has(msg.reqId)) {
      return Promise.reject(new Error(`${op}: reqId ${msg.reqId} is already pending`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(msg.reqId);
        reject(new ProtocolError(op, { code: 'TIMEOUT', message: `no response within ${timeoutMs} ms`, reqId: msg.reqId }, { local: true }));
      }, timeoutMs);
      this.#pending.set(msg.reqId, { op, resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(msg.reqId);
        reject(e);
      }
    });
  }

  /** Sends `hello`; on success remembers the session and starts the 2 s ping. */
  async hello({ clientId, token } = {}) {
    const args = {
      clientId,
      protocolVersions: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      appVersion: 'probe-client',
      platform: 'node',
      ...(token ? { token } : {}),
    };
    this.session = await this.request('hello', args);
    this.#startPing();
    return this.session;
  }

  close(code = 1000, reason = 'client close') {
    this.#closedByClient = true;
    this.#stopPing();
    try {
      this.#socket.close(code, reason);
    } catch {
      // already closing
    }
  }

  #startPing() {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      const started = performance.now();
      this.request('ping', {}).then(
        (data) => this.#opts.onPing?.(performance.now() - started, data),
        (err) => this.#opts.onPingError?.(err),
      );
    }, this.#opts.pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  #stopPing() {
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #onMessage(data) {
    if (typeof data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.t === 'res') {
      const entry = this.#pending.get(msg.reqId);
      if (!entry) return; // late (timed out) or unknown
      this.#pending.delete(msg.reqId);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.data ?? {});
      else entry.reject(new ProtocolError(entry.op, msg.error));
    } else if (msg?.t === 'evt') {
      this.#opts.onEvent?.(msg.name, msg.data, msg);
    }
  }

  #onClose(code, reason) {
    this.#stopPing();
    this.closeInfo = { code, reason, label: CLOSE_LABELS[code] ?? null, byClient: this.#closedByClient };
    const message = `socket closed (${describeClose(code, reason)})`;
    for (const [reqId, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new ProtocolError(entry.op, { code: 'CLOSED', message, reqId, closeCode: code }, { local: true }));
    }
    this.#pending.clear();
    this.#opts.onClose?.(this.closeInfo);
  }
}

/**
 * Opens a WebSocket and resolves once it is open. Node's WebSocket reports neither the HTTP
 * status nor the errno of a failed upgrade, so the error says what the usual causes are.
 */
export function openWebSocket(url, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const fail = (why) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* not open yet */ }
      reject(new Error(`cannot open ${url}: ${why}`));
    };
    const timer = setTimeout(() => fail(`no handshake within ${timeoutMs} ms`), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => fail('connection refused, unreachable, or upgrade rejected (non-101 status, e.g. 409)'), { once: true });
  });
}
