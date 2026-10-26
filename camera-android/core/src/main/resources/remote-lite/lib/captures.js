// Outstanding captures (PROTOCOL.md §6 capture/getOperation, §8). Every capture is recorded by its
// reqId before it is sent and stays recorded until the camera gives a terminal answer for THAT
// reqId (a FrameInfo, failed, unknown). Lost answers, timeouts and reconnects only keep it waiting;
// it is resolved with getOperation, never re-sent. No DOM: storage, request and timers are injected.

export const OUTSTANDING_KEY = 'kopernikadr.remoteLite.outstanding';

/** Error codes after which the camera may still hold (or be taking) the photo for this reqId. */
const UNCERTAIN_CODES = new Set(['CAPTURE_IN_PROGRESS', 'LEASE_LOST', 'INTERNAL', 'UNKNOWN']);

/**
 * The outstanding records, by reqId, written through to storage on every change.
 * Record: {reqId, projectId, rotation, cameraId, at, dismissed?}
 */
export class OutstandingStore {
  #map = new Map();

  constructor(storage, key = OUTSTANDING_KEY) {
    this.storage = storage;
    this.key = key;
    let raw = null;
    try {
      raw = JSON.parse(storage?.getItem(key));
    } catch {
      raw = null;
    }
    // an older page kept a single record under the same key
    const records = raw && typeof raw.reqId === 'string' ? [raw] : raw && typeof raw === 'object' ? Object.values(raw) : [];
    for (const r of records) if (r && typeof r.reqId === 'string') this.#map.set(r.reqId, r);
  }

  #save() {
    try {
      if (this.#map.size) this.storage?.setItem(this.key, JSON.stringify(Object.fromEntries(this.#map)));
      else this.storage?.removeItem?.(this.key);
    } catch {
      // storage full or blocked: the in-memory map still works for this page
    }
  }

  get size() {
    return this.#map.size;
  }

  /** Oldest first. */
  list() {
    return [...this.#map.values()].sort((a, b) => a.at - b.at);
  }

  get(reqId) {
    return this.#map.get(reqId) ?? null;
  }

  add(rec) {
    this.#map.set(rec.reqId, { ...rec });
    this.#save();
  }

  update(reqId, patch) {
    const r = this.#map.get(reqId);
    if (!r) return false;
    Object.assign(r, patch);
    this.#save();
    return true;
  }

  /** Removes exactly this reqId; other outstanding captures are untouched. */
  remove(reqId) {
    const had = this.#map.delete(reqId);
    if (had) this.#save();
    return had;
  }
}

/**
 * Sends captures and reconciles the outstanding ones.
 * - `busy`: an unresolved capture for this camera blocks the Capture button;
 * - `stuck`: it has been unresolved for `stuckAfterMs`; `dismiss()` then re-enables the button
 *   (the record stays and keeps being reconciled — nothing is retaken automatically).
 * Callbacks: onFrame(frameInfo, rec, {direct}), onFailed(rec, error), onChange().
 */
export class CaptureTracker {
  #timer = null;
  #checking = new Set();

  constructor({ store, request, isOnline = () => true, newId, onFrame, onFailed, onChange, now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
    captureTimeoutMs = 10_000, opTimeoutMs = 4000, stuckAfterMs = 60_000, pollFastMs = 1000, pollSlowMs = 5000, fastForMs = 15_000 }) {
    Object.assign(this, { store, request, isOnline, newId, onFrame, onFailed, onChange, now, setTimer, clearTimer,
      captureTimeoutMs, opTimeoutMs, stuckAfterMs, pollFastMs, pollSlowMs, fastForMs });
    this.cameraId = null;
  }

  /** Records this camera can resolve (a record bound to another camera waits for that one). */
  relevant() {
    return this.store.list().filter((r) => r.cameraId == null || this.cameraId == null || r.cameraId === this.cameraId);
  }

  #blocking() {
    return this.relevant().filter((r) => !r.dismissed);
  }

  get busy() {
    return this.#blocking().length > 0;
  }

  /** ms the oldest blocking capture has been waiting, or 0. */
  get waitingMs() {
    const b = this.#blocking();
    return b.length ? Math.max(0, this.now() - b[0].at) : 0;
  }

  get stuck() {
    return this.busy && this.waitingMs >= this.stuckAfterMs;
  }

