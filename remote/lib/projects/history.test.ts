import { describe, expect, it } from 'vitest';
import { duplicateEntry, setHold, setOff } from './edit';
import { EditHistory, HISTORY_CAP, restoreSnapshot } from './history';
import type { FrameEntry, Project, Sticker } from './model';
import { expireFrames, hideFrame } from './reducers';
import { timeline } from './timeline';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const frame = (n: number): FrameEntry => ({ frameId: `F${n}`, seq: n, bytes: 1, sha256: `s${n}`, state: 'local', hiddenUntil: null });
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

/** Applies an edit and records it, the way the controller will. */
function edit(h: EditHistory, p: Project, fn: (p: Project) => Project): Project {
  const next = fn(p);
  h.record(p.id, p, next);
  return next;
}
function undo(h: EditHistory, p: Project): Project {
  const snap = h.pop(p.id);
  return snap ? restoreSnapshot(p, snap) : p;
}

describe('EditHistory', () => {
  it('push then undo restores the previous cut; no redo', () => {
    const h = new EditHistory();
    const p0 = project(3);
    const p1 = edit(h, p0, (p) => setHold(p, 'F1', 3));
    const p2 = edit(h, p1, (p) => setOff(p, 'F2', true));
    expect(h.canUndo('P')).toBe(true);
    const back1 = undo(h, p2);
    expect(back1.cut).toEqual(p1.cut);
    const back0 = undo(h, back1);
    expect(back0.cut).toBeUndefined();
    expect(h.canUndo('P')).toBe(false);
    expect(h.pop('P')).toBeUndefined();
  });

  it('a no-op edit does not push', () => {
    const h = new EditHistory();
    const p = project(2);
    edit(h, p, (x) => setHold(x, 'F1', 1));
    edit(h, p, (x) => setOff(x, 'F1', false));
    expect(h.canUndo('P')).toBe(false);
  });

  it('keeps the last 30', () => {
    const h = new EditHistory();
    let p = project(2);
    for (let i = 0; i < HISTORY_CAP + 10; i++) p = edit(h, p, (x) => setHold(x, 'F1', (i % 7) + 2 === x.cut?.[0]?.hold ? 1 : (i % 7) + 2));
    let n = 0;
    while (h.pop('P')) n++;
    expect(n).toBe(HISTORY_CAP);
  });

  it('is per project', () => {
    const h = new EditHistory();
    const a = project(2);
    const b = { ...project(2), id: 'Q' };
    edit(h, a, (p) => setHold(p, 'F1', 2));
    expect(h.canUndo('P')).toBe(true);
    expect(h.canUndo('Q')).toBe(false);
    edit(h, b, (p) => setHold(p, 'F1', 2));
    h.clear('P');
    expect(h.canUndo('P')).toBe(false);
    expect(h.canUndo('Q')).toBe(true);
  });

  it('a duplicate-entry delete style edit (cut + stickers) comes back whole', () => {
    const h = new EditHistory();
    const p0 = project(2, { stickers: [sticker('S', ['F1'])] });
    const p1 = edit(h, p0, (p) => duplicateEntry(p, 'F1', 'D1'));
    expect(p1.stickers![0]!.on).toEqual(['F1', 'D1']);
    const back = undo(h, p1);
    expect(back.stickers).toEqual(p0.stickers);
    expect(timeline(back).map((e) => e.id)).toEqual(['F1', 'F2']);
  });
});

describe('restoreSnapshot', () => {
  it('re-prunes against the current frames: an expired frame does not come back', () => {
    const h = new EditHistory();
    const p0 = project(3);
    const p1 = edit(h, p0, (p) => setHold(p, 'F2', 4));
    const expired = expireFrames(hideFrame(p1, 'F2', T0), T0 + 5000).project;
    const back = undo(h, expired);
    expect(timeline(back).map((e) => e.id)).toEqual(['F1', 'F3']);
    expect(back.deletedFrameIds).toEqual(['F2']);
  });

  it('an emptied sticker stays gone', () => {
    const h = new EditHistory();
    const p0 = project(3, { stickers: [sticker('S', ['F2'])] });
    const p1 = edit(h, p0, (p) => setHold(p, 'F1', 2));
    const expired = expireFrames(hideFrame(p1, 'F2', T0), T0 + 5000).project;
    expect(expired.stickers).toEqual([]);
    // the snapshot still carries the sticker; restoring prunes it again
    const back = undo(h, { ...expired, stickers: [] });
    expect(back.stickers).toEqual([]);
  });

  it('keeps everything else of the current project (new frames, fps)', () => {
    const h = new EditHistory();
    const p0 = project(2);
    const p1 = edit(h, p0, (p) => setHold(p, 'F1', 2));
    const now: Project = { ...p1, fps: 12, frames: [...p1.frames, frame(3)] };
    const back = undo(h, now);
    expect(back.fps).toBe(12);
    expect(timeline(back).map((e) => e.id)).toEqual(['F1', 'F2', 'F3']);
  });
});
