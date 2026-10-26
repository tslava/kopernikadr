// Preview pull loop (PROTOCOL.md §7): send {"t":"next"}, wait for one binary frame, hand it to
// `onFrame` (which draws it), then ask for the next one. Watchdog: no frame within 3 s of a
// `next`, or a frame that fails to parse/decode → close and reopen.

import { parsePreviewFrame } from './preview-frame.js';

export class PreviewLoop {
  #ws = null;
  #sessionId = null;
  #running = false;
  #watchdog = null;
  #reopenTimer = null;
  #token = 0;
  #failures = 0;

  /**
   * @param {{urlFor: (sessionId: string) => string, onFrame: (header: object, jpeg: Uint8Array) => Promise<void>|void,
   *          onError?: (e: Error) => void, WebSocketImpl?: any, watchdogMs?: number, reopenDelayMs?: number}} opts
   */
  constructor({ urlFor, onFrame, onError, WebSocketImpl = globalThis.WebSocket, watchdogMs = 3000, reopenDelayMs = 300 }) {
    Object.assign(this, { urlFor, onFrame, onError, WebSocketImpl, watchdogMs, reopenDelayMs });
    this.frames = 0;
    this.reopens = 0;
  }

  get running() {
    return this.#running;
  }

  /** A new session (after hello) or null (offline). The loop only runs with a session. */
  setSession(sessionId) {
    if (sessionId === this.#sessionId) return;
    this.#sessionId = sessionId;
    this.#close();
    this.#failures = 0;
    if (this.#running && sessionId) this.#open();
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    if (this.#sessionId) this.#open();
  }

  stop() {
    this.#running = false;
    this.#close();
  }

  #open() {
    const token = ++this.#token;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.urlFor(this.#sessionId));
    } catch (e) {
      this.onError?.(e);
      this.#reopenLater(token);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.addEventListener('open', () => { if (token === this.#token) this.#next(token); });
    ws.addEventListener('message', (e) => this.#onMessage(token, e.data));
    ws.addEventListener('close', (e) => {
      if (token !== this.#token) return;
      this.#ws = null;
      clearTimeout(this.#watchdog);
      // replaced / lease lost: wait for the control connection to bring a new session
      if (e.code === 4001 || e.code === 4002) return;
      this.#reopenLater(token);
    });
  }

  async #onMessage(token, data) {
    if (token !== this.#token || typeof data === 'string') return;
    clearTimeout(this.#watchdog);
    try {
      const { header, jpeg } = parsePreviewFrame(data);
      await this.onFrame(header, jpeg);
      this.frames++;
      this.#failures = 0;
    } catch (e) {
      this.onError?.(e);
      if (token === this.#token) this.#restart(token);
      return;
    }
    if (token === this.#token) this.#next(token);
  }

  #next(token) {
    const ws = this.#ws;
    if (!ws || token !== this.#token) return;
    try {
      ws.send('{"t":"next"}');
    } catch {
      this.#restart(token);
      return;
    }
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => this.#restart(token), this.watchdogMs);
  }

  #restart(token) {
    if (token !== this.#token) return;
    this.#close();
    this.#reopenLater(this.#token);
  }

  #reopenLater(token) {
    if (token !== this.#token || !this.#running || !this.#sessionId) return;
    clearTimeout(this.#reopenTimer);
    const delay = Math.min(2000, this.reopenDelayMs * 2 ** Math.min(this.#failures++, 3));
    this.#reopenTimer = setTimeout(() => {
      if (token !== this.#token || !this.#running || !this.#sessionId) return;
      this.reopens++;
      this.#open();
    }, delay);
  }

  #close() {
    this.#token++;
    clearTimeout(this.#watchdog);
    clearTimeout(this.#reopenTimer);
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try { ws.close(); } catch { /* not open yet */ }
    }
  }
}
