import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cameraProbe, captureFrame, hostPort, NO_TARGET, openSession, parseAddress, resolveTarget, type CameraData, type CameraProbeDeps } from './camera';
import { holdSession, nodeSessionDeps, shared as sharedFor, startFakeCamera, type FakeCamera } from './fakeCamera.testutil';
import { runProbes } from './runner';
import type { ProbeShared } from './shared';

let cam: FakeCamera | null = null;
afterEach(async () => {
  await cam?.close();
  cam = null;
});

const deps = (clientId = randomUUID()): CameraProbeDeps => ({
  ...nodeSessionDeps(clientId),
  fetch,
  projectId: randomUUID(),
  previewSeconds: 0.25,
  qualitySettleMs: 0,
});

async function runCamera(shared: ProbeShared, d = deps()) {
  const run = await runProbes([cameraProbe(d)], { shared });
  return run.results[0];
}

describe('address', () => {
  it('parses host, host:port, URLs and IPv6', () => {
    expect(parseAddress('10.0.2.2:8765')).toEqual({ host: '10.0.2.2', port: 8765 });
    expect(parseAddress(' 192.168.1.34 ')).toEqual({ host: '192.168.1.34', port: 8765 });
    expect(parseAddress('http://192.168.1.34:9000/info')).toEqual({ host: '192.168.1.34', port: 9000 });
    expect(parseAddress('ws://phone.local:8765')).toEqual({ host: 'phone.local', port: 8765 });
    expect(parseAddress('[fe80::1]:8765')).toEqual({ host: 'fe80::1', port: 8765 });
    for (const bad of ['', '  ', 'a b', 'host:0', 'host:70000', 'host:x', 'fe80::1']) expect(parseAddress(bad), bad).toBeNull();
  });

  it('host:port for URLs brackets IPv6', () => {
    expect(hostPort({ host: '10.0.2.2', port: 8765 })).toBe('10.0.2.2:8765');
    expect(hostPort({ host: 'fe80::1%wlan0', port: 8765 })).toBe('[fe80::1%25wlan0]:8765');
  });

  it('target: the first NSD camera wins, else the manual address, else none', () => {
    const nsd = { cameraId: 'c', name: 'n', protocolVersions: { min: 1, max: 1 }, host: '192.168.1.34', port: 8765 };
    expect(resolveTarget({ manualAddress: '10.0.2.2:8765', nsdServices: [nsd] })).toEqual({ host: '192.168.1.34', port: 8765, source: 'nsd' });
    expect(resolveTarget({ manualAddress: '10.0.2.2:8765', nsdServices: [] })).toEqual({ host: '10.0.2.2', port: 8765, source: 'manual' });
    expect(resolveTarget({ manualAddress: '' })).toBeNull();
  });
});

