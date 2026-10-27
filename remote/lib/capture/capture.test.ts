import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../camera/client';
import { STRINGS } from '../i18n';
import { FakeFs } from '../projects/fakeFs.testutil';
import type { FrameInfo } from '../projects/model';
import { ProjectStore } from '../projects/store';
import type { Transfer } from '../transfer/types';
import { createCapture, type CameraLike } from './capture';

const info = (projectId: string, n: number, rotation = 0): FrameInfo => ({
  frameId: `F${n}`,
  seq: n,
  projectId,
  clientId: 'c',
  rotation,
  capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: 'a'.repeat(64) },
});

const timeoutErr = () => Object.assign(new Error('timeout'), { code: 'TIMEOUT', local: true });
const closedErr = () => Object.assign(new Error('closed'), { code: 'CLOSED', local: true });
const protoErr = (code: string) => Object.assign(new Error(code), { code, local: false });

type Handler = (op: string, args: any, opts: { reqId?: string; timeoutMs?: number }) => Promise<any> | any;

class FakeCamera implements CameraLike {
  status = 'online';
  hello: { cameraId: string; bootId: string } | null = { cameraId: 'cam-A', bootId: 'boot-1' };
  reconciling = false;
  calls: { op: string; args: any; reqId?: string }[] = [];
  handler: Handler = () => {
    throw new Error('no handler');
  };
  get snapshot() {
    return { status: this.status, hello: this.hello, reconciling: this.reconciling };
  }
  request = async (op: string, args: any = {}, opts: { reqId?: string; timeoutMs?: number } = {}) => {
    this.calls.push({ op, args, reqId: opts.reqId });
    return this.handler(op, args, opts);
  };
  captures() {
    return this.calls.filter((c) => c.op === 'capture');
  }
  /** Never answers: rejects with the local timeout after `timeoutMs` (fake timers drive it). */
  static silent(opts: { timeoutMs?: number }) {
    return new Promise((_, rej) => setTimeout(() => rej(timeoutErr()), opts.timeoutMs ?? 10_000));
  }
}

class FakeTransfer implements Transfer {
  enqueued: [string, string][] = [];
  acked: string[][] = [];
  enqueue(frameId: string, projectId: string) {
    this.enqueued.push([frameId, projectId]);
  }
  ackNow(ids: string[]) {
    this.acked.push(ids);
  }
}

