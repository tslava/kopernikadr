// Browser-only media: frame loading, looped playback on a canvas, and the MediaRecorder export.
// The retry policy lives in frame-loader.js, the export loop in export-core.js (both tested in Node).

import { fitRect, pickMimeType, ringWindow, extensionFor, safeFileName } from './video.js';
import { loadFrame, EXPORT_POLICY, VIEW_POLICY } from './frame-loader.js';
import { runExport } from './export-core.js';

/** Decodes a frame JPEG; a `full` fallback is scaled down to the `play` size while decoding. */
export function decodeFrame(blob, variant, size = { w: 1440, h: 1080 }) {
  return variant === 'full'
    ? createImageBitmap(blob, { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'high' })
    : createImageBitmap(blob);
}

/** Fetches and decodes a frame for display, retrying briefly (VIEW_POLICY). */
export async function loadFrameBitmap(urlFor, frameId, { signal, policy = VIEW_POLICY } = {}) {
  const r = await loadFrame(frameId, { urlFor, decode: decodeFrame, policy, signal });
  return r.value;
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
const RETRY_FAILED_MS = 2000;

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
    const now = performance.now();
    for (const [i, e] of this.#ring) {
      // out of the window, or failed a while ago (a just-captured frame may be ready by now)
      if (!want.has(i) || (e.failed && now - e.failedAt > RETRY_FAILED_MS)) {
        this.#dispose(e);
        this.#ring.delete(i);
      }
    }
    for (const i of want) {
      if (this.#ring.has(i)) continue;
      const e = { bmp: null, failed: false, failedAt: 0, cancelled: false, abort: new AbortController() };
      e.promise = loadFrameBitmap(this.urlFor, this.#frames[i], { signal: e.abort.signal }).then(
        (bmp) => { if (e.cancelled) bmp.close(); else e.bmp = bmp; },
        () => { e.failed = true; e.failedAt = performance.now(); },
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

  #dispose(e) {
    e.cancelled = true;
    e.abort.abort();
    e.bmp?.close();
  }

  #clearRing() {
    for (const e of this.#ring.values()) this.#dispose(e);
    this.#ring.clear();
  }
}

/** The recording sink of runExport: a canvas in the page, its captureStream(0) and a MediaRecorder. */
function canvasRecorder({ width, height, mime, MR }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'export-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  let track = null;
  let rec = null;
  let stopped = null;
  const chunks = [];
  const stopRec = () => {
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
  };
  return {
    draw: (pic) => drawContain(ctx, pic, width, height),
    // created once the first picture is on the canvas: the stream starts with the canvas as it is
    start() {
      const stream = canvas.captureStream(0);
      [track] = stream.getVideoTracks();
      rec = new MR(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      stopped = new Promise((resolve, reject) => {
        rec.onstop = resolve;
        rec.onerror = (e) => reject(e.error ?? new Error('MediaRecorder error'));
      });
      stopped.catch(() => {});
      rec.start(1000);
    },
    requestFrame: () => track.requestFrame(),
    pause: () => { if (rec.state === 'recording') rec.pause(); },
    resume: () => { if (rec.state === 'paused') rec.resume(); },
    async finish() {
      stopRec();
      await stopped;
      return new Blob(chunks, { type: mime.split(';')[0] });
    },
    cancel() {
      stopRec();
      chunks.length = 0;
    },
    dispose() {
      track?.stop();
      canvas.remove();
    },
  };
}

/**
 * Renders the frames at 1440×1080 and records them with MediaRecorder. First every frame is
 * fetched once (the camera may still be generating `play` variants), then recorded; a frame that
 * cannot be loaded after retries and the `full` fallback aborts with code FRAME_LOAD_FAILED and
 * no file. At most `ahead + 1` decoded pictures are alive at a time.
 * @param {{frameIds: string[], fps: number, name: string, urlFor: Function, signal?: AbortSignal,
 *          onProgress?: (p: {phase: 'prepare'|'record', i: number, n: number}) => void}} o
 * @returns {Promise<{blob: Blob, mime: string, fileName: string, frames: number}>}
 */
export async function exportVideo({ frameIds, fps, name, urlFor, onProgress, signal, width = 1440, height = 1080,
  policy = EXPORT_POLICY }) {
  const MR = globalThis.MediaRecorder;
  const mime = MR ? pickMimeType((m) => MR.isTypeSupported(m)) : '';
  if (!mime) throw Object.assign(new Error('MediaRecorder cannot record video here'), { code: 'UNSUPPORTED' });
  const onRetry = ({ frameId, variant, tries, error }) => console.warn(`export: frame ${frameId} ${variant} try ${tries}: ${error?.message}`);
  const sink = canvasRecorder({ width, height, mime, MR });
  try {
    const r = await runExport({
      frameIds, fps, signal, onProgress, sink,
      prepare: (id, o) => loadFrame(id, { urlFor, policy, onRetry, ...o }),
      load: (id, o) => loadFrame(id, { urlFor, policy, onRetry, decode: (b, v) => decodeFrame(b, v, { w: width, h: height }), ...o }),
    });
    return { blob: r.blob, mime, fileName: safeFileName(name, extensionFor(mime)), frames: r.frames };
  } finally {
    sink.dispose();
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
