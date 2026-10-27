import { describe, expect, it } from 'vitest';
import { runProbes } from './runner';
import type { ProbeShared } from './shared';
import { videoFrameProbe, type BitmapLike, type VideoFrameDeps, type VideoFrameLike } from './videoFrame';

const FILE = { frameId: '01FRAME000001', path: 'probe/frame.jpg', uri: 'file:///data/x/files/kopernikadr/probe/frame.jpg', bytes: 1012 };

/** Fakes that record what was created and closed (every bitmap and frame must be closed). */
function fakes(opts: { blobBytes?: number; full?: [number, number]; frameSize?: (b: BitmapLike) => [number, number]; decodeError?: Error } = {}) {
  const log: string[] = [];
  let n = 0;
  const deps: VideoFrameDeps = {
    native: true,
    now: () => (n += 5),
    async readBlob(uri) {
      log.push(`read ${uri}`);
      return new Blob([new Uint8Array(opts.blobBytes ?? FILE.bytes)]);
    },
    async createImageBitmap(_blob, o) {
      if (opts.decodeError) throw opts.decodeError;
      const [w, h] = o?.resizeWidth ? [o.resizeWidth, o.resizeHeight!] : (opts.full ?? [3264, 2448]);
      log.push(`bitmap ${w}x${h}`);
      return { width: w, height: h, close: () => log.push(`close bitmap ${w}x${h}`) };
    },
    VideoFrame: class implements VideoFrameLike {
      codedWidth: number;
      codedHeight: number;
      displayWidth: number;
      displayHeight: number;
      format = 'RGBX';
      constructor(image: BitmapLike, init: { timestamp: number }) {
        const [w, h] = opts.frameSize?.(image) ?? [image.width, image.height];
        this.codedWidth = this.displayWidth = w;
        this.codedHeight = this.displayHeight = h;
        log.push(`frame ${w}x${h} ts ${init.timestamp}`);
      }
      close() {
        log.push(`close frame ${this.displayWidth}x${this.displayHeight}`);
      }
    },
  };
  return { deps, log };
}

async function run(deps: VideoFrameDeps, shared: ProbeShared = { manualAddress: '', downloaded: FILE }) {
  return (await runProbes([videoFrameProbe(deps)], { shared })).results[0];
}

describe('videoFrame probe', () => {
  it('decodes the downloaded full into a VideoFrame, then at the export size, closing everything', async () => {
    const { deps, log } = fakes();
    const r = await run(deps);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      frameId: FILE.frameId,
      blobBytes: FILE.bytes,
      full: { bitmap: { w: 3264, h: 2448 }, frame: { codedWidth: 3264, displayHeight: 2448, format: 'RGBX' } },
      exportSize: { bitmap: { w: 1440, h: 1080 }, frame: { displayWidth: 1440, displayHeight: 1080 } },
    });
    expect(log).toEqual([
      `read ${FILE.uri}`,
      'bitmap 3264x2448',
      'frame 3264x2448 ts 0',
      'close frame 3264x2448',
      'close bitmap 3264x2448',
      'bitmap 1440x1080',
      'frame 1440x1080 ts 0',
      'close frame 1440x1080',
      'close bitmap 1440x1080',
    ]);
  });

  it('fails when the file read back has the wrong size', async () => {
    const r = await run(fakes({ blobBytes: 10 }).deps);
    expect(r).toMatchObject({ ok: false, error: `read 10 bytes, expected ${FILE.bytes}` });
  });

  it('fails when the VideoFrame size differs from the bitmap', async () => {
    const r = await run(fakes({ frameSize: (b) => [b.width / 2, b.height / 2] }).deps);
    expect(r).toMatchObject({ ok: false, error: 'VideoFrame 1632×1224 ≠ bitmap 3264×2448' });
  });

  it('fails when the resized frame is not 1440×1080', async () => {
    const r = await run(fakes({ frameSize: (b) => (b.width === 1440 ? [1440, 1081] : [b.width, b.height]) }).deps);
    expect(r).toMatchObject({ ok: false, error: 'resized VideoFrame 1440×1081 ≠ 1440×1080' });
  });

  it('fails on a decode error and without WebCodecs', async () => {
    const bad = await run(fakes({ decodeError: new DOMException('The source image cannot be decoded.', 'InvalidStateError') }).deps);
    expect(bad).toMatchObject({ ok: false, error: 'InvalidStateError: The source image cannot be decoded.' });
    const none = await run({ ...fakes().deps, VideoFrame: undefined });
    expect(none).toMatchObject({ ok: false, error: 'VideoFrame is not available' });
  });

  it('is skipped without a downloaded file: native-only in a browser, no-input natively', async () => {
    const { deps } = fakes();
    expect(await run({ ...deps, native: false }, { manualAddress: '' })).toMatchObject({ ok: false, skipped: 'native-only' });
    expect(await run(deps, { manualAddress: '' })).toMatchObject({ ok: false, skipped: 'no-input' });
  });
});
