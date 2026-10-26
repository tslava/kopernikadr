// Pure helpers for playback and the MediaRecorder video export.

export const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

/** First candidate the browser can record, or '' if none. */
export function pickMimeType(isTypeSupported, candidates = MIME_CANDIDATES) {
  for (const m of candidates) {
    try {
      if (isTypeSupported(m)) return m;
    } catch {
      // treat as unsupported
    }
  }
  return '';
}

export function extensionFor(mime) {
  return /^video\/mp4/.test(mime) ? 'mp4' : 'webm';
}

export function formatLabel(mime) {
  const ext = extensionFor(mime).toUpperCase();
  const codec = /codecs=([^;]+)/.exec(mime)?.[1];
  return codec ? `${ext} (${codec})` : ext;
}

/** A file name safe on Android/Windows/macOS, keeping letters with diacritics. */
export function safeFileName(name, ext) {
  const base = String(name ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 80) || 'film';
  return `${base}.${ext}`;
}

/**
 * Recording schedule: each frame is drawn, `requestFrame()`d and held for 1000/fps ms; the last
 * frame is requested once more and held again so the recorder does not cut it.
 * @returns {{steps: {frameId: string, holdMs: number, extra: boolean}[], totalMs: number}}
 */
export function buildSchedule(frameIds, fps) {
  const holdMs = 1000 / fps;
  const steps = frameIds.map((frameId) => ({ frameId, holdMs, extra: false }));
  if (steps.length) steps.push({ frameId: frameIds[frameIds.length - 1], holdMs, extra: true });
  return { steps, totalMs: steps.length * holdMs };
}

/** Largest rect with the source aspect ratio centered in the destination ("contain"). */
export function fitRect(sw, sh, dw, dh) {
  if (!(sw > 0 && sh > 0)) return { x: 0, y: 0, w: dw, h: dh };
  const s = Math.min(dw / sw, dh / sh);
  const w = Math.round(sw * s);
  const h = Math.round(sh * s);
  return { x: Math.round((dw - w) / 2), y: Math.round((dh - h) / 2), w, h };
}

/** Indices a playback ring should hold: `size` frames starting at `index`, wrapping around. */
export function ringWindow(index, count, size) {
  if (count <= 0) return [];
  const n = Math.min(size, count);
  const out = [];
  for (let k = 0; k < n; k++) out.push((index + k) % count);
  return out;
}
