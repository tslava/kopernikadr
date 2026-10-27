// Integration: boot() with the real CameraClient + capture + transfer + reconcile against the Node
// fake camera (real HTTP + WebSocket). The tablet side is an in-memory FakeFs (project files AND
// downloaded frames) plus a TransferIO that behaves like installFile / writeTextAtomic (verified
// size + sha256, tmp -> dest), with a crash point. Timing is short (capture constants, a clock
// that runs 200x faster for the download backoff).
//
// The safety property asserted everywhere: the fake camera's `acked` set only ever holds frames
// that are `local` on the tablet (or tombstoned / of a deleted project).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { NsdAdapter } from '../discovery';
import { createCapture } from '../capture/capture';
import { boot, type AppContext } from '../app/boot';
import { startFakeCamera, type FakeCamera } from '../probes/fakeCamera.testutil';
import { FakeFs } from '../projects/fakeFs.testutil';
import { ProjectStore } from '../projects/store';
import type { Project } from '../projects/model';
import type { Clock } from './ack';
import { DownloadError, type TransferIO } from './download';
import { createTransfer, type TransferService } from './queue';
import { createReconcile } from './reconcile';

const nsd: NsdAdapter = { start: async () => {}, stop: async () => {} };
const until = async (cond: () => boolean, what: string, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const hit = async (cam: FakeCamera, path: string) => (await fetch(`http://127.0.0.1:${cam.port}${path}`)).json();
const nativeErr = (code: string) => Object.assign(new Error(code), { code });

/** 200x faster than real time: backoff (1/4/10 s) and storage waits pass in milliseconds. */
function fastClock(): Clock {
  const t0 = Date.now();
  return {
    now: () => (Date.now() - t0) * 200,
    schedule(ms, fn) {
      const t = setTimeout(fn, ms / 200);
      return () => clearTimeout(t);
    },
  };
}

interface Hooks {
  hold: Promise<void> | null;
  /** the `ack` request never reaches the camera (the process dies between the local commit and the ack) */
  dropAck?: boolean;
  afterInstall?: () => void;
}

function makeIO(fs: FakeFs, hooks: Hooks): TransferIO {
  return {
    freeBytes: async () => 1e12,
    mkdir: async () => {},
    async download(url, tmp) {
      await hooks.hold;
      const res = await fetch(url);
      if (!res.ok) throw new DownloadError('http', `http ${res.status}`, { status: res.status });
      fs.files.set(tmp, Buffer.from(await res.arrayBuffer()).toString('latin1'));
    },
    async installFile({ tmp, dest, bytes, sha256 }) {
      const got = fs.files.get(tmp);
      if (got === undefined) throw nativeErr('NOT_FOUND');
      const buf = Buffer.from(got, 'latin1');
      if (buf.length !== bytes || createHash('sha256').update(buf).digest('hex') !== sha256) throw nativeErr('CHECKSUM_MISMATCH');
      fs.files.delete(tmp);
      fs.files.set(dest, got);
      hooks.afterInstall?.();
      return {};
    },
    async moveCache(tmp, dest) {
      const got = fs.files.get(tmp);
      if (got === undefined) throw nativeErr('NOT_FOUND');
      fs.files.delete(tmp);
      fs.files.set(dest, got);
    },
    validateJpeg: async (p) => fs.files.has(p),
    remove: async (p) => void fs.files.delete(p),
  };
}

let cam: FakeCamera | null = null;
const running: { app: AppContext; service: TransferService }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.app.client.stop();
    r.service.stop();
  }
  await cam?.close();
  cam = null;
});

interface Rig {
  fs: FakeFs;
  hooks: Hooks;
  cameraId: string;
  start(): Promise<{ app: AppContext; service: TransferService }>;
}

