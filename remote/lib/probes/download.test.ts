import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { captureFrame, openSession } from './camera';
import { DOWNLOAD_DEST, downloadProbe, type DownloadData, type DownloadNative, type DownloadProbeDeps } from './download';
import { nodeSessionDeps, shared as sharedFor, startFakeCamera, type FakeCamera } from './fakeCamera.testutil';
import { runProbes } from './runner';
import type { ProbeShared } from './shared';

let cam: FakeCamera | null = null;
afterEach(async () => {
  await cam?.close();
  cam = null;
});

const ROOT = 'file:///data/user/0/pl.slava.kopernikadr.remote.debug/files/kopernikadr/';

/** An in-memory stand-in for Filesystem + FileTransfer + KopernikadrNative. */
function fakeNative(opts: { corrupt?: boolean; installError?: Error } = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const native: DownloadNative = {
    async ensureTmpDir() {
      calls.push('mkdir tmp');
    },
    async uriOf(path) {
      return ROOT + path;
    },
    async download(url, uri) {
      calls.push(`download ${uri.slice(ROOT.length)}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (opts.corrupt) bytes[bytes.length - 1] ^= 1;
      files.set(uri.slice(ROOT.length), bytes);
    },
    async read(uri) {
      const b = files.get(uri.slice(ROOT.length));
      if (!b) throw new Error(`no file ${uri}`);
      return b;
    },
    async installFile({ tmp, dest, bytes }) {
      calls.push(`install ${tmp} -> ${dest}`);
      if (opts.installError) throw opts.installError;
      const b = files.get(tmp);
      if (!b || b.length !== bytes) throw Object.assign(new Error('mismatch'), { code: 'CHECKSUM_MISMATCH' });
      files.delete(tmp);
      files.set(dest, b);
      return 'INSTALLED';
    },
    async remove(path) {
      calls.push(`remove ${path}`);
      files.delete(path);
    },
  };
  return { native, files, calls };
}

const PROJECT = randomUUID();

function deps(clientId: string, native: DownloadNative | null, extra: Partial<DownloadProbeDeps> = {}): DownloadProbeDeps {
  return { ...nodeSessionDeps(clientId), fetch, native, projectId: PROJECT, ...extra };
}

/** Captures `n` frames as `clientId` (the probe, or the kid's remote). */
async function capture(c: FakeCamera, clientId: string, n: number): Promise<string[]> {
  const s = await openSession({ host: '127.0.0.1', port: c.port }, nodeSessionDeps(clientId));
  try {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await captureFrame(s, { projectId: PROJECT, rotation: 180 }, { now: () => performance.now() })).frame.frameId);
    return ids;
  } finally {
    s.close();
  }
}

async function run(d: DownloadProbeDeps, shared: ProbeShared) {
  return (await runProbes([downloadProbe(d)], { shared })).results[0];
}

describe('download probe (fake camera)', () => {
  it('native: downloads the probe frames to tmp/, verifies size + sha256, installs, then acks them', async () => {
    cam = await startFakeCamera();
    const probeId = randomUUID();
    const ids = await capture(cam, probeId, 2);
    const { native, files, calls } = fakeNative();
    const shared: ProbeShared = sharedFor(cam);
    const r = await run(deps(probeId, native), shared);

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const data = r.data as DownloadData;
    expect(data).toMatchObject({ mode: 'native', listed: 2, hasMore: false, ack: { requested: 2, acked: 2, unknown: [] }, errors: [] });
    expect(data.capturedFrameId).toBeUndefined();
    expect(data.frames.map((f) => [f.frameId, f.sizeOk, f.sha256Ok, f.install, f.verified])).toEqual(ids.map((id) => [id, true, true, 'INSTALLED', true]));
    expect(data.totalBytes).toBe(2 * cam.fullBytes.length);
    expect(calls).toEqual([
      'mkdir tmp',
      `download tmp/probe-${ids[0]}.jpg`,
      `install tmp/probe-${ids[0]}.jpg -> ${DOWNLOAD_DEST}`,
      `download tmp/probe-${ids[1]}.jpg`,
      `install tmp/probe-${ids[1]}.jpg -> ${DOWNLOAD_DEST}`,
    ]);
    expect([...files.keys()]).toEqual([DOWNLOAD_DEST]);
    expect(shared.downloaded).toEqual({ frameId: ids[1], path: DOWNLOAD_DEST, uri: ROOT + DOWNLOAD_DEST, bytes: cam.fullBytes.length });
    expect([...cam.state.acked].sort()).toEqual([...ids].sort());
  });

  it('captures its own frame when the probe has none listed, and acks it', async () => {
    cam = await startFakeCamera();
    const probeId = randomUUID();
    const r = await run(deps(probeId, fakeNative().native), sharedFor(cam));
    const data = r.data as DownloadData;
    expect(r.ok).toBe(true);
    expect(data.listed).toBe(0);
    expect(cam.state.frames.get(data.capturedFrameId!)).toMatchObject({ clientId: probeId, projectId: PROJECT });
    expect([...cam.state.acked]).toEqual([data.capturedFrameId]);
  });

  it('never lists or acks another client\'s frames (the kid\'s)', async () => {
    cam = await startFakeCamera();
    // The kid's frames are put straight into the fake's spool: a second clientId would get BUSY
    // until the kid's session TTL (10 s) runs out.
    const kidFrames = ['01KID000001', '01KID000002'];
    for (const [i, frameId] of kidFrames.entries()) {
      cam.state.frames.set(frameId, { frameId, seq: 100 + i, clientId: randomUUID(), projectId: randomUUID(), full: { w: 1, h: 1, bytes: 1, sha256: '0'.repeat(64) } });
    }
    const probeId = randomUUID();
    const probeFrames = await capture(cam, probeId, 1);
    const r = await run(deps(probeId, fakeNative().native), sharedFor(cam));
    expect(r.ok).toBe(true);
    expect((r.data as DownloadData).frames.map((f) => f.frameId)).toEqual(probeFrames);
    expect([...cam.state.acked]).toEqual(probeFrames);
    for (const id of kidFrames) expect(cam.state.acked.has(id)).toBe(false);
  });

  it('a corrupt download is not installed and NOT acked; its tmp file is removed', async () => {
    cam = await startFakeCamera();
    const probeId = randomUUID();
    const [id] = await capture(cam, probeId, 1);
    const { native, files, calls } = fakeNative({ corrupt: true });
    const shared: ProbeShared = sharedFor(cam);
    const r = await run(deps(probeId, native), shared);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`${id}: sha256 mismatch`);
    const data = r.data as DownloadData;
    expect(data.frames[0]).toMatchObject({ sizeOk: true, sha256Ok: false, verified: false });
    expect(data.ack).toBeNull();
    expect(cam.state.acked.size).toBe(0);
    expect(calls).toContain(`remove tmp/probe-${id}.jpg`);
    expect(calls.some((c) => c.startsWith('install'))).toBe(false);
    expect(files.size).toBe(0);
    expect(shared.downloaded).toBeUndefined();
  });

  it('an installFile error (no space) fails the frame and it is NOT acked', async () => {
    cam = await startFakeCamera();
    const probeId = randomUUID();
    await capture(cam, probeId, 1);
    const err = Object.assign(new Error('free space below reserve'), { code: 'NO_SPACE' });
    const r = await run(deps(probeId, fakeNative({ installError: err }).native), sharedFor(cam));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/NO_SPACE: free space below reserve/);
    expect(cam.state.acked.size).toBe(0);
  });

  it('caps the frames per run (the rest stay for the next run)', async () => {
    cam = await startFakeCamera();
    const probeId = randomUUID();
    const ids = await capture(cam, probeId, 3);
    const r = await run(deps(probeId, fakeNative().native, { maxFrames: 2 }), sharedFor(cam));
    expect(r.data).toMatchObject({ listed: 2, hasMore: true, ack: { acked: 2 } });
    expect([...cam.state.acked].sort()).toEqual(ids.slice(0, 2).sort());
  });

  it('browser: skipped as native-only, but the frames are fetched, verified and acked', async () => {
    cam = await startFakeCamera();
    const probeId = randomUUID();
    const ids = await capture(cam, probeId, 2);
    const shared: ProbeShared = sharedFor(cam);
    const r = await run(deps(probeId, null), shared);
    expect(r).toMatchObject({ ok: false, skipped: 'native-only' });
    expect(r.data).toMatchObject({ mode: 'fetch', listed: 2, ack: { acked: 2 }, errors: [] });
    expect([...cam.state.acked].sort()).toEqual([...ids].sort());
    expect(shared.downloaded).toBeUndefined();
  });

  it('fails without an address, and with hello errors when the camera is down', async () => {
    expect(await run(deps(randomUUID(), null), { manualAddress: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/no camera address/) });
    cam = await startFakeCamera();
    const port = cam.port;
    await cam.close();
    cam = null;
    const r = await run(deps(randomUUID(), fakeNative().native), { manualAddress: `127.0.0.1:${port}` });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^hello: cannot connect/) });
  });
});
