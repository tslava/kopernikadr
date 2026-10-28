/**
 * Sticker styling as pure functions over `{width, height, data}` (RGBA, straight alpha), so every
 * step runs on synthetic images in vitest and gives the same pixels in playback and export.
 * The native side only returns the photo and a raw uint8 confidence mask (`w*h`, confidence x 255);
 * the cut-out, trim, outline, shadow and comic look are all made here. Output is a square, at most
 * `MAX_STICKER_PX`, plus a `THUMB_PX` thumbnail for the "Moje" tiles.
 */

export interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export const MAX_STICKER_PX = 1024;
export const THUMB_PX = 160;
/** Mask confidence below this is background. */
export const MASK_THRESHOLD = 0.15;

export type StickerStyle = 'naklejka' | 'komiks';

const blank = (width: number, height: number): Img => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });

/** Source-over of `src` onto `dst` with `src`'s top-left at (ox, oy); mutates `dst`. */
function compositeOver(dst: Img, src: Img, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const sa = src.data[s + 3] / 255;
      if (sa === 0) continue;
      const d = (dy * dst.width + dx) * 4;
      const da = dst.data[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) dst.data[d + c] = (src.data[s + c] * sa + dst.data[d + c] * da * (1 - sa)) / oa;
      dst.data[d + 3] = oa * 255;
    }
  }
}

/**
 * Alpha from a uint8 confidence mask (`maskW` x `maskH`, nearest-neighbour when the size differs from
 * the image). Confidence under `threshold` clears the pixel. Returns null when nothing is left.
 */
export function cutout(image: Img, mask: ArrayLike<number>, maskW: number, maskH: number, threshold: number = MASK_THRESHOLD): Img | null {
  const { width: w, height: h } = image;
  const out = { width: w, height: h, data: new Uint8ClampedArray(image.data) };
  const min = threshold * 255;
  let any = false;
  for (let y = 0; y < h; y++) {
    const my = Math.min(maskH - 1, Math.floor((y * maskH) / h));
    for (let x = 0; x < w; x++) {
      const mx = Math.min(maskW - 1, Math.floor((x * maskW) / w));
      const m = mask[my * maskW + mx];
      const i = (y * w + x) * 4;
      if (m < min) out.data[i + 3] = 0;
      else {
        out.data[i + 3] = m; // the mask is the alpha: soft edges stay soft
        any = true;
      }
    }
  }
  return any ? out : null;
}

/** Crops to the bounding box of every pixel with alpha > 0, plus `pad` transparent pixels. Null if empty. */
export function trimToContent(img: Img, pad: number = 0): Img | null {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const out = blank(x1 - x0 + 1 + pad * 2, y1 - y0 + 1 + pad * 2);
  for (let y = y0; y <= y1; y++) {
    const from = (y * img.width + x0) * 4;
    out.data.set(img.data.subarray(from, from + (x1 - x0 + 1) * 4), ((y - y0 + pad) * out.width + pad) * 4);
  }
  return out;
}

/** Centres the image on a transparent square of the longer side. */
export function padSquare(img: Img): Img {
  if (img.width === img.height) return img;
  const side = Math.max(img.width, img.height);
  const out = blank(side, side);
  compositeOver(out, img, Math.floor((side - img.width) / 2), Math.floor((side - img.height) / 2));
  return out;
}

/** Two-pass chamfer distance (pixels) from each pixel to the nearest pixel with alpha >= `cutoff`. */
export function distanceToInside(img: Img, cutoff: number = 128): Float32Array {
  const { width: w, height: h } = img;
  const inf = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = img.data[i * 4 + 3] >= cutoff ? 0 : inf;
  const dg = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + dg);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + dg);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + dg);
        if (x > 0) v = Math.min(v, d[i + w - 1] + dg);
      }
      d[i] = v;
    }
  }
  return d;
}

/** A solid `color` border `radiusPx` wide around the shape (grows the canvas by the radius), the shape on top. */
export function outline(img: Img, opts: { radiusPx: number; color: [number, number, number] }): Img {
  const r = Math.max(1, Math.round(opts.radiusPx));
  const pad = r + 1;
  const big = blank(img.width + pad * 2, img.height + pad * 2);
  compositeOver(big, img, pad, pad);
  const dist = distanceToInside(big);
  const out = blank(big.width, big.height);
  for (let i = 0; i < dist.length; i++) {
    const a = Math.max(0, Math.min(1, r + 0.5 - dist[i])); // 1 px of anti-aliasing at the rim
    if (a === 0) continue;
    out.data[i * 4] = opts.color[0];
    out.data[i * 4 + 1] = opts.color[1];
    out.data[i * 4 + 2] = opts.color[2];
    out.data[i * 4 + 3] = a * 255;
  }
  compositeOver(out, big, 0, 0);
  return out;
}

