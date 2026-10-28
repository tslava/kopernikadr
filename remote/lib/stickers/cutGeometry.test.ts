import { describe, expect, it } from 'vitest';
import { MAX_POINTS, MIN_STEP, appendPoint, containRect, toNormalized } from './cutGeometry';
import { composePreview, coverage } from './cutPreview';

describe('containRect', () => {
  it('letterboxes a wide picture in a tall box and centers it', () => {
    expect(containRect({ x: 10, y: 20, w: 100, h: 200 }, 400, 200)).toEqual({ x: 10, y: 20 + 75, w: 100, h: 50 });
  });
  it('pillarboxes a tall picture in a wide box', () => {
    expect(containRect({ x: 0, y: 0, w: 1000, h: 500 }, 100, 200)).toEqual({ x: 375, y: 0, w: 250, h: 500 });
  });
  it('is empty for a degenerate size', () => {
    expect(containRect({ x: 0, y: 0, w: 0, h: 10 }, 4, 4).w).toBe(0);
  });
});

describe('toNormalized', () => {
  const shown = { x: 100, y: 50, w: 200, h: 100 };
  it('maps the corners and the center', () => {
    expect(toNormalized(100, 50, shown, false)).toEqual([0, 0]);
    expect(toNormalized(300, 150, shown, false)).toEqual([1, 1]);
    expect(toNormalized(200, 100, shown, false)).toEqual([0.5, 0.5]);
  });
  it('rejects a point in the letterbox on a press, clamps it on a move', () => {
    expect(toNormalized(50, 100, shown, false)).toBeNull();
    expect(toNormalized(50, 100, shown, true)).toEqual([0, 0.5]);
    expect(toNormalized(999, 999, shown, true)).toEqual([1, 1]);
  });
});

describe('appendPoint', () => {
  it('skips tiny moves and stops at the native limit', () => {
    const p1: [number, number][] = [[0.1, 0.1]];
    expect(appendPoint(p1, [0.1 + MIN_STEP / 2, 0.1])).toBe(p1);
    expect(appendPoint(p1, [0.2, 0.1])).toEqual([[0.1, 0.1], [0.2, 0.1]]);
    const full = Array.from({ length: MAX_POINTS }, (_, i): [number, number] => [(i % 100) / 100, 0]);
    expect(appendPoint(full, [0.99, 0.9])).toBe(full);
  });
});

describe('cut preview', () => {
  it('coverage is the share of pixels at or above the threshold', () => {
    expect(coverage(new Uint8Array([0, 10, 39, 255]))).toBe(0.5);
    expect(coverage(new Uint8Array(0))).toBe(0);
  });
  it('keeps the toy opaque and dims the rest (nearest-neighbour for another mask size)', () => {
    const photo = { width: 2, height: 1, data: new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255]) };
    const out = composePreview(photo, new Uint8Array([255, 0]), 2, 1, 0.3);
    expect(out.data[3]).toBe(255);
    expect(out.data[7]).toBeGreaterThan(70);
    expect(out.data[7]).toBeLessThan(80);
    expect(photo.data[7]).toBe(255); // the input is not touched
    expect(composePreview(photo, new Uint8Array([255]), 1, 1).data[7]).toBe(255);
  });
});
