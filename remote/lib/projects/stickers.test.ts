import { describe, expect, it } from 'vitest';
import { duplicateEntry } from './edit';
import type { FrameEntry, Project } from './model';
import { addSticker, removeSticker, setRange, updateSticker } from './stickers';
import { timeline } from './timeline';

const frame = (n: number): FrameEntry => ({
  frameId: `F${n}`,
  seq: n,
  bytes: 1,
  sha256: `s${n}`,
  state: 'local',
  hiddenUntil: null,
});
const project = (n: number, over: Partial<Project> = {}): Project => ({
  version: 1,
  id: 'P',
  name: 'Film',
  createdAt: '2026-10-27T10:00:00.000Z',
  fps: 8,
  geometry: { aspect: '4:3', rotation: 0 },
  cameraId: 'cam',
  frames: Array.from({ length: n }, (_, i) => frame(i + 1)),
  deletedFrameIds: [],
  outstanding: [],
  ...over,
});

describe('addSticker', () => {
  it('shows on the entry and every later entry, and materializes cut with stable ids', () => {
    const p = addSticker(project(4), 'F2', '1F436', 'S1');
    expect(p.cut?.map((e) => e.id)).toEqual(['F1', 'F2', 'F3', 'F4']);
    expect(p.stickers).toEqual([{ id: 'S1', emoji: '1F436', x: 0.5, y: 0.5, size: 0.25, rot: 0, on: ['F2', 'F3', 'F4'] }]);
  });
  it('follows cut order, including duplicates', () => {
    const base = duplicateEntry(project(3), 'F2', 'D2'); // F1 F2 D2 F3
    const p = addSticker(base, 'D2', '1F436', 'S1');
    expect(p.stickers![0]!.on).toEqual(['D2', 'F3']);
  });
  it('puts new stickers on top and clamps the initial pose', () => {
    let p = addSticker(project(2), 'F1', '1F436', 'A');
    p = addSticker(p, 'F1', '1F431', 'B', { x: 9, size: 0.001, rot: 270 });
    expect(p.stickers!.map((s) => s.id)).toEqual(['A', 'B']);
    expect(p.stickers![1]).toMatchObject({ x: 1.25, size: 0.05, rot: -90 });
  });
  it('an unknown entry, an empty emoji or a taken id changes nothing', () => {
    const p = addSticker(project(2), 'F1', '1F436', 'A');
    expect(addSticker(p, 'nope', '1F436', 'B')).toBe(p);
    expect(addSticker(p, 'F1', '', 'B')).toBe(p);
    expect(addSticker(p, 'F1', '1F436', 'A')).toBe(p);
  });
});

describe('updateSticker', () => {
  const base = addSticker(project(2), 'F1', '1F436', 'S');
  it('applies a pose and clamps x/y/size/rot', () => {
    const p = updateSticker(base, 'S', { x: -5, y: 5, size: 3, rot: 190 });
    expect(p.stickers![0]).toMatchObject({ x: -0.25, y: 1.25, size: 1, rot: -170 });
  });
  it('leaves untouched fields and the entry list alone', () => {
    const p = updateSticker(base, 'S', { x: 0.1 });
    expect(p.stickers![0]).toMatchObject({ x: 0.1, y: 0.5, size: 0.25, on: ['F1', 'F2'] });
  });
  it('is the same reference when nothing changes, or for an unknown sticker', () => {
    expect(updateSticker(base, 'S', { x: 0.5, rot: 0 })).toBe(base);
    expect(updateSticker(base, 'S', { x: NaN })).toBe(base);
    expect(updateSticker(base, 'nope', { x: 0.1 })).toBe(base);
  });
});

describe('removeSticker', () => {
  it('removes one sticker; unknown is the same reference', () => {
    let p = addSticker(project(2), 'F1', '1F436', 'A');
    p = addSticker(p, 'F1', '1F431', 'B');
    expect(removeSticker(p, 'A').stickers!.map((s) => s.id)).toEqual(['B']);
    expect(removeSticker(p, 'nope')).toBe(p);
    expect(removeSticker(project(2), 'A').stickers).toBeUndefined();
  });
});

describe('setRange', () => {
  const base = addSticker(project(5), 'F1', '1F436', 'S'); // on F1..F5
  it('keeps the entries between the two ends, inclusive', () => {
    expect(setRange(base, 'S', 'F2', 'F4').stickers![0]!.on).toEqual(['F2', 'F3', 'F4']);
  });
  it('works in either direction and returns timeline order', () => {
    expect(setRange(base, 'S', 'F4', 'F2').stickers![0]!.on).toEqual(['F2', 'F3', 'F4']);
  });
  it('a single entry range', () => {
    expect(setRange(base, 'S', 'F3', 'F3').stickers![0]!.on).toEqual(['F3']);
  });
  it('uses the current timeline order after a move', () => {
    const dup = duplicateEntry(base, 'F1', 'D1'); // F1 D1 F2.. ; the copy inherits S
    expect(setRange(dup, 'S', 'D1', 'F3').stickers![0]!.on).toEqual(['D1', 'F2', 'F3']);
    expect(timeline(dup).map((e) => e.id)).toEqual(['F1', 'D1', 'F2', 'F3', 'F4', 'F5']);
  });
  it('re-applying the same range after a duplicate is a no-op (same set)', () => {
    const dup = duplicateEntry(base, 'F2', 'D1');
    expect(setRange(dup, 'S', 'F1', 'F5')).toBe(dup);
    const reordered = { ...dup, stickers: [{ ...dup.stickers![0]!, on: ['F1', 'F2', 'F3', 'F4', 'F5', 'D1'] }] };
    expect(setRange(reordered, 'S', 'F1', 'F5')).toBe(reordered);
  });
  it('is the same reference for the same range, an unknown sticker or an unknown entry', () => {
    expect(setRange(base, 'S', 'F1', 'F5')).toBe(base);
    expect(setRange(base, 'nope', 'F1', 'F2')).toBe(base);
    expect(setRange(base, 'S', 'F1', 'nope')).toBe(base);
  });
});
