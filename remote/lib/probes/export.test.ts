import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NoEncoderError, type ExportBenchmarkOptions, type ExportBenchmarkResult } from '../export/benchmark';
import { ExportFrameError } from '../export/mediabunnyExport';
import { exportProbe, type ExportData, type ExportProbeDeps } from './export';
import type { DownloadNative } from './download';
import { nodeSessionDeps, shared as sharedFor, startFakeCamera, type FakeCamera } from './fakeCamera.testutil';
import { runProbes } from './runner';

let cam: FakeCamera | null = null;
afterEach(async () => {
  await cam?.close();
  cam = null;
});

const ROOT = 'file:///files/kopernikadr/';
const PROJECT = randomUUID();

function fakeNative() {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const native: DownloadNative = {
    async ensureTmpDir() {},
    async uriOf(path) {
      return ROOT + path;
    },
    async download(url, uri) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      files.set(uri.slice(ROOT.length), new Uint8Array(await res.arrayBuffer()));
    },
    async read(uri) {
      return files.get(uri.slice(ROOT.length))!;
    },
    async installFile() {
      return 'INSTALLED';
    },
    async remove(path) {
      removed.push(path);
      files.delete(path);
    },
  };
  return { native, files, removed };
}

const okResult = (o: ExportBenchmarkOptions): ExportBenchmarkResult =>
  ({
    uri: `content://media/video/${o.repeatTo}`,
    codec: 'avc1.640028',
    bytes: o.repeatTo * 1000,
    writes: 3,
    frames: o.repeatTo,
    ms: o.repeatTo * 10,
    perFrame: Array.from({ length: o.repeatTo }, () => ({})),
    pick: { tried: [{ codecString: 'avc1.640028' }], failed: [] },
    summary: { decodeMs: { mean: 1, p50: 1, p95: 2, max: 3 }, waitMs: { mean: 0, p50: 0, p95: 0, max: 0 }, encodeMs: { mean: 5, p50: 5, p95: 6, max: 7 }, msPerFrame: 10, speed: 0.8 },
  }) as unknown as ExportBenchmarkResult;

function deps(native: DownloadNative | null, extra: Partial<ExportProbeDeps> = {}): ExportProbeDeps {
  return {
    ...nodeSessionDeps(),
    native,
    projectId: PROJECT,
    convertFileSrc: (u) => `https://localhost/_capacitor_file_${u.slice(7)}`,
    createWriter: () => ({}) as never,
    runBenchmark: async (o) => okResult(o),
    ...extra,
  };
}

async function run(d: ExportProbeDeps, signal?: AbortSignal) {
  return (await runProbes([exportProbe(d)], { shared: sharedFor(cam!), signal })).results[0];
}

describe('export probe', () => {
  it('is native-only', async () => {
    cam = await startFakeCamera();
    const r = await run(deps(null));
    expect(r.skipped).toBe('native-only');
    expect(cam.state.frames.size).toBe(0);
  });

  it('captures, downloads, runs 20 then 100, acks its own frames and deletes its files', async () => {
    cam = await startFakeCamera();
    // the kid's frame must stay untouched
    const kidFrame = 'kid-frame-1';
    cam.state.frames.set(kidFrame, { frameId: kidFrame, seq: 0, clientId: randomUUID(), projectId: PROJECT, full: { w: 1, h: 1, bytes: 1, sha256: '00' } });

    const { native, removed } = fakeNative();
    const calls: ExportBenchmarkOptions[] = [];
    const writers = new Set<unknown>();
    const r = await run(
      deps(native, {
        createWriter: () => {
          const w = {};
          writers.add(w);
          return w as never;
        },
        runBenchmark: async (o) => {
          calls.push(o);
          return okResult(o);
        },
      }),
    );
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const d = r.data as ExportData;
    expect(calls.map((c) => c.repeatTo)).toEqual([20, 100]);
    expect(calls[0].frames).toHaveLength(20);
    expect(calls[0].frames[0]).toMatch(/^https:\/\/localhost\/_capacitor_file_/);
    expect(calls.every((c) => c.fps === 8 && /^probe-(20|100)-\d{14}$/.test(c.displayName!))).toBe(true);
    expect(writers.size).toBe(2);
    expect(d.runs.map((x) => [x.n, x.ok, x.codec, x.bytes, x.ms, x.uri])).toEqual([
      [20, true, 'avc1.640028', 20000, 200, 'content://media/video/20'],
      [100, true, 'avc1.640028', 100000, 1000, 'content://media/video/100'],
    ]);
    expect(d.runs[0].summary?.msPerFrame).toBe(10);
    expect(d.runs[0].tried).toHaveLength(1);
    expect(d.runs[0].failed).toEqual([]);
    expect(JSON.stringify(d)).not.toContain('perFrame');
    expect(d.ack).toEqual({ requested: 20, acked: 20, unknown: [] });
    expect(cam.state.acked.size).toBe(20);
    expect(cam.state.acked.has(kidFrame)).toBe(false);
    expect(removed).toHaveLength(20);
  });

  it('NO_ENCODER fails with the pick and still acks', async () => {
    cam = await startFakeCamera();
    const { native, removed } = fakeNative();
    const pick = { tried: [{ codecString: 'avc1.640028' }], failed: [{ codecString: 'avc1.640028', error: 'x' }] };
    const r = await run(
      deps(native, {
        runBenchmark: async () => {
          throw new NoEncoderError(pick as never);
        },
      }),
    );
    expect(r.ok).toBe(false);
    const d = r.data as ExportData;
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0].error).toMatchObject({ code: 'NO_ENCODER', pick });
    expect(r.error).toContain('NO_ENCODER');
    expect(cam.state.acked.size).toBe(20);
    expect(removed).toHaveLength(20);
  });

  it('FRAME_LOAD_FAILED fails with the index and still acks', async () => {
    cam = await startFakeCamera();
    const { native } = fakeNative();
    const r = await run(
      deps(native, {
        runBenchmark: async () => {
          throw new ExportFrameError(7, new Error('decode'));
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect((r.data as ExportData).runs[0].error).toMatchObject({ code: 'FRAME_LOAD_FAILED', index: 7 });
    expect(cam.state.acked.size).toBe(20);
  });

  it('a native error code (NO_SPACE) is reported', async () => {
    cam = await startFakeCamera();
    const { native } = fakeNative();
    const r = await run(
      deps(native, {
        runBenchmark: async () => {
          throw Object.assign(new Error('disk full'), { code: 'NO_SPACE' });
        },
      }),
    );
    expect((r.data as ExportData).runs[0].error?.code).toBe('NO_SPACE');
    expect(cam.state.acked.size).toBe(20);
  });

  it('cancel via the signal ends as cancelled and still acks what was downloaded', async () => {
    cam = await startFakeCamera();
    const { native, removed } = fakeNative();
    const ac = new AbortController();
    const r = await run(
      deps(native, {
        runBenchmark: (o) =>
          new Promise<ExportBenchmarkResult>((_, reject) => {
            o.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            ac.abort();
          }),
      }),
      ac.signal,
    );
    expect(r.skipped).toBe('cancelled');
    expect(cam.state.acked.size).toBe(20);
    expect(removed).toHaveLength(20);
  });
});
