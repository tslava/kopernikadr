/**
 * The one renderer (plan "One renderer"): two passes over a minimal 2D context, used by the stage
 * (frame canvas by the player, sticker canvas redrawn on its own) and by the export (both on one
 * OffscreenCanvas). `drawStickers` does not clear: the stage clears its sticker canvas first.
 */
import type { Sticker } from '../projects/model';
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
export function drawStickers(ctx: Ctx2D, stickers: readonly Sticker[], entryId: string | null, sprite: SpriteLookup): void {
  if (entryId === null) return;
  const { width, height } = ctx.canvas;
  for (const s of stickers) {
    if (!s.on.includes(entryId)) continue;
    const bmp = sprite(s.emoji);
    if (!bmp) continue;
    const b = stickerBox(s, width, height);
    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.rotate((b.rot * Math.PI) / 180);
    ctx.drawImage(bmp, -b.side / 2, -b.side / 2, b.side, b.side);
    ctx.restore();
  }
}
