/**
 * OpenMoji sprites: an SVG is rasterized to an ImageBitmap per (hexcode, size bucket).
 * OpenMoji SVGs have only a viewBox, so `createImageBitmap(img)` throws in Chrome; the <img> is
 * drawn onto a canvas at the bucket size and the bitmap is made from that canvas.
 * The cache is an LRU capped by bytes; evicted bitmaps are closed. The export `preload`s every
 * sprite it needs into a pinned set that the LRU never touches.
 * `urlOf(emoji)` maps a sprite id to its image: a hexcode to the OpenMoji SVG, a custom `my:<uuid>`
 * to the movie's own WebP copy (bound per project); null means an unknown sprite (it fails like a
 * broken image).
 */
import { openmojiUrlOf, type SpriteUrlOf } from './catalog';

export const SPRITE_BUCKETS = [128, 256, 512, 1024] as const;
export type SpriteBucket = (typeof SPRITE_BUCKETS)[number];
export const SPRITE_CACHE_BYTES = 32 * 1024 * 1024;

/** Smallest bucket that holds `px` pixels (the largest one for anything bigger). */
export function bucketFor(px: number): SpriteBucket {
  for (const b of SPRITE_BUCKETS) if (px <= b) return b;
  return SPRITE_BUCKETS[SPRITE_BUCKETS.length - 1];
}

/** The image-loading seam: rasterizes the SVG at `url` to a `size` x `size` bitmap. */
export type Rasterize = (url: string, size: number) => Promise<ImageBitmap>;

export const rasterizeSvg: Rasterize = async (url, size) => {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`sprite image failed: ${url}`));
    img.src = url;
  });
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('sprite: no 2d context');
  ctx.drawImage(img, 0, 0, size, size);
  return createImageBitmap(canvas);
};

/** Sprites held for one export; not subject to the LRU. */
export interface PinnedSprites {
  get(hexcode: string): ImageBitmap | undefined;
  release(): void;
}

const bytesOf = (bucket: number): number => bucket * bucket * 4;
const keyOf = (hexcode: string, bucket: number): string => `${hexcode}@${bucket}`;

export class SpriteCache {
  private readonly entries = new Map<string, ImageBitmap>(); // insertion order = recency
  private readonly inflight = new Map<string, Promise<ImageBitmap>>();
  private readonly failed = new Set<string>(); // negative cache: a broken sprite is not re-fetched on every paint
  private total = 0;
  private generation = 0; // bumped by clear(): a load that began before it must not insert into the emptied cache

  constructor(
    private readonly raster: Rasterize = rasterizeSvg,
    private readonly maxBytes: number = SPRITE_CACHE_BYTES,
    private readonly urlOf: SpriteUrlOf = openmojiUrlOf,
  ) {}

  private rasterOf(emoji: string, bucket: number): Promise<ImageBitmap> {
    const url = this.urlOf(emoji);
    return url === null ? Promise.reject(new Error(`unknown sprite: ${emoji}`)) : this.raster(url, bucket);
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The cached bitmap, if any; marks it most recently used. Synchronous, for drawing. */
  get(hexcode: string, bucket: SpriteBucket): ImageBitmap | undefined {
    const k = keyOf(hexcode, bucket);
    const bmp = this.entries.get(k);
    if (bmp) {
      this.entries.delete(k);
      this.entries.set(k, bmp);
    }
    return bmp;
  }

  /** True once a load of this sprite failed (until `clear`). */
  hasFailed(hexcode: string, bucket: SpriteBucket): boolean {
    return this.failed.has(keyOf(hexcode, bucket));
  }

  /** Loads (or returns the cached) sprite. Concurrent calls share one rasterization; a failed one is remembered. */
  load(hexcode: string, bucket: SpriteBucket): Promise<ImageBitmap> {
    const hit = this.get(hexcode, bucket);
    if (hit) return Promise.resolve(hit);
    const k = keyOf(hexcode, bucket);
    if (this.failed.has(k)) return Promise.reject(new Error(`sprite failed before: ${k}`));
    let p = this.inflight.get(k);
    if (!p) {
      const gen = this.generation;
      p = this.rasterOf(hexcode, bucket).then(
        (bmp) => {
          if (gen !== this.generation) {
            bmp.close(); // cleared (the view went away) while this was loading
            throw new Error(`sprite cache cleared: ${k}`);
          }
          this.inflight.delete(k);
          this.insert(k, bmp, bucket);
          return bmp;
        },
        (e: unknown) => {
          if (gen === this.generation) {
            this.inflight.delete(k);
            this.failed.add(k);
          }
          throw e;
        },
      );
      this.inflight.set(k, p);
    }
    return p;
  }

  /**
   * Rasterizes every hexcode at `bucket` into a pinned set. Rejects naming the hexcodes that
   * failed (the export then fails with a clear message); bitmaps made so far are closed.
   */
  async preload(hexcodes: readonly string[], bucket: SpriteBucket): Promise<PinnedSprites> {
    const unique = [...new Set(hexcodes)];
    const results = await Promise.allSettled(unique.map((h) => this.rasterOf(h, bucket)));
    const held = new Map<string, ImageBitmap>();
    const failed: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') held.set(unique[i], r.value);
      else failed.push(unique[i]);
    });
    if (failed.length > 0) {
      for (const b of held.values()) b.close();
      throw Object.assign(new Error(`sprites failed to load: ${failed.join(', ')}`), { failed });
    }
    return {
      get: (h) => held.get(h),
      release: () => {
        for (const b of held.values()) b.close();
        held.clear();
      },
    };
  }

  /** Closes and forgets everything cached (and every failure); loads still in flight are discarded when they land. */
  clear(): void {
    this.generation++;
    this.inflight.clear();
    this.failed.clear();
    for (const b of this.entries.values()) b.close();
    this.entries.clear();
    this.total = 0;
  }

  private insert(k: string, bmp: ImageBitmap, bucket: number): void {
    this.entries.set(k, bmp);
    this.total += bytesOf(bucket);
    // evict least recently used, but never the sprite just added
    for (const [ek, eb] of this.entries) {
      if (this.total <= this.maxBytes || ek === k) break;
      this.entries.delete(ek);
      this.total -= bytesOf(Number(ek.slice(ek.indexOf('@') + 1)));
      eb.close();
    }
  }
}

/** A sprite cache is bound to one project and one url resolver: rebuild it when either changes. */
export function needsNewSpriteCache<U>(built: { id: string; urls: U } | null, id: string, urls: U): boolean {
  return built === null || built.id !== id || built.urls !== urls;
}
