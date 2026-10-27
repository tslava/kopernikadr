import { describe, expect, it, vi } from 'vitest';
import { CODEC_LADDER } from './codecPick';
import {
  ExportFrameError,
  exportVideo,
  type CreateEncoder,
  type ExportFrameSource,
  type ExportImage,
  type ExportOptions,
  type ExportProgress,
  type ExportWriter,
} from './mediabunnyExport';

const noop = () => {};

interface FakeImage {
  id: number;
  closed: number;
  close(): void;
}

function image(id: number): FakeImage {
  return {
    id,
    closed: 0,
    close() {
      this.closed++;
    },
  };
}

/** Frame source over `count` fake images; `fail(i, attempt)` returning true rejects that load. */
function source(count: number, opts: { fail?: (i: number, attempt: number) => boolean; prepareFail?: number } = {}) {
  const images: FakeImage[] = [];
  const attempts = new Map<number, number>();
  const prepared: number[] = [];
  const src: ExportFrameSource & { images: FakeImage[]; attempts: Map<number, number>; prepared: number[] } = {
    count,
    images,
    attempts,
    prepared,
    async load(i) {
      const attempt = (attempts.get(i) ?? 0) + 1;
      attempts.set(i, attempt);
      if (opts.fail?.(i, attempt)) throw new Error(`load ${i} failed`);
      const img = image(i);
      images.push(img);
      return img as unknown as ExportImage;
    },
  };
  return src;
}

type Log = string[];

/** Writer that records calls into `log` and assembles the file from positional writes. */
function fakeWriter(log: Log, opts: Partial<Record<'open' | 'close' | 'publish' | 'abort', Error>> & { failWriteAt?: number } = {}) {
  let file = new Uint8Array(0);
  let writes = 0;
  const w: ExportWriter & { file(): Uint8Array } = {
    async open() {
      log.push('open');
      if (opts.open) throw opts.open;
    },
    async writeAt(position, bytes) {
      writes++;
      log.push(`write ${position} ${bytes.byteLength}`);
      if (opts.failWriteAt === writes) throw Object.assign(new Error('no space'), { code: 'NO_SPACE' });
      const end = position + bytes.byteLength;
      if (end > file.length) {
        const grown = new Uint8Array(end);
        grown.set(file);
        file = grown;
      }
      file.set(bytes, position);
    },
    async close() {
      log.push('close');
      if (opts.close) throw opts.close;
    },
    async publish(displayName) {
      log.push(`publish ${displayName}`);
      if (opts.publish) throw opts.publish;
      return { uri: 'content://media/external/video/media/42' };
    },
    async abort() {
      log.push('abort');
      if (opts.abort) throw opts.abort;
    },
    file: () => file,
  };
  return w;
}

/**
 * Encoder that behaves like Mediabunny's MP4 muxer on a StreamTarget: a placeholder header at 0,
 * one packet per frame appended, then at finalize the header patched at position 0 and the
 * trailer appended. Writes are fire-and-forget (errors surface on `ready`/`close`), as in
 * `StreamTarget._flush`.
 */
function fakeEncoder(log: Log, opts: { failAddAt?: number; failFinalize?: Error; hangAddAt?: number } = {}) {
  const added: { id: number; timestamp: number; duration: number }[] = [];
  const create: CreateEncoder = async ({ stream }) => {
    log.push('encoder');
    const w = stream.getWriter();
    let pos = 0;
    const put = (data: Uint8Array<ArrayBuffer>, position: number) => {
      w.write({ type: 'write', data, position }).catch(noop);
    };
    put(new Uint8Array(8), 0);
    pos = 8;
    let adds = 0;
    return {
      async add(img, timestamp, duration) {
        adds++;
        log.push(`add ${timestamp}`);
        added.push({ id: (img as unknown as FakeImage).id, timestamp, duration });
        if (opts.hangAddAt === adds) return new Promise<void>(noop);
        if (opts.failAddAt === adds) throw new Error('encoder error');
        await w.ready;
        put(new Uint8Array(100).fill(adds), pos);
        pos += 100;
      },
      async finalize() {
        log.push('finalize');
        if (opts.failFinalize) throw opts.failFinalize;
        put(new Uint8Array(8).fill(0xee), 0);
        put(new Uint8Array(20).fill(0xff), pos);
        await w.ready;
        await w.close();
      },
      async cancel() {
        log.push('cancel');
        await w.close().catch(noop);
      },
    };
  };
  return { create, added };
}

