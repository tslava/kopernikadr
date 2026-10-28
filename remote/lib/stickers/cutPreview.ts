/** The cut-step preview: the cut-out on a checkerboard (CSS) with the rest of the photo dimmed. */
import { MASK_THRESHOLD, type Img } from './stickerize';

/** Fraction of mask pixels at or above the cut-out threshold. */
export function coverage(mask: ArrayLike<number>, threshold: number = MASK_THRESHOLD): number {
  if (mask.length === 0) return 0;
  const min = threshold * 255;
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= min) n++;
  return n / mask.length;
}

/**
 * The photo with alpha = the mask, and the pixels outside it kept at `dim` of their opacity, so over a
 * checkerboard the toy shows through at the soft edge and the rest is dimmed. A mask of another size
 * is sampled nearest-neighbour, like `cutout`.
 */
export function composePreview(photo: Img, mask: ArrayLike<number>, maskW: number, maskH: number, dim = 0.3): Img {
  const { width: w, height: h } = photo;
  const data = new Uint8ClampedArray(photo.data);
  const min = MASK_THRESHOLD * 255;
  for (let y = 0; y < h; y++) {
    const my = Math.min(maskH - 1, Math.floor((y * maskH) / h));
    for (let x = 0; x < w; x++) {
      const mx = Math.min(maskW - 1, Math.floor((x * maskW) / w));
      const raw = mask[my * maskW + mx];
      const m = raw < min ? 0 : raw / 255;
      data[(y * w + x) * 4 + 3] = 255 * Math.max(m, dim * (1 - m));
    }
  }
  return { width: w, height: h, data };
}
