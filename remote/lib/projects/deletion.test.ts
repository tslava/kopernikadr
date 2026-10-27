import { describe, expect, it } from 'vitest';
import { ProjectDeletion } from './deletion';
import { FakeFs } from './fakeFs.testutil';
import { projectDir } from './files';
import { ackEligible } from './eligibility';
import { mergeFrame, setLocal } from './reducers';
import { ProjectStore } from './store';
import type { FrameInfo } from './model';

const info = (projectId: string, frameId: string, seq: number): FrameInfo => ({
  frameId, seq, projectId, clientId: 'c', rotation: 0, capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: 'a'.repeat(64) },
});

async function setup() {
  let t = 1_700_000_000_000;
  const fs = new FakeFs();
  const store = new ProjectStore(fs, { now: () => t, newId: () => 'p1' });
  await store.load();
  const p = await store.createProject('Film 1');
  await store.updateProject(p.id, (pr) => {
    pr = { ...pr, cameraId: 'cam' };
    pr = mergeFrame(pr, info(pr.id, 'f1', 1), 'cam').project;
    pr = mergeFrame(pr, info(pr.id, 'f2', 2), 'cam').project;
    return setLocal(pr, 'f1');
  });
  const log: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const realRemove = fs.remove.bind(fs);
  fs.remove = async (path, opts) => { log.push(`remove ${path}`); return realRemove(path, opts); };
  const d = new ProjectDeletion({
    store, fs,
    transfer: {
      ackNow: (ids) => {
        // the tombstone must already be committed when the ack pass runs
        const s = store.state.get();
        log.push(`ack ${ids.join(',')} eligible=${ids.every((id) => ackEligible({ frameId: id, projectId: 'p1' }, null, s.index))}`);
      },
    },
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  return { fs, store, d, log, timers, advance: (ms: number) => { t += ms; } };
}

describe('ProjectDeletion', () => {
  it('Undo inside the window: nothing acked, nothing removed, project back', async () => {
    const { store, d, log, timers, advance } = await setup();
    expect(await d.requestDelete('p1')).toBe(true);
    const s = store.state.get();
    expect(s.index.pendingProjectDeletes).toHaveLength(1);
    expect(ackEligible({ frameId: 'f1', projectId: 'p1' }, s.projects.p1, s.index)).toBe(false);
    advance(3000);
    expect(await d.undo('p1')).toBe(true);
    expect(store.state.get().index.pendingProjectDeletes).toEqual([]);
    expect(store.state.get().index.deletedProjects).toEqual([]);
    expect(timers.every((x) => !x.live)).toBe(true);
    expect(log).toEqual([]);
  });

  it('arms a timer for the Undo window and acks nothing before it', async () => {
    const { d, log, timers } = await setup();
    await d.requestDelete('p1');
    expect(timers.filter((x) => x.live).map((x) => x.ms)).toEqual([5000]);
    expect(await d.expireDue()).toEqual([]); // too early
    expect(log).toEqual([]);
  });

  it('expiry: commit (tombstone) -> remove dir -> ack pass, in that order', async () => {
    const { fs, store, d, log, timers, advance } = await setup();
    await d.requestDelete('p1');
    advance(5000);
    timers.find((x) => x.live)!.fn();
    await store.idle();
    await new Promise((r) => setTimeout(r, 0));
    const s = store.state.get();
    expect(s.index.deletedProjects).toEqual(['p1']);
    expect(s.index.projects).toEqual([]);
    expect(log).toEqual([`remove ${projectDir('p1')}`, 'ack f1,f2 eligible=true']);
    expect(fs.files.has('projects/p1/project.json')).toBe(false);
  });

  it('Undo after expiry restores nothing', async () => {
    const { d, advance } = await setup();
    await d.requestDelete('p1');
    advance(5000);
    await d.expireDue();
    expect(await d.undo('p1')).toBe(false);
  });

  it('a failing dir removal does not stop the ack pass', async () => {
    const { fs, d, log, advance } = await setup();
    fs.remove = async () => { throw new Error('io'); };
    await d.requestDelete('p1');
    advance(5000);
    await d.expireDue();
    expect(log).toEqual(['ack f1,f2 eligible=true']);
  });

  it('deleting an unknown or already pending project is a no-op', async () => {
    const { d } = await setup();
    expect(await d.requestDelete('nope')).toBe(false);
    expect(await d.requestDelete('p1')).toBe(true);
    expect(await d.requestDelete('p1')).toBe(false);
  });
});
