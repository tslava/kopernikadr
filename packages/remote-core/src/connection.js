// Keeps one control session to the camera alive: hello, 2 s ping, offline after 5 s without a
// pong, reconnect with backoff 0.5→5 s, BUSY → wait retryAfterMs. Works with any WebSocket
// implementation (browser, or Node's global WebSocket in tests).

import { ControlClient, PROTOCOL_VERSION, ProtocolError } from './protocol.js';
import { Backoff } from './backoff.js';

/** Close code 4001: the same clientId (another tab or device with this page) took the session. */
export const CLOSE_REPLACED = 4001;

/**
 * @typedef {import('./protocol.js').CloseInfo} CloseInfo
 * @typedef {'connecting'|'online'|'offline'|'busy'|'unsupported'|'replaced'} ConnectionState
 * @typedef {{ url: string, clientId: string, appVersion?: string, platform?: string,
 *   WebSocketImpl?: new (url: string) => WebSocket, pingIntervalMs?: number, offlineAfterMs?: number,
 *   connectTimeoutMs?: number, backoff?: Backoff }} ConnectionOptions
 */

/**
 * What to do when the camera closes the control socket (PROTOCOL.md §4): 4001 replaced → stop
 * (reconnecting would steal the session back and the two tabs would fight forever); anything else
 * (4002 lease lost, network drop, ...) → reconnect with backoff.
 * @param {number | undefined} code
 * @returns {'stop'|'reconnect'}
 */
export function closeAction(code) {
  return code === CLOSE_REPLACED ? 'stop' : 'reconnect';
}

/**
 * States: 'connecting' (never had a session yet), 'online', 'offline' (lost it, reconnecting),
 * 'busy' (another client holds the camera), 'unsupported' (no common protocol version),
 * 'replaced' (another tab/device with this clientId took over; no reconnect until takeOver()).
 * Events (on): state(state, detail), session(helloData), controls(c), status(s), event(name, data).
 */
export class CameraConnection {
  /** @type {WebSocket | null} */
  #ws = null;
  /** @type {ControlClient | null} */
  #client = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer = undefined;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #pingTimer = undefined;
  #lastPong = 0;
  #token = 0;
  /** @type {Map<string, Set<(...args: any[]) => void>>} */
  #listeners = new Map();
  #running = false;

  /** @param {ConnectionOptions} opts */
  constructor({ url, clientId, appVersion = 'remote-lite', platform = 'web', WebSocketImpl = globalThis.WebSocket,
    pingIntervalMs = 2000, offlineAfterMs = 5000, connectTimeoutMs = 5000, backoff = new Backoff() }) {
    /** @type {string} */ this.url = url;
    /** @type {string} */ this.clientId = clientId;
    /** @type {string} */ this.appVersion = appVersion;
    /** @type {string} */ this.platform = platform;
    /** @type {new (url: string) => WebSocket} */ this.WebSocketImpl = WebSocketImpl;
    /** @type {number} */ this.pingIntervalMs = pingIntervalMs;
    /** @type {number} */ this.offlineAfterMs = offlineAfterMs;
    /** @type {number} */ this.connectTimeoutMs = connectTimeoutMs;
    /** @type {Backoff} */ this.backoff = backoff;
    /** @type {ConnectionState} */
    this.state = 'connecting';
    /** @type {any} the `hello` data of the current/last session */
    this.session = null;
    /** @type {any} */
    this.capabilities = null;
    /** @type {any} */
    this.controls = null;
    /** @type {any} */
    this.status = null;
    this.everOnline = false;
  }

  /**
   * @param {'state'|'session'|'controls'|'status'|'event'} name
   * @param {(...args: any[]) => void} fn
   * @returns {() => boolean} unsubscribe
   */
  on(name, fn) {
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => /** @type {Set<(...args: any[]) => void>} */ (set).delete(fn);
  }

  /** @param {string} name @param {...unknown} args */
  #emit(name, ...args) {
    for (const fn of this.#listeners.get(name) ?? []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** @param {ConnectionState} state @param {{ retryAfterMs?: number, closeCode?: number }} [detail] */
  #setState(state, detail = {}) {
    const changed = state !== this.state;
    this.state = state;
    if (changed || detail.retryAfterMs != null) this.#emit('state', state, detail);
  }

  get online() {
    return this.state === 'online';
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#connect();
  }

  stop() {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#drop('stop');
  }

