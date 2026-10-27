import { describe, expect, it } from 'vitest';
import {
  changeHold,
  deleteEntry,
  duplicateEntry,
  endHere,
  moveEntry,
  pruneEdits,
  setHold,
  setOff,
  startHere,
} from './edit';
import type { FrameEntry, Project, Sticker } from './model';
import { expireFrames, hideFrame } from './reducers';
import { timeline } from './timeline';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const frame = (n: number, over: Partial<FrameEntry> = {}): FrameEntry => ({
  frameId: `F${n}`,
  seq: n,
  bytes: 1,
  sha256: `s${n}`,
  state: 'local',
  hiddenUntil: null,
  ...over,
});
const sticker = (id: string, on: string[]): Sticker => ({ id, emoji: '1F436', x: 0.5, y: 0.5, size: 0.2, rot: 0, on });
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
const ids = (p: Project) => timeline(p).map((e) => e.id);

/** The invariant: every non-hidden frame has at least one entry (or `cut` is absent). */
function invariant(p: Project): void {
  if (!p.cut) return;
  for (const f of p.frames) if (f.hiddenUntil === null) expect(p.cut.some((e) => e.frameId === f.frameId)).toBe(true);
}

describe('materialize', () => {
  it('the first edit writes cut = timeline() and applies the change', () => {
    const p = setHold(project(3), 'F2', 4);
    expect(p.cut).toEqual([
      { id: 'F1', frameId: 'F1', hold: 1 },
      { id: 'F2', frameId: 'F2', hold: 4 },
      { id: 'F3', frameId: 'F3', hold: 1 },
    ]);
  });
  it('a no-op edit does not materialize', () => {
    const p = project(3);
    expect(setHold(p, 'F2', 1)).toBe(p);
    expect(setHold(p, 'nope', 3)).toBe(p);
    expect(p.cut).toBeUndefined();
  });
});

describe('duplicateEntry', () => {
  it('inserts a new entry right after the source, same frame and hold', () => {
    const p = duplicateEntry(setHold(project(3), 'F2', 3), 'F2', 'D1');
    expect(ids(p)).toEqual(['F1', 'F2', 'D1', 'F3']);
    expect(p.cut![2]).toEqual({ id: 'D1', frameId: 'F2', hold: 3 });
    invariant(p);
  });
  it('copies the sticker membership of the source entry', () => {
    const p = duplicateEntry(project(3, { stickers: [sticker('S1', ['F2', 'F3']), sticker('S2', ['F1'])] }), 'F2', 'D1');
    expect(p.stickers![0]!.on).toEqual(['F2', 'F3', 'D1']);
    expect(p.stickers![1]!.on).toEqual(['F1']);
  });
  it('an off entry is copied off', () => {
    const p = duplicateEntry(setOff(project(2), 'F1', true), 'F1', 'D1');
    expect(p.cut![1]).toEqual({ id: 'D1', frameId: 'F1', hold: 1, off: true });
  });
  it('unknown source or a taken id: same reference', () => {
    const p = project(2);
    expect(duplicateEntry(p, 'nope', 'D1')).toBe(p);
    expect(duplicateEntry(p, 'F1', 'F2')).toBe(p);
  });
});

describe('hold', () => {
  it('is clamped to 1..8', () => {
    let p = project(2);
    for (let i = 0; i < 10; i++) p = changeHold(p, 'F1', 1);
    expect(p.cut![0]!.hold).toBe(8);
    const same = changeHold(p, 'F1', 1);
    expect(same).toBe(p);
    for (let i = 0; i < 10; i++) p = changeHold(p, 'F1', -1);
    expect(p.cut![0]!.hold).toBe(1);
    expect(setHold(p, 'F1', 99).cut![0]!.hold).toBe(8);
    expect(setHold(p, 'F1', -5)).toBe(p);
  });
});

describe('moveEntry', () => {
  it('moves one step left and right', () => {
    const p = project(3);
    expect(ids(moveEntry(p, 'F2', -1))).toEqual(['F2', 'F1', 'F3']);
    expect(ids(moveEntry(p, 'F2', 1))).toEqual(['F1', 'F3', 'F2']);
  });
  it('at the ends: same reference, nothing materialized', () => {
    const p = project(3);
    expect(moveEntry(p, 'F1', -1)).toBe(p);
    expect(moveEntry(p, 'F3', 1)).toBe(p);
    expect(moveEntry(p, 'nope', 1)).toBe(p);
  });
  it('steps over entries of frames in their Undo window', () => {
    const p = hideFrame(project(4), 'F2', T0);
    expect(ids(moveEntry(p, 'F1', 1))).toEqual(['F2', 'F3', 'F1', 'F4']);
    expect(ids(moveEntry(p, 'F3', -1))).toEqual(['F3', 'F1', 'F2', 'F4']);
  });
});

