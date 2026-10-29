import type { Img, StickerStyle } from './stickerize';

/**
 * The styled sticker per (enhance, style) for one picture. The per-pixel styling (outline, shadow, comic) is
 * the slow part, so it runs at most once per (enhance on/off, style): a chip tap, the preview and "Zapisz" all read
 * the same result. `make` is injected so a test can count the calls.
 */
export class StyleCache {
  private cut: Img | null = null;
  private readonly made = new Map<string, Img>();

  constructor(private readonly make: (cut: Img, style: StickerStyle, enhance: boolean) => Img | null) {}

  /** A new picture: forgets every styled result. */
  setSource(cut: Img | null): void {
    this.cut = cut;
    this.made.clear();
  }

  clear(): void {
    this.setSource(null);
  }

  /** Null when there is no picture or nothing is visible in it (a null result is not cached). */
  get(style: StickerStyle, enhance: boolean): Img | null {
    const key = `${enhance ? 1 : 0}:${style}`;
    const hit = this.made.get(key);
    if (hit) return hit;
    const img = this.cut ? this.make(this.cut, style, enhance) : null;
    if (img) this.made.set(key, img);
    return img;
  }
}
