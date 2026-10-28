import { describe, expect, it } from 'vitest';
import { hasTransparency } from './imageDecode';

const img = (alphas: number[]) => ({ width: alphas.length, height: 1, data: Uint8ClampedArray.from(alphas.flatMap((a) => [10, 20, 30, a])) });

describe('hasTransparency', () => {
  it('an opaque photo has none', () => {
    expect(hasTransparency(img([255, 255, 255]))).toBe(false);
  });

  it('any pixel under alpha 250 counts', () => {
    expect(hasTransparency(img([255, 249, 255]))).toBe(true);
    expect(hasTransparency(img([0, 0]))).toBe(true);
  });

  it('alpha 250 to 255 is treated as opaque (decoder noise)', () => {
    expect(hasTransparency(img([250, 252, 255]))).toBe(false);
  });
});
