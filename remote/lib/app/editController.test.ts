import { describe, expect, it } from 'vitest';
import { createStore } from '../state/store';
import { FakeFs } from '../projects/fakeFs.testutil';
import { FrameDeletion } from '../projects/frameDeletion';
import type { FrameInfo, Project } from '../projects/model';
import { mergeFrame, setLocal } from '../projects/reducers';
import { ProjectStore } from '../projects/store';
import { timeline } from '../projects/timeline';
import { EditController, toolStates } from './editController';

const info = (projectId: string, frameId: string, seq: number): FrameInfo => ({
  frameId, seq, projectId, clientId: 'c', rotation: 0, capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: 'a'.repeat(64) },
});

async function setup(frames = 5) {
  let t = 1_700_000_000_000;
  let n = 0;
  const fs = new FakeFs();
  const store = new ProjectStore(fs, { now: () => t, newId: () => 'p1' });
  await store.load();
  const p = await store.createProject('Film 1');
  await store.updateProject(p.id, (pr) => {
    pr = { ...pr, cameraId: 'cam' };
    for (let i = 1; i <= frames; i++) pr = setLocal(mergeFrame(pr, info(pr.id, `f${i}`, i), 'cam').project, `f${i}`);
    return pr;
  });
  const exporting = createStore(false);
  const acks: string[][] = [];
  const timers: (() => void)[] = [];
  const frameDeletion = new FrameDeletion({
    store, fs, exporting,
    transfer: { ackNow: (ids) => { acks.push(ids); } },
    now: () => t,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  const c = new EditController({ store, frameDeletion, exporting, newId: () => `new${++n}` });
  const project = () => store.state.get().projects.p1!;
  const ids = () => timeline(project()).map((e) => e.id);
  return { c, store, exporting, project, ids, advance: (ms: number) => { t += ms; }, acks, frameDeletion };
}

describe('EditController', () => {
  it('each tool runs its reducer through updateProject', async () => {
    const { c, project, ids } = await setup();
    expect(await c.duplicate('p1', 'f2')).toBe(true);
    expect(ids()).toEqual(['f1', 'f2', 'new1', 'f3', 'f4', 'f5']);
    await c.hold('p1', 'f3', 1);
    await c.hold('p1', 'f3', 1);
    await c.hold('p1', 'f3', 1);
    expect(timeline(project()).find((e) => e.id === 'f3')!.hold).toBe(4);
    await c.move('p1', 'f5', -1);
    expect(ids()).toEqual(['f1', 'f2', 'new1', 'f3', 'f5', 'f4']);
    await c.off('p1', 'f4', true);
    expect(timeline(project()).find((e) => e.id === 'f4')!.off).toBe(true);
    await c.off('p1', 'f4', false);
    expect(timeline(project()).find((e) => e.id === 'f4')!.off).toBeUndefined();
    await c.startHere('p1', 'f2');
    expect(timeline(project()).filter((e) => e.off).map((e) => e.id)).toEqual(['f1']);
    await c.endHere('p1', 'f3');
    expect(timeline(project()).filter((e) => e.off).map((e) => e.id)).toEqual(['f1', 'f5', 'f4']);
  });

  it('a no-op tool changes nothing and records nothing', async () => {
    const { c, project } = await setup();
    const before = project();
    expect(await c.move('p1', 'f1', -1)).toBe(false);
    expect(await c.hold('p1', 'f1', -1)).toBe(false);
    expect(project()).toBe(before);
    expect(c.canUndo('p1')).toBe(false);
  });

  it('Cofnij restores the previous {cut, stickers}, newest first, and tools push history', async () => {
    const { c, project, ids } = await setup();
    await c.duplicate('p1', 'f2');
    await c.off('p1', 'f4', true);
    expect(c.canUndo('p1')).toBe(true);
    await c.undo('p1');
    expect(timeline(project()).find((e) => e.id === 'f4')!.off).toBeUndefined();
    expect(ids()).toContain('new1');
    await c.undo('p1');
    expect(ids()).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(c.canUndo('p1')).toBe(false);
    expect(await c.undo('p1')).toBe(false);
  });

  it('Delete of a duplicate entry removes the entry (original stays) and is in history', async () => {
    const { c, project, ids } = await setup();
    await c.duplicate('p1', 'f2');
    expect(await c.delete('p1', 'new1')).toBe('entry');
    expect(ids()).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(project().frames.every((f) => f.hiddenUntil === null)).toBe(true);
    await c.undo('p1');
    expect(ids()).toContain('new1');
  });

  it('Delete of the last entry starts the frame Undo window instead of editing the cut', async () => {
    const { c, project, ids, frameDeletion, advance, acks } = await setup();
    await c.hold('p1', 'f3', 1);
    const cut = project().cut;
    expect(await c.delete('p1', 'f1')).toBe('frame');
    expect(project().cut).toBe(cut);
    expect(project().frames.find((f) => f.frameId === 'f1')!.hiddenUntil).not.toBeNull();
    // not in the Cofnij history: that is the frame's own Undo
    await c.undo('p1');
    expect(project().frames.find((f) => f.frameId === 'f1')!.hiddenUntil).not.toBeNull();
    expect(await frameDeletion.undo('p1', 'f1')).toBe(true);
    expect(ids()).toContain('f1');
    // and let it expire
    await c.delete('p1', 'f1');
    advance(5000);
    expect(await frameDeletion.expireDue()).toEqual(['f1']);
    expect(ids()).toEqual(['f2', 'f3', 'f4', 'f5']);
    expect(acks).toEqual([['f1']]);
  });

  it('does nothing while an export runs', async () => {
    const { c, project, exporting } = await setup();
    await c.duplicate('p1', 'f2');
    const before = project();
    exporting.set(true);
    expect(await c.duplicate('p1', 'f1')).toBe(false);
    expect(await c.hold('p1', 'f1', 1)).toBe(false);
    expect(await c.delete('p1', 'f1')).toBe('none');
    expect(await c.undo('p1')).toBe(false);
    expect(project()).toBe(before);
    expect(c.canUndo('p1')).toBe(true);
  });
});

describe('toolStates', () => {
  const p = async (): Promise<Project> => (await setup()).project();
  const free = { exporting: false, canUndo: false };

  it('all off without a selection, Cofnij follows the history', async () => {
    const pr = await p();
    expect(Object.values(toolStates(pr, null, free)).some(Boolean)).toBe(false);
    expect(toolStates(pr, null, { exporting: false, canUndo: true }).undo).toBe(true);
    expect(toolStates(pr, 'gone', free).delete).toBe(false);
  });

  it('move at the edges, hold at 1 and 8, trim with nothing to trim', async () => {
    const pr = await p();
    const first = toolStates(pr, 'f1', free);
    expect(first).toMatchObject({ moveLeft: false, moveRight: true, holdDown: false, holdUp: true, startHere: false, endHere: true, delete: true, duplicate: true, off: true });
    const last = toolStates(pr, 'f5', free);
    expect(last).toMatchObject({ moveLeft: true, moveRight: false, startHere: true, endHere: false });
    const max = { ...pr, cut: timeline(pr).map((e) => (e.id === 'f3' ? { ...e, hold: 8 } : e)) };
    expect(toolStates(max, 'f3', free)).toMatchObject({ holdUp: false, holdDown: true });
  });

  it('everything is off while exporting, and for an entry in its Undo window', async () => {
    const pr = await p();
    expect(Object.values(toolStates(pr, 'f2', { exporting: true, canUndo: true })).some(Boolean)).toBe(false);
    const hidden = { ...pr, frames: pr.frames.map((f) => (f.frameId === 'f2' ? { ...f, hiddenUntil: '2099-01-01T00:00:00.000Z' } : f)) };
    const s = toolStates(hidden, 'f2', { exporting: false, canUndo: true });
    expect(s.delete || s.duplicate || s.off).toBe(false);
    expect(s.undo).toBe(true);
  });
});
