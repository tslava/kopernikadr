// Control WebSocket client (PROTOCOL.md §4–§6), browser variant of
// protocol/tools/probe-client/protocol.mjs. No Node imports: runs in the browser and in `node --test`.

export const PROTOCOL_VERSION = 1;
/** @type {Record<number, string>} */
export const CLOSE_LABELS = { 4000: 'protocol error', 4001: 'replaced', 4002: 'lease lost', 4003: 'busy' };

/**
 * @typedef {{ code?: string, message?: string, retryable?: boolean, retryAfterMs?: number,
 *   data?: { retryAfterMs?: number } & Record<string, unknown> } & Record<string, unknown>} ErrorBody
 *   A `res.error` object (PROTOCOL.md §5), or the details of a local failure.
 * @typedef {{ code: number, reason: string, label: string | null, byClient: boolean }} CloseInfo
 * @typedef {{ timeoutMs?: number, onEvent?: (name: string, data: any) => void,
 *   onClose?: (info: CloseInfo) => void }} ControlClientOptions
 * @typedef {{ addEventListener(type: string, fn: (e: any) => void): void, send(data: string): void,
 *   close(code?: number, reason?: string): void }} SocketLike
 *   The part of a WebSocket the client uses (browser WebSocket, Node's global one, a test fake).
 */

/**
 * UUID v4. `crypto.randomUUID` only exists in secure contexts, and the page is served over plain
 * http://<phone-ip>, so this uses `getRandomValues` (available everywhere).
 */
export function uuid() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** @param {string} op @param {object} [args] @param {string} [reqId] */
export function buildRequest(op, args = {}, reqId = uuid()) {
  return { v: PROTOCOL_VERSION, t: 'req', reqId, op, args };
}

/**
 * Whether a lock control is in the "Lock failed" state (PROTOCOL.md §6). `exposure` and
 * `whiteBalance` report `mode: 'failed'`. Focus has no `failed` mode on the wire: its failed lock
 * is `mode: 'locked'` + `confirmed: false` + `focusOk: false`.
 * @param {'exposure' | 'whiteBalance' | 'focus'} key
 * @param {{ mode?: string, confirmed?: boolean, focusOk?: boolean } | null | undefined} control
 */
export function isLockFailed(key, control) {
  if (!control) return false;
  if (control.mode === 'failed') return true;
  return key === 'focus' && control.mode === 'locked' && control.confirmed === false && control.focusOk === false;
}

/** A `res` with `ok:false`, or a local failure (`TIMEOUT`, `CLOSED`) with `local: true`. */
export class ProtocolError extends Error {
  /** @param {string} op @param {ErrorBody} [error] @param {{ local?: boolean }} [opts] */
  constructor(op, error = {}, { local = false } = {}) {
    const code = error.code ?? 'UNKNOWN';
    super(`${op}: ${code}${error.message ? ` - ${error.message}` : ''}`);
    this.name = 'ProtocolError';
    this.op = op;
    this.code = code;
    this.retryable = Boolean(error.retryable);
    this.retryAfterMs = error.retryAfterMs ?? error.data?.retryAfterMs;
    this.local = local;
    this.details = error;
  }
}

/**
 * Wraps an open WebSocket. Requests are correlated by `reqId`; `evt` messages go to
 * `onEvent(name, data)`. `abort()` drops the socket at once (a dead network may delay the
 * browser's own `close` event for a long time).
 */
export class ControlClient {
  /** @type {SocketLike} */
  #socket;
  /** @type {Map<string, { op: string, resolve: (data: any) => void, reject: (e: ProtocolError) => void, timer: ReturnType<typeof setTimeout> }>} */
  #pending = new Map();
  /** @type {ControlClientOptions & { timeoutMs: number }} */
  #opts;
  #closed = false;

  /** @param {SocketLike} socket @param {ControlClientOptions} [opts] */
  constructor(socket, opts = {}) {
    this.#socket = socket;
    this.#opts = { timeoutMs: 10_000, ...opts };
    /** @type {CloseInfo | null} */
    this.closeInfo = null;
    socket.addEventListener('message', (e) => this.#onMessage(e.data));
    socket.addEventListener('close', (e) => this.#onClose(e.code, e.reason));
  }

  get pendingCount() {
    return this.#pending.size;
  }

  /**
   * @param {string} op @param {object} [args] @param {{ reqId?: string, timeoutMs?: number }} [opts]
   * @returns {Promise<any>} the `data` of an ok `res`; rejects with a ProtocolError
   */
  request(op, args = {}, { reqId, timeoutMs = this.#opts.timeoutMs } = {}) {
    const msg = buildRequest(op, args, reqId);
    if (this.#closed) return Promise.reject(new ProtocolError(op, { code: 'CLOSED', message: 'socket closed' }, { local: true }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(msg.reqId);
        reject(new ProtocolError(op, { code: 'TIMEOUT', message: `no response within ${timeoutMs} ms` }, { local: true }));
      }, timeoutMs);
      this.#pending.set(msg.reqId, { op, resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(msg.reqId);
        reject(new ProtocolError(op, { code: 'CLOSED', message: String(/** @type {any} */ (e)?.message ?? e) }, { local: true }));
      }
    });
  }

  /** @param {number} [code] @param {string} [reason] */
  abort(code = 1000, reason = 'client close') {
    try {
      this.#socket.close(code, reason);
    } catch {
      // already closing
    }
    this.#onClose(code, reason, true);
  }

  /** @param {unknown} data */
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
      this.#opts.onEvent?.(msg.name, msg.data);
    }
  }

  /** @param {number} code @param {string} reason @param {boolean} [byClient] */
  #onClose(code, reason, byClient = false) {
    if (this.#closed) return;
    this.#closed = true;
    this.closeInfo = { code, reason, label: CLOSE_LABELS[code] ?? null, byClient };
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ProtocolError(entry.op, { code: 'CLOSED', message: `socket closed (${code})`, closeCode: code }, { local: true }));
    }
    this.#pending.clear();
    this.#opts.onClose?.(this.closeInfo);
  }
}