async function rig(): Promise<Rig> {
  cam = await startFakeCamera({ rotation: 0 });
  const info = (await (await fetch(`http://127.0.0.1:${cam.port}/info`)).json()) as { cameraId: string };
  const fs = new FakeFs();
  const seed = new ProjectStore(fs);
  await seed.load();
  await seed.updateIndex((i) => ({ ...i, rememberedCamera: { cameraId: info.cameraId, host: '127.0.0.1', port: cam!.port } }));
  const hooks: Hooks = { hold: null };
  const clock = fastClock();
  const verify = async (path: string, bytes: number, sha256: string) => {
    const got = fs.files.get(path);
    if (got === undefined) return false;
    const buf = Buffer.from(got, 'latin1');
    return buf.length === bytes && createHash('sha256').update(buf).digest('hex') === sha256;
  };
  return {
    fs,
    hooks,
    cameraId: info.cameraId,
    async start() {
      let service!: TransferService;
      let hook!: ReturnType<typeof createReconcile>;
      let n = 0;
      const app = await boot({
        fs,
        verify,
        nsd,
        createTransfer: ({ store, request, target, cameraId }) => {
          service = createTransfer({ store, io: makeIO(fs, hooks), request: (op, a, o) => (op === 'ack' && hooks.dropAck ? Promise.reject(Object.assign(new Error('killed'), { code: 'CLOSED', local: true })) : request(op, a, o)), target, cameraId, clock });
          hook = createReconcile({ store, transfer: service });
          return service;
        },
        reconcile: (ctx) => hook(ctx),
        createCapture: (env) => createCapture({ ...env, newId: () => `req-${Date.now()}-${++n}`, sendTimeoutMs: 300, pollMs: 40, giveUpMs: 600 }),
        clientDeps: { searchWindowMs: 50 },
      });
      const r = { app, service };
      running.push(r);
      return r;
    },
  };
}

const online = (app: AppContext) => app.client.snapshot.status === 'online' && !app.client.snapshot.reconciling;
const listFramesCalls = () => cam!.state.requests.filter((r) => r === 'listFrames').length;
const projects = (app: AppContext) => Object.values(app.store.state.get().projects);
const frames = (app: AppContext) => projects(app).flatMap((p) => p.frames.map((f) => ({ ...f, projectId: p.id })));

/** The one safety property: acked ⊆ local ∪ tombstoned ∪ frames of deleted projects. */
function expectAckedSafe(app: AppContext, deletedProjectFrames: string[] = []) {
  const ok = new Set<string>(deletedProjectFrames);
  for (const p of projects(app)) {
    for (const f of p.frames) if (f.state === 'local') ok.add(f.frameId);
    for (const id of p.deletedFrameIds) ok.add(id);
  }
  for (const id of cam!.state.acked) expect(ok.has(id), `acked ${id} is not local/tombstoned`).toBe(true);
}

async function connect(r: Rig) {
  const x = await r.start();
  await until(() => online(x.app), 'online');
  return x;
}

