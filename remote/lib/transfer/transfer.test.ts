import { describe, expect, it, vi } from 'vitest';
import { CrashError, FakeFs } from '../projects/fakeFs.testutil';
import { projectJsonPath } from '../projects/files';
import type { FrameInfo, Project } from '../projects/model';
import { expireFrames, expireProjects, hideFrame, hideProject, mergeFrame, unhideProject } from '../projects/reducers';
import { ProjectStore } from '../projects/store';
import { runStartupSweep } from '../projects/sweep';
import { ACK_CHUNK, type Clock } from './ack';
import { DownloadError, RESERVE_BYTES, type TransferIO } from './download';
import { MAX_RETRIES, STORAGE_RECHECK_MS, createTransfer } from './queue';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const sha = (c: string) => c.repeat(64);
const MB = 1024 * 1024;
let n = 0;

const info = (projectId: string, frameId: string, seq: number, c = 'a', bytes = 10): FrameInfo => ({
  frameId,
  seq,
  projectId,
  clientId: 'c',
  rotation: 0,
  capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes, sha256: sha(c) },
});
const fp = (pid: string, id: string, v: 'full' | 'play' | 'thumb' = 'full') => `projects/${pid}/frames/${id}.${v}.jpg`;
const content = (c = 'a', bytes = 10) => `${sha(c)}:${bytes}`;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const nativeErr = (code: string) => Object.assign(new Error(code), { code });

