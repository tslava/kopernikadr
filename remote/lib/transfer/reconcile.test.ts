import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../camera/client';
import { FakeFs } from '../projects/fakeFs.testutil';
import type { FrameInfo, Project } from '../projects/model';
import { mergeFrame } from '../projects/reducers';
import { ProjectStore } from '../projects/store';
import { LOST_REASON, createReconcile } from './reconcile';

const CAM = 'cam-A';
const NOW = Date.parse('2026-10-27T10:00:00.000Z');
const sha = 'a'.repeat(64);
let n = 0;

const info = (projectId: string, frameId: string, seq: number): FrameInfo => ({
  frameId,
  seq,
  projectId,
  clientId: 'me',
  rotation: 0,
  capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: sha },
});

async function rig(opts: { camera?: string | null; frames?: [string, 'pending' | 'local'][] } = {}) {
  const store = new ProjectStore(new FakeFs(), { now: () => NOW, newId: () => `id-${++n}` });
  await store.load();
  await store.updateIndex((i) => ({ ...i, clientId: 'me' }));
  const p = await store.createProject('Film');
  const camera = opts.camera === undefined ? CAM : opts.camera;
  await store.updateProject(p.id, (cur) => {
    let x: Project = { ...cur, cameraId: camera };
    (opts.frames ?? []).forEach(([id, state], i) => {
      x = mergeFrame({ ...x, cameraId: CAM }, info(p.id, id, i + 1), CAM).project;
      x = { ...x, cameraId: camera, frames: x.frames.map((f) => (f.frameId === id ? { ...f, state } : f)) };
    });
    return x;
  });
  const calls: string[] = [];
  const acks: string[][] = [];
  const projectOfs: Record<string, string>[] = [];
  const transfer = {
    enqueue: vi.fn((f: string, pid: string) => void calls.push(`enqueue ${f}@${pid}`)),
    ackNow: vi.fn((ids: string[], po?: Record<string, string>) => {
      acks.push(ids);
      projectOfs.push(po ?? {});
    }),
    kick: vi.fn(() => void calls.push('kick')),
    retryUnavailable: vi.fn(async () => 0),
  };
  const pages: { frames: FrameInfo[]; hasMore: boolean }[] = [];
  const requests: object[] = [];
  const listed = { frames: [] as FrameInfo[], fail: false };
  const request = vi.fn(async (op: string, args: { afterSeq?: number; limit?: number }) => {
    expect(op).toBe('listFrames');
    requests.push(args);
    if (listed.fail) throw new Error('offline');
    const after = args.afterSeq ?? 0;
    const rest = listed.frames.filter((f) => f.seq > after).sort((a, b) => a.seq - b.seq);
    const lim = args.limit ?? 100;
    return { frames: rest.slice(0, lim), hasMore: rest.length > lim };
  });
  void pages;
  const reports: unknown[] = [];
  const run = (limit?: number) =>
    createReconcile({
      store,
      transfer,
      now: () => NOW,
      newId: () => `new-${++n}`,
      formatDate: () => '27.10.2026',
      ...(limit ? { pageLimit: limit } : {}),
      onReport: (r) => reports.push(r),
    })({ hello: { cameraId: CAM }, request } as unknown as SessionContext);
  const proj = (id = p.id) => store.state.get().projects[id]!;
  return { store, p, transfer, calls, acks, projectOfs, listed, requests, run, proj, reports };
}

