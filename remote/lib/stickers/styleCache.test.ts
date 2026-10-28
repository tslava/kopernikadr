import { describe, expect, it, vi } from 'vitest';
import type { Img } from './stickerize';
import { StyleCache } from './styleCache';

const img = (n: number): Img => ({ width: n, height: n, data: new Uint8ClampedArray(n * n * 4) });

describe('StyleCache', () => {
  it('styles once per style: preview, chip tap and save read the same result', () => {
    const make = vi.fn((cut: Img) => img(cut.width + 1));
    const cache = new StyleCache(make);
    cache.setSource(img(4));
    const a = cache.get('komiks'); // preview
    const b = cache.get('komiks'); // "Zapisz" after dispatch('save') re-rendered
    expect(b).toBe(a);
    expect(make).toHaveBeenCalledTimes(1);
    cache.get('naklejka');
    cache.get('komiks');
    cache.get('naklejka');
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('a new picture drops the old results', () => {
    const make = vi.fn((cut: Img) => img(cut.width));
    const cache = new StyleCache(make);
    cache.setSource(img(4));
    cache.get('naklejka');
    cache.setSource(img(6));
    expect(cache.get('naklejka')?.width).toBe(6);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('nothing to style: null, and a null result is retried rather than cached', () => {
    const make = vi.fn(() => null);
    const cache = new StyleCache(make);
    expect(cache.get('naklejka')).toBeNull(); // no source yet
    expect(make).not.toHaveBeenCalled();
    cache.setSource(img(4));
    expect(cache.get('naklejka')).toBeNull();
    expect(make).toHaveBeenCalledTimes(1);
    cache.clear();
    expect(cache.get('naklejka')).toBeNull();
    expect(make).toHaveBeenCalledTimes(1);
  });
});
