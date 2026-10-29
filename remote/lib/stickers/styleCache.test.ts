import { describe, expect, it, vi } from 'vitest';
import type { Img } from './stickerize';
import { StyleCache } from './styleCache';

const img = (n: number): Img => ({ width: n, height: n, data: new Uint8ClampedArray(n * n * 4) });

describe('StyleCache', () => {
  it('styles once per style: preview, chip tap and save read the same result', () => {
    const make = vi.fn((cut: Img) => img(cut.width + 1));
    const cache = new StyleCache(make);
    cache.setSource(img(4));
    const a = cache.get('komiks', false); // preview
    const b = cache.get('komiks', false); // "Zapisz" after dispatch('save') re-rendered
    expect(b).toBe(a);
    expect(make).toHaveBeenCalledTimes(1);
    cache.get('naklejka', false);
    cache.get('komiks', false);
    cache.get('naklejka', false);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('keys by the enhance toggle too: each combination is computed once and reused', () => {
    const make = vi.fn((cut: Img, _s: string, enhance: boolean) => img(cut.width + (enhance ? 10 : 0)));
    const cache = new StyleCache(make);
    cache.setSource(img(4));
    expect(cache.get('naklejka', true)?.width).toBe(14);
    expect(cache.get('naklejka', false)?.width).toBe(4);
    expect(cache.get('naklejka', true)?.width).toBe(14);
    expect(cache.get('naklejka', false)?.width).toBe(4);
    expect(make).toHaveBeenCalledTimes(2);
    expect(make).toHaveBeenCalledWith(expect.anything(), 'naklejka', true);
  });

  it('a new picture drops the old results', () => {
    const make = vi.fn((cut: Img) => img(cut.width));
    const cache = new StyleCache(make);
    cache.setSource(img(4));
    cache.get('naklejka', false);
    cache.setSource(img(6));
    expect(cache.get('naklejka', false)?.width).toBe(6);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('nothing to style: null, and a null result is retried rather than cached', () => {
    const make = vi.fn(() => null);
    const cache = new StyleCache(make);
    expect(cache.get('naklejka', false)).toBeNull(); // no source yet
    expect(make).not.toHaveBeenCalled();
    cache.setSource(img(4));
    expect(cache.get('naklejka', false)).toBeNull();
    expect(make).toHaveBeenCalledTimes(1);
    cache.clear();
    expect(cache.get('naklejka', false)).toBeNull();
    expect(make).toHaveBeenCalledTimes(1);
  });
});