describe('reconcile', () => {
  it('ack-eligible (local) -> ackNow; pending -> enqueue; nothing else is acked', async () => {
    const r = await rig({ frames: [['L', 'local'], ['P', 'pending']] });
    r.listed.frames = [info(r.p.id, 'L', 1), info(r.p.id, 'P', 2)];
    await r.run();
    expect(r.acks).toEqual([['L']]);
    expect(r.transfer.enqueue).toHaveBeenCalledWith('P', r.p.id);
    expect(r.calls.at(-1)).toBe('kick');
  });

  it('a tombstoned frame is acked (never merged again)', async () => {
    const r = await rig();
    await r.store.updateProject(r.p.id, (p) => ({ ...p, deletedFrameIds: ['T'] }));
    r.listed.frames = [info(r.p.id, 'T', 1)];
    await r.run();
    expect(r.acks).toEqual([['T']]);
    expect(r.proj().frames).toEqual([]);
  });

  it('pages through listFrames with afterSeq', async () => {
    const r = await rig();
    r.listed.frames = [1, 2, 3, 4, 5].map((i) => info(r.p.id, `F${i}`, i));
    await r.run(2);
    expect(r.requests).toEqual([{ limit: 2 }, { afterSeq: 2, limit: 2 }, { afterSeq: 4, limit: 2 }]);
    expect(r.proj().frames.map((f) => f.frameId)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
    // oldest first, so the newest ends up at the front of the download queue
    expect(r.transfer.enqueue.mock.calls.map((c) => c[0])).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
  });

  it('unknown frame in a live project of this camera: merged pending, enqueued, not acked', async () => {
    const r = await rig();
    r.listed.frames = [info(r.p.id, 'N', 7)];
    await r.run();
    expect(r.proj().frames).toMatchObject([{ frameId: 'N', seq: 7, state: 'pending' }]);
    expect(r.transfer.enqueue).toHaveBeenCalledWith('N', r.p.id);
    expect(r.acks).toEqual([]);
  });

  it('unknown frame in a project with cameraId null: binds to this camera, then merges', async () => {
    const r = await rig({ camera: null });
    r.listed.frames = [info(r.p.id, 'N', 1)];
    await r.run();
    expect(r.proj().cameraId).toBe(CAM);
    expect(r.proj().frames).toHaveLength(1);
  });

  it('a project bound to another camera: the frame goes to a recovered project, the project is untouched', async () => {
    const r = await rig({ camera: 'cam-OTHER' });
    r.listed.frames = [info(r.p.id, 'N', 1), info(r.p.id, 'M', 2)];
    await r.run();
    expect(r.proj().frames).toEqual([]);
    const rec = Object.values(r.store.state.get().projects).filter((p) => p.id !== r.p.id);
    expect(rec).toHaveLength(1); // both frames in ONE recovered project
    expect(rec[0]).toMatchObject({ name: 'Odzyskany 27.10.2026', cameraId: CAM });
    expect(rec[0]!.frames.map((f) => f.frameId)).toEqual(['N', 'M']);
    expect(r.transfer.enqueue).toHaveBeenCalledWith('N', rec[0]!.id);
    expect(r.acks).toEqual([]);
    // next session: already known -> resumes, no second recovered project
    await r.run();
    expect(Object.keys(r.store.state.get().projects)).toHaveLength(2);
  });

  it('unknown projectId (not tombstoned): "Odzyskany <date>" with that id, bound to this camera', async () => {
    const r = await rig();
    r.listed.frames = [{ ...info('lost-proj', 'N', 1), rotation: 180 }, info('lost-proj', 'M', 2)];
    await r.run();
    const rec = r.store.state.get().projects['lost-proj']!;
    expect(rec).toMatchObject({ name: 'Odzyskany 27.10.2026', cameraId: CAM, geometry: { rotation: 180 } });
    expect(rec.frames.map((f) => f.frameId)).toEqual(['N', 'M']);
    expect(r.store.state.get().index.projects.some((p) => p.id === 'lost-proj')).toBe(true);
    expect(r.acks).toEqual([]);
  });

  it('a tombstoned project: frames are acked (via projectOf), never merged', async () => {
    const r = await rig();
    await r.store.updateIndex((i) => ({ ...i, deletedProjects: ['gone'] }));
    r.listed.frames = [info('gone', 'G', 1)];
    await r.run();
    expect(r.acks).toEqual([['G']]);
    expect(r.projectOfs[0]).toEqual({ G: 'gone' });
    expect(r.store.state.get().projects.gone).toBeUndefined();
  });

  it('a pending frame of this camera that vanished: unavailable "lost on the phone", not acked, not enqueued', async () => {
    const r = await rig({ frames: [['V', 'pending'], ['K', 'pending']] });
    r.listed.frames = [info(r.p.id, 'K', 2)];
    await r.run();
    expect(r.proj().frames.find((f) => f.frameId === 'V')!.unavailable).toMatchObject({ reason: LOST_REASON });
    expect(r.proj().frames.find((f) => f.frameId === 'K')!.unavailable).toBeUndefined();
    expect(r.reports[0]).toMatchObject({ lost: ['V'] });
    expect(r.acks).toEqual([]);
  });

  it('a local frame or another camera\'s pending frame that is not listed is left alone', async () => {
    const r = await rig({ frames: [['L', 'local']] });
    const other = await r.store.createProject('Inna');
    await r.store.updateProject(other.id, (p) => ({ ...mergeFrame({ ...p, cameraId: 'cam-X' }, info(p.id, 'X', 1), 'cam-X').project }));
    r.listed.frames = [];
    await r.run();
    expect(r.proj().frames[0]!.unavailable).toBeUndefined();
    expect(r.proj(other.id).frames[0]!.unavailable).toBeUndefined();
  });

  it('a frame merged after the listing started is not "lost"', async () => {
    const r = await rig();
    let raced = false;
    const base = r.listed;
    const run = createReconcile({ store: r.store, transfer: r.transfer, now: () => NOW, formatDate: () => 'd' });
    await run({
      hello: { cameraId: CAM },
      request: async () => {
        if (!raced) {
          raced = true;
          await r.store.updateProject(r.p.id, (p) => mergeFrame(p, info(p.id, 'RACE', 9), CAM).project);
        }
        return { frames: base.frames, hasMore: false };
      },
    } as unknown as SessionContext);
    expect(r.proj().frames[0]!.unavailable).toBeUndefined();
  });

  it('retryUnavailable runs only when a listed frame is flagged', async () => {
    const r = await rig({ frames: [['U', 'pending']] });
    r.listed.frames = [info(r.p.id, 'U', 1)];
    await r.run();
    expect(r.transfer.retryUnavailable).not.toHaveBeenCalled();
    await r.store.updateProject(r.p.id, (p) => ({ ...p, frames: p.frames.map((f) => ({ ...f, unavailable: { reason: 'http 404', since: 'x' } })) }));
    await r.run();
    expect(r.transfer.retryUnavailable).toHaveBeenCalledTimes(1);
  });

  it('a failing listFrames: nothing changes, nothing is marked lost, kick still runs', async () => {
    const r = await rig({ frames: [['P', 'pending']] });
    r.listed.fail = true;
    await expect(r.run()).rejects.toThrow('offline');
    expect(r.proj().frames[0]!.unavailable).toBeUndefined();
    expect(r.calls).toEqual(['kick']);
  });

  it('frames of another clientId are ignored', async () => {
    const r = await rig();
    r.listed.frames = [{ ...info(r.p.id, 'Z', 1), clientId: 'someone-else' }];
    await r.run();
    expect(r.proj().frames).toEqual([]);
  });
});