/** A translucent black copy of the silhouette, offset by (dx, dy) and blurred, under the image (grows the canvas). */
export function shadow(img: Img, opts: { dx: number; dy: number; alpha: number; blurPx: number }): Img {
  const blur = Math.max(0, Math.round(opts.blurPx));
  // two box-blur passes spread the shadow 2 * blur px beyond the offset silhouette; +1 so the last
  // (faintest) pixel is not on the canvas edge
  const reach = blur > 0 ? 2 * blur + 1 : 0;
  const padL = Math.max(0, reach - opts.dx), padR = Math.max(0, reach + opts.dx);
  const padT = Math.max(0, reach - opts.dy), padB = Math.max(0, reach + opts.dy);
  const out = blank(img.width + padL + padR, img.height + padT + padB);
  const w = out.width, h = out.height;
  let a: Float32Array = new Float32Array(w * h);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      a[(y + padT + opts.dy) * w + x + padL + opts.dx] = img.data[(y * img.width + x) * 4 + 3] / 255;
    }
  }
  if (blur > 0) a = boxBlur(boxBlur(a, w, h, blur), w, h, blur);
  for (let i = 0; i < a.length; i++) out.data[i * 4 + 3] = a[i] * opts.alpha * 255;
  compositeOver(out, img, padL, padT);
  return out;
}

/** Separable box blur of a float plane, radius r (outside the plane counts as zero). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) sum += src[y * w + x];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      const add = x + r + 1, del = x - r;
      if (add < w) sum += src[y * w + add];
      if (del >= 0) sum -= src[y * w + del];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      const add = y + r + 1, del = y - r;
      if (add < h) sum += tmp[add * w + x];
      if (del >= 0) sum -= tmp[del * w + x];
    }
  }
  return out;
}

/** RGB (0..255) -> [h 0..360, s 0..1, v 0..1]. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h * 60, max === 0 ? 0 : d / max, max / 255];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
}

/** Gradients weaker than this (Sobel of a 0..255 luminance, a full black/white step is ~1020) are never lines. */
const EDGE_FLOOR = 90;
/** Share of opaque pixels allowed to become line: only the strongest edges. */
const EDGE_SHARE = 0.06;
const SATURATION_BOOST = 1.2;

/**
 * Cartoon look: hue is kept, brightness is posterized to `levels` steps and saturation is lifted a
 * little (so the object stays the same colour, only flatter). A dark line (`edgePx` thick) is drawn on
 * the strongest edges of the *smoothed* luminance (Sobel; blur radius ~1.5% of the side kills fabric
 * texture and noise, and only the top ~6% of gradients count). The silhouette edge is left to `outline`.
 * `edgeThreshold` overrides the adaptive threshold (absolute Sobel magnitude).
 */
export function comic(img: Img, opts: { levels: number; edgePx: number; edgeThreshold?: number }): Img {
  const { width: w, height: h } = img;
  const levels = Math.max(2, Math.round(opts.levels));
  const out: Img = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  // posterize a lightly smoothed copy (alpha-weighted), so fabric speckle does not become confetti
  const soft = Math.max(1, Math.round(Math.max(w, h) * 0.006));
  const wgt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) wgt[i] = img.data[i * 4 + 3] / 255;
  const bw = boxBlur(boxBlur(wgt, w, h, soft), w, h, soft);
  const chan: Float32Array[] = [0, 1, 2].map((c) => {
    const p = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) p[i] = img.data[i * 4 + c] * wgt[i];
    return boxBlur(boxBlur(p, w, h, soft), w, h, soft);
  });
  for (let i = 0; i < w * h; i++) {
    const k = bw[i] > 1e-3 ? 1 / bw[i] : 0;
    const [hue, sat, val] = rgbToHsv(chan[0][i] * k, chan[1][i] * k, chan[2][i] * k);
    const q = Math.round(val * (levels - 1)) / (levels - 1);
    const rgb = hsvToRgb(hue, Math.min(1, sat * SATURATION_BOOST), q);
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = rgb[c];
  }
  // alpha-weighted luminance, blurred: transparent pixels (colour 0) do not pull the silhouette dark
  const radius = Math.max(1, Math.round(Math.max(w, h) * 0.015));
  const lum = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = img.data[i * 4 + 3] / 255;
    alpha[i] = a;
    lum[i] = (0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]) * a;
  }
  const bl = boxBlur(boxBlur(lum, w, h, radius), w, h, radius);
  const ba = boxBlur(boxBlur(alpha, w, h, radius), w, h, radius);
  for (let i = 0; i < w * h; i++) bl[i] = ba[i] > 1e-3 ? bl[i] / ba[i] : 0;
  const at = (x: number, y: number): number => bl[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  const mag = new Float32Array(w * h);
  const values: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (img.data[(y * w + x) * 4 + 3] < 128) continue;
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const m = Math.hypot(gx, gy);
      mag[y * w + x] = m;
      values.push(m);
    }
  }
  let thr = opts.edgeThreshold ?? EDGE_FLOOR;
  if (opts.edgeThreshold === undefined && values.length > 0) {
    values.sort((a, b) => a - b);
    thr = Math.max(EDGE_FLOOR, values[Math.min(values.length - 1, Math.floor(values.length * (1 - EDGE_SHARE)))]);
  }
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mag[i] >= thr && mag[i] > 0) edge[i] = 1;
  const grow = Math.max(0, Math.round(opts.edgePx) - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      for (let yy = Math.max(0, y - grow); yy <= Math.min(h - 1, y + grow); yy++) {
        for (let xx = Math.max(0, x - grow); xx <= Math.min(w - 1, x + grow); xx++) {
          const i = (yy * w + xx) * 4;
          if (out.data[i + 3] < 128) continue;
          out.data[i] = out.data[i + 1] = out.data[i + 2] = 30;
        }
      }
    }
  }
  return out;
}