function setup(n = 5, o: {
  writer?: Parameters<typeof fakeWriter>[1];
  encoder?: Parameters<typeof fakeEncoder>[1];
  source?: Parameters<typeof source>[1];
} = {}) {
  const log: Log = [];
  const writer = fakeWriter(log, o.writer);
  const enc = fakeEncoder(log, o.encoder);
  const src = source(n, o.source);
  const progress: ExportProgress[] = [];
  const options: ExportOptions = {
    source: src,
    fps: 8,
    width: 1440,
    height: 1080,
    bitrate: 8_000_000,
    codec: CODEC_LADDER[3],
    writer,
    displayName: 'probe-5',
    createEncoder: enc.create,
    onProgress: (p) => progress.push(p),
  };
  return { log, writer, enc, src, progress, options };
}

const at = (log: Log, entry: string) => {
  const i = log.indexOf(entry);
  expect(i, `${entry} in ${JSON.stringify(log)}`).toBeGreaterThanOrEqual(0);
  return i;
};
const writesOf = (log: Log) => log.filter((e) => e.startsWith('write '));

describe('exportVideo: success', () => {
  it('opens, writes with positions, finalizes, closes, then publishes', async () => {
    const { log, writer, options } = setup(5);
    const r = await exportVideo(options);

    expect(log[0]).toBe('open');
    expect(log[1]).toBe('encoder');
    const close = at(log, 'close');
    expect(at(log, 'finalize')).toBeLessThan(close);
    expect(log.indexOf('publish probe-5')).toBe(close + 1);
    expect(log.at(-1)).toBe('publish probe-5');
    expect(log).not.toContain('abort');
    expect(log).not.toContain('cancel');
    // every write lands after open and before close
    log.forEach((e, i) => {
      if (e.startsWith('write ')) expect(i).toBeLessThan(close);
    });
    // header, 5 packets, header patch at 0 (out of order), trailer
    expect(writesOf(log)).toEqual([
      'write 0 8',
      'write 8 100',
      'write 108 100',
      'write 208 100',
      'write 308 100',
      'write 408 100',
      'write 0 8',
      'write 508 20',
    ]);
    expect(Array.from(writer.file().subarray(0, 8))).toEqual(Array(8).fill(0xee));
    expect(writer.file()[8]).toBe(1);

    expect(r.uri).toBe('content://media/external/video/media/42');
    expect(r.codec).toBe('vp09.00.40.08');
    expect(r.bytes).toBe(528);
    expect(r.writes).toBe(8);
    expect(r.frames).toBe(5);
    expect(r.perFrame.map((f) => f.index)).toEqual([0, 1, 2, 3, 4]);
    for (const f of r.perFrame) {
      expect(f.decodeMs).toBeGreaterThanOrEqual(0);
      expect(f.waitMs).toBeGreaterThanOrEqual(0);
      expect(f.encodeMs).toBeGreaterThanOrEqual(0);
    }
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('adds frames in order with timestamp i/fps and duration 1/fps, closing each image', async () => {
    const { enc, src, options } = setup(4);
    await exportVideo(options);
    expect(enc.added).toEqual([0, 1, 2, 3].map((i) => ({ id: i, timestamp: i / 8, duration: 1 / 8 })));
    expect(src.images.map((im) => im.closed)).toEqual([1, 1, 1, 1]);
  });

  it('a source hold makes the duration hold/fps and the timestamps the cumulative ticks', async () => {
    const { enc, src, options } = setup(4);
    const holds = [1, 4, 2, 1];
    await exportVideo({ ...options, source: { ...src, hold: (i) => holds[i] } });
    expect(enc.added.map((a) => [a.timestamp, a.duration])).toEqual([
      [0, 1 / 8],
      [1 / 8, 4 / 8],
      [5 / 8, 2 / 8],
      [7 / 8, 1 / 8],
    ]);
  });

  it('reports progress through the phases', async () => {
    const { progress, options } = setup(2);
    await exportVideo(options);
    expect(progress).toEqual([
      { phase: 'encoding', i: 0, n: 2 },
      { phase: 'encoding', i: 1, n: 2 },
      { phase: 'encoding', i: 2, n: 2 },
      { phase: 'finalizing', i: 2, n: 2 },
      { phase: 'publishing', i: 2, n: 2 },
    ]);
  });

  it('prefetches at most `ahead` frames beyond the one being encoded', async () => {
    const { src, options } = setup(6);
    const loadsAtAdd: number[] = [];
    const create = options.createEncoder!;
    options.createEncoder = async (o) => {
      const e = await create(o);
      return { ...e, add: (img, ts, d) => (loadsAtAdd.push(src.attempts.size), e.add(img, ts, d)) };
    };
    options.ahead = 2;
    await exportVideo(options);
    expect(loadsAtAdd).toEqual([3, 4, 5, 6, 6, 6]);
  });

  it('retries a failed load and then succeeds', async () => {
    const { src, options, log } = setup(3, { source: { fail: (i, attempt) => i === 1 && attempt === 1 } });
    const r = await exportVideo(options);
    expect(r.frames).toBe(3);
    expect(src.attempts.get(1)).toBe(2);
    expect(log).not.toContain('abort');
  });

  it('runs prepare for every frame before opening the writer', async () => {
    const { log, options } = setup(3);
    const prepared: number[] = [];
    options.source.prepare = async (i) => {
      prepared.push(i);
      log.push(`prepare ${i}`);
    };
    await exportVideo(options);
    expect(prepared).toEqual([0, 1, 2]);
    expect(log.slice(0, 4)).toEqual(['prepare 0', 'prepare 1', 'prepare 2', 'open']);
  });

  it('ignores a cancel once finalizing has started (publish and abort are exclusive)', async () => {
    const ac = new AbortController();
    const { log, options } = setup(2);
    options.signal = ac.signal;
    options.onProgress = (p) => {
      if (p.phase === 'finalizing') ac.abort();
    };
    const r = await exportVideo(options);
    expect(r.uri).toMatch(/^content:/);
    expect(log).not.toContain('abort');
  });
});

describe('exportVideo: failure never publishes', () => {
  const expectAborted = (log: Log, { cancel = true } = {}) => {
    expect(log.some((e) => e.startsWith('publish'))).toBe(false);
    expect(log.at(-1)).toBe('abort');
    if (cancel) expect(at(log, 'cancel')).toBeLessThan(at(log, 'abort'));
    else expect(log).not.toContain('cancel');
  };

  it('aborts with a FRAME_LOAD_FAILED error when a frame cannot be loaded after retries', async () => {
    const { log, src, options } = setup(5, { source: { fail: (i) => i === 3 } });
    options.retries = 2;
    const err = await exportVideo(options).catch((e) => e);
    expect(err).toBeInstanceOf(ExportFrameError);
    expect(err.code).toBe('FRAME_LOAD_FAILED');
    expect(err.index).toBe(3);
    expect(err.cause).toBeInstanceOf(Error);
    expect(src.attempts.get(3)).toBe(3);
    expectAborted(log);
    expect(log).not.toContain('add 0.375');
    expect(src.images.every((im) => im.closed === 1)).toBe(true);
  });

  it('fails in prepare without opening the writer', async () => {
    const { log, options } = setup(3);
    options.retries = 0;
    options.source.prepare = async (i) => {
      if (i === 1) throw new Error('missing full');
    };
    const err = await exportVideo(options).catch((e) => e);
    expect(err).toBeInstanceOf(ExportFrameError);
    expect(err.index).toBe(1);
    expect(log).toEqual([]);
  });

  it('aborts when the encoder rejects a frame', async () => {
    const { log, src, options } = setup(5, { encoder: { failAddAt: 2 } });
    await expect(exportVideo(options)).rejects.toThrow('encoder error');
    expectAborted(log);
    expect(src.images.every((im) => im.closed === 1)).toBe(true);
  });

  it('aborts when a positional write fails (e.g. NO_SPACE) and rethrows that error', async () => {
    const { log, options } = setup(5, { writer: { failWriteAt: 3 } });
    const err = await exportVideo(options).catch((e) => e);
    expect(err.code).toBe('NO_SPACE');
    expectAborted(log);
  });

  it('aborts when finalize fails', async () => {
    const { log, options } = setup(2, { encoder: { failFinalize: new Error('muxer') } });
    await expect(exportVideo(options)).rejects.toThrow('muxer');
    expectAborted(log);
  });

  it('aborts when close fails, without cancelling the finalized output', async () => {
    const { log, options } = setup(2, { writer: { close: new Error('fsync') } });
    await expect(exportVideo(options)).rejects.toThrow('fsync');
    expectAborted(log, { cancel: false });
  });

  it('aborts when publish fails', async () => {
    const { log, options } = setup(2, { writer: { publish: new Error('provider') } });
    await expect(exportVideo(options)).rejects.toThrow('provider');
    expect(log.slice(-2)).toEqual(['publish probe-5', 'abort']);
    expect(log).not.toContain('cancel');
  });

  it('aborts when open fails and never creates the encoder', async () => {
    const { log, options } = setup(2, { writer: { open: new Error('PATH_INVALID') } });
    await expect(exportVideo(options)).rejects.toThrow('PATH_INVALID');
    expect(log).toEqual(['open', 'abort']);
  });

  it('keeps the original error when abort itself fails', async () => {
    const { log, options } = setup(2, { encoder: { failAddAt: 1 }, writer: { abort: new Error('abort failed') } });
    await expect(exportVideo(options)).rejects.toThrow('encoder error');
    expect(log.at(-1)).toBe('abort');
  });

  it('rejects an empty export without touching the writer', async () => {
    const { log, options } = setup(0);
    await expect(exportVideo(options)).rejects.toThrow(/no frames/);
    expect(log).toEqual([]);
  });
});

describe('exportVideo: cancel', () => {
  it('cancels mid-encoding: AbortError, encoder cancelled, file aborted, images closed', async () => {
    const ac = new AbortController();
    const { log, src, options } = setup(10);
    options.signal = ac.signal;
    options.onProgress = (p) => {
      if (p.phase === 'encoding' && p.i === 3) ac.abort();
    };
    const err = await exportVideo(options).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(log.filter((e) => e.startsWith('add'))).toHaveLength(3);
    expect(log.slice(-2)).toEqual(['cancel', 'abort']);
    expect(log.some((e) => e.startsWith('publish'))).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(src.images.every((im) => im.closed === 1)).toBe(true);
  });

  it('does not open the writer when already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const { log, options } = setup(3);
    options.signal = ac.signal;
    await expect(exportVideo(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(log).toEqual([]);
  });

  it('cancels promptly while the encoder is stuck on backpressure', async () => {
    const ac = new AbortController();
    const { log, options } = setup(5, { encoder: { hangAddAt: 2 } });
    options.signal = ac.signal;
    const p = exportVideo(options);
    await vi.waitFor(() => expect(log).toContain('add 0.125'));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(log.slice(-2)).toEqual(['cancel', 'abort']);
  });

  it('cancels while a frame is still loading and closes it when it arrives', async () => {
    const ac = new AbortController();
    const { log, options } = setup(3);
    options.signal = ac.signal;
    let release!: () => void;
    const late = image(99);
    options.source.load = (i) =>
      i === 0 ? new Promise((r) => (release = () => r(late as unknown as ExportImage))) : new Promise(noop);
    const p = exportVideo(options);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(log).toEqual(['open', 'encoder', 'write 0 8', 'cancel', 'abort']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(late.closed).toBe(1);
  });
});
