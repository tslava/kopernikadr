// Integration: the capture flow + CameraClient + CameraConnection against the Node fake camera
// (real HTTP + WebSocket on an ephemeral port, real timers with shortened capture constants).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { NsdAdapter } from '../discovery';
import { CameraClient } from '../camera/client';
import { startFakeCamera, type FakeCamera } from '../probes/fakeCamera.testutil';
import { FakeFs } from '../projects/fakeFs.testutil';
import { ProjectStore } from '../projects/store';
import type { Transfer } from '../transfer/types';
import { createCapture } from './capture';
import type { CaptureOutcome } from './outstanding';

const nsd: NsdAdapter = { start: async () => {}, stop: async () => {} };
const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const hit = async (cam: FakeCamera, path: string) => (await fetch(`http://127.0.0.1:${cam.port}${path}`)).json();

let cam: FakeCamera | null = null;
let client: CameraClient | null = null;
afterEach(async () => {
  client?.stop();
  client = null;
  await cam?.close();
  cam = null;
});

async function rig(over: { sendTimeoutMs?: number; pollMs?: number; giveUpMs?: number; start?: boolean } = {}) {
  cam = await startFakeCamera({ rotation: 0 });
  const info = (await (await fetch(`http://127.0.0.1:${cam.port}/info`)).json()) as { cameraId: string };
  const store = new ProjectStore(new FakeFs());
  await store.load();
  const project = await store.createProject('Film');
  const enqueued: string[] = [];
  const acked: string[][] = [];
  const transfer: Transfer = { enqueue: (f) => void enqueued.push(f), ackNow: (ids) => void acked.push(ids) };
  const notices: CaptureOutcome[] = [];
  const c = { current: null as unknown as CameraClient };
  let n = 0;
  const cap = createCapture({
    store,
    transfer,
    newId: () => `req-${++n}`,
    camera: { request: (...a) => c.current.request(...a), get snapshot() { return c.current.snapshot; } },
    sendTimeoutMs: over.sendTimeoutMs ?? 300,
    pollMs: over.pollMs ?? 40,
    giveUpMs: over.giveUpMs ?? 600,
    notify: (o) => notices.push(o),
  });
  client = c.current = new CameraClient({
    clientId: randomUUID(),
    remembered: { cameraId: info.cameraId, host: '127.0.0.1', port: cam.port },
    saveRememberedCamera: () => {},
    resolveOutstanding: cap.resolveOutstanding,
    reconcile: () => {},
    nsd,
    searchWindowMs: 50,
  });
  if (over.start !== false) {
    client.start();
    await until(() => client!.snapshot.status === 'online' && !client!.snapshot.reconciling, 'online');
  }
  const proj = () => store.state.get().projects[project.id]!;
  return { store, project, cap, enqueued, acked, notices, proj, cameraId: info.cameraId };
}