  /** "Spróbuj ponownie": stop blocking the button; the records are still reconciled. */
  dismiss() {
    for (const r of this.#blocking()) this.store.update(r.reqId, { dismissed: true });
    this.onChange?.();
  }

  /**
   * Takes a photo. The record is stored before the request is sent.
   * @returns {Promise<{kind: 'done'|'failed'|'pending'|'blocked', frame?: object, error?: object}>}
   */
  async capture({ projectId, rotation }) {
    if (this.busy) return { kind: 'blocked' };
    const rec = { reqId: this.newId(), projectId, rotation, cameraId: this.cameraId, at: this.now() };
    this.store.add(rec);
    this.onChange?.();
    try {
      const info = await this.request('capture', { projectId, rotation }, { reqId: rec.reqId, timeoutMs: this.captureTimeoutMs });
      this.#done(rec.reqId, info, true);
      return { kind: 'done', frame: info };
    } catch (e) {
      if (e?.local || UNCERTAIN_CODES.has(e?.code)) {
        // No answer (timeout, socket closed) or an answer that does not settle THIS reqId:
        // keep the record and ask the camera what became of it.
        const state = this.isOnline() ? await this.check(rec.reqId, { report: false }) : 'unreachable';
        this.#schedule();
        if (state === 'done') return { kind: 'done', frame: this.lastResolved };
        if (state === 'failed' || state === 'unknown' || state === 'unsupported') return { kind: 'failed', error: e };
        return { kind: 'pending', error: e };
      }
      // The camera answered with an error: per §6 nothing was committed for this reqId.
      this.store.remove(rec.reqId);
      this.onChange?.();
      return { kind: 'failed', error: e };
    }
  }

  /**
   * One getOperation for `reqId`. Terminal answers remove the record; pending/unreachable keep it.
   * `report: false` skips onFailed (the caller reports the failure itself).
   * @returns {Promise<'done'|'pending'|'failed'|'unknown'|'unsupported'|'unreachable'|'busy'>}
   */
  async check(reqId, { report = true } = {}) {
    if (!this.store.get(reqId)) return 'unknown';
    if (this.#checking.has(reqId)) return 'busy';
    this.#checking.add(reqId);
    try {
      let r;
      try {
        r = await this.request('getOperation', { reqId }, { timeoutMs: this.opTimeoutMs });
      } catch (e) {
        if (e?.code === 'UNKNOWN_OP') {
          // a camera without getOperation: listFrames still brings the frame in
          this.#resolve(reqId);
          return 'unsupported';
        }
        return 'unreachable';
      }
      if (r?.state === 'done' && r.result) {
        this.#done(reqId, r.result, false);
        return 'done';
      }
      if (r?.state === 'failed' || r?.state === 'unknown') {
        const rec = this.store.get(reqId);
        this.#resolve(reqId);
        if (rec && report) this.onFailed?.(rec, r.error ?? { code: r.state.toUpperCase() });
        return r.state;
      }
      return 'pending';
    } finally {
      this.#checking.delete(reqId);
    }
  }

  /** After (re)connect and on each poll: one getOperation per relevant record, oldest first. */
  async reconcile() {
    this.#cancelTimer();
    for (const r of this.relevant()) {
      if (!this.isOnline()) break;
      await this.check(r.reqId);
    }
    this.onChange?.();
    this.#schedule();
  }

  stop() {
    this.#cancelTimer();
  }

  #done(reqId, info, direct) {
    const rec = this.store.get(reqId);
    this.lastResolved = info;
    this.#resolve(reqId);
    if (rec) this.onFrame?.(info, rec, { direct });
  }

  #resolve(reqId) {
    if (this.store.remove(reqId)) this.onChange?.();
  }

  #cancelTimer() {
    if (this.#timer != null) this.clearTimer(this.#timer);
    this.#timer = null;
  }

  /** Polls while something is outstanding and the camera is reachable; a reconnect calls reconcile(). */
  #schedule() {
    if (this.#timer != null) return;
    const recs = this.relevant();
    if (!recs.length || !this.isOnline()) return;
    const age = this.now() - recs[0].at;
    this.#timer = this.setTimer(() => {
      this.#timer = null;
      if (this.isOnline()) this.reconcile();
    }, age < this.fastForMs ? this.pollFastMs : this.pollSlowMs);
  }
}