let ids = 0;
async function rig() {
  const fs = new FakeFs();
  const store = new ProjectStore(fs, { now: () => 1_700_000_000_000, newId: () => `p-${++ids}` });
  await store.load();
  const project = await store.createProject('Film');
  const camera = new FakeCamera();
  const transfer = new FakeTransfer();
  const notices: unknown[] = [];
  let n = 0;
  const cap = createCapture({ store, camera, transfer, newId: () => `req-${++n}`, notify: (o) => notices.push(o) });
  const proj = () => store.state.get().projects[project.id]!;
  const ctx = (over: Partial<{ cameraId: string; bootId: string; bootIdChanged: boolean }> = {}): SessionContext =>
    ({
      hello: { cameraId: over.cameraId ?? 'cam-A', bootId: over.bootId ?? 'boot-1', sessionId: 's' },
      bootId: over.bootId ?? 'boot-1',
      bootIdChanged: over.bootIdChanged ?? false,
      request: camera.request,
    }) as SessionContext;
  return { store, camera, transfer, cap, project, proj, ctx, notices };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('press', () => {
  it('begins (outstanding + camera bound), sends capture with the project rotation, merges, enqueues', async () => {
    const r = await rig();
    r.camera.handler = async (op, args) => {
      if (op === 'capture') {
        // the beginCapture mutation was awaited BEFORE the send
        expect(r.proj().outstanding).toEqual([{ reqId: 'req-1', cameraId: 'cam-A', sentAt: expect.any(String) }]);
        expect(r.proj().cameraId).toBe('cam-A');
        return info(args.projectId, 1);
      }
    };
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: true, frameId: 'F1', merge: 'inserted' });
    expect(r.camera.captures()).toEqual([{ op: 'capture', args: { projectId: r.project.id, rotation: 0 }, reqId: 'req-1' }]);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.proj().frames.map((f) => [f.frameId, f.state])).toEqual([['F1', 'pending']]);
    expect(r.transfer.enqueued).toEqual([['F1', r.project.id]]);
  });

  it('sends the project rotation (180), frozen at the first press', async () => {
    const r = await rig();
    const p = await r.store.createProject('Odwrócony', { rotation: 180 });
    r.camera.handler = async (_op, args) => info(args.projectId, 1, 180);
    await r.cap.press(p.id);
    expect(r.camera.captures()[0]!.args.rotation).toBe(180);
  });

  it('uses a new reqId for every press', async () => {
    const r = await rig();
    let seq = 0;
    r.camera.handler = async (_op, args) => info(args.projectId, ++seq);
    await r.cap.press(r.project.id);
    await r.cap.press(r.project.id);
    expect(r.camera.captures().map((c) => c.reqId)).toEqual(['req-1', 'req-2']);
    expect(r.proj().frames).toHaveLength(2);
  });

  it('refuses a press while a capture is outstanding (limit 1), without touching the camera', async () => {
    const r = await rig();
    r.camera.handler = (_op, _a, opts) => FakeCamera.silent(opts);
    const first = r.cap.press(r.project.id);
    await vi.advanceTimersByTimeAsync(100);
    const second = await r.cap.press(r.project.id);
    expect(second).toMatchObject({ ok: false, reason: 'in_progress', messageKey: 'capture.err.inProgress' });
    expect(r.camera.captures()).toHaveLength(1);
    expect(r.proj().outstanding).toHaveLength(1);
    r.camera.handler = async () => ({ state: 'unknown' });
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
  });

  it('two presses in the same tick: exactly one is sent', async () => {
    const r = await rig();
    r.camera.handler = async (_op, args) => info(args.projectId, 1);
    const [a, b] = await Promise.all([r.cap.press(r.project.id), r.cap.press(r.project.id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(r.camera.captures()).toHaveLength(1);
  });

  it('offline: refused before any state change', async () => {
    const r = await rig();
    r.camera.status = 'offline';
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: false, reason: 'offline' });
    expect(r.camera.calls).toEqual([]);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.proj().cameraId).toBeNull();
  });

  it('while the per-session hooks run: not ready', async () => {
    const r = await rig();
    r.camera.reconciling = true;
    expect(await r.cap.press(r.project.id)).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(r.camera.calls).toEqual([]);
  });

  it('a project bound to another camera: blocked with "new movie needed"', async () => {
    const r = await rig();
    r.camera.handler = async (_op, args) => info(args.projectId, 1);
    await r.cap.press(r.project.id); // binds cam-A
    r.camera.hello = { cameraId: 'cam-B', bootId: 'b' };
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: false, reason: 'new_movie_needed', messageKey: 'capture.err.newMovie' });
    expect(r.camera.captures()).toHaveLength(1);
    expect(r.proj().outstanding).toEqual([]);
  });

  it('a result for a deleted project is not merged and goes to ackNow', async () => {
    const r = await rig();
    r.camera.handler = async (_op, args) => {
      // the project is deleted (Undo expired) while the capture is in flight
      await r.store.mutate((s) => ({
        result: undefined,
        index: { ...s.index, projects: [], deletedProjects: [args.projectId] },
        dropProjects: [args.projectId],
      }));
      return info(args.projectId, 7);
    };
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: true, merge: 'deleted_project' });
    expect(r.transfer.enqueued).toEqual([]);
    expect(r.transfer.acked).toEqual([['F7']]);
    expect(r.store.state.get().projects[r.project.id]).toBeUndefined();
  });

  it('a tombstoned frame is not re-inserted and goes to ackNow', async () => {
    const r = await rig();
    await r.store.updateProject(r.project.id, (p) => ({ ...p, deletedFrameIds: ['F1'] }));
    r.camera.handler = async (_op, args) => info(args.projectId, 1);
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: true, merge: 'tombstoned' });
    expect(r.proj().frames).toEqual([]);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.transfer.acked).toEqual([['F1']]);
  });
});

