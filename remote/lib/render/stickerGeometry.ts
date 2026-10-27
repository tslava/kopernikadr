/**
 * Sticker transform math (plan "One renderer"). Pure, no canvas: normalized frame coordinates
 * <-> pixels of whatever canvas is drawing (1440x1080 export, the CSS-sized stage), hit-testing
 * and the corner-handle drag. A sticker is a square of `size * width` px centred on (x, y).
 * Rotation is in degrees, clockwise (the canvas y axis points down).
 */
import { STICKER_SIZE_MAX, STICKER_SIZE_MIN, type Sticker } from '../projects/model';

export interface Pt {
  x: number;
  y: number;
}

export interface StickerBox {
  /** Centre in px. */
  cx: number;
  cy: number;
  /** Side of the square in px. */
  side: number;
  rot: number;
}

type Geo = Pick<Sticker, 'x' | 'y' | 'size' | 'rot'>;

/** Degrees folded into -180..180 (180 maps to -180). */
export function normalizeRot(deg: number): number {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === 0 ? 0 : r; // no -0
}

export function stickerBox(s: Geo, width: number, height: number): StickerBox {
  return { cx: s.x * width, cy: s.y * height, side: s.size * width, rot: s.rot };
}

/** Rotates `p` about the origin by `deg` degrees (clockwise on screen). */
function rotate(p: Pt, deg: number): Pt {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Is the px point inside the (rotated) sticker square? */
export function hitTest(s: Geo, p: Pt, width: number, height: number): boolean {
  const b = stickerBox(s, width, height);
  const local = rotate({ x: p.x - b.cx, y: p.y - b.cy }, -b.rot);
  const h = b.side / 2;
  return Math.abs(local.x) <= h && Math.abs(local.y) <= h;
}

/** The topmost sticker (last in array order) under the point, or null. */
export function hitTopSticker(stickers: readonly Sticker[], p: Pt, width: number, height: number): Sticker | null {
  for (let i = stickers.length - 1; i >= 0; i--) {
    if (hitTest(stickers[i]!, p, width, height)) return stickers[i]!;
  }
  return null;
}

/** Where the scale/rotate handle sits: the bottom-right corner of the rotated square, in px. */
export function handlePoint(s: Geo, width: number, height: number): Pt {
  const b = stickerBox(s, width, height);
  const d = rotate({ x: b.side / 2, y: b.side / 2 }, b.rot);
  return { x: b.cx + d.x, y: b.cy + d.y };
}

/**
 * Dragging the corner handle to `p` scales and rotates together: the handle stays under the
 * finger. Size is clamped to the model range; rotation to -180..180.
 */
export function dragHandle(s: Geo, p: Pt, width: number, height: number): { size: number; rot: number } {
  const b = stickerBox(s, width, height);
  const dx = p.x - b.cx;
  const dy = p.y - b.cy;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { size: s.size, rot: s.rot }; // no direction: keep the pose
  const size = Math.min(STICKER_SIZE_MAX, Math.max(STICKER_SIZE_MIN, (dist * Math.SQRT2) / width));
  const rot = normalizeRot((Math.atan2(dy, dx) * 180) / Math.PI - 45);
  return { size, rot };
}