describe('camera probe (fake camera)', () => {
  it('measures /info, hello, preview at low/normal/high, ping during a capture and a capture round-trip', async () => {
    cam = await startFakeCamera();
    const shared: ProbeShared = sharedFor(cam);
    const d = deps();
    const r = await runCamera(shared, d);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const data = r.data as CameraData;
    expect(data.target).toEqual({ host: '127.0.0.1', port: cam.port, source: 'manual' });
    expect(data.info).toMatchObject({ cameraId: 'cam-1', protocolVersions: { min: 1, max: 1 } });
    expect(data.hello).toMatchObject({ cameraId: 'cam-1', bootId: data.info!.bootId, protocolVersion: 1, rotation: 180, previewQuality: 'normal' });
    for (const q of ['low', 'normal', 'high'] as const) {
      const p = data.preview[q]!;
      expect(p.frames, q).toBeGreaterThan(0);
      expect(p.fps).toBeGreaterThan(0);
      expect(p.latencyMs.p50).not.toBeNull();
      expect(p.sizes).toEqual({ '1280x960': p.frames });
      expect(p.stalls).toBe(0);
      expect(p.decodeMs).toBeNull();
    }
    expect(data.captureWithPing).toMatchObject({ viaGetOperation: false, notReadyRetries: 0, pingErrors: [] });
    expect(data.captureWithPing!.pings).toBeGreaterThan(0);
    expect(data.capture).toMatchObject({ viaGetOperation: false, full: { bytes: cam.fullBytes.length } });
    expect(data.errors).toEqual([]);

    // Both frames belong to the probe's clientId and project; the quality is restored; nothing is acked.
    expect(shared.capturedFrameIds).toHaveLength(2);
    for (const id of shared.capturedFrameIds!) expect(cam.state.frames.get(id)).toMatchObject({ clientId: d.clientId, projectId: d.projectId });
    expect(cam.state.ctl.previewQuality).toBe('normal');
    expect(cam.state.acked.size).toBe(0);
    expect(cam.state.requests).not.toContain('ack');
  });

  it('times JPEG decoding when a decoder is given', async () => {
    cam = await startFakeCamera();
    let decoded = 0;
    const r = await runCamera(sharedFor(cam), { ...deps(), decode: async () => void decoded++ });
    const p = (r.data as CameraData).preview.low!;
    expect(decoded).toBeGreaterThanOrEqual(p.frames);
    expect(p.decodeMs?.p50).not.toBeNull();
  });

  it('recovers from a preview stall (watchdog) and counts it', async () => {
    cam = await startFakeCamera({ stallNexts: 1 });
    const r = await runCamera(sharedFor(cam), { ...deps(), previewSeconds: 0.6, stallMs: 150 });
    const p = (r.data as CameraData).preview.low!;
    expect(p.stalls).toBe(1);
    expect(p.stallLog[0]).toMatch(/no frame within 150 ms/);
    expect(p.frames).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });

  it('fails without an address', async () => {
    const r = await runCamera({ manualAddress: '' });
    expect(r).toMatchObject({ ok: false, error: NO_TARGET });
  });

  it('fails with info and hello errors when nothing listens there', async () => {
    cam = await startFakeCamera();
    const port = cam.port;
    await cam.close();
    cam = null;
    const r = await runCamera({ manualAddress: `127.0.0.1:${port}` });
    expect(r.ok).toBe(false);
    const data = r.data as CameraData;
    expect(data.errors.map((e) => e.step)).toEqual(['info', 'hello']);
    expect(data.hello).toBeNull();
  });

  it('BUSY (another remote holds the camera) fails with a hint', async () => {
    cam = await startFakeCamera();
    const release = await holdSession(cam);
    try {
      const r = await runCamera(sharedFor(cam));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^hello: camera busy: another remote holds the session \(close remote-lite\)/);
      expect((r.data as CameraData).info).not.toBeNull();
    } finally {
      release();
    }
  });
});

describe('captureFrame', () => {
  it('a lost capture response is resolved through getOperation', async () => {
    cam = await startFakeCamera();
    const s = await openSession({ host: '127.0.0.1', port: cam.port }, nodeSessionDeps());
    try {
      await fetch(`http://${cam.host}/fake/drop-capture`);
      const r = await captureFrame(s, { projectId: randomUUID(), rotation: 180 }, { now: () => performance.now(), timeoutMs: 200 });
      expect(r.viaGetOperation).toBe(true);
      expect(cam.state.frames.has(r.frame.frameId)).toBe(true);
    } finally {
      s.close();
    }
  });

  it('CAMERA_NOT_READY (controls settling) is retried with a new reqId', async () => {
    cam = await startFakeCamera({ confirmDelayMs: 700 });
    const s = await openSession({ host: '127.0.0.1', port: cam.port }, nodeSessionDeps());
    try {
      await s.request('setControl', { control: 'exposure', mode: 'locked' });
      const ids: string[] = [];
      const r = await captureFrame(s, { projectId: randomUUID(), rotation: 180 }, {
        now: () => performance.now(),
        newReqId: () => {
          ids.push(randomUUID());
          return ids.at(-1)!;
        },
      });
      expect(r.notReadyRetries).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      s.close();
    }
  });

  it('other errors are not retried', async () => {
    cam = await startFakeCamera();
    const s = await openSession({ host: '127.0.0.1', port: cam.port }, nodeSessionDeps());
    try {
      await expect(captureFrame(s, { projectId: randomUUID(), rotation: 0 }, { now: () => performance.now() })).rejects.toMatchObject({ code: 'GEOMETRY_MISMATCH' });
    } finally {
      s.close();
    }
  });
});