describe('camera error answers', () => {
  const cases: [string, string, string][] = [
    ['CAPTURE_IN_PROGRESS', 'in_progress', 'capture.err.inProgress'],
    ['CAMERA_NOT_READY', 'not_ready', 'capture.err.notReady'],
    ['STORAGE_LOW', 'storage_low', 'capture.err.storageLow'],
    ['GEOMETRY_MISMATCH', 'geometry_mismatch', 'capture.err.geometry'],
    ['CAPTURE_FAILED', 'generic', 'capture.err.generic'],
  ];
  for (const [code, reason, key] of cases) {
    it(`${code}: entry dropped, kid message ${key}, next press uses a new reqId, no auto-retake`, async () => {
      const r = await rig();
      r.camera.handler = async () => {
        throw protoErr(code);
      };
      const o = await r.cap.press(r.project.id);
      expect(o).toMatchObject({ ok: false, reason, messageKey: key, code });
      expect(r.proj().outstanding).toEqual([]);
      expect(r.camera.calls).toHaveLength(1); // no getOperation, no retry
      await r.cap.press(r.project.id);
      expect(r.camera.captures().map((c) => c.reqId)).toEqual(['req-1', 'req-2']);
    });
  }

  it('the kid-level keys exist in pl and ru', () => {
    for (const [, , key] of cases) for (const lang of ['pl', 'ru'] as const) expect((STRINGS[lang] as any)[key]).toBeTypeOf('string');
    for (const key of ['capture.err.later', 'capture.err.newMovie', 'capture.err.offline']) expect((STRINGS.pl as any)[key]).toBeTypeOf('string');
    expect(STRINGS.pl['capture.err.later']).toBe('Sprawdzimy tę klatkę później.');
    expect(STRINGS.pl['capture.err.generic']).toBe('Nie wyszło, spróbuj jeszcze raz.');
  });
});

describe('send timeout and resolve', () => {
  it('10 s without an answer: getOperation(reqId) -> done -> merged and enqueued', async () => {
    const r = await rig();
    r.camera.handler = (op, args, opts) => {
      if (op === 'capture') return FakeCamera.silent(opts);
      expect(args).toEqual({ reqId: 'req-1' });
      return { state: 'done', result: info(r.project.id, 1) };
    };
    const p = r.cap.press(r.project.id);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(r.camera.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ ok: true, frameId: 'F1' });
    expect(r.camera.captures()[0]).toMatchObject({ reqId: 'req-1' });
    expect(r.proj().outstanding).toEqual([]);
    expect(r.transfer.enqueued).toEqual([['F1', r.project.id]]);
  });

  it('pending: polls every 1 s, then gives up after 30 s with "sprawdzimy później" and drops the entry', async () => {
    const r = await rig();
    r.camera.handler = (op, _a, opts) => (op === 'capture' ? FakeCamera.silent(opts) : { state: 'pending' });
    const p = r.cap.press(r.project.id);
    await vi.advanceTimersByTimeAsync(10_000);
    const ops = () => r.camera.calls.filter((c) => c.op === 'getOperation').length;
    expect(ops()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ops()).toBe(6);
    expect(r.proj().outstanding).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25_000);
    const o = await p;
    expect(o).toMatchObject({ ok: false, reason: 'later', messageKey: 'capture.err.later' });
    expect(ops()).toBeGreaterThanOrEqual(30);
    expect(ops()).toBeLessThanOrEqual(32);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.proj().frames).toEqual([]);
  });

  it('pending, then the camera restarts (bootId changes): dropped at once', async () => {
    const r = await rig();
    r.camera.handler = (op, _a, opts) => (op === 'capture' ? FakeCamera.silent(opts) : { state: 'pending' });
    const p = r.cap.press(r.project.id);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(r.proj().outstanding).toHaveLength(1);
    r.camera.hello = { cameraId: 'cam-A', bootId: 'boot-2' };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toMatchObject({ ok: false, reason: 'later' });
    expect(r.proj().outstanding).toEqual([]);
  });

  it('failed / unknown: dropped with "nie wyszło"', async () => {
    for (const answer of [{ state: 'failed', error: { code: 'INTERRUPTED' } }, { state: 'unknown' }]) {
      const r = await rig();
      r.camera.handler = (op, _a, opts) => (op === 'capture' ? FakeCamera.silent(opts) : answer);
      const p = r.cap.press(r.project.id);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toMatchObject({ ok: false, reason: 'generic', messageKey: 'capture.err.generic' });
      expect(r.proj().outstanding).toEqual([]);
    }
  });

  it('connection lost while waiting: the entry stays for the next session', async () => {
    const r = await rig();
    r.camera.handler = async (op) => {
      throw closedErr();
    };
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: false, reason: 'later' });
    expect(r.proj().outstanding).toHaveLength(1);
  });
});

