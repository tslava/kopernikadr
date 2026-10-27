import { describe, expect, it } from 'vitest';
import type { CutEntry, FrameEntry } from './model';
import { playableItems, timeline } from './timeline';

const frame = (n: number, over: Partial<FrameEntry> = {}): FrameEntry => ({
  frameId: `F${n}`,
  seq: n,
  bytes: 1,
  sha256: `s${n}`,
  state: 'local',
  hiddenUntil: null,
  ...over,
});
const entry = (id: string, frameId: string, over: Partial<CutEntry> = {}): CutEntry => ({ id, frameId, hold: 1, ...over });

describe('timeline', () => {
  it('without a cut: frames in seq order, id == frameId, hold 1', () => {
    const t = timeline({ frames: [frame(3), frame(1), frame(2)] });
    expect(t).toEqual([entry('F1', 'F1'), entry('F2', 'F2'), entry('F3', 'F3')]);
  });
  it('with a cut: cut order, then unreferenced frames in seq order', () => {
    const cut = [entry('F3', 'F3', { hold: 4 }), entry('F1', 'F1'), entry('U1', 'F3')];
    const t = timeline({ frames: [frame(5), frame(1), frame(3), frame(4)], cut });
    expect(t.map((e) => e.id)).toEqual(['F3', 'F1', 'U1', 'F4', 'F5']);
    expect(t[0].hold).toBe(4);
    expect(t[3]).toEqual(entry('F4', 'F4'));
  });
  it('skips entries of frames gone from the pool', () => {
    const t = timeline({ frames: [frame(1), frame(2)], cut: [entry('F9', 'F9'), entry('F2', 'F2'), entry('F1', 'F1')] });
    expect(t.map((e) => e.id)).toEqual(['F2', 'F1']);
  });
  it('an entry of an absent frame is skipped while a pool frame without entries is appended', () => {
    const t = timeline({ frames: [frame(1)], cut: [entry('F2', 'F2')] });
    expect(t.map((e) => e.id)).toEqual(['F1']);
  });
  it('does not mutate its input', () => {
    const frames = [frame(2), frame(1)];
    timeline({ frames });
    expect(frames.map((f) => f.frameId)).toEqual(['F2', 'F1']);
  });
});

describe('playableItems', () => {
  it('filters off, hidden, pending and unavailable entries', () => {
    const frames = [
      frame(1),
      frame(2, { hiddenUntil: '2026-10-27T10:00:05.000Z' }),
      frame(3, { state: 'pending' }),
      frame(4, { unavailable: { reason: 'r', since: 's' } }),
      frame(5),
      frame(6),
    ];
    const cut = [entry('F1', 'F1'), entry('F2', 'F2'), entry('F3', 'F3'), entry('F4', 'F4'), entry('F5', 'F5', { off: true }), entry('D6', 'F6', { hold: 2 })];
    expect(playableItems({ frames, cut })).toEqual([entry('F1', 'F1'), entry('D6', 'F6', { hold: 2 })]);
  });
  it('without a cut it is every playable frame in seq order', () => {
    expect(playableItems({ frames: [frame(2), frame(1, { state: 'pending' })] }).map((e) => e.id)).toEqual(['F2']);
  });
});
