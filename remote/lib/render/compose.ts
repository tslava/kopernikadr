/**
 * The one renderer (plan "One renderer"): two passes over a minimal 2D context, used by the stage
 * (frame canvas by the player, sticker canvas redrawn on its own) and by the export (both on one
 * OffscreenCanvas). `drawStickers` does not clear: the stage clears its sticker canvas first.
 */
import { isCustomSticker, type Sticker } from '../projects/model';
import { stickerBox } from './stickerGeometry';

/** What the passes need from a CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D. */
export interface Ctx2D {
  readonly canvas: { readonly width: number; readonly height: number };
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  // the placeholder of a missing custom sticker (stage only); a context without them draws nothing for it
  strokeStyle?: unknown;
  lineWidth?: number;
  font?: string;
  textAlign?: string;
  textBaseline?: string;
  beginPath?(): void;
  roundRect?(x: number, y: number, w: number, h: number, r: number): void;
  fill?(): void;
  stroke?(): void;
  setLineDash?(segments: number[]): void;
  fillText?(text: string, x: number, y: number): void;
}

/** What to paint for a sticker: its sprite, the "?" placeholder (a custom sticker whose picture failed to load), or nothing. */
export type StickerPaint = 'draw' | 'placeholder' | 'skip';

/** `failed` = the sprite load was tried and failed. Unknown OpenMoji hexcodes stay skipped. */
export function stickerPaint(emoji: string, loaded: boolean, failed: boolean): StickerPaint {
  if (loaded) return 'draw';
  return failed && isCustomSticker(emoji) ? 'placeholder' : 'skip';
}

/** A light translucent rounded square with a dashed outline and a "?", centred on the origin. */
export function drawPlaceholder(ctx: Ctx2D, side: number): void {
  const r = side * 0.18;
  const half = side / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.strokeStyle = 'rgba(60,60,80,0.8)';
  ctx.lineWidth = Math.max(2, side * 0.035);
  ctx.setLineDash?.([side * 0.1, side * 0.07]);
  ctx.beginPath?.();
  ctx.roundRect?.(-half, -half, side, side, r);
  ctx.fill?.();
  ctx.stroke?.();
  ctx.setLineDash?.([]);
  ctx.fillStyle = 'rgba(60,60,80,0.9)';
  ctx.font = `bold ${Math.round(side * 0.6)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText?.('?', 0, side * 0.04);
}

/** Sprite bitmap for a hexcode at the caller's bucket, or undefined (not loaded / unknown emoji). */
export type SpriteLookup = (hexcode: string) => ImageBitmap | undefined;

/** Draws the frame contained in the canvas, centred; black bars when the aspect differs. */
export function drawFrame(ctx: Ctx2D, bitmap: ImageBitmap): void {
  const { width: cw, height: ch } = ctx.canvas;
  const scale = Math.min(cw / bitmap.width, ch / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  if (w < cw || h < ch) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.drawImage(bitmap, (cw - w) / 2, (ch - h) / 2, w, h);
}

/** Draws the stickers shown on `entryId`, in array order (last on top). Missing sprites are skipped. */
export function drawStickers(
  ctx: Ctx2D,
  stickers: readonly Sticker[],
  entryId: string | null,
  sprite: SpriteLookup,
  /** Stage only: true when this sprite's load failed, so a custom one gets the placeholder (the export fails loudly instead). */
  failed?: (emoji: string) => boolean,
): void {
  if (entryId === null) return;
  const { width, height } = ctx.canvas;
  for (const s of stickers) {
    if (!s.on.includes(entryId)) continue;
    const bmp = sprite(s.emoji);
    const paint = stickerPaint(s.emoji, !!bmp, failed?.(s.emoji) ?? false);
    if (paint === 'skip') continue;
    const b = stickerBox(s, width, height);
    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.rotate((b.rot * Math.PI) / 180);
    if (bmp) ctx.drawImage(bmp, -b.side / 2, -b.side / 2, b.side, b.side);
    else drawPlaceholder(ctx, b.side);
    ctx.restore();
  }
}
