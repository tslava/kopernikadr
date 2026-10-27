import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeImage, NoEncoderError, runExportBenchmark, stats } from './benchmark';
import type { CreateEncoder, ExportImage, ExportWriter } from './mediabunnyExport';

const noop = () => {};

function fakes() {
  const log: string[] = [];
  const writer: ExportWriter = {
    open: async () => void log.push('open'),
    writeAt: async (p, b) => void log.push(`write ${p} ${b.byteLength}`),
    close: async () => void log.push('close'),
    publish: async (name) => (log.push(`publish ${name}`), { uri: 'content://v/1' }),
    abort: async () => void log.push('abort'),
  };
  const added: number[] = [];
  const createEncoder: CreateEncoder = async ({ stream, codec }) => {
    log.push(`encoder ${codec.codecString}`);
    const w = stream.getWriter();
    let pos = 0;
    return {
      async add(_img, timestamp) {
        added.push(timestamp);
        await w.ready;
        w.write({ type: 'write', data: new Uint8Array(10), position: pos }).catch(noop);
        pos += 10;
      },
      async finalize() {
        await w.close();
      },
      async cancel() {
        await w.close().catch(noop);
      },
    };
  };
  const decoded: string[] = [];
  const decode = vi.fn(async (url: string, _opts: { width: number; height: number; signal: AbortSignal }) => {
    decoded.push(url);
    return { close() {} } as unknown as ExportImage;
  });
  let t = 0;
  const now = () => (t += 5);
  return { log, writer, createEncoder, added, decode, decoded, now };
}

const vp9Only = async (config: VideoEncoderConfig) => ({ supported: config.codec.startsWith('vp09'), config });

describe('runExportBenchmark', () => {
  it('cycles the source frames to repeatTo and exports with the picked codec', async () => {
    const f = fakes();
    const r = await runExportBenchmark({
      frames: ['a', 'b', 'c'],
      repeatTo: 7,
      writer: f.writer,
      isConfigSupported: vp9Only,
      decode: f.decode,
      createEncoder: f.createEncoder,
      now: f.now,
    });
    expect(f.decoded).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a']);
    expect(f.decode.mock.calls[0][1]).toMatchObject({ width: 1440, height: 1080 });
    expect(f.added).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => i / 8));
    expect(f.log[0]).toBe('open');
    expect(f.log[1]).toBe('encoder vp09.00.40.08');
    expect(f.log.slice(-2)).toEqual(['close', 'publish probe-7']);

    expect(r.codec).toBe('vp09.00.40.08');
    expect(r.pick.failed).toEqual(['avc1.640028', 'avc1.4d0028', 'avc1.42e028']);
    expect(r.uri).toBe('content://v/1');
    expect(r.frames).toBe(7);
    expect(r.sourceFrames).toBe(3);
    expect(r.bytes).toBe(70);
    expect(r).toMatchObject({ fps: 8, width: 1440, height: 1080, bitrate: 8_000_000 });
    expect(r.perFrame).toHaveLength(7);
    expect(r.summary.encodeMs.p50).toBe(5); // fake clock: every measured span is one tick
    expect(r.summary.msPerFrame).toBeCloseTo(r.ms / 7);
    expect(r.summary.speed).toBeCloseTo(7 / 8 / (r.ms / 1000));
  });

  it('passes size, fps, bitrate and display name through', async () => {
    const f = fakes();
    const configs: VideoEncoderConfig[] = [];
    const r = await runExportBenchmark({
      frames: ['a'],
      repeatTo: 2,
      writer: f.writer,
      fps: 12,
      width: 640,
      height: 480,
      bitrate: 2_000_000,
      displayName: 'bench',
      isConfigSupported: async (c) => (configs.push(c), { supported: true, config: c }),
      decode: f.decode,
      createEncoder: f.createEncoder,
    });
    expect(configs[0]).toMatchObject({ codec: 'avc1.640028', width: 640, height: 480, framerate: 12, bitrate: 2_000_000 });
    expect(f.decode.mock.calls[0][1]).toMatchObject({ width: 640, height: 480 });
    expect(f.added).toEqual([0, 1 / 12]);
    expect(f.log.at(-1)).toBe('publish bench');
    expect(r.codec).toBe('avc1.640028');
  });

  it('throws NoEncoderError without opening the writer when nothing is supported', async () => {
    const f = fakes();
    const err = await runExportBenchmark({
      frames: ['a'],
      repeatTo: 2,
      writer: f.writer,
      isConfigSupported: async (c) => ({ supported: false, config: c }),
      decode: f.decode,
      createEncoder: f.createEncoder,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NoEncoderError);
    expect(err.code).toBe('NO_ENCODER');
    expect(err.pick.failed).toHaveLength(4);
    expect(f.log).toEqual([]);
  });

  it('aborts the file when a source frame cannot be decoded', async () => {
    const f = fakes();
    f.decode.mockImplementation(async (url: string, _opts) => {
      if (url === 'b') throw new Error('corrupt');
      return { close() {} } as unknown as ExportImage;
    });
    const err = await runExportBenchmark({
      frames: ['a', 'b'],
      repeatTo: 4,
      writer: f.writer,
      isConfigSupported: vp9Only,
      decode: f.decode,
      createEncoder: f.createEncoder,
    }).catch((e) => e);
    expect(err.code).toBe('FRAME_LOAD_FAILED');
    expect(err.index).toBe(1);
    expect(f.log.at(-1)).toBe('abort');
    expect(f.log.some((e) => e.startsWith('publish'))).toBe(false);
  });

  it('rejects bad input', async () => {
    const f = fakes();
    await expect(runExportBenchmark({ frames: [], repeatTo: 2, writer: f.writer })).rejects.toThrow(/no source/);
    await expect(runExportBenchmark({ frames: ['a'], repeatTo: 0, writer: f.writer })).rejects.toThrow(RangeError);
  });
});

describe('stats', () => {
  it('computes nearest-rank percentiles', () => {
    const s = stats(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toEqual({ mean: 50.5, p50: 50, p95: 95, max: 100 });
    expect(stats([7])).toEqual({ mean: 7, p50: 7, p95: 7, max: 7 });
    expect(stats([])).toEqual({ mean: 0, p50: 0, p95: 0, max: 0 });
  });
});

describe('decodeImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the URL and decodes it resized', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const fetchMock = vi.fn(async () => new Response(blob));
    const bitmap = { close() {} };
    const cib = vi.fn(async (_blob: Blob, _opts: ImageBitmapOptions) => bitmap);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', cib);
    const signal = new AbortController().signal;
    const img = await decodeImage('http://localhost/_capacitor_file_/x.jpg', { width: 1440, height: 1080, signal });
    expect(img).toBe(bitmap);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost/_capacitor_file_/x.jpg', { signal });
    expect(cib.mock.calls[0][1]).toEqual({ resizeWidth: 1440, resizeHeight: 1080 });
  });

  it('rejects on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(decodeImage('u', { width: 1, height: 1, signal: new AbortController().signal })).rejects.toThrow(/404/);
  });
});