describe('off / on', () => {
  it('switches an entry off and back on, keeping the frame', () => {
    const off = setOff(project(2), 'F1', true);
    expect(off.cut![0]).toEqual({ id: 'F1', frameId: 'F1', hold: 1, off: true });
    expect(off.frames).toHaveLength(2);
    const on = setOff(off, 'F1', false);
    expect(on.cut![0]).toEqual({ id: 'F1', frameId: 'F1', hold: 1 });
    expect('off' in on.cut![0]!).toBe(false);
    expect(setOff(off, 'F1', true)).toBe(off);
  });
  it('start here turns off everything before the entry', () => {
    const p = startHere(project(4), 'F3');
    expect(p.cut!.map((e) => !!e.off)).toEqual([true, true, false, false]);
    expect(startHere(p, 'F3')).toBe(p);
    expect(startHere(project(4), 'F1').cut).toBeUndefined();
  });
  it('end here turns off everything after the entry', () => {
    const p = endHere(project(4), 'F2');
    expect(p.cut!.map((e) => !!e.off)).toEqual([false, false, true, true]);
    expect(endHere(p, 'F2')).toBe(p);
    expect(endHere(project(4), 'F4').cut).toBeUndefined();
  });
});

describe('deleteEntry', () => {
  it('the last entry of a frame: asks the caller to hide the frame, project untouched', () => {
    const p = project(3);
    const r = deleteEntry(p, 'F2');
    expect(r.project).toBe(p);
    expect(r.hideFrameId).toBe('F2');
  });
  it('a duplicate entry is removed alone; the frame and the original stay', () => {
    const dup = duplicateEntry(project(3), 'F2', 'D1');
    const r = deleteEntry(dup, 'D1');
    expect(r.hideFrameId).toBeNull();
    expect(ids(r.project)).toEqual(['F1', 'F2', 'F3']);
    expect(r.project.frames).toHaveLength(3);
    invariant(r.project);
  });
  it('deleting the original while a copy exists leaves the copy (no re-append of the frame)', () => {
    const dup = duplicateEntry(project(3), 'F2', 'D1');
    const r = deleteEntry(dup, 'F2');
    expect(ids(r.project)).toEqual(['F1', 'D1', 'F3']);
    invariant(r.project);
  });
  it('drops the entry from the stickers; an emptied sticker goes', () => {
    const withStickers = project(3, { stickers: [sticker('S1', ['F1']), sticker('S2', ['F1', 'F3'])] });
    const dup = duplicateEntry(withStickers, 'F1', 'D1');
    expect(dup.stickers!.map((s) => s.on)).toEqual([['F1', 'D1'], ['F1', 'F3', 'D1']]);
    // S1 lives only on the copy
    const r = deleteEntry({ ...dup, stickers: [sticker('S1', ['D1']), sticker('S2', ['F1', 'D1'])] }, 'D1');
    expect(r.project.stickers!.map((s) => s.id)).toEqual(['S2']);
    expect(r.project.stickers![0]!.on).toEqual(['F1']);
  });
  it('an unknown entry: same reference, no hide', () => {
    const p = project(2);
    expect(deleteEntry(p, 'nope')).toEqual({ project: p, hideFrameId: null });
  });
});

describe('invariant and new captures', () => {
  it('holds after every reducer', () => {
    let p = project(5);
    const steps: ((p: Project) => Project)[] = [
      (x) => setHold(x, 'F2', 3),
      (x) => duplicateEntry(x, 'F3', 'D1'),
      (x) => moveEntry(x, 'F1', 1),
      (x) => setOff(x, 'F5', true),
      (x) => startHere(x, 'F2'),
      (x) => endHere(x, 'F4'),
      (x) => deleteEntry(x, 'D1').project,
      (x) => setOff(x, 'F5', false),
    ];
    for (const s of steps) {
      p = s(p);
      invariant(p);
      expect([...new Set(timeline(p).map((e) => e.frameId))].sort()).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
    }
  });
  it('a frame captured after the edits appears at the end', () => {
    const p = moveEntry(project(3), 'F1', 1);
    const later: Project = { ...p, frames: [...p.frames, frame(4)] };
    expect(ids(later)).toEqual(['F2', 'F1', 'F3', 'F4']);
  });
  it('a hidden frame keeps its entry, and a restored Undo is whole', () => {
    const p = hideFrame(setHold(project(2), 'F1', 2), 'F1', T0);
    invariant(p);
    expect(p.cut!.some((e) => e.frameId === 'F1')).toBe(true);
  });
});

describe('pruneEdits', () => {
  it('same reference when everything is live', () => {
    const p = project(2, { cut: timeline(project(2)), stickers: [sticker('S', ['F1'])] });
    expect(pruneEdits(p)).toBe(p);
    const bare = project(2);
    expect(pruneEdits(bare)).toBe(bare);
  });
  it('drops entries of gone frames, dead ids and emptied stickers', () => {
    const p = expireFrames(
      hideFrame(setHold(project(3, { stickers: [sticker('S1', ['F2']), sticker('S2', ['F2', 'F3'])] }), 'F1', 2), 'F2', T0),
      T0 + 5000,
    ).project;
    expect(ids(p)).toEqual(['F1', 'F3']);
    expect(p.stickers!.map((s) => [s.id, s.on])).toEqual([['S2', ['F3']]]);
  });
});