describe('transfer + reconcile against the fake camera', () => {
  it('capture -> download -> local -> ack; reconnect -> reconcile changes nothing', async () => {
    const r = await rig();
    const { app, service } = await connect(r);
    const p = await app.store.createProject('Film');
    expect(await app.capture.press(p.id)).toMatchObject({ ok: true });
    expect(await app.capture.press(p.id)).toMatchObject({ ok: true });
    await until(() => cam!.state.acked.size === 2, 'two frames acked');
    await service.idle();
    expect(frames(app).map((f) => f.state)).toEqual(['local', 'local']);
    for (const f of frames(app)) expect(r.fs.files.has(`projects/${f.projectId}/frames/${f.frameId}.full.jpg`)).toBe(true);
    expectAckedSafe(app);

    const before = listFramesCalls();
    await hit(cam!, '/fake/kick');
    await until(() => listFramesCalls() > before && online(app), 'reconcile after reconnect');
    expect(frames(app)).toHaveLength(2);
    expect(projects(app)).toHaveLength(1);
    expect(cam!.state.acked.size).toBe(2);
  });

  it('crash between install and the local commit: nothing acked; after restart the sweep promotes, reconcile acks', async () => {
    const r = await rig();
    const first = await connect(r);
    const p = await first.app.store.createProject('Film');
    r.hooks.afterInstall = () => r.fs.crashAfter(0); // the file is installed, the commit write "kills" the process
    await first.app.capture.press(p.id).catch(() => {});
    await until(() => [...r.fs.files.keys()].some((k) => k.endsWith('.full.jpg')), 'file installed');
    await new Promise((res) => setTimeout(res, 150));
    expect(cam!.state.acked.size).toBe(0); // pending on disk -> never acked
    first.app.client.stop();
    first.service.stop();

    r.fs.restart();
    r.hooks.afterInstall = undefined;
    const second = await connect(r);
    await until(() => cam!.state.acked.size === 1, 'acked after restart');
    expect(second.app.sweep.promoted.length + frames(second.app).filter((f) => f.state === 'local').length).toBeGreaterThan(0);
    expect(frames(second.app).map((f) => f.state)).toEqual(['local']);
    expectAckedSafe(second.app);
  });

  it('killed after the local commit, before the ack: after restart reconcile lists the local frame and acks it', async () => {
    const r = await rig();
    r.hooks.dropAck = true;
    const first = await connect(r);
    const p = await first.app.store.createProject('Film');
    await first.app.capture.press(p.id);
    await until(() => frames(first.app).some((f) => f.state === 'local'), 'local committed');
    await new Promise((res) => setTimeout(res, 100));
    expect(cam!.state.acked.size).toBe(0);
    first.app.client.stop();
    first.service.stop();

    r.fs.restart();
    r.hooks.dropAck = false;
    const second = await connect(r);
    await until(() => cam!.state.acked.size === 1, 'acked after restart');
    expect(second.app.sweep.promoted).toEqual([]); // nothing for the sweep to do: the diff the acker missed is reconcile's
    expect(frames(second.app).map((f) => f.state)).toEqual(['local']);
    expectAckedSafe(second.app);
  });

  it('/fake/restart (new bootId): reconcile runs again, pending frames resume, no duplicates, only local frames acked', async () => {
    const r = await rig();
    const { app, service } = await connect(r);
    const p = await app.store.createProject('Film');
    let release!: () => void;
    r.hooks.hold = new Promise<void>((res) => (release = res));
    await app.capture.press(p.id);
    await app.capture.press(p.id);
    expect(frames(app).map((f) => f.state)).toEqual(['pending', 'pending']);
    const before = listFramesCalls();
    await hit(cam!, '/fake/restart');
    await until(() => listFramesCalls() > before && online(app), 'reconcile after restart');
    expect(cam!.state.acked.size).toBe(0);
    expect(frames(app)).toHaveLength(2);
    release();
    await until(() => cam!.state.acked.size === 2, 'acked');
    await service.idle();
    expect(frames(app).map((f) => f.state)).toEqual(['local', 'local']);
    expectAckedSafe(app);
  });

  it('an unknown frame in a live project of THIS camera is merged and downloaded', async () => {
    const r = await rig();
    const { app, service } = await connect(r);
    const p = await app.store.createProject('Film');
    r.hooks.hold = new Promise<void>(() => {}); // keep the capture's own download from finishing
    await app.capture.press(p.id);
    const id = frames(app)[0]!.frameId;
    service.stop(); // (the held download dies with the test)
    await app.store.updateProject(p.id, (x) => ({ ...x, frames: [] })); // the merge was lost
    r.hooks.hold = null;
    const second = await (async () => {
      app.client.stop();
      return connect(r);
    })();
    await until(() => frames(second.app).some((f) => f.frameId === id && f.state === 'local'), 'merged and installed');
    expect(projects(second.app)).toHaveLength(1);
    await until(() => cam!.state.acked.has(id), 'acked');
    expectAckedSafe(second.app);
  });

  it('/fake/camera-id: a frame of a project bound to the OLD camera goes to a recovered project, never merged into it', async () => {
    const r = await rig();
    const { app, service } = await connect(r);
    const p = await app.store.createProject('Film');
    r.hooks.hold = new Promise<void>(() => {});
    await app.capture.press(p.id);
    const id = frames(app)[0]!.frameId;
    const oldCamera = app.store.state.get().projects[p.id]!.cameraId;
    service.stop();
    app.client.stop();
    await app.store.updateProject(p.id, (x) => ({ ...x, frames: [] })); // unknown to the store again
    r.hooks.hold = null;
    await hit(cam!, '/fake/camera-id?id=another-phone');
    const second = await r.start();
    await until(() => projects(second.app).length === 2, 'recovered project', 15_000);
    const orig = second.app.store.state.get().projects[p.id]!;
    const rec = projects(second.app).find((x) => x.id !== p.id) as Project;
    expect(orig.frames).toEqual([]);
    expect(orig.cameraId).toBe(oldCamera);
    expect(rec.name).toMatch(/^Odzyskany /);
    expect(rec.cameraId).toBe('another-phone');
    expect(rec.frames.map((f) => f.frameId)).toEqual([id]);
    await until(() => cam!.state.acked.has(id), 'acked after install');
    expect(frames(second.app).find((f) => f.frameId === id)!.state).toBe('local');
    expectAckedSafe(second.app);
  });

  it('/fake/missing-full: the frame becomes unavailable and is never acked; when the file is back, reconcile retries it', async () => {
    const r = await rig();
    const { app, service } = await connect(r);
    const p = await app.store.createProject('Film');
    await app.capture.press(p.id); // happy frame
    await until(() => cam!.state.acked.size === 1, 'first acked');
    await service.idle();
    let release!: () => void;
    r.hooks.hold = new Promise<void>((res) => (release = res));
    await app.capture.press(p.id);
    const bad = frames(app).find((f) => f.state === 'pending')!.frameId;
    await hit(cam!, `/fake/missing-full?frame=${bad}`);
    r.hooks.hold = null;
    release();
    await until(() => frames(app).find((f) => f.frameId === bad)?.unavailable !== undefined, 'unavailable (4 tries)');
    expect(cam!.state.acked.has(bad)).toBe(false);
    expectAckedSafe(app);

    await hit(cam!, `/fake/missing-full?frame=${bad}&off=1`);
    const before = listFramesCalls();
    await hit(cam!, '/fake/kick');
    await until(() => listFramesCalls() > before && online(app), 'reconcile');
    await until(() => frames(app).find((f) => f.frameId === bad)?.state === 'local', 'retried and installed');
    await until(() => cam!.state.acked.has(bad), 'acked');
    expectAckedSafe(app);
  }, 30_000);

  it('a pending frame the phone no longer lists: unavailable "lost on the phone", never acked by the tablet', async () => {
    const r = await rig();
    const { app } = await connect(r);
    const p = await app.store.createProject('Film');
    r.hooks.hold = new Promise<void>(() => {});
    await app.capture.press(p.id);
    const id = frames(app)[0]!.frameId;
    cam!.state.acked.add(id); // the phone side lost it (not an ack from the tablet)
    const before = listFramesCalls();
    await hit(cam!, '/fake/kick');
    await until(() => listFramesCalls() > before && online(app), 'reconcile');
    expect(frames(app)[0]).toMatchObject({ frameId: id, state: 'pending', unavailable: { reason: 'lost on the phone' } });
    expect(cam!.state.requests.filter((o) => o === 'ack')).toEqual([]);
  });

  it('a deleted project: its frame is acked without being merged', async () => {
    const r = await rig();
    const { app } = await connect(r);
    const p = await app.store.createProject('Film');
    r.hooks.hold = new Promise<void>(() => {});
    await app.capture.press(p.id);
    const id = frames(app)[0]!.frameId;
    await app.store.mutate((s) => ({
      result: undefined,
      index: { ...s.index, projects: s.index.projects.filter((x) => x.id !== p.id), deletedProjects: [...s.index.deletedProjects, p.id] },
      dropProjects: [p.id],
    }));
    await hit(cam!, '/fake/kick');
    await until(() => cam!.state.acked.has(id), 'acked');
    expect(projects(app)).toEqual([]);
    expectAckedSafe(app, [id]);
  });

  it('/fake/reclaim: reclaimed (acked) frames stay local; nothing is listed or re-acked', async () => {
    const r = await rig();
    const { app, service } = await connect(r);
    const p = await app.store.createProject('Film');
    await app.capture.press(p.id);
    await until(() => cam!.state.acked.size === 1, 'acked');
    await service.idle();
    await hit(cam!, '/fake/reclaim');
    const before = listFramesCalls();
    const acks = cam!.state.requests.filter((o) => o === 'ack').length;
    await hit(cam!, '/fake/kick');
    await until(() => listFramesCalls() > before && online(app), 'reconcile');
    expect(frames(app).map((f) => f.state)).toEqual(['local']);
    expect(cam!.state.requests.filter((o) => o === 'ack')).toHaveLength(acks);
    expectAckedSafe(app);
  });
});