describe('capture against the fake camera', () => {
  it('happy path: frame merged as pending and enqueued', async () => {
    const r = await rig();
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: true, merge: 'inserted' });
    expect(r.proj().frames).toHaveLength(1);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.proj().cameraId).toBe(r.cameraId);
    expect(r.enqueued).toEqual([r.proj().frames[0]!.frameId]);
  });

  it('a lost response on a live connection (/fake/drop-capture): resolved by getOperation, one frame', async () => {
    const r = await rig();
    await hit(cam!, '/fake/drop-capture');
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: true, merge: 'inserted' });
    expect(r.proj().frames).toHaveLength(1);
    expect(r.proj().outstanding).toEqual([]);
    expect(cam!.state.frames.size).toBe(1); // never re-sent
    expect(r.enqueued).toHaveLength(1);
  });

  it('pending forever: gives up with "later", the entry is dropped, the next press works', async () => {
    const r = await rig();
    await hit(cam!, '/fake/pending-forever');
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: false, reason: 'later', messageKey: 'capture.err.later' });
    expect(r.proj().outstanding).toEqual([]);
    expect(r.proj().frames).toEqual([]);
    const again = await r.cap.press(r.project.id);
    expect(again).toMatchObject({ ok: true });
  });

  it('a bootId change while pending: the entry is dropped by the new session\'s hook', async () => {
    const r = await rig({ giveUpMs: 60_000 });
    await hit(cam!, '/fake/pending-forever');
    const p = r.cap.press(r.project.id);
    await new Promise((res) => setTimeout(res, 450)); // past the send timeout, polling
    expect(r.proj().outstanding).toHaveLength(1);
    await hit(cam!, '/fake/restart'); // the record stays `pending` like after a crash
    expect(await p).toMatchObject({ ok: false });
    await until(() => r.proj().outstanding.length === 0, 'entry dropped after restart', 15_000);
    expect(r.proj().frames).toEqual([]);
    await until(() => client!.snapshot.status === 'online' && !client!.snapshot.reconciling, 'online again', 15_000);
    expect(await r.cap.press(r.project.id)).toMatchObject({ ok: true });
  }, 30_000);

  it('a duplicate result via a second resolve is harmless', async () => {
    const r = await rig();
    await hit(cam!, '/fake/drop-capture');
    expect(await r.cap.press(r.project.id)).toMatchObject({ ok: true });
    const frameId = r.proj().frames[0]!.frameId;
    // the same entry again (as if a session raced the press): getOperation answers `done` once more
    await r.store.updateProject(r.project.id, (p) => ({
      ...p,
      outstanding: [{ reqId: 'req-1', cameraId: r.cameraId, sentAt: new Date().toISOString() }],
    }));
    await r.cap.resolveOutstanding({ hello: { cameraId: r.cameraId } } as never);
    expect(r.proj().frames.map((f) => f.frameId)).toEqual([frameId]);
    expect(r.proj().outstanding).toEqual([]);
    expect(r.enqueued).toHaveLength(1);
  });

  it('capture while offline is refused without touching state', async () => {
    const r = await rig({ start: false });
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: false, reason: 'offline', messageKey: 'capture.err.offline' });
    expect(r.proj().outstanding).toEqual([]);
    expect(r.proj().cameraId).toBeNull();
    expect(cam!.state.frames.size).toBe(0);
  });

  it('entries of another camera are left alone by the session hook', async () => {
    const r = await rig({ start: false });
    const other = await r.store.createProject('Inna kamera');
    await r.store.updateProject(other.id, (p) => ({
      ...p,
      cameraId: 'some-other-camera',
      outstanding: [{ reqId: 'r-other', cameraId: 'some-other-camera', sentAt: new Date().toISOString() }],
    }));
    client!.start();
    await until(() => client!.snapshot.status === 'online' && !client!.snapshot.reconciling, 'online');
    expect(r.store.state.get().projects[other.id]!.outstanding.map((o) => o.reqId)).toEqual(['r-other']);
    expect(r.notices).toEqual([]);
    // and it does not block this camera's own capture
    expect(await r.cap.press(r.project.id)).toMatchObject({ ok: true });
  });

  it('an outstanding entry of this camera is resolved when the session starts', async () => {
    const r = await rig({ start: false });
    await r.store.updateProject(r.project.id, (p) => ({
      ...p,
      cameraId: r.cameraId,
      outstanding: [{ reqId: randomUUID(), cameraId: r.cameraId, sentAt: new Date().toISOString() }],
    }));
    client!.start();
    await until(() => client!.snapshot.status === 'online' && !client!.snapshot.reconciling, 'online');
    expect(r.proj().outstanding).toEqual([]); // unknown reqId -> dropped
    expect(r.notices[0]).toMatchObject({ ok: false, reason: 'generic' });
  });

  it('GEOMETRY_MISMATCH (project rotation differs from the camera): kid message, entry dropped', async () => {
    const r = await rig();
    const p = await r.store.createProject('Odwrócony', { rotation: 180 });
    const o = await r.cap.press(p.id);
    expect(o).toMatchObject({ ok: false, reason: 'geometry_mismatch', messageKey: 'capture.err.geometry' });
    expect(r.store.state.get().projects[p.id]!.outstanding).toEqual([]);
  });

  it('STORAGE_LOW: kid message, entry dropped, no auto-retake, next press (new reqId) succeeds', async () => {
    const r = await rig();
    await hit(cam!, '/fake/storage-low');
    const o = await r.cap.press(r.project.id);
    expect(o).toMatchObject({ ok: false, reason: 'storage_low', messageKey: 'capture.err.storageLow' });
    expect(r.proj().outstanding).toEqual([]);
    expect(cam!.state.frames.size).toBe(0);
    expect(await r.cap.press(r.project.id)).toMatchObject({ ok: true });
  });
});
