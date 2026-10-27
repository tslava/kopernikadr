import { describe, expect, it } from 'vitest';
import type { Sticker } from '../projects/model';
import { dragHandle, handlePoint, hitTest, hitTopSticker, normalizeRot, stickerBox } from './stickerGeometry';

const st = (over: Partial<Sticker> = {}): Sticker => ({ id: 's', emoji: '1F436', x: 0.5, y: 0.5, size: 0.2, rot: 0, on: ['a'], ...over });

describe('stickerBox', () => {
  it('maps normalized to px for 1440x1080', () => {
    expect(stickerBox(st({ x: 0.25, y: 0.75, size: 0.5, rot: 30 }), 1440, 1080)).toEqual({ cx: 360, cy: 810, side: 720, rot: 30 });
  });
  it('maps for an arbitrary canvas', () => {
    expect(stickerBox(st({ x: 0.5, y: 0.5, size: 0.1 }), 640, 480)).toEqual({ cx: 320, cy: 240, side: 64, rot: 0 });
  });
});

describe('normalizeRot', () => {
  it('folds into -180..180', () => {
    expect(normalizeRot(190)).toBeCloseTo(-170);
    expect(normalizeRot(-190)).toBeCloseTo(170);
    expect(normalizeRot(720)).toBe(0);
    expect(normalizeRot(45)).toBe(45);
    expect(normalizeRot(180)).toBe(-180);
    expect(Object.is(normalizeRot(-360), -0)).toBe(false);
  });
});

describe('hitTest', () => {
  const W = 1000;
  const H = 750;
  it('hits inside and misses outside an unrotated square', () => {
    const s = st({ size: 0.2 }); // 200 px side at (500, 375)
    expect(hitTest(s, { x: 590, y: 460 }, W, H)).toBe(true);
    expect(hitTest(s, { x: 610, y: 375 }, W, H)).toBe(false);
  });
  it('respects rotation: an old corner is outside after a 45 degree turn', () => {
    const s = st({ size: 0.2, rot: 45 });
    expect(hitTest(s, { x: 590, y: 465 }, W, H)).toBe(false); // old corner (90, 90) from the centre
    expect(hitTest(s, { x: 500, y: 375 + 130 }, W, H)).toBe(true); // along the rotated diagonal (half-diagonal ~141)
  });
  it('hitTopSticker prefers the last in array order', () => {
    const a = st({ id: 'a' });
    const b = st({ id: 'b' });
    expect(hitTopSticker([a, b], { x: 500, y: 375 }, W, H)?.id).toBe('b');
    expect(hitTopSticker([a, b], { x: 5, y: 5 }, W, H)).toBeNull();
  });
});

describe('corner handle', () => {
  const W = 1440;
  const H = 1080;
  it('handlePoint is the bottom-right corner, rotated with the sticker', () => {
    const p0 = handlePoint(st({ size: 0.2 }), W, H);
    expect(p0.x).toBeCloseTo(720 + 144);
    expect(p0.y).toBeCloseTo(540 + 144);
    const p90 = handlePoint(st({ size: 0.2, rot: 90 }), W, H);
    expect(p90.x).toBeCloseTo(720 - 144);
    expect(p90.y).toBeCloseTo(540 + 144);
  });
  it('dragging the handle to its own position changes nothing', () => {
    const s = st({ size: 0.3, rot: 25 });
    const r = dragHandle(s, handlePoint(s, W, H), W, H);
    expect(r.size).toBeCloseTo(0.3);
    expect(r.rot).toBeCloseTo(25);
  });
  it('dragging further out scales; dragging around turns', () => {
    const s = st({ size: 0.2 });
    const out = dragHandle(s, { x: 720 + 288, y: 540 + 288 }, W, H);
    expect(out.size).toBeCloseTo(0.4);
    expect(out.rot).toBeCloseTo(0);
    const turned = dragHandle(s, { x: 720 - 144, y: 540 + 144 }, W, H);
    expect(turned.size).toBeCloseTo(0.2);
    expect(turned.rot).toBeCloseTo(90);
  });
  it('clamps size and keeps rotation within -180..180', () => {
    const s = st();
    expect(dragHandle(s, { x: 720 + 1, y: 540 + 1 }, W, H).size).toBe(0.05);
    expect(dragHandle(s, { x: 720 + 5000, y: 540 + 5000 }, W, H).size).toBe(1);
    const r = dragHandle(s, { x: 720 - 100, y: 540 - 100 }, W, H).rot; // atan2 -135 - 45 = -180
    expect(r).toBeGreaterThanOrEqual(-180);
    expect(r).toBeLessThanOrEqual(180);
    expect(dragHandle(s, { x: 720, y: 540 }, W, H)).toEqual({ size: 0.2, rot: 0 });
  });
});
