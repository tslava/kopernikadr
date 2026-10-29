import { describe, expect, it, vi } from 'vitest';
import {
  MAX_STICKER_PX,
  autoEnhance,
  THUMB_PX,
  comic,
  cutout,
  distanceToInside,
  downscale,
  encodeStickerWebps,
  makeSticker,
  makeThumbnail,
  naklejka,
  outline,
  padSquare,
  shadow,
  trimToContent,
  type Img,
} from './stickerize';

/** A w x h image, every pixel from `f(x, y)` = [r, g, b, a]. */
function make(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const alphaAt = (img: Img, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3];
const px = (img: Img, x: number, y: number): number[] => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
/** Opaque red square of `s` at (ox, oy) on a transparent w x h. */
const square = (w: number, h: number, ox: number, oy: number, s: number): Img =>
  make(w, h, (x, y) => (x >= ox && x < ox + s && y >= oy && y < oy + s ? [200, 0, 0, 255] : [0, 0, 0, 0]));
const bbox = (img: Img): [number, number, number, number] => {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (alphaAt(img, x, y) > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
  }
  return [x0, y0, x1, y1];
};

describe('cutout', () => {
  const photo = make(4, 4, () => [10, 20, 30, 255]);

  it('takes alpha from the mask and clears pixels under the threshold', () => {
    const mask = new Uint8Array(16);
    mask[5] = 255;
    mask[6] = 128;
    mask[9] = 20; // 20/255 = 0.08 < 0.15: background
    const out = cutout(photo, mask, 4, 4)!;
    expect(alphaAt(out, 1, 1)).toBe(255);
    expect(alphaAt(out, 2, 1)).toBe(128);
    expect(alphaAt(out, 1, 2)).toBe(0);
    expect(px(out, 1, 1).slice(0, 3)).toEqual([10, 20, 30]); // colour is untouched
  });

  it('samples a mask of another size nearest-neighbour', () => {
    const mask = new Uint8Array([255, 0, 0, 0]); // 2x2: only the top-left quadrant
    const out = cutout(photo, mask, 2, 2)!;
    expect(alphaAt(out, 1, 1)).toBe(255);
    expect(alphaAt(out, 2, 1)).toBe(0);
    expect(alphaAt(out, 1, 2)).toBe(0);
  });

  it('returns null for an empty mask ("nothing cut")', () => {
    expect(cutout(photo, new Uint8Array(16), 4, 4)).toBeNull();
    expect(cutout(photo, new Uint8Array(16).fill(30), 4, 4)).toBeNull(); // only noise under 0.15
  });

  it('works with a full-image mask', () => {
    const out = cutout(photo, new Uint8Array(16).fill(255), 4, 4)!;
    expect(bbox(out)).toEqual([0, 0, 3, 3]);
  });
});

describe('trimToContent', () => {
  it('crops to the bounding box', () => {
    const out = trimToContent(square(10, 8, 3, 2, 2))!;
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(alphaAt(out, 0, 0)).toBe(255);
  });

  it('adds transparent padding', () => {
    const out = trimToContent(square(10, 8, 3, 2, 2), 2)!;
    expect([out.width, out.height]).toEqual([6, 6]);
    expect(bbox(out)).toEqual([2, 2, 3, 3]);
  });

  it('returns null for an empty image', () => {
    expect(trimToContent(make(3, 3, () => [1, 2, 3, 0]))).toBeNull();
  });
});

describe('padSquare', () => {
  it('centres a wide image on a square of the long side', () => {
    const out = padSquare(make(6, 2, () => [0, 0, 255, 255]));
    expect([out.width, out.height]).toEqual([6, 6]);
    expect(bbox(out)).toEqual([0, 2, 5, 3]); // rows 2..3 of 6: centred
  });

  it('centres a tall image', () => {
    const out = padSquare(make(2, 6, () => [0, 0, 255, 255]));
    expect(bbox(out)).toEqual([2, 0, 3, 5]);
  });

  it('leaves a square alone', () => {
    const img = square(4, 4, 0, 0, 4);
    expect(padSquare(img)).toBe(img);
  });
});

describe('distanceToInside', () => {
  it('is 0 inside and grows with distance', () => {
    const d = distanceToInside(make(9, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [0, 0, 0, 0])));
    expect(Array.from(d.slice(0, 4))).toEqual([0, 1, 2, 3]);
    const diag = distanceToInside(make(4, 4, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 255] : [0, 0, 0, 0])));
    expect(diag[3 * 4 + 3]).toBeCloseTo(3 * Math.SQRT2, 4);
  });
});