  /** Drop the current socket now and reconnect (used by the liveness check and on page resume). */
  reconnectNow() {
    if (!this.#running || this.state === 'replaced') return;
    this.#drop('reconnect');
    clearTimeout(this.#timer);
    this.#connect();
  }

  /** After 'replaced': explicitly take the session back (the other tab then gets 4001 itself). */
  takeOver() {
    if (!this.#running || this.state !== 'replaced') return;
    this.backoff.reset();
    this.#drop('takeover');
    clearTimeout(this.#timer);
    this.#connect();
  }

  /** @param {string} op @param {object} [args] @param {{ reqId?: string, timeoutMs?: number }} [opts] @returns {Promise<any>} */
  request(op, args = {}, opts = {}) {
    if (!this.#client || this.state !== 'online') {
      return Promise.reject(new ProtocolError(op, { code: 'CLOSED', message: 'not connected' }, { local: true }));
    }
    return this.#client.request(op, args, opts);
  }

  #connect() {
    if (!this.#running) return;
    const token = ++this.#token;
    if (this.state !== 'busy' && this.state !== 'unsupported') this.#setState(this.everOnline ? 'offline' : 'connecting');
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch {
      this.#scheduleReconnect(token);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    const openTimer = setTimeout(() => { if (token === this.#token && !this.#client) this.#fail(token); }, this.connectTimeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(openTimer);
      if (token !== this.#token) return;
      const client = new ControlClient(ws, {
        onEvent: (name, data) => this.#onEvent(name, data),
        onClose: (info) => { if (token === this.#token) this.#closed(token, info); },
      });
      this.#client = client;
      this.#hello(token, client);
    });
    ws.addEventListener('error', () => { clearTimeout(openTimer); if (token === this.#token && !this.#client) this.#fail(token); });
    ws.addEventListener('close', () => { clearTimeout(openTimer); if (token === this.#token && !this.#client) this.#fail(token); });
  }

  /** @param {number} token @param {ControlClient} client */
  async #hello(token, client) {
    try {
      const data = await client.request('hello', {
        clientId: this.clientId,
        protocolVersions: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
        appVersion: this.appVersion,
        platform: this.platform,
      }, { timeoutMs: this.connectTimeoutMs });
      if (token !== this.#token) return;
      this.session = data;
      this.capabilities = data.capabilities ?? {};
      this.controls = data.controls ?? null;
      this.status = data.status ?? null;
      this.everOnline = true;
      this.backoff.reset();
      this.#lastPong = performance.now();
      this.#startPing(token, client);
      this.#setState('online');
      this.#emit('session', data);
      if (this.controls) this.#emit('controls', this.controls);
      if (this.status) this.#emit('status', this.status);
    } catch (err) {
      if (token !== this.#token) return;
      const e = /** @type {ProtocolError} */ (err);
      if (e.code === 'BUSY') {
        const wait = Math.max(500, Number(e.retryAfterMs) || 2000);
        this.#drop('busy');
        this.#setState('busy', { retryAfterMs: wait });
        this.#timer = setTimeout(() => this.#connect(), wait);
      } else if (e.code === 'UNSUPPORTED_VERSION') {
        this.#drop('unsupported');
        this.#setState('unsupported');
        this.#timer = setTimeout(() => this.#connect(), 10_000);
      } else {
        this.#fail(token);
      }
    }
  }

  /** @param {number} token @param {ControlClient} client */
  #startPing(token, client) {
    clearInterval(this.#pingTimer);
    this.#pingTimer = setInterval(() => {
      if (token !== this.#token) return;
      if (performance.now() - this.#lastPong > this.offlineAfterMs) {
        this.#fail(token);
        return;
      }
      client.request('ping', {}, { timeoutMs: this.offlineAfterMs }).then(
        () => { if (token === this.#token) this.#lastPong = performance.now(); },
        () => {},
      );
    }, this.pingIntervalMs);
  }

  /** @param {string} name @param {any} data */
  #onEvent(name, data) {
    if (name === 'controls') {
      this.controls = data;
      this.#emit('controls', data);
    } else if (name === 'status') {
      this.status = data;
      this.#emit('status', data);
    }
    this.#emit('event', name, data);
  }

  /** @param {number} token @param {CloseInfo} info */
  #closed(token, info) {
    if (!info?.byClient && closeAction(info?.code) === 'stop') {
      this.#drop('replaced');
      clearTimeout(this.#timer);
      this.#setState('replaced', { closeCode: info.code });
      return;
    }
    this.#fail(token);
  }

  /** The current socket failed: drop it, go offline, reconnect after a backoff delay. */
  /** @param {number} token */
  #fail(token) {
    if (token !== this.#token) return;
    this.#drop('fail');
    if (!this.#running) return;
    this.#setState(this.everOnline ? 'offline' : 'connecting');
    this.#scheduleReconnect(this.#token);
  }

  /** @param {number} token */
  #scheduleReconnect(token) {
    if (token !== this.#token || !this.#running) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), this.backoff.next());
  }

  /** @param {string} [_why] */
  #drop(_why) {
    this.#token++;
    clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    const client = this.#client;
    const ws = this.#ws;
    this.#client = null;
    this.#ws = null;
    if (client) client.abort();
    else if (ws) {
      try { ws.close(); } catch { /* not open yet */ }
    }
  }
}
