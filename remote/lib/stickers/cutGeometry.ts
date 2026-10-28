/**
 * Pointer -> normalized image coordinates for the cut step. The picture is shown with
 * `object-fit: contain` inside a box, so the displayed image rect is smaller than the box on one
 * axis; strokes are normalized (0..1) to that rect, which is what the segmenter expects.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The rect an `imgW x imgH` picture occupies inside `box` with `object-fit: contain` (centered). */
export function containRect(box: Rect, imgW: number, imgH: number): Rect {
  if (imgW <= 0 || imgH <= 0 || box.w <= 0 || box.h <= 0) return { x: box.x, y: box.y, w: 0, h: 0 };
  const s = Math.min(box.w / imgW, box.h / imgH);
  const w = imgW * s;
  const h = imgH * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** A client point as a 0..1 point in `shown`. `clamp` pins an outside point to the edge, otherwise it is null. */
export function toNormalized(clientX: number, clientY: number, shown: Rect, clamp: boolean): [number, number] | null {
  if (shown.w <= 0 || shown.h <= 0) return null;
  const x = (clientX - shown.x) / shown.w;
  const y = (clientY - shown.y) / shown.h;
  const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (!inside && !clamp) return null;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}

/** Native limits (`SegStrokes`): at most this many strokes, and points per stroke. */
export const MAX_STROKES = 50;
export const MAX_POINTS = 2000;
/** A move shorter than this (fraction of the picture) adds no point: keeps strokes light. */
export const MIN_STEP = 0.008;

/** Appends `p` unless it is closer than [MIN_STEP] to the last point or the stroke is full. */
export function appendPoint(points: [number, number][], p: [number, number]): [number, number][] {
  const last = points[points.length - 1];
  if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_STEP) return points;
  if (points.length >= MAX_POINTS) return points;
  return [...points, p];
}
