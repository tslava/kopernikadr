import { describe, expect, it } from 'vitest';
import { ackEligible } from './eligibility';
import { FrameDeletion } from './frameDeletion';
import { FakeFs } from './fakeFs.testutil';
import type { FrameInfo } from './model';
import { duplicateEntry, setHold } from './edit';
import { hideFrame, mergeFrame, setLocal } from './reducers';
import { ProjectStore } from './store';
import { createStore } from '../state/store';

const info = (projectId: string, frameId: string, seq: number): FrameInfo => ({
  frameId, seq, projectId, clientId: 'c', rotation: 0, capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: 'a'.repeat(64) },
});

async function setup(opts: { preHidden?: boolean } = {}) {
  let t = 1_700_000_000_000;
  const fs = new FakeFs();
  const store = new ProjectStore(fs, { now: () => t, newId: () => 'p1' });
  await store.load();
  const p = await store.createProject('Film 1');
  await store.updateProject(p.id, (pr) => {
    pr = { ...pr, cameraId: 'cam' };
    for (const [id, seq] of [['f1', 1], ['f2', 2], ['f3', 3]] as const) pr = setLocal(mergeFrame(pr, info(pr.id, id, seq), 'cam').project, id);
    pr = duplicateEntry(setHold(pr, 'f2', 3), 'f2', 'dup');
    return opts.preHidden ? hideFrame(pr, 'f2', t) : pr;
  });
  for (const f of ['f1', 'f2', 'f3']) for (const k of ['full', 'play', 'thumb']) fs.files.set(`projects/p1/frames/${f}.${k}.jpg`, 'x');
  const log: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const realRemove = fs.remove.bind(fs);
  fs.remove = async (path, o) => { log.push(`remove ${path}`); return realRemove(path, o); };
  const exporting = createStore(false);
  const acks: { ids: string[]; projectOf: Record<string, string> | undefined; eligible: boolean; stillOnDisk: number }[] = [];
  const d = new FrameDeletion({
    store, fs, exporting,
    transfer: {
      ackNow: (ids, projectOf) => {
        const s = store.state.get();
        // the tombstone is committed (the frames are gone from the project and ack-eligible) and the files are unlinked
        acks.push({
          ids, projectOf: projectOf as Record<string, string> | undefined,
          eligible: ids.every((id) => ackEligible({ frameId: id, projectId: 'p1' }, s.projects.p1, s.index)),
          stillOnDisk: [...fs.files.keys()].filter((k) => ids.some((id) => k.includes(`${id}.`)) && k.includes('/frames/')).length,
        });
        log.push(`ack ${ids.join(',')}`);
      },
    },
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    onError: (e) => log.push(`error ${(e as Error).message}`),
  });
  return { fs, store, d, log, timers, acks, exporting, advance: (ms: number) => { t += ms; } };
}

const live = <T extends { live: boolean }>(timers: T[]) => timers.filter((x) => x.live);