describe('outline', () => {
  it('draws a border of the given radius around the shape, grows the canvas and keeps the shape on top', () => {
    const s = outline(square(5, 5, 0, 0, 5), { radiusPx: 3, color: [255, 255, 255] });
    expect(s.width).toBe(5 + 2 * 4);
    expect(px(s, 4, 4)).toEqual([200, 0, 0, 255]); // the original pixel (offset by pad 4) is on top
    expect(px(s, 4 - 2, 4)).toEqual([255, 255, 255, 255]); // 2 px left of the shape: white border
    expect(alphaAt(s, 0, 4)).toBe(0); // beyond the radius
    expect(alphaAt(s, 4 - 4, 4 + 2)).toBe(0);
  });
});

describe('shadow', () => {
  it('offsets a translucent silhouette under the image', () => {
    const base = square(6, 6, 0, 0, 3);
    const s = shadow(base, { dx: 2, dy: 2, alpha: 0.5, blurPx: 0 });
    expect([s.width, s.height]).toEqual([8, 8]);
    expect(px(s, 0, 0)).toEqual([200, 0, 0, 255]); // sticker untouched on top
    const sh = px(s, 4, 4); // inside the shadow (2..4), outside the sticker (0..2)
    expect(sh.slice(0, 3)).toEqual([0, 0, 0]);
    expect(Math.abs(sh[3] - 127.5)).toBeLessThanOrEqual(1);
    expect(alphaAt(s, 7, 0)).toBe(0);
  });

  it('blur spreads the shadow wider than the silhouette', () => {
    const s = shadow(square(9, 9, 3, 3, 3), { dx: 0, dy: 0, alpha: 1, blurPx: 2 });
    const [x0, , x1] = bbox(s);
    expect(x1 - x0 + 1).toBeGreaterThan(3);
  });

  it('the shadow fades out before the canvas edge (no straight cutoff), also with an offset', () => {
    for (const [dx, dy, blurPx] of [[0, 0, 4], [3, 5, 4], [-3, -5, 4], [4, 0, 2], [0, -6, 3]]) { // |offset| < reach: the sticker itself stays off the edge
      // a wide, opaque shape: its straight edges keep the spread's tail well above 1/255
      const src = square(40, 40, 0, 0, 40);
      const s = shadow(src, { dx, dy, alpha: 1, blurPx });
      const reach = 2 * blurPx + 1;
      const w = s.width, h = s.height;
      const padL = Math.max(0, reach - dx), padT = Math.max(0, reach - dy);
      let touches = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (alphaAt(s, x, y) > 0 && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) touches = true;
        }
      }
      expect(touches, `dx=${dx} dy=${dy} blur=${blurPx}`).toBe(false);
      expect(w).toBe(src.width + padL + Math.max(0, reach + dx));
      expect(h).toBe(src.height + padT + Math.max(0, reach + dy));
    }
  });
});

describe('comic', () => {
  it('posterizes every channel to at most `levels` values', () => {
    const grad = make(16, 16, (x) => [x * 16, x * 16, x * 16, 255]); // a smooth ramp
    const out = comic(grad, { levels: 5, edgePx: 1, edgeThreshold: 1e9 });
    const seen = new Set<number>();
    for (let i = 0; i < out.data.length; i += 4) seen.add(out.data[i]);
    expect(seen.size).toBeLessThanOrEqual(5);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('draws a dark line on a strong inner edge and leaves flat areas alone', () => {
    const img = make(10, 10, (x) => (x < 5 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = comic(img, { levels: 5, edgePx: 1 });
    expect(px(out, 4, 5).slice(0, 3)).toEqual([30, 30, 30]); // the edge column turns dark
    expect(px(out, 1, 5).slice(0, 3)).toEqual([255, 255, 255]);
  });
});

describe('comic on a noisy photo-like texture', () => {
  // a blue blob with +-25 grain per channel, on a transparent margin (deterministic noise)
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const SIZE = 160, PAD = 20;
  const blob = make(SIZE, SIZE, (x, y) =>
    x >= PAD && x < SIZE - PAD && y >= PAD && y < SIZE - PAD
      ? [90 + rnd() * 25, 120 + rnd() * 25, 200 + rnd() * 25, 255]
      : [0, 0, 0, 0]);
  const hueOf = (r: number, g: number, b: number): number => {
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h * 60;
  };

  it('texture does not become black blotches', () => {
    const out = comic(blob, { levels: 5, edgePx: 1 });
    let opaque = 0, dark = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] < 128) continue;
      opaque++;
      if (0.299 * out.data[i] + 0.587 * out.data[i + 1] + 0.114 * out.data[i + 2] < 60) dark++;
    }
    expect(opaque).toBeGreaterThan(10000);
    expect(dark / opaque).toBeLessThan(0.1);
  });

  it('keeps the hue of a coloured object', () => {
    const out = comic(blob, { levels: 5, edgePx: 1 });
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] < 128 || out.data[i] === 30 && out.data[i + 1] === 30) continue; // skip line pixels
      const a = (hueOf(out.data[i], out.data[i + 1], out.data[i + 2]) * Math.PI) / 180;
      sx += Math.cos(a); sy += Math.sin(a); n++;
    }
    expect(n).toBeGreaterThan(5000);
    const mean = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
    const want = hueOf(90, 120, 200);
    expect(Math.abs(mean - want)).toBeLessThan(15);
  });

  it('komiks on the same texture is still mostly the object colour', () => {
    const out = makeSticker(blob, 'komiks')!;
    let blue = 0, opaque = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] < 250) continue;
      opaque++;
      if (out.data[i + 2] > out.data[i] + 20) blue++;
    }
    expect(blue / opaque).toBeGreaterThan(0.7);
  });
});

