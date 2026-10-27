import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../camera/client';
import { createCapture, type CameraLike } from '../capture/capture';
import { FakeFs } from '../projects/fakeFs.testutil';
import type { FrameInfo } from '../projects/model';
import { ProjectStore } from '../projects/store';
import { createStore } from '../state/store';
import { createLifecycle, KeepAwakeManager } from './lifecycle';

function rig() {
  const log: string[] = [];
  const exporting = createStore(false);
  let paused = false;
  let running = true;
  let connections = 0;
  const client = {
    start: () => {
      running = true;
      log.push('client.start');
    },
    stop: () => {
      running = false;
      log.push('client.stop');
    },
    // like CameraClient.resume(): a no-op unless running, never opens a second connection
    resume: () => {
      log.push('client.resume');
      if (running) connections = 1;
    },
  };
  const transfer = {
    pause: vi.fn(async () => {
      paused = true;
      log.push('transfer.pause');
    }),
    resume: vi.fn(() => {
      paused = false;
      log.push('transfer.resume');
    }),
    kick: vi.fn(() => void log.push('transfer.kick')),
  };
  const awake = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const lc = createLifecycle({ client, transfer, exporting, keepAwake: awake });
  const preview = { start: vi.fn(() => void log.push('preview.start')), stop: vi.fn(() => void log.push('preview.stop')) };
  lc.registerPreview(preview);
  return { log, exporting, client, transfer, awake, lc, preview, isPaused: () => paused, connections: () => connections };
}

describe('pause / resume', () => {
  it('pause: stops the preview, pauses transfers, releases keep-awake; resume: client, preview, transfers + kick', () => {
    const r = rig();
    const off = r.lc.keepAwake.hold('view');
    expect(r.awake.acquire).toHaveBeenCalledTimes(1);
    r.lc.setActive(false);
    expect(r.log).toEqual(['preview.stop', 'transfer.pause']);
    expect(r.awake.release).toHaveBeenCalledTimes(1);
    r.log.length = 0;
    r.lc.setActive(true);
    expect(r.log).toEqual(['client.resume', 'preview.start', 'transfer.resume', 'transfer.kick']);
    expect(r.awake.acquire).toHaveBeenCalledTimes(2);
    off();
    expect(r.awake.release).toHaveBeenCalledTimes(2);
  });

  it('repeated resume does not double anything: one connection, one resume per transition', () => {
    const r = rig();
    r.lc.setActive(false);
    r.lc.setActive(true);
    r.lc.setActive(true);
    r.lc.setActive(true);
    expect(r.log.filter((l) => l === 'client.resume')).toHaveLength(1);
    expect(r.log.filter((l) => l === 'client.start')).toHaveLength(0);
    expect(r.transfer.resume).toHaveBeenCalledTimes(1);
    expect(r.connections()).toBe(1);
    // a resume while the app was never paused is a no-op too
    const r2 = rig();
    r2.lc.setActive(true);
    expect(r2.log).toEqual([]);
  });

  it('a download in flight: the queue is paused (after the current job) and continues after resume', async () => {
    const r = rig();
    let finishJob!: () => void;
    r.transfer.pause.mockImplementationOnce(() => new Promise<void>((res) => (finishJob = res)));
    r.lc.setActive(false);
    expect(r.transfer.pause).toHaveBeenCalledTimes(1);
    r.lc.setActive(true); // back before the job ended
    expect(r.transfer.resume).toHaveBeenCalledTimes(1);
    expect(r.transfer.kick).toHaveBeenCalledTimes(1);
    finishJob();
  });
});

describe('export', () => {
  it('background during an export: no transfer pause (the export owns it), keep-awake stays, resume leaves the queue paused', () => {
    const r = rig();
    r.exporting.set(true); // export started: it holds the screen
    expect(r.lc.keepAwake.held).toBe(true);
    r.lc.setActive(false);
    expect(r.transfer.pause).not.toHaveBeenCalled();
    expect(r.lc.keepAwake.held).toBe(true);
    expect(r.awake.release).not.toHaveBeenCalled();
    r.lc.setActive(true);
    expect(r.transfer.resume).not.toHaveBeenCalled();
    expect(r.transfer.kick).not.toHaveBeenCalled();
    expect(r.log).toContain('client.resume');
  });

  it('the export ends while in the background: the queue is paused again and the screen released', () => {
    const r = rig();
    r.exporting.set(true);
    r.lc.setActive(false);
    // the export controller's finally: transfer.resume() then exporting=false
    r.transfer.resume();
    r.exporting.set(false);
    expect(r.transfer.pause).toHaveBeenCalledTimes(1);
    expect(r.isPaused()).toBe(true);
    expect(r.lc.keepAwake.held).toBe(false);
    r.lc.setActive(true);
    expect(r.isPaused()).toBe(false);
  });

  it('background first, then an export starts: it is not undone by resume', () => {
    const r = rig();
    r.lc.setActive(false);
    r.exporting.set(true);
    expect(r.lc.keepAwake.held).toBe(true);
    r.lc.setActive(true);
    expect(r.transfer.resume).not.toHaveBeenCalled(); // `paused` was ours, but the export's pause is in force
  });
});

