// The export loop without the DOM: prepare every frame on the camera, then draw them one by one
// into a recording sink on the fps schedule. A frame that cannot be loaded aborts the export:
// the movie never silently repeats the previous picture in place of a missing one.

import { buildSchedule } from './video.js';
import { abortError, realClock, sleep, FrameLoadError } from './frame-loader.js';

/**
 * @param {object} o
 * @param {string[]} o.frameIds
 * @param {number} o.fps
 * @param {(frameId: string, opts: {signal: AbortSignal}) => Promise<{variant: string}>} o.prepare
 *   fetches a frame once so the camera has its variant ready (body discarded); rejects if it cannot
 * @param {(frameId: string, opts: {signal: AbortSignal, prefer: string}) => Promise<{value: {close?: Function}}>} o.load
 *   fetches and decodes a frame for drawing; rejects if it cannot
 * @param {{draw(pic): void, start(): void, requestFrame(): void, pause(): void, resume(): void,
 *          finish(): Promise<Blob>, cancel(): void}} o.sink  the canvas + MediaRecorder (or a fake)
 * @param {{now(): number, setTimeout: Function, clearTimeout: Function}} [o.clock]
 * @param {(p: {phase: 'prepare'|'record', i: number, n: number}) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{blob: Blob, frames: number, variants: string[]}>}
 * @throws {FrameLoadError} (code FRAME_LOAD_FAILED, `index`) when a frame cannot be loaded; AbortError on cancel
 */
export async function runExport({ frameIds, fps, prepare, load, sink, clock = realClock, onProgress, signal,
  ahead = 3, prepareConcurrency = 2 }) {
  const n = frameIds.length;
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal?.addEventListener('abort', onAbort);
  const checkAbort = () => { if (signal?.aborted) throw abortError(); };
  const fail = (i, e) => {
    if (e?.name === 'AbortError') return e;
    const err = e instanceof FrameLoadError ? e : new FrameLoadError(frameIds[i], e, 0);
    err.index = i;
    return err;
  };

  const variants = new Array(n).fill('play');
  const loads = new Map();
  const settled = new Set();
  let last = null;
  let finished = false;
  try {
    // 1. Prepare: the camera generates the `play` variants on demand; wait for each, a few at a time.
    let next = 0;
    let done = 0;
    onProgress?.({ phase: 'prepare', i: 0, n });
    const worker = async () => {
      while (next < n) {
        const i = next++;
        checkAbort();
        try {
          const r = await prepare(frameIds[i], { signal: inner.signal });
          if (r?.variant) variants[i] = r.variant;
        } catch (e) {
          throw fail(i, e);
        }
        onProgress?.({ phase: 'prepare', i: ++done, n });
      }
    };
    const workers = Array.from({ length: Math.min(prepareConcurrency, n) }, worker);
    try {
      await Promise.all(workers);
    } catch (e) {
      inner.abort();
      await Promise.allSettled(workers);
      throw e;
    }
    checkAbort();

    // 2. Record.
    const startLoad = (i) => {
      if (i >= n || loads.has(i)) return;
      const p = load(frameIds[i], { signal: inner.signal, prefer: variants[i] });
      p.then(() => settled.add(i), () => settled.add(i)); // also marks a rejection as handled
      loads.set(i, p);
    };
    const take = async (i) => {
      try {
        const r = await loads.get(i);
        loads.delete(i);
        return r.value;
      } catch (e) {
        loads.delete(i);
        throw fail(i, e);
      }
    };

    const { steps } = buildSchedule(frameIds, fps);
    for (let i = 0; i <= ahead; i++) startLoad(i);
    // The first picture is on the canvas before the recorder starts: no black opening frame,
    // and the clock starts with it, not with its download.
    const first = await take(0);
    checkAbort();
    sink.draw(first);
    last = first;
    sink.start();
    let drawn = 0;
    let t = clock.now();
    for (let s = 0; s < steps.length; s++) {
      checkAbort();
      const step = steps[s];
      if (!step.extra) {
        let pic = first;
        if (s > 0) {
          if (!settled.has(s)) {
            // A late download must not stretch the previous picture: the paused time is not recorded.
            sink.pause();
            try {
              pic = await take(s);
            } finally {
              sink.resume();
            }
            t = clock.now();
          } else {
            pic = await take(s);
          }
          if (signal?.aborted) {
            pic?.close?.();
            throw abortError();
          }
          sink.draw(pic);
          if (last !== pic) last?.close?.();
          last = pic;
        }
        startLoad(s + ahead + 1);
        drawn++;
      } else {
        // An unchanged canvas emits no frame on requestFrame(): redraw so the last picture is held.
        sink.draw(last);
      }
      sink.requestFrame();
      onProgress?.({ phase: 'record', i: Math.min(s + 1, n), n });
      t += step.holdMs;
      await sleep(Math.max(0, t - clock.now()), { clock, signal });
    }
    if (drawn !== n) throw new Error(`export drew ${drawn} of ${n} frames`);
    finished = true;
    const blob = await sink.finish();
    return { blob, frames: drawn, variants };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    inner.abort();
    last?.close?.();
    for (const p of loads.values()) p.then((r) => r?.value?.close?.(), () => {});
    if (!finished) sink.cancel();
  }
}