describe('downscale / presets', () => {
  it('downscale keeps colour of semi-transparent areas (no bleed from transparent pixels)', () => {
    const out = downscale(make(4, 4, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 0, 0])), 2);
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out, 1, 0)[3]).toBe(0);
  });

  it('naklejka grows the shape by a white border and a shadow', () => {
    const base = trimToContent(square(40, 40, 5, 5, 30))!;
    const out = naklejka(base);
    expect(out.width).toBeGreaterThan(base.width);
    const c = Math.floor(out.width / 2);
    expect(px(out, c, c)).toEqual([200, 0, 0, 255]);
  });

  it('makeSticker: a square within the cap, thumbnail within its cap', () => {
    const wide = make(2000, 600, () => [10, 200, 10, 255]);
    const s = makeSticker(wide, 'naklejka')!;
    expect(s.width).toBe(s.height);
    expect(s.width).toBeLessThanOrEqual(MAX_STICKER_PX);
    const t = makeThumbnail(s);
    expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(THUMB_PX);
    expect(t.width).toBe(t.height);
  });

  it('makeSticker returns null for an empty image and works for both styles', () => {
    expect(makeSticker(make(5, 5, () => [0, 0, 0, 0]), 'komiks')).toBeNull();
    for (const style of ['naklejka', 'komiks'] as const) {
      const s = makeSticker(square(30, 20, 4, 4, 12), style)!;
      expect(s.width).toBe(s.height);
    }
  });

  it('an already transparent PNG keeps its shape: trimmed, centred, same aspect inside the square', () => {
    const png = make(40, 20, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? [0, 0, 200, 255] : [0, 0, 0, 0]));
    const s = makeSticker(png, 'naklejka')!;
    const [x0, y0, x1, y1] = bbox(s);
    expect(Math.abs(x0 - (s.width - 1 - x1))).toBeLessThanOrEqual(1);
    expect(Math.abs(y0 - (s.height - 1 - y1))).toBeLessThanOrEqual(1);
    expect(x1 - x0).toBeGreaterThan(y1 - y0);
  });
});