describe('keep-awake ref counting', () => {
  const adapter = () => ({ acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) });

  it('held while any holder exists; acquire/release once per edge; release is idempotent', () => {
    const a = adapter();
    const k = new KeepAwakeManager(a);
    const v1 = k.hold('view');
    const v2 = k.hold('view');
    const e = k.hold('export');
    expect(a.acquire).toHaveBeenCalledTimes(1);
    v1();
    v1(); // double release does nothing
    expect(k.count('view')).toBe(1);
    v2();
    expect(a.release).not.toHaveBeenCalled(); // the export still holds
    e();
    expect(a.release).toHaveBeenCalledTimes(1);
    expect(k.held).toBe(false);
  });

  it('background drops view holds only; an export keeps the screen', () => {
    const a = adapter();
    const k = new KeepAwakeManager(a);
    const v = k.hold('view');
    k.setBackground(true);
    expect(k.held).toBe(false);
    const e = k.hold('export');
    expect(k.held).toBe(true);
    e();
    expect(k.held).toBe(false);
    k.setBackground(false);
    expect(k.held).toBe(true);
    v();
    expect(k.held).toBe(false);
  });

  it('a failing plugin never throws', async () => {
    const k = new KeepAwakeManager({ acquire: () => Promise.reject(new Error('x')), release: () => Promise.reject(new Error('y')) });
    k.hold()();
    await Promise.resolve();
  });
});

describe('Diagnostics probes', () => {
  it('the app client yields while probes run, restarts after; app state changes meanwhile do not restart it', () => {
    const r = rig();
    const done = r.lc.yieldToProbes();
    expect(r.log).toEqual(['client.stop', 'preview.stop', 'transfer.pause']);
    r.lc.setActive(false);
    r.lc.setActive(true); // probes still running: nothing restarts
    expect(r.log).not.toContain('client.resume');
    r.log.length = 0;
    done();
    done();
    expect(r.log).toEqual(['client.start', 'preview.start', 'transfer.resume', 'transfer.kick']);
  });

  it('probes finishing in the background restart only the client', () => {
    const r = rig();
    const done = r.lc.yieldToProbes();
    r.lc.setActive(false);
    r.log.length = 0;
    done();
    expect(r.log).toEqual(['client.start']);
  });
});

// --- a capture in flight while the app goes to the background (§7 crash point) ------------------

const info = (projectId: string): FrameInfo => ({
  frameId: 'F1',
  seq: 1,
  projectId,
  clientId: 'c',
  rotation: 0,
  capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: 'a'.repeat(64) },
});

describe('capture in flight', () => {
  it('press -> pause -> session lost -> resume -> the per-session hook resolves it via getOperation', async () => {
    const fs = new FakeFs();
    const store = new ProjectStore(fs, { now: () => 1_700_000_000_000, newId: () => 'p-1' });
    await store.load();
    const project = await store.createProject('Film');
    const calls: string[] = [];
    let online = true;
    let release!: (e: Error) => void;
    const camera: CameraLike & { request: any } = {
      get snapshot() {
        return { status: 'online', hello: { cameraId: 'cam-A', bootId: 'b1' }, reconciling: false } as any;
      },
      request: async (op: string) => {
        calls.push(op);
        if (op === 'capture') return new Promise((_, rej) => (release = rej));
        if (op === 'getOperation') {
          if (!online) throw Object.assign(new Error('closed'), { code: 'CLOSED', local: true });
          return { state: 'done', result: info(project.id) };
        }
        throw new Error(op);
      },
    };
    const enqueued: string[] = [];
    const cap = createCapture({ store, camera, transfer: { enqueue: (f: string) => void enqueued.push(f), ackNow: () => {} }, newId: () => 'req-1', notify: () => {} });
    const ctx = { hello: { cameraId: 'cam-A', bootId: 'b1', sessionId: 's2' }, bootId: 'b1', bootIdChanged: false, request: camera.request } as unknown as SessionContext;
    const r = rig();
    // the real client would run the hook on the new session after resume()
    r.client.resume = () => {
      online = true;
      void cap.resolveOutstanding(ctx);
    };

    const pressing = cap.press(project.id);
    await vi.waitFor(() => expect(calls).toContain('capture'));
    r.lc.setActive(false); // app to the background mid-capture
    online = false;
    release(Object.assign(new Error('closed'), { code: 'CLOSED', local: true })); // the OS killed the socket
    await pressing;
    expect(store.state.get().projects[project.id]!.outstanding).toHaveLength(1);
    expect(store.state.get().projects[project.id]!.frames).toHaveLength(0);

    r.lc.setActive(true);
    await vi.waitFor(() => expect(store.state.get().projects[project.id]!.outstanding).toHaveLength(0));
    expect(calls).toContain('getOperation');
    expect(store.state.get().projects[project.id]!.frames.map((f) => f.frameId)).toEqual(['F1']);
    expect(enqueued).toEqual(['F1']);
  });
});