/** Area-average downscale so the longer side is at most `maxSide`; returns the input when already small. */
export function downscale(img: Img, maxSide: number): Img {
  const scale = maxSide / Math.max(img.width, img.height);
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * img.height) / h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.width) / w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const al = img.data[i + 3]; // colour is averaged alpha-weighted, so transparent pixels do not bleed in
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a;
      }
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

const dropShadow = (img: Img, side: number): Img =>
  shadow(img, { dx: Math.round(side * 0.012), dy: Math.round(side * 0.02), alpha: 0.35, blurPx: Math.max(1, Math.round(side * 0.012)) });

/** The "Naklejka" look: a white die-cut border (3% of the side) with a drop shadow. */
export function naklejka(img: Img): Img {
  const side = Math.max(img.width, img.height);
  return dropShadow(outline(img, { radiusPx: side * 0.03, color: [255, 255, 255] }), side);
}

/** The "Komiks" look: fewer colours, dark lines inside, a black border (2%) and the same shadow. */
export function komiks(img: Img): Img {
  const side = Math.max(img.width, img.height);
  const flat = comic(img, { levels: 5, edgePx: Math.max(1, Math.round(side * 0.002)) });
  return dropShadow(outline(flat, { radiusPx: side * 0.02, color: [20, 20, 20] }), side);
}

/**
 * Cut-out (or an already transparent picture) -> finished sticker: trimmed, styled, centred on a
 * square, at most `MAX_STICKER_PX`. Null when nothing is visible ("nothing cut").
 */
export function makeSticker(cut: Img, style: StickerStyle): Img | null {
  const trimmed = trimToContent(downscale(cut, MAX_STICKER_PX));
  if (!trimmed) return null;
  const styled = style === 'komiks' ? komiks(trimmed) : naklejka(trimmed);
  return downscale(padSquare(styled), MAX_STICKER_PX);
}

/** The small square for the "Moje" tiles. */
export function makeThumbnail(sticker: Img): Img {
  return downscale(sticker, THUMB_PX);
}

const STICKER_MIME = 'image/webp';
const STICKER_QUALITY = 0.92;

/**
 * The sticker and its `THUMB_PX` thumbnail as WebP in one go (browser only: OffscreenCanvas). The big
 * canvas is filled once; the thumbnail is the same canvas drawn scaled (native resampling, no JS
 * pixel loop) and both are encoded natively with `convertToBlob`, in parallel.
 * WebP, not PNG: the PNG encode took 4 s on the tablet (1024 px), WebP at 0.92 takes 0.3 s; it keeps alpha.
 */
export async function encodeStickerWebps(img: Img): Promise<{ webp: Blob; thumb: Blob }> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('stickerize: no 2d context');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const scale = Math.min(1, THUMB_PX / Math.max(img.width, img.height));
  const tw = Math.max(1, Math.round(img.width * scale)), th = Math.max(1, Math.round(img.height * scale));
  const small = new OffscreenCanvas(tw, th);
  const sctx = small.getContext('2d');
  if (!sctx) throw new Error('stickerize: no 2d context');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, tw, th);
  const opts = { type: STICKER_MIME, quality: STICKER_QUALITY };
  const [webp, thumb] = await Promise.all([canvas.convertToBlob(opts), small.convertToBlob(opts)]);
  return { webp, thumb };
}