describe('encodeStickerWebps', () => {
  it('encodes the sticker and the thumbnail as image/webp (PNG took 4 s on the tablet)', async () => {
    const types: unknown[] = [];
    class FakeCanvas {
      constructor(public width: number, public height: number) {}
      getContext() { return { putImageData() {}, drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'low' }; }
      async convertToBlob(o: { type: string; quality: number }) { types.push(o); return new Blob([new Uint8Array(1)], { type: o.type }); }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    try {
      const r = await encodeStickerWebps(make(8, 8, () => [1, 2, 3, 255]));
      expect(types).toEqual([{ type: 'image/webp', quality: 0.92 }, { type: 'image/webp', quality: 0.92 }]);
      expect(r.webp.type).toBe('image/webp');
      expect(r.thumb.type).toBe('image/webp');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('autoEnhance', () => {
  const lumOf = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  /** [min, median, max] luminance of the opaque pixels. */
  const stats = (img: Img): [number, number, number] => {
    const v: number[] = [];
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] >= 128) v.push(lumOf(img.data, i));
    v.sort((a, b) => a - b);
    return [v[0], v[v.length >> 1], v[v.length - 1]];
  };
  const hue = (r: number, g: number, b: number): number => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  /** A dim, flat toy: values 50..110 in a gradient on a transparent border. */
  const dim = (n = 64) => make(n, n, (x, y) => {
    if (x < 4 || y < 4 || x >= n - 4 || y >= n - 4) return [0, 0, 0, 0];
    const t = (x + y) / (2 * n);
    return [50 + 60 * t, 45 + 55 * t, 40 + 50 * t, 255];
  });

  it('a dim, low-contrast toy gets a wider range and a higher median; alpha is untouched', () => {
    const src = dim();
    const [lo0, med0, hi0] = stats(src);
    const out = autoEnhance(src);
    const [lo1, med1, hi1] = stats(out);
    expect(hi1 - lo1).toBeGreaterThan((hi0 - lo0) * 1.5);
    expect(med1).toBeGreaterThan(med0 + 15);
    for (let i = 3; i < src.data.length; i += 4) expect(out.data[i]).toBe(src.data[i]);
  });

  it('an already full-range image is (nearly) unchanged', () => {
    const src = make(64, 64, (x, y) => { const v = Math.round(((x + y) / 126) * 255); return [v, v, v, 255]; });
    const out = autoEnhance(src);
    let maxd = 0;
    for (let i = 0; i < src.data.length; i += 4) for (let c = 0; c < 3; c++) maxd = Math.max(maxd, Math.abs(out.data[i + c] - src.data[i + c]));
    expect(maxd).toBeLessThanOrEqual(8); // grey: only the unsharp mask on the gradient's steps can move it
  });

  it('statistics ignore transparent pixels (their RGB is garbage) and alpha is preserved exactly', () => {
    const base = dim();
    const noisy = make(64, 64, (x, y) => {
      const i = (y * 64 + x) * 4;
      return base.data[i + 3] === 0 ? [255, 255, 255, 0] : [base.data[i], base.data[i + 1], base.data[i + 2], 255];
    });
    const a = autoEnhance(base);
    const b = autoEnhance(noisy);
    for (let i = 0; i < a.data.length; i += 4) {
      expect(b.data[i + 3]).toBe(noisy.data[i + 3]);
      if (noisy.data[i + 3] === 255) expect([b.data[i], b.data[i + 1], b.data[i + 2]]).toEqual([a.data[i], a.data[i + 1], a.data[i + 2]]);
      else expect([b.data[i], b.data[i + 1], b.data[i + 2]]).toEqual([255, 255, 255]); // not touched either
    }
  });

  it('keeps the hue of a coloured blob (within 10 degrees)', () => {
    const src = make(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 26 ? [90 + (x % 5), 50, 40, 255] : [0, 0, 0, 0]));
    const out = autoEnhance(src);
    const i = (32 * 64 + 32) * 4;
    const dh = Math.abs(hue(src.data[i], src.data[i + 1], src.data[i + 2]) - hue(out.data[i], out.data[i + 1], out.data[i + 2]));
    expect(Math.min(dh, 360 - dh)).toBeLessThanOrEqual(10);
    expect(out.data[i]).toBeGreaterThan(src.data[i]);
  });

  it('sharpening raises the contrast across a blurred step', () => {
    // soft steps 5 -> 128 -> 250 (wide range, median 128) so levels and gamma stay out of the way
    const src = make(80, 40, (x) => { const sig = (c: number) => 1 / (1 + Math.exp(-(x - c) / 1.2));
      const v = Math.round(5 + 123 * sig(20) + 122 * sig(60)); return [v, v, v, 255]; });
    const out = autoEnhance(src);
    const row = 20 * 80 * 4;
    const grad = (img: Img) => Math.max(...Array.from({ length: 79 }, (_, x) => Math.abs(img.data[row + (x + 1) * 4] - img.data[row + x * 4])));
    const maxGrad = (img: Img) => Math.max(...Array.from({ length: 79 }, (_, x) => Math.abs(img.data[row + (x + 1) * 4] - img.data[row + x * 4])));
    expect(maxGrad(out)).toBeGreaterThan(maxGrad(src) * 1.05);
  });

  it('output stays within 0..255 and a bright/dark extremes image does not wrap', () => {
    const src = make(64, 64, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = autoEnhance(src);
    expect(out.data.length).toBe(src.data.length);
    expect(Math.min(...out.data)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...out.data)).toBeLessThanOrEqual(255);
  });

  it('nothing opaque: a copy', () => {
    const src = make(8, 8, () => [10, 20, 30, 0]);
    expect(Array.from(autoEnhance(src).data)).toEqual(Array.from(src.data));
  });

  it('1024x1024 completes quickly', () => {
    const src = dim(1024);
    const t0 = performance.now();
    const out = autoEnhance(src);
    const ms = performance.now() - t0;
    console.log(`autoEnhance 1024x1024: ${ms.toFixed(0)} ms`);
    expect(out.width).toBe(1024);
    expect(ms).toBeLessThan(2000); // loose for CI; the target on a dev machine is well under 300
  });

  it('makeSticker enhances before styling only when asked', () => {
    const toy = make(64, 64, (x, y) => (x > 8 && y > 8 && x < 56 && y < 56 ? [60 + x / 2, 50, 40, 255] : [0, 0, 0, 0]));
    const plain = makeSticker(toy, 'naklejka');
    const enhanced = makeSticker(toy, 'naklejka', true);
    expect(plain && enhanced && Buffer.compare(Buffer.from(plain.data), Buffer.from(enhanced.data))).not.toBe(0);
  });
});