/** A manual clock: nothing runs unless `advance` is called. */
function manualClock() {
  let t = T0;
  const timers: { at: number; fn: () => void }[] = [];
  const clock: Clock = {
    now: () => t,
    schedule(ms, fn) {
      const e = { at: t + ms, fn };
      timers.push(e);
      return () => {
        const i = timers.indexOf(e);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = Math.max(t, next.at);
      next.fn();
      await settle();
    }
    t = end;
    await settle();
  };
  return { clock, advance, timers };
}

interface Env {
  fs: FakeFs;
  store: ProjectStore;
  pid: string;
  io: TransferIO & {
    calls: string[];
    downloads: string[];
    freeBytes: ReturnType<typeof vi.fn>;
  };
  hooks: {
    download?: (url: string, tmp: string) => Promise<void> | void;
    afterInstall?: () => void;
    beforeInstall?: () => void;
  };
  /** frameId -> what the camera serves for `full`. */
  server: Map<string, string>;
  acks: string[][];
  ackFails: { on: boolean };
  /** state of project.json (frame states) at the moment of every ack */
  ackSnapshots: Record<string, string | undefined>[];
  online: { on: boolean };
  clock: ReturnType<typeof manualClock>;
  mk: (fs?: FakeFs, store?: ProjectStore) => ReturnType<typeof createTransfer>;
  tr: ReturnType<typeof createTransfer>;
}

async function mkEnv(frames: [string, string?][] = [['F1'], ['F2'], ['F3']], opts: { free?: number } = {}): Promise<Env> {
  const fs = new FakeFs();
  const store = new ProjectStore(fs, { now: () => T0, newId: () => `id-${++n}` });
  await store.load();
  const p = await store.createProject('Film');
  await store.updateProject(p.id, (cur) => {
    let x: Project = { ...cur, cameraId: 'cam' };
    frames.forEach(([id, c], i) => (x = mergeFrame(x, info(p.id, id, i + 1, c ?? 'a'), 'cam').project));
    return x;
  });
  const server = new Map<string, string>(frames.map(([id, c]) => [id, content(c ?? 'a')]));
  const hooks: Env['hooks'] = {};
  const acks: string[][] = [];
  const ackFails = { on: false };
  const ackSnapshots: Env['ackSnapshots'] = [];
  const online = { on: true };
  const clock = manualClock();
  const calls: string[] = [];
  const downloads: string[] = [];
  const freeBytes = vi.fn(async () => opts.free ?? 10_000 * MB);
  const io: Env['io'] = {
    calls,
    downloads,
    freeBytes,
    mkdir: async () => {},
    async download(url, tmp) {
      const m = /\/frames\/([^/]+)\/(full|play|thumb)\.jpg$/.exec(url)!;
      downloads.push(`${m[1]}/${m[2]}`);
      calls.push(`download ${m[1]}/${m[2]}`);
      await hooks.download?.(url, tmp);
      fs.files.set(tmp, m[2] === 'full' ? (server.get(m[1]!) ?? '') : 'cache');
    },
    async installFile({ tmp, dest, bytes, sha256 }) {
      calls.push(`install ${dest}`);
      hooks.beforeInstall?.();
      const got = fs.files.get(tmp);
      if (got === undefined) throw nativeErr('NOT_FOUND');
      if (got !== `${sha256}:${bytes}`) throw nativeErr('CHECKSUM_MISMATCH');
      fs.files.delete(tmp);
      fs.files.set(dest, got);
      hooks.afterInstall?.();
      return { result: 'INSTALLED' };
    },
    async moveCache(tmp, dest) {
      const got = fs.files.get(tmp);
      if (got === undefined) throw nativeErr('NOT_FOUND');
      fs.files.delete(tmp);
      fs.files.set(dest, got);
    },
    validateJpeg: async (path) => fs.files.get(path) === 'cache',
    remove: async (path) => void fs.files.delete(path),
  };
  const request = vi.fn(async (op: string, args: any) => {
    if (op !== 'ack') throw new Error(`unexpected op ${op}`);
    if (ackFails.on) throw Object.assign(new Error('not connected'), { code: 'CLOSED' });
    acks.push(args.frameIds);
    const snap: Record<string, string | undefined> = {};
    const pj = fs.json(projectJsonPath(p.id)) as Project | undefined;
    for (const id of args.frameIds as string[]) snap[id] = pj?.frames.find((f) => f.frameId === id)?.state;
    ackSnapshots.push(snap);
    return { acked: args.frameIds.length, unknown: [] };
  });
  const mk = (_fs?: FakeFs, st?: ProjectStore) =>
    createTransfer({ store: st ?? store, io, request, clock: clock.clock, target: () => (online.on ? { host: '10.0.0.2', port: 8080 } : null) });
  const tr = mk();
  return { fs, store, pid: p.id, io, hooks, server, acks, ackFails, ackSnapshots, online, clock, mk, tr };
}

const proj = (e: Env): Project => e.store.state.get().projects[e.pid]!;
const frameState = (e: Env, id: string) => proj(e).frames.find((f) => f.frameId === id)?.state;
const allAcked = (e: Env) => e.acks.flat();

describe('happy path', () => {
  it('downloads full to tmp, installs, commits local, THEN acks only that frame; caches follow', async () => {
    const e = await mkEnv([['F1']]);
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(e.fs.files.get(fp(e.pid, 'F1'))).toBe(content());
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/'))).toEqual([]);
    expect(frameState(e, 'F1')).toBe('local');
    expect((e.fs.json(projectJsonPath(e.pid)) as Project).frames[0]!.state).toBe('local');
    expect(e.acks).toEqual([['F1']]);
    // the ack was sent after `local` was committed to disk
    expect(e.ackSnapshots[0]).toEqual({ F1: 'local' });
    // best-effort caches installed after the full
    expect(e.fs.files.get(fp(e.pid, 'F1', 'play'))).toBe('cache');
    expect(e.fs.files.get(fp(e.pid, 'F1', 'thumb'))).toBe('cache');
    expect(e.io.downloads).toEqual(['F1/full', 'F1/play', 'F1/thumb']);
    expect(e.tr.status.get()).toMatchObject({ queued: 0, current: null, paused: null, unavailable: 0, ackPending: 0 });
  });

  it('one at a time, newest first; every full before any cache', async () => {
    const e = await mkEnv();
    const gate = deferred();
    e.hooks.download = (url) => (url.includes('F1/full') ? gate.promise : undefined);
    e.tr.enqueue('F1', e.pid);
    await settle();
    e.tr.enqueue('F2', e.pid);
    e.tr.enqueue('F3', e.pid);
    expect(e.tr.status.get().current).toEqual({ frameId: 'F1', projectId: e.pid, variant: 'full' });
    expect(e.tr.status.get().queued).toBe(2);
    gate.resolve();
    await e.tr.idle();
    expect(e.io.downloads.filter((d) => d.endsWith('/full'))).toEqual(['F1/full', 'F3/full', 'F2/full']);
    const firstCache = e.io.downloads.findIndex((d) => !d.endsWith('/full'));
    expect(e.io.downloads.slice(0, 3)).toEqual(['F1/full', 'F3/full', 'F2/full']);
    expect(firstCache).toBe(3);
  });

  it('installFile gets the frame bytes and sha256 (verified natively, no JS hash)', async () => {
    const e = await mkEnv([['F1', 'b']]);
    const spy = vi.spyOn(e.io, 'installFile');
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(spy).toHaveBeenCalledWith({ tmp: expect.stringMatching(/^tmp\/F1\.full\./), dest: fp(e.pid, 'F1'), bytes: 10, sha256: sha('b') });
  });
});

describe('ack eligibility', () => {
  it('nothing is acked before state local commits (ackNow on a pending frame is a no-op)', async () => {
    const e = await mkEnv([['F1']]);
    const gate = deferred();
    e.hooks.download = () => gate.promise;
    e.tr.enqueue('F1', e.pid);
    await settle();
    await e.tr.ackNow(['F1']);
    expect(e.acks).toEqual([]);
    expect(frameState(e, 'F1')).toBe('pending');
    gate.resolve();
    await e.tr.idle();
    expect(e.acks).toEqual([['F1']]);
  });

  it('unknown ids are not acked', async () => {
    const e = await mkEnv([['F1']]);
    await e.tr.ackNow(['NOPE']);
    expect(e.acks).toEqual([]);
  });

  it('pendingProjectDeletes: a local frame is not acked inside the Undo window; acked after Undo', async () => {
    const e = await mkEnv([['F1']]);
    e.ackFails.on = true; // the ack cannot go out yet
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('local');
    await e.store.updateIndex((i) => hideProject(i, e.pid, T0));
    e.ackFails.on = false;
    e.tr.kick();
    await e.tr.idle();
    await settle();
    expect(e.acks).toEqual([]); // inside the window: never
    await e.store.updateIndex((i) => unhideProject(i, e.pid));
    await e.tr.idle();
    await settle();
    expect(e.acks).toEqual([['F1']]);
  });

  it('pendingProjectDeletes -> expiry: acked only once the project is in deletedProjects', async () => {
    const e = await mkEnv([['F1']]);
    e.ackFails.on = true;
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    await e.store.updateIndex((i) => hideProject(i, e.pid, T0));
    e.ackFails.on = false;
    e.tr.kick();
    await e.tr.idle();
    expect(e.acks).toEqual([]);
    await e.store.mutate((s) => {
      const r = expireProjects(s.index, T0 + 10_000);
      return { result: undefined, index: r.index, dropProjects: r.expired };
    });
    await e.tr.idle();
    await settle();
    expect(allAcked(e)).toEqual(['F1']);
  });

  it('a pending download in a project deleted (expired) is dropped and its frame acked as eligible', async () => {
    const e = await mkEnv([['F1'], ['F2']]);
    const gate = deferred();
    e.hooks.download = () => gate.promise;
    e.tr.enqueue('F1', e.pid);
    await settle();
    e.tr.enqueue('F2', e.pid); // queued
    await e.store.updateIndex((i) => hideProject(i, e.pid, T0));
    await settle();
    expect(e.acks).toEqual([]);
    await e.store.mutate((s) => {
      const r = expireProjects(s.index, T0 + 10_000);
      return { result: undefined, index: r.index, dropProjects: r.expired };
    });
    gate.resolve();
    await e.tr.idle();
    await settle();
    // nothing installed into the deleted project; its frames are eligible (deletedProjects) and acked
    expect([...e.fs.files.keys()].filter((k) => k.includes('/frames/') && k.endsWith('.jpg'))).toEqual([]);
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/'))).toEqual([]);
    expect(e.io.downloads).toEqual(['F1/full']);
    expect(allAcked(e).sort()).toEqual(['F1', 'F2']);
    expect(e.tr.status.get().queued).toBe(0);
  });

  it('ackNow for a frame of a deleted project (not in the store) uses projectOf', async () => {
    const e = await mkEnv([]);
    await e.store.mutate((s) => {
      const r = hideProject(s.index, e.pid, T0 - 10_000);
      const x = expireProjects(r, T0);
      return { result: undefined, index: x.index, dropProjects: x.expired };
    });
    await e.tr.ackNow(['G9']); // unresolvable: skipped
    expect(e.acks).toEqual([]);
    await e.tr.ackNow(['G9'], { G9: e.pid });
    expect(e.acks).toEqual([['G9']]);
  });

  it('a tombstoned frame is acked; a hidden (Undo window) pending frame is not', async () => {
    const e = await mkEnv([['F1'], ['F2']]);
    await e.store.updateProject(e.pid, (p) => hideFrame(p, 'F1', T0, 5_000));
    await e.tr.ackNow(['F1']);
    expect(e.acks).toEqual([]); // pending (not yet local), hidden: not eligible
    await e.store.mutate((s) => {
      const r = expireFrames(s.projects[e.pid]!, T0 + 10_000);
      return { result: undefined, projects: [r.project] };
    });
    await e.tr.idle();
    await settle();
    expect(e.acks).toEqual([['F1']]); // the tombstone commit triggers the pass by itself
  });

  it('chunks big batches', async () => {
    const e = await mkEnv([]);
    await e.store.mutate((s) => {
      const r = hideProject(s.index, e.pid, T0 - 10_000);
      const x = expireProjects(r, T0);
      return { result: undefined, index: x.index, dropProjects: x.expired };
    });
    const ids = Array.from({ length: ACK_CHUNK * 2 + 5 }, (_, i) => `G${i}`);
    await e.tr.ackNow(ids, Object.fromEntries(ids.map((i) => [i, e.pid])));
    expect(e.acks.map((a) => a.length)).toEqual([ACK_CHUNK, ACK_CHUNK, 5]);
  });
});

describe('ack failures', () => {
  it('a failed ack is retried (backoff), the need is never lost, nothing else is acked', async () => {
    const e = await mkEnv([['F1'], ['F2']]);
    e.ackFails.on = true;
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('local');
    expect(frameState(e, 'F2')).toBe('pending');
    expect(e.tr.status.get().ackPending).toBe(1);
    await e.clock.advance(1_000);
    expect(e.acks).toEqual([]); // still failing
    e.ackFails.on = false;
    await e.clock.advance(5_000);
    expect(e.acks).toEqual([['F1']]);
    expect(e.tr.status.get().ackPending).toBe(0);
  });

  it('kick() retries a failed ack at once', async () => {
    const e = await mkEnv([['F1']]);
    e.ackFails.on = true;
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    e.ackFails.on = false;
    e.tr.kick();
    await e.tr.idle();
    expect(e.acks).toEqual([['F1']]);
  });
});

describe('retries', () => {
  it('checksum mismatch: retried with backoff, then unavailable; never acked; tmp cleaned', async () => {
    const e = await mkEnv([['F1']]);
    e.server.set('F1', content('b')); // camera serves other bytes than FrameInfo promised
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(e.io.downloads.length).toBe(1);
    await e.clock.advance(1_000);
    expect(e.io.downloads.length).toBe(2);
    await e.clock.advance(4_000);
    expect(e.io.downloads.length).toBe(3);
    expect(proj(e).frames[0]!.unavailable).toBeUndefined();
    await e.clock.advance(10_000);
    expect(e.io.downloads.length).toBe(1 + MAX_RETRIES);
    const f = proj(e).frames[0]!;
    expect(f.state).toBe('pending');
    expect(f.unavailable).toMatchObject({ reason: 'mismatch' });
    expect(e.acks).toEqual([]);
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/') || k.includes('/frames/'))).toEqual([]);
    expect(e.tr.status.get()).toMatchObject({ unavailable: 1, queued: 0 });
    await e.clock.advance(60_000);
    expect(e.io.downloads.length).toBe(1 + MAX_RETRIES); // gives up: no more attempts
  });

  it('retryUnavailable (reconcile) clears the flag, requeues, and the frame then installs and acks', async () => {
    const e = await mkEnv([['F1'], ['F2']]);
    e.server.set('F1', content('b'));
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    await e.clock.advance(20_000);
    expect(proj(e).frames[0]!.unavailable).toBeDefined();
    e.server.set('F1', content('a'));
    expect(await e.tr.retryUnavailable()).toBe(1);
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('local');
    expect(proj(e).frames[0]!.unavailable).toBeUndefined();
    expect(allAcked(e)).toEqual(['F1']);
    expect(await e.tr.retryUnavailable()).toBe(0);
  });

  it('404 on full: retried, then unavailable, never acked', async () => {
    const e = await mkEnv([['F1']]);
    e.hooks.download = () => {
      throw new DownloadError('http', 'HTTP 404', { status: 404 });
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    await e.clock.advance(20_000);
    expect(e.io.downloads.length).toBe(1 + MAX_RETRIES);
    expect(proj(e).frames[0]!.unavailable).toMatchObject({ reason: 'http 404' });
    expect(e.acks).toEqual([]);
  });

  it('a 404 that clears on the 2nd attempt installs', async () => {
    const e = await mkEnv([['F1']]);
    let k = 0;
    e.hooks.download = () => {
      if (k++ === 0) throw new DownloadError('http', 'HTTP 404', { status: 404 });
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    await e.clock.advance(1_000);
    expect(frameState(e, 'F1')).toBe('local');
    expect(allAcked(e)).toEqual(['F1']);
  });

  it('a failing frame does not block the next one', async () => {
    const e = await mkEnv([['F1'], ['F2']]);
    e.server.set('F2', content('b'));
    e.tr.enqueue('F1', e.pid);
    e.tr.enqueue('F2', e.pid); // newest first: F2 is tried first (F1 already started)
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('local');
    expect(frameState(e, 'F2')).toBe('pending');
  });

  it('a stalled download hits the deadline and is retried with a fresh tmp name', async () => {
    const e = await mkEnv([['F1']]);
    const tr = createTransfer({
      store: e.store,
      io: e.io,
      request: async () => ({ acked: 1 }),
      clock: e.clock.clock,
      target: () => ({ host: 'h', port: 1 }),
      fullTimeoutMs: 20,
    });
    const gate = deferred();
    let first = true;
    e.hooks.download = () => {
      if (first) {
        first = false;
        return gate.promise; // never answers in time
      }
    };
    tr.enqueue('F1', e.pid);
    await new Promise((r) => setTimeout(r, 60));
    expect(proj(e).frames[0]!.state).toBe('pending');
    gate.resolve(); // the abandoned native call finally writes its file: it is deleted, not installed
    await settle();
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/'))).toEqual([]);
    await e.clock.advance(1_000);
    expect(frameState(e, 'F1')).toBe('local');
    tr.stop();
  });
});

describe('Wi-Fi drop', () => {
  it('a drop mid-download while offline does not use a retry; resumes with kick()', async () => {
    const e = await mkEnv([['F1']]);
    const gate = deferred();
    e.hooks.download = () => gate.promise;
    e.tr.enqueue('F1', e.pid);
    await settle();
    e.online.on = false;
    gate.reject(new Error('connection reset'));
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('pending');
    expect(proj(e).frames[0]!.unavailable).toBeUndefined();
    expect(e.tr.status.get().queued).toBe(1);
    expect(e.acks).toEqual([]);
    await e.clock.advance(60_000);
    expect(e.io.downloads.length).toBe(1); // offline: nothing is attempted
    e.hooks.download = undefined;
    e.online.on = true;
    e.tr.kick();
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('local');
    expect(allAcked(e)).toEqual(['F1']);
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/'))).toEqual([]);
  });

  it('a drop while still "online" counts as a retry and backs off', async () => {
    const e = await mkEnv([['F1']]);
    let k = 0;
    e.hooks.download = () => {
      if (k++ === 0) throw new Error('socket closed');
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(e.io.downloads.length).toBe(1);
    await e.clock.advance(1_000);
    expect(frameState(e, 'F1')).toBe('local');
  });
});

describe('storage', () => {
  it('pauses with "storage full" below reserve + full + 1 MB, downloads nothing, acks nothing', async () => {
    const e = await mkEnv([['F1']], { free: RESERVE_BYTES + 10 + MB - 1 });
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(e.tr.status.get().paused).toBe('storage_full');
    expect(e.io.downloads).toEqual([]);
    expect(e.acks).toEqual([]);
    expect(frameState(e, 'F1')).toBe('pending');
    expect(e.tr.status.get().queued).toBe(1);
  });

  it('exactly reserve + full + 1 MB is enough; the pause lifts on the recheck timer', async () => {
    const e = await mkEnv([['F1']], { free: RESERVE_BYTES + 10 + MB - 1 });
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    e.io.freeBytes.mockResolvedValue(RESERVE_BYTES + 10 + MB);
    await e.clock.advance(STORAGE_RECHECK_MS);
    expect(e.tr.status.get().paused).toBeNull();
    expect(frameState(e, 'F1')).toBe('local');
    expect(allAcked(e)).toEqual(['F1']);
  });

  it('ENOSPC during the download: pause, tmp deleted, no retry consumed, nothing acked', async () => {
    const e = await mkEnv([['F1']]);
    e.hooks.download = (_u, tmp) => {
      e.fs.files.set(tmp, 'partial');
      throw Object.assign(new Error('write failed: ENOSPC (No space left on device)'), { code: 'ENOSPC' });
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(e.tr.status.get().paused).toBe('storage_full');
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/'))).toEqual([]);
    expect(e.acks).toEqual([]);
    e.hooks.download = undefined;
    await e.clock.advance(STORAGE_RECHECK_MS);
    expect(frameState(e, 'F1')).toBe('local');
    expect(proj(e).frames[0]!.unavailable).toBeUndefined();
  });

  it('NO_SPACE from installFile pauses too', async () => {
    const e = await mkEnv([['F1']]);
    let k = 0;
    e.hooks.beforeInstall = () => {
      if (k++ === 0) throw nativeErr('NO_SPACE');
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(e.tr.status.get().paused).toBe('storage_full');
    expect(e.acks).toEqual([]);
  });

  it('a project.json write failing with NO_SPACE keeps the frame pending: not acked', async () => {
    const e = await mkEnv([['F1']]);
    e.fs.failOn({ op: 'writeTextAtomic', path: projectJsonPath(e.pid), error: Object.assign(new Error('NO_SPACE'), { code: 'NO_SPACE' }), times: 1 });
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('pending');
    expect(e.acks).toEqual([]);
    expect(e.tr.status.get().paused).toBe('storage_full');
    await e.clock.advance(STORAGE_RECHECK_MS); // retried: ALREADY installed, now committed
    expect(frameState(e, 'F1')).toBe('local');
    expect(allAcked(e)).toEqual(['F1']);
  });

  it('pause() for export waits for the current job, starts nothing new, resume() continues', async () => {
    const e = await mkEnv([['F1'], ['F2']]);
    const gate = deferred();
    e.hooks.download = (url) => (url.includes('F1/full') ? gate.promise : undefined);
    e.tr.enqueue('F1', e.pid);
    await settle();
    e.tr.enqueue('F2', e.pid);
    let paused = false;
    const p = e.tr.pause().then(() => (paused = true));
    await settle();
    expect(paused).toBe(false);
    expect(e.tr.status.get().paused).toBe('export');
    gate.resolve();
    await p;
    expect(frameState(e, 'F1')).toBe('local');
    expect(frameState(e, 'F2')).toBe('pending');
    expect(e.io.downloads.filter((d) => d.startsWith('F2'))).toEqual([]);
    expect(allAcked(e)).toEqual(['F1']); // an ack is not a bulk write: it still goes out
    e.tr.resume();
    await e.tr.idle();
    expect(frameState(e, 'F2')).toBe('local');
  });
});

describe('delete during a download', () => {
  it('the project leaves the store mid-download: abort, no install, tmp deleted once the call settles', async () => {
    const e = await mkEnv([['F1']]);
    const gate = deferred();
    e.hooks.download = (_u, tmp) => gate.promise.then(() => void e.fs.files.set(tmp, 'late'));
    e.tr.enqueue('F1', e.pid);
    await settle();
    e.tr.dropProject(e.pid);
    await settle();
    expect(e.tr.status.get().current).toBeNull();
    gate.resolve();
    await e.tr.idle();
    await settle();
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/') || k.includes('/frames/'))).toEqual([]);
    expect(e.acks).toEqual([]); // the project still exists and the frame is pending: not eligible
    expect(frameState(e, 'F1')).toBe('pending');
  });

  it('the frame is tombstoned during the download: tmp deleted, not installed, then acked as tombstoned', async () => {
    const e = await mkEnv([['F1']]);
    const gate = deferred();
    e.hooks.download = () => gate.promise;
    e.tr.enqueue('F1', e.pid);
    await settle();
    await e.store.updateProject(e.pid, (p) => hideFrame(p, 'F1', T0 - 10_000, 1));
    await e.store.mutate((s) => {
      const r = expireFrames(s.projects[e.pid]!, T0);
      return { result: undefined, projects: [r.project] };
    });
    gate.resolve();
    await e.tr.idle();
    await settle();
    expect(e.io.calls.some((c) => c.startsWith('install'))).toBe(false);
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/') || k.includes('/frames/'))).toEqual([]);
    expect(allAcked(e)).toEqual(['F1']);
    expect(proj(e).frames).toEqual([]);
  });

  it('tombstoned between install and commit: the installed file is deleted (garbage), frame acked as tombstoned', async () => {
    const e = await mkEnv([['F1']]);
    e.hooks.afterInstall = () => {
      // the expiry commit wins the race against the install mutation
      void e.store.updateProject(e.pid, (p) => ({ ...p, frames: [], deletedFrameIds: [...p.deletedFrameIds, 'F1'] }));
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    await settle();
    expect(e.fs.files.has(fp(e.pid, 'F1'))).toBe(false);
    expect(proj(e).deletedFrameIds).toEqual(['F1']);
    expect(allAcked(e)).toEqual(['F1']);
  });

  it('queued (not started) jobs of a deleted project are dropped without any download', async () => {
    const e = await mkEnv([['F1'], ['F2'], ['F3']]);
    const gate = deferred();
    e.hooks.download = () => gate.promise;
    e.tr.enqueue('F1', e.pid);
    await settle();
    e.tr.enqueue('F2', e.pid);
    e.tr.enqueue('F3', e.pid);
    e.tr.dropProject(e.pid);
    expect(e.tr.status.get().queued).toBe(0);
    gate.resolve();
    await e.tr.idle();
    expect(e.io.downloads).toEqual(['F1/full']);
  });
});

describe('best-effort caches', () => {
  it('503 on a cache is retried later; 404 is skipped; neither blocks the next full or an ack', async () => {
    const e = await mkEnv([['F1'], ['F2']]);
    let k = 0;
    e.hooks.download = (url) => {
      if (url.includes('F1/play') && k++ === 0) throw new DownloadError('http', 'HTTP 503', { status: 503, retryAfterMs: 1_000 });
      if (url.includes('F1/thumb')) throw new DownloadError('http', 'HTTP 404', { status: 404 });
    };
    e.tr.enqueue('F1', e.pid);
    e.tr.enqueue('F2', e.pid);
    await e.tr.idle();
    expect(frameState(e, 'F1')).toBe('local');
    expect(frameState(e, 'F2')).toBe('local');
    expect(allAcked(e).sort()).toEqual(['F1', 'F2']);
    await e.clock.advance(1_000);
    expect(e.fs.files.get(fp(e.pid, 'F1', 'play'))).toBe('cache');
    expect(e.fs.files.has(fp(e.pid, 'F1', 'thumb'))).toBe(false);
    expect(proj(e).frames.every((f) => f.unavailable === undefined)).toBe(true);
  });

  it('a cache that is not a valid image is not installed', async () => {
    const e = await mkEnv([['F1']]);
    e.io.validateJpeg = async () => false;
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    await e.clock.advance(30_000);
    expect(e.fs.files.has(fp(e.pid, 'F1', 'play'))).toBe(false);
    expect([...e.fs.files.keys()].filter((k) => k.startsWith('tmp/'))).toEqual([]);
    expect(allAcked(e)).toEqual(['F1']);
  });

  it('a cache failure never marks the frame unavailable', async () => {
    const e = await mkEnv([['F1']]);
    e.hooks.download = (url) => {
      if (!url.includes('/full')) throw new DownloadError('http', 'HTTP 503', { status: 503 });
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    await e.clock.advance(60_000);
    expect(proj(e).frames[0]!.unavailable).toBeUndefined();
    expect(frameState(e, 'F1')).toBe('local');
  });
});

/** "The process was killed and started again": same disk, new store, new Transfer. */
async function restart(e: Env) {
  e.fs.restart();
  const store = new ProjectStore(e.fs, { now: () => T0, newId: () => `id-${++n}` });
  await store.load();
  const tr = e.mk(e.fs, store);
  return { store, tr };
}
const verify = (fs: FakeFs) => async (path: string, bytes: number, s: string) => fs.files.get(path) === `${s}:${bytes}`;

describe('kill points', () => {
  it('after the download (before install): restart sweeps tmp, frame is pending, nothing acked; a requeue then completes', async () => {
    const e = await mkEnv([['F1']]);
    e.hooks.beforeInstall = () => {
      throw new CrashError();
    };
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    e.tr.stop();
    expect([...e.fs.files.keys()].some((k) => k.startsWith('tmp/'))).toBe(false); // (our fake removes on failure; a real kill leaves it)
    e.fs.files.set('tmp/F1.full.99.jpg', content()); // what a real kill leaves behind
    e.hooks.beforeInstall = undefined;
    const r = await restart(e);
    const rep = await runStartupSweep(r.store, e.fs, { verify: verify(e.fs), now: () => T0 });
    expect(rep.tmpRemoved.length).toBe(1);
    expect(r.store.state.get().projects[e.pid]!.frames[0]!.state).toBe('pending');
    await settle();
    expect(e.acks).toEqual([]);
    r.tr.enqueue('F1', e.pid); // reconcile's "pending -> resume"
    await r.tr.idle();
    expect(allAcked(e)).toEqual(['F1']);
  });

  it('after install (before local commits): the sweep promotes and the new ack pass acks it', async () => {
    const e = await mkEnv([['F1']]);
    e.hooks.afterInstall = () => e.fs.crashAfter(0); // killed right after installFile
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    e.tr.stop();
    expect(e.fs.files.get(fp(e.pid, 'F1'))).toBe(content());
    expect((e.fs.json(projectJsonPath(e.pid)) as Project).frames[0]!.state).toBe('pending');
    expect(e.acks).toEqual([]);
    const r = await restart(e); // Transfer exists before the sweep, like at app start
    expect(e.acks).toEqual([]);
    await runStartupSweep(r.store, e.fs, { verify: verify(e.fs), now: () => T0 });
    await r.tr.idle();
    await settle();
    expect(e.acks).toEqual([['F1']]);
    expect(e.ackSnapshots[0]).toEqual({ F1: 'local' });
  });

  it('before the ack: local is committed, the ack never left; restart does not ack by itself, an ackNow/reconcile does', async () => {
    const e = await mkEnv([['F1']]);
    e.ackFails.on = true;
    e.tr.enqueue('F1', e.pid);
    await e.tr.idle();
    e.tr.stop();
    expect((e.fs.json(projectJsonPath(e.pid)) as Project).frames[0]!.state).toBe('local');
    e.ackFails.on = false;
    const r = await restart(e);
    await runStartupSweep(r.store, e.fs, { verify: verify(e.fs), now: () => T0 });
    await settle();
    expect(e.acks).toEqual([]); // nothing was acked: the frame stays on the phone until reconcile asks
    await r.tr.ackNow(['F1']); // what reconcile does for ack-eligible listFrames rows
    expect(e.acks).toEqual([['F1']]);
  });
});