describe('resolveOutstanding (per-session hook)', () => {
  const seed = async (r: Awaited<ReturnType<typeof rig>>, reqId: string, cameraId: string) =>
    r.store.updateProject(r.project.id, (p) => ({
      ...p,
      cameraId: p.cameraId ?? cameraId,
      outstanding: [...p.outstanding, { reqId, cameraId, sentAt: '2026-10-27T10:00:00.000Z' }],
    }));

  it('resolves entries of the connected camera; entries of another camera are left alone', async () => {
    const r = await rig();
    const other = await r.store.createProject('Inna kamera');
    await r.store.updateProject(other.id, (p) => ({
      ...p,
      cameraId: 'cam-B',
      outstanding: [{ reqId: 'req-B', cameraId: 'cam-B', sentAt: '2026-10-27T10:00:00.000Z' }],
    }));
    await seed(r, 'req-A', 'cam-A');
    r.camera.handler = (op, args) => {
      expect(op).toBe('getOperation');
      expect(args.reqId).toBe('req-A');
      return { state: 'done', result: info(r.project.id, 1) };
    };
    await r.cap.resolveOutstanding(r.ctx());
    expect(r.camera.calls).toHaveLength(1);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.proj().frames).toHaveLength(1);
    expect(r.transfer.enqueued).toEqual([['F1', r.project.id]]);
    expect(r.store.state.get().projects[other.id]!.outstanding.map((o) => o.reqId)).toEqual(['req-B']);
    expect(r.notices).toHaveLength(1);
  });

  it('a duplicate result via a second resolve changes nothing and does not enqueue twice', async () => {
    const r = await rig();
    await seed(r, 'req-A', 'cam-A');
    r.camera.handler = () => ({ state: 'done', result: info(r.project.id, 1) });
    await r.cap.resolveOutstanding(r.ctx());
    const after = r.proj();
    await r.cap.resolveOutstanding(r.ctx()); // nothing outstanding any more
    // and the very same result applied again (e.g. a second session racing the first)
    await seed(r, 'req-A', 'cam-A');
    await r.cap.resolveOutstanding(r.ctx());
    expect(r.proj().frames).toEqual(after.frames);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.transfer.enqueued).toHaveLength(1);
  });

  it('pending after a bootId change: dropped without polling', async () => {
    const r = await rig();
    await seed(r, 'req-A', 'cam-A');
    r.camera.handler = () => ({ state: 'pending' });
    await r.cap.resolveOutstanding(r.ctx({ bootIdChanged: true, bootId: 'boot-2' }));
    expect(r.camera.calls).toHaveLength(1);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.notices[0]).toMatchObject({ ok: false, reason: 'later' });
  });

  it('pending without a restart: polls up to 30 s', async () => {
    const r = await rig();
    await seed(r, 'req-A', 'cam-A');
    r.camera.handler = () => ({ state: 'pending' });
    const p = r.cap.resolveOutstanding(r.ctx());
    await vi.advanceTimersByTimeAsync(29_000);
    expect(r.proj().outstanding).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await p;
    expect(r.proj().outstanding).toEqual([]);
  });

  it('getOperation cannot be asked (connection dropped): the entry is kept', async () => {
    const r = await rig();
    await seed(r, 'req-A', 'cam-A');
    r.camera.handler = () => {
      throw closedErr();
    };
    await r.cap.resolveOutstanding(r.ctx());
    expect(r.proj().outstanding).toHaveLength(1);
  });
});
