// Browser-only media: frame loading, looped playback on a canvas, and the MediaRecorder export.

import { buildSchedule, fitRect, pickMimeType, ringWindow, extensionFor, safeFileName } from './video.js';

/** Fetches a frame variant and decodes it. Falls back to `full` (downscaled) when `play` is missing. */
export async function loadFrameBitmap(urlFor, frameId, { variant = 'play', resize = null, signal } = {}) {
  let res = await fetch(urlFor(frameId, variant), { signal });
  let fallback = false;
  if (!res.ok && variant === 'play') {
    res = await fetch(urlFor(frameId, 'full'), { signal });
    fallback = true;
  }
  if (!res.ok) throw new Error(`frame ${frameId}: HTTP ${res.status}`);
  const blob = await res.blob();
  const opts = fallback && resize ? { resizeWidth: resize.w, resizeHeight: resize.h, resizeQuality: 'high' } : undefined;
  return opts ? createImageBitmap(blob, opts) : createImageBitmap(blob);
}

export function drawContain(ctx, bmp, w, h) {
  const r = fitRect(bmp.width, bmp.height, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
}

/**
 * Looped playback: swaps frames on a timer, keeping a ring of at most `ringSize` decoded
 * ImageBitmaps ahead of the current frame (bounded memory for long movies).
 */
export class Player {
  #ring = new Map(); // index → {promise, bmp, failed}
  #timer = null;
  #playing = false;
  #index = 0;
  #frames = [];

  constructor({ canvas, urlFor, ringSize = 8, onIndex }) {
    Object.assign(this, { canvas, urlFor, ringSize, onIndex });
    this.ctx = canvas.getContext('2d');
    this.fps = 8;
  }

  get playing() {
    return this.#playing;
  }

  setFrames(frameIds) {
    this.#clearRing();
    this.#frames = frameIds.slice();
    this.#index = 0;
  }

  setFps(fps) {
    this.fps = fps;
  }

  play() {
    if (this.#playing || !this.#frames.length) return;
    this.#playing = true;
    this.#tick();
  }

  pause() {
    this.#playing = false;
    clearTimeout(this.#timer);
  }

  stop() {
    this.pause();
    this.#clearRing();
  }

  #ensureRing() {
    const want = new Set(ringWindow(this.#index, this.#frames.length, this.ringSize));
    for (const [i, e] of this.#ring) {
      if (!want.has(i)) {
        e.cancelled = true;
        e.bmp?.close();
        this.#ring.delete(i);
      }
    }
    for (const i of want) {
      if (this.#ring.has(i)) continue;
      const e = { bmp: null, failed: false, cancelled: false };
      e.promise = loadFrameBitmap(this.urlFor, this.#frames[i]).then(
        (bmp) => { if (e.cancelled) bmp.close(); else e.bmp = bmp; },
        () => { e.failed = true; },
      );
      this.#ring.set(i, e);
    }
  }

  #tick() {
    if (!this.#playing) return;
    const n = this.#frames.length;
    this.#ensureRing();
    const e = this.#ring.get(this.#index);
    if (e && !e.bmp && !e.failed) {
      // not decoded yet: wait instead of skipping
      this.#timer = setTimeout(() => this.#tick(), 15);
      return;
    }
    if (e?.bmp) {
      const { canvas, ctx } = this;
      if (canvas.width !== e.bmp.width || canvas.height !== e.bmp.height) {
        canvas.width = e.bmp.width;
        canvas.height = e.bmp.height;
      }
      ctx.drawImage(e.bmp, 0, 0);
    }
    this.onIndex?.(this.#index, n);
    this.#index = (this.#index + 1) % n;
    this.#timer = setTimeout(() => this.#tick(), 1000 / this.fps);
  }

  #clearRing() {
    for (const e of this.#ring.values()) {
      e.cancelled = true;
      e.bmp?.close();
    }
    this.#ring.clear();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Renders the frames at 1440×1080 onto a hidden canvas and records it with MediaRecorder.
 * At most 4 ImageBitmaps are alive (current + 3 prefetched); each is closed after drawing.
 * @returns {Promise<{blob: Blob, mime: string, fileName: string}>}
 */
export async function exportVideo({ frameIds, fps, name, urlFor, onProgress, signal, width = 1440, height = 1080 }) {
  const MR = globalThis.MediaRecorder;
  const mime = MR ? pickMimeType((m) => MR.isTypeSupported(m)) : '';
  if (!mime) throw Object.assign(new Error('MediaRecorder cannot record video here'), { code: 'UNSUPPORTED' });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'export-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  // Created once the first picture is on the canvas: the stream starts with the canvas as it is.
  let track = null;
  let rec = null;
  const chunks = [];

  const ahead = 3;
  const loads = new Map();
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort);
  const settled = new Set();
  const load = (i) => {
    if (i >= frameIds.length || loads.has(i)) return;
    const p = loadFrameBitmap(urlFor, frameIds[i], { resize: { w: width, h: height }, signal: abort.signal });
    p.then(() => settled.add(i), () => settled.add(i));
    loads.set(i, p);
  };

  const { steps } = buildSchedule(frameIds, fps);
  let last = null; // the picture on the canvas, kept to redraw it for the extra step
  try {
    for (let i = 0; i <= ahead; i++) load(i);
    // The clock starts with the first picture, not with its download; it is on the canvas before
    // the recorder starts, so the video does not open with the black canvas.
    const first = loads.has(0) ? await loads.get(0).catch(() => null) : null;
    if (first) drawContain(ctx, first, width, height);
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const stream = canvas.captureStream(0);
    [track] = stream.getVideoTracks();
    rec = new MR(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = (e) => reject(e.error ?? new Error('MediaRecorder error'));
    });
    rec.start(1000);
    let t = performance.now();
    for (let s = 0; s < steps.length; s++) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const step = steps[s];
      if (!step.extra) {
        if (!settled.has(s)) {
          // A late download must not stretch the previous picture: the paused time is not recorded.
          rec.pause();
          await loads.get(s).catch(() => null);
          rec.resume();
          t = performance.now();
        }
        // a frame that cannot be loaded keeps the previous picture on screen
        const bmp = await loads.get(s).catch(() => null);
        loads.delete(s);
        load(s + ahead + 1);
        if (signal?.aborted) {
          bmp?.close();
          throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        }
        if (bmp) {
          drawContain(ctx, bmp, width, height);
          last?.close();
          last = bmp;
        }
      } else if (last) {
        // An unchanged canvas emits no frame on requestFrame(): redraw so the last picture is held.
        drawContain(ctx, last, width, height);
      }
      track.requestFrame();
      onProgress?.(Math.min(s + 1, frameIds.length), frameIds.length);
      t += step.holdMs;
      await sleep(Math.max(0, t - performance.now()));
    }
    rec.stop();
    await stopped;
    const type = mime.split(';')[0];
    return { blob: new Blob(chunks, { type }), mime, fileName: safeFileName(name, extensionFor(mime)) };
  } finally {
    last?.close();
    signal?.removeEventListener('abort', onAbort);
    abort.abort();
    for (const p of loads.values()) p.then((b) => b.close(), () => {});
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
    track?.stop();
    canvas.remove();
  }
}

/** Saves a Blob through a temporary <a download>. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
