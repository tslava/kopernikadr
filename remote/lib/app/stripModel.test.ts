import { describe, expect, it } from 'vitest';
import type { FrameEntry, Project } from '../projects/model';
import { reconcileSelection, stripTiles, tileImage, visibleWindow } from './stripModel';

const frame = (seq: number, over: Partial<FrameEntry> = {}): FrameEntry => ({
  frameId: `f${seq}`, seq, bytes: 1, sha256: 'x', state: 'local', hiddenUntil: null, ...over,
});
const proj = (frames: FrameEntry[], extra: Partial<Project> = {}) => ({ frames, ...extra }) as Pick<Project, 'frames' | 'cut' | 'stickers'>;

describe('stripTiles', () => {
  it('has one ready tile per frame when nothing was edited', () => {
    expect(stripTiles(proj([frame(1), frame(2)]))).toEqual([
      { entryId: 'f1', frameId: 'f1', state: 'ready', hold: 1, marked: false },
      { entryId: 'f2', frameId: 'f2', state: 'ready', hold: 1, marked: false },
    ]);
  });

  it('follows the cut: order, copies and hold', () => {
    const p = proj([frame(1), frame(2)], {
      cut: [
        { id: 'f2', frameId: 'f2', hold: 3 },
        { id: 'c1', frameId: 'f2', hold: 1 },
        { id: 'f1', frameId: 'f1', hold: 1 },
      ],
    });
    expect(stripTiles(p).map((t) => [t.entryId, t.hold])).toEqual([['f2', 3], ['c1', 1], ['f1', 1]]);
  });

  it('marks the state: deleting, unavailable, off, downloading', () => {
    const p = proj(
      [
        frame(1, { hiddenUntil: '2026-01-01T00:00:00Z' }),
        frame(2, { unavailable: { reason: 'x', since: 's' } }),
        frame(3),
        frame(4, { state: 'pending' }),
        frame(5, { state: 'pending', hiddenUntil: '2026-01-01T00:00:00Z' }),
      ],
      {
        cut: [1, 2, 3, 4, 5].map((n) => ({ id: `f${n}`, frameId: `f${n}`, hold: 1, ...(n === 3 ? { off: true as const } : {}) })),
      },
    );
    expect(stripTiles(p).map((t) => t.state)).toEqual(['deleting', 'unavailable', 'off', 'downloading', 'deleting']);
  });

  it('marks the entries a sticker is shown on', () => {
    const p = proj([frame(1), frame(2), frame(3)], {
      stickers: [{ id: 's1', emoji: '1F436', x: 0.5, y: 0.5, size: 0.25, rot: 0, on: ['f2', 'f3'] }],
    });
    expect(stripTiles(p, 's1').map((t) => t.marked)).toEqual([false, true, true]);
    expect(stripTiles(p, 'nope').map((t) => t.marked)).toEqual([false, false, false]);
    expect(stripTiles(p).map((t) => t.marked)).toEqual([false, false, false]);
  });
});

describe('visibleWindow', () => {
  // pitch 120: index i spans [120 i, 120 i + 112)
  it('covers the viewport plus overscan', () => {
    expect(visibleWindow({ count: 500, scrollLeft: 1200, viewport: 600, pitch: 120, overscan: 2 })).toEqual({ start: 8, end: 17 });
  });
  it('clamps to the ends', () => {
    expect(visibleWindow({ count: 5, scrollLeft: 0, viewport: 2000, pitch: 120, overscan: 3 })).toEqual({ start: 0, end: 5 });
    expect(visibleWindow({ count: 500, scrollLeft: 0, viewport: 240, pitch: 120, overscan: 0 })).toEqual({ start: 0, end: 2 });
  });
  it('is empty for no tiles and tolerates a negative scroll', () => {
    expect(visibleWindow({ count: 0, scrollLeft: 0, viewport: 600, pitch: 120, overscan: 2 })).toEqual({ start: 0, end: 0 });
    expect(visibleWindow({ count: 10, scrollLeft: -50, viewport: 240, pitch: 120, overscan: 0 }).start).toBe(0);
  });
});

describe('reconcileSelection', () => {
  const tiles = stripTiles(proj([frame(1), frame(2)]));
  it('keeps a selection whose entry is still there (by entry id, wherever it moved)', () => {
    expect(reconcileSelection('f2', tiles)).toBe('f2');
    expect(reconcileSelection('f2', [...tiles].reverse())).toBe('f2');
  });
  it('clears when the entry is gone', () => {
    expect(reconcileSelection('c9', tiles)).toBeNull();
    expect(reconcileSelection(null, tiles)).toBeNull();
  });
});

describe('tileImage', () => {
  const urls = (have: Record<string, string>) => (_p: string, f: string, k: 'thumb' | 'play' | 'full') => have[`${f}.${k}`] ?? null;
  it('prefers thumb, then play', () => {
    expect(tileImage(urls({ 'f1.thumb': 'T', 'f1.play': 'P' }), 'p', 'f1')).toEqual({ kind: 'thumb', url: 'T' });
    expect(tileImage(urls({ 'f1.play': 'P' }), 'p', 'f1')).toEqual({ kind: 'play', url: 'P' });
  });
  it('is a placeholder (null) rather than full', () => {
    expect(tileImage(urls({ 'f1.full': 'F' }), 'p', 'f1')).toBeNull();
    expect(tileImage(undefined, 'p', 'f1')).toBeNull();
  });
});