describe('FrameDeletion', () => {
  it('fires at the earliest hiddenUntil', async () => {
    const { d, timers, advance } = await setup();
    await d.hide('p1', 'f3');
    expect(live(timers).map((x) => x.ms)).toEqual([5000]);
    advance(2000);
    await d.hide('p1', 'f1');
    // still the f3 deadline (3 s away), not f1's later one
    expect(live(timers).map((x) => x.ms)).toEqual([3000]);
  });

  it('commits, THEN unlinks the three files, THEN calls ackNow with the projectOf map', async () => {
    const { d, store, fs, log, acks, advance } = await setup();
    await d.hide('p1', 'f3');
    advance(5000);
    expect(await d.expireDue()).toEqual(['f3']);
    const s = store.state.get().projects.p1!;
    expect(s.frames.map((f) => f.frameId)).toEqual(['f1', 'f2']);
    expect(s.deletedFrameIds).toEqual(['f3']);
    expect(log).toEqual([
      'remove projects/p1/frames/f3.full.jpg',
      'remove projects/p1/frames/f3.play.jpg',
      'remove projects/p1/frames/f3.thumb.jpg',
      'ack f3',
    ]);
    expect(acks).toEqual([{ ids: ['f3'], projectOf: { f3: 'p1' }, eligible: true, stillOnDisk: 0 }]);
    expect(fs.files.has('projects/p1/frames/f1.full.jpg')).toBe(true);
  });

  it('expiry drops the frame\'s cut entries (all of them) and nothing else', async () => {
    const { d, store, advance } = await setup();
    await d.hide('p1', 'f2');
    advance(5000);
    await d.expireDue();
    expect(store.state.get().projects.p1!.cut!.map((e) => e.id)).toEqual(['f1', 'f3']);
  });

  it('Undo before the deadline cancels: nothing unlinked or acked, the timer is gone', async () => {
    const { d, store, log, timers, advance } = await setup();
    await d.hide('p1', 'f3');
    advance(3000);
    expect(await d.undo('p1', 'f3')).toBe(true);
    expect(live(timers)).toEqual([]);
    advance(10_000);
    expect(await d.expireDue()).toEqual([]);
    expect(log).toEqual([]);
    expect(store.state.get().projects.p1!.frames.find((f) => f.frameId === 'f3')!.hiddenUntil).toBeNull();
  });

  it('Undo after the deadline is refused', async () => {
    const { d, advance } = await setup();
    await d.hide('p1', 'f3');
    advance(5000);
    expect(await d.undo('p1', 'f3')).toBe(false);
  });

  it('a pending deadline from a previous run fires after construction', async () => {
    const { d: first, store, fs, timers, advance } = await setup({ preHidden: true });
    first.dispose();
    timers.length = 0;
    advance(1000);
    const logTimers: { fn: () => void; ms: number }[] = [];
    const second = new FrameDeletion({
      store, fs,
      transfer: { ackNow: () => {} },
      now: () => 1_700_000_001_000,
      setTimer: (fn, ms) => { logTimers.push({ fn, ms }); return 1; },
      clearTimer: () => {},
    });
    expect(logTimers.map((x) => x.ms)).toEqual([4000]);
    second.dispose();
  });

  it('waits while an export runs, and re-arms when it ends', async () => {
    const { d, timers, exporting, advance, store } = await setup();
    await d.hide('p1', 'f3');
    exporting.set(true);
    d.schedule();
    expect(live(timers)).toEqual([]);
    advance(6000);
    expect(await d.expireDue()).toEqual([]);
    expect(store.state.get().projects.p1!.frames).toHaveLength(3);
    exporting.set(false);
    expect(live(timers).map((x) => x.ms)).toEqual([0]);
    expect(await d.expireDue()).toEqual(['f3']);
  });

  it('an unlink failure does not block the ack', async () => {
    const { d, fs, log, acks, advance } = await setup();
    fs.failOn({ op: 'remove', path: /f3\.play\.jpg$/ });
    await d.hide('p1', 'f3');
    advance(5000);
    expect(await d.expireDue()).toEqual(['f3']);
    expect(log.some((l) => l.startsWith('error'))).toBe(true);
    expect(acks.map((a) => a.ids)).toEqual([['f3']]);
    // the other two files were still tried
    expect(log).toContain('remove projects/p1/frames/f3.thumb.jpg');
  });

  it('a failing ack is reported, not thrown', async () => {
    const { store, fs, advance } = await setup();
    const errors: unknown[] = [];
    const d = new FrameDeletion({
      store, fs,
      transfer: { ackNow: () => { throw new Error('offline'); } },
      now: () => 1_700_000_000_000 + 5000,
      setTimer: () => 1,
      clearTimer: () => {},
      onError: (e) => errors.push(e),
    });
    await store.updateProject('p1', (p) => hideFrame(p, 'f3', 1_700_000_000_000));
    advance(0);
    expect(await d.expireDue()).toEqual(['f3']);
    expect(errors).toHaveLength(1);
  });

  it('hide of an unknown or already hidden frame reports false', async () => {
    const { d } = await setup();
    expect(await d.hide('p1', 'nope')).toBe(false);
    expect(await d.hide('p1', 'f3')).toBe(true);
    expect(await d.hide('p1', 'f3')).toBe(false);
  });
});
