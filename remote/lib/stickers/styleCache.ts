import type { Img, StickerStyle } from './stickerize';

/**
 * The styled sticker per style for one picture. The per-pixel styling (outline, shadow, comic) is
 * the slow part, so it runs at most once per style: a chip tap, the preview and "Zapisz" all read
 * the same result. `make` is injected so a test can count the calls.
 */
export class StyleCache {
  private cut: Img | null = null;
  private readonly made = new Map<StickerStyle, Img>();

  constructor(private readonly make: (cut: Img, style: StickerStyle) => Img | null) {}

  /** A new picture: forgets every styled result. */
  setSource(cut: Img | null): void {
    this.cut = cut;
    this.made.clear();
  }

  clear(): void {
    this.setSource(null);
  }

  /** Null when there is no picture or nothing is visible in it (a null result is not cached). */
  get(style: StickerStyle): Img | null {
    const hit = this.made.get(style);
    if (hit) return hit;
    const img = this.cut ? this.make(this.cut, style) : null;
    if (img) this.made.set(style, img);
    return img;
  }
}
