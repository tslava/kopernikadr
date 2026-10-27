// MP4 export (ARCHITECTURE §5.7): decoded frames → Mediabunny (WebCodecs) → positional writes into a
// seekable temp file → close → publish to the gallery. The export is all or nothing, as in
// remote-lite's export-core.js: every frame is prepared first, a frame that cannot be loaded
// (after retries) aborts the export, and any error or cancel aborts the temp file. A partial file is
// never published.
//
// Mediabunny 1.61.4 facts this relies on (checked in node_modules/mediabunny/dist/modules/src):
// - `new StreamTarget(writable: WritableStream<StreamTargetChunk>, {chunked, chunkSize})`; a chunk
//   is `{type: 'write', data: Uint8Array, position: number}`. There is no `onData` callback.
// - With `chunked: true` writes are batched into `chunkSize`-aligned chunks (default 16 MiB, min
//   1024); without it every muxer flush is one write. Positions are not monotonic for
//   `Mp4OutputFormat({fastStart: false})`: the `mdat` header is patched at finalize.
// - StreamTarget does not await `write()`; it awaits `writer.ready` when `desiredSize <= 0`, so
//   the stream's queue (default high-water mark 1) is the backpressure, and a rejected write
//   surfaces on the next flush or in `finalize()`.
// - `finalize()` ends with `writer.close()`, which resolves only after every queued write;
//   `cancel()` also closes the stream (waiting for queued writes) but does not abort it.
// - A full codec string is passed as `VideoEncodingConfig.fullCodecString` next to `codec`, which
//   must match it (`inferCodecFromCodecString`), e.g. `{codec: 'avc', fullCodecString:
//   'avc1.640028'}`; it becomes `VideoEncoderConfig.codec` verbatim. Bitrate goes in
//   `quality: new Quality({bitrate})` (`bitrate` on the config is deprecated).
// - Frame size comes from the first sample; the frame rate from `addVideoTrack(src, {frameRate})`.
import {
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  type StreamTargetChunk,
} from 'mediabunny';
import type { CodecCandidate } from './codecPick';

/** A decoded frame at the export size. Closed by the export after it was encoded. */
export type ExportImage = ImageBitmap | VideoFrame;

/** The temp file + gallery publish (the real one: `nativeWriter.ts` over KopernikadrNative). */
export interface ExportWriter {
  open(): Promise<void>;
  /** Writes `bytes` at byte `position`; out of order and overlapping writes must work. */
  writeAt(position: number, bytes: Uint8Array): Promise<void>;
  /** fsync + close; after this only `publish` or `abort`. */
  close(): Promise<void>;
  publish(displayName: string): Promise<{ uri: string }>;
  /** Closes and deletes the temp file. Idempotent; must work in any state, also before `open`. */
  abort(): Promise<void>;
}

export interface ExportFrameSource {
  count: number;
  /** Ticks (1/fps) frame `index` is shown for; default 1. Timestamps are the cumulative sum. */
  hold?(index: number): number;
  /** Optional first pass over every frame before the file is opened (e.g. check it exists). */
  prepare?(index: number, opts: { signal: AbortSignal }): Promise<void>;
  /** Loads and decodes frame `index` at the export size. */
  load(index: number, opts: { signal: AbortSignal }): Promise<ExportImage>;
}

export type ExportPhase = 'prepare' | 'encoding' | 'finalizing' | 'publishing';

export interface ExportProgress {
  phase: ExportPhase;
  /** Frames done in this phase. */
  i: number;
  n: number;
}

export interface FrameStat {
  index: number;
  /** load() time, including retries (overlaps the previous frame's encode when prefetched). */
  decodeMs: number;
  /** Time the encode loop waited for this frame to be loaded. */
  waitMs: number;
  /** `add()` time: encoder input + muxing + backpressure from the writes. */
  encodeMs: number;
}

export interface ExportResult {
  uri: string;
  /** The full codec string used. */
  codec: string;
  /** File size (the highest written end position). */
  bytes: number;
  /** `writeAt` calls. */
  writes: number;
  frames: number;
  /** Wall time from start to publish. */
  ms: number;
  perFrame: FrameStat[];
}

export interface EncoderOptions {
  stream: WritableStream<StreamTargetChunk>;
  codec: CodecCandidate;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** StreamTarget `chunkSize` (bytes, ≥1024). */
  chunkSize: number;
}

/** The Mediabunny Output + video source, behind a seam so the export order is testable in Node. */
export interface ExportEncoder {
  /** Timestamp and duration in seconds. Resolves when the encoder can take the next frame. */
  add(image: ExportImage, timestamp: number, duration: number): Promise<void>;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
}

export type CreateEncoder = (options: EncoderOptions) => Promise<ExportEncoder>;

export interface ExportOptions {
  source: ExportFrameSource;
  fps: number;
  /** Size of the images `source.load` returns. */
  width: number;
  height: number;
  /** Bits per second. */
  bitrate: number;
  /** From `pickCodec`. */
  codec: CodecCandidate;
  writer: ExportWriter;
  /** Gallery name part (the native side makes it `kopernikadr-<displayName>.mp4`). */
  displayName: string;
  /** Honoured until encoding ends; from `finalizing` on the export runs to done or failed (§5.7). */
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  /** Extra attempts per frame for `prepare` and `load`. Default 1. */
  retries?: number;
  /** Frames loaded ahead of the one being encoded. Default 1. */
  ahead?: number;
  /** Default 1 MiB, so one `writeAt` stays one bridge call of ~1.4 MB base64. */
  chunkSize?: number;
  createEncoder?: CreateEncoder;
  now?: () => number;
}

export const DEFAULT_CHUNK_SIZE = 1 << 20;

/** A frame could not be prepared or loaded; the export was aborted. */
export class ExportFrameError extends Error {
  readonly code = 'FRAME_LOAD_FAILED';
  constructor(
    readonly index: number,
    readonly cause: unknown,
  ) {
    super(`frame ${index} could not be loaded: ${String(cause)}`);
    this.name = 'ExportFrameError';
  }
}

const noop = () => {};
const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AbortError';

export async function exportVideo(o: ExportOptions): Promise<ExportResult> {
  const now = o.now ?? (() => performance.now());
  const { source, writer, fps } = o;
  const n = source.count;
  const retries = o.retries ?? 1;
  const ahead = o.ahead ?? 1;
  const createEncoder = o.createEncoder ?? createMediabunnyEncoder;
  const t0 = now();

  const signal = o.signal;
  // Aborted on cancel and on any exit: stops loads still in flight.
  const inner = new AbortController();
  const onAbort = () => inner.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort);
  const checkAbort = () => signal?.throwIfAborted();

  /** `p`, or a rejection as soon as the export is cancelled (encoding phase only). */
  const abortable = <T>(p: Promise<T>): Promise<T> => {
    p.catch(noop); // a loser of the race must not become an unhandled rejection
    if (!signal) return p;
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  };

  const withRetries = async <T>(index: number, attempt: () => Promise<T>): Promise<T> => {
    for (let k = 0; ; k++) {
      checkAbort();
      try {
        return await attempt();
      } catch (e) {
        if (isAbort(e) || signal?.aborted) throw signal?.reason ?? e;
        if (k >= retries) throw new ExportFrameError(index, e);
      }
    }
  };

  type Loaded = { image: ExportImage; decodeMs: number };
  const loads = new Map<number, Promise<Loaded>>();
  const startLoad = (i: number) => {
    if (i >= n || loads.has(i)) return;
    const t = now();
    const p = withRetries(i, () => source.load(i, { signal: inner.signal })).then((image) => ({
      image,
      decodeMs: now() - t,
    }));
    p.catch(noop); // handled when taken
    loads.set(i, p);
  };
  let nextToLoad = 0;
  const take = async (i: number): Promise<Loaded> => {
    const p = loads.get(i)!;
    loads.delete(i);
    try {
      return await abortable(p);
    } catch (e) {
      p.then((r) => r.image.close(), noop); // cancelled while loading: close it when it arrives
      throw e;
    }
  };

  let opened = false;
  let encoder: ExportEncoder | undefined;
  let finalized = false;
  let bytes = 0;
  let writes = 0;
  const perFrame: FrameStat[] = [];

  try {
    if (!(n > 0)) throw new Error('export has no frames');
    checkAbort();

    // 1. Prepare every frame before anything is written.
    if (source.prepare) {
      o.onProgress?.({ phase: 'prepare', i: 0, n });
      for (let i = 0; i < n; i++) {
        await withRetries(i, () => source.prepare!(i, { signal: inner.signal }));
        o.onProgress?.({ phase: 'prepare', i: i + 1, n });
      }
    }
    checkAbort();

    // 2. Temp file + encoder.
    opened = true; // before the call: abort() is idempotent and also cleans up a half-open file
    await writer.open();
    checkAbort();
    const stream = new WritableStream<StreamTargetChunk>({
      async write(chunk) {
        if (chunk.type !== 'write') throw new Error(`unexpected StreamTarget chunk: ${String(chunk.type)}`);
        await writer.writeAt(chunk.position, chunk.data);
        writes++;
        bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
      },
    });
    encoder = await createEncoder({
      stream,
      codec: o.codec,
      width: o.width,
      height: o.height,
      fps,
      bitrate: o.bitrate,
      chunkSize: o.chunkSize ?? DEFAULT_CHUNK_SIZE,
    });

    // 3. Encode, strictly in order; frame i+1..i+ahead load while frame i encodes.
    o.onProgress?.({ phase: 'encoding', i: 0, n });
    let ticks = 0; // whole ticks before frame i: no float drift in the timestamps
    for (let i = 0; i < n; i++) {
      for (; nextToLoad <= Math.min(i + ahead, n - 1); nextToLoad++) startLoad(nextToLoad);
      const tw = now();
      const { image, decodeMs } = await take(i);
      const waitMs = now() - tw;
      let encodeMs: number;
      try {
        checkAbort();
        const te = now();
        const hold = source.hold?.(i) ?? 1;
        await abortable(encoder.add(image, ticks / fps, hold / fps));
        ticks += hold;
        encodeMs = now() - te;
      } finally {
        image.close();
      }
      perFrame.push({ index: i, decodeMs, waitMs, encodeMs });
      o.onProgress?.({ phase: 'encoding', i: i + 1, n });
    }
    checkAbort();

    // 4. From here on cancel is ignored: publish and abort stay mutually exclusive.
    o.onProgress?.({ phase: 'finalizing', i: n, n });
    await encoder.finalize(); // resolves after every write reached the writer
    finalized = true;
    await writer.close();

    o.onProgress?.({ phase: 'publishing', i: n, n });
    const { uri } = await writer.publish(o.displayName);
    return { uri, codec: o.codec.codecString, bytes, writes, frames: n, ms: now() - t0, perFrame };
  } catch (e) {
    if (encoder && !finalized) await encoder.cancel().catch(noop);
    // A failed abort leaves the temp file to the startup sweep (videoCleanupAbandoned).
    if (opened) await writer.abort().catch(noop);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    inner.abort();
    for (const p of loads.values()) p.then((r) => r.image.close(), noop);
    loads.clear();
  }
}

export interface MediabunnyEncoderSeams {
  /** Wraps a decoded image into a VideoSample; tests replace it (Node has no VideoFrame). */
  toSample?: (image: ExportImage, timestamp: number, duration: number) => VideoSample;
}

/** The real encoder: `Output{Mp4OutputFormat({fastStart: false}), StreamTarget(chunked)}`. */
export function mediabunnyEncoderFactory(seams: MediabunnyEncoderSeams = {}): CreateEncoder {
  const toSample =
    seams.toSample ?? ((image, timestamp, duration) => new VideoSample(image, { timestamp, duration }));
  return async ({ stream, codec, fps, bitrate, chunkSize }) => {
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(stream, { chunked: true, chunkSize }),
    });
    const video = new VideoSampleSource({
      codec: codec.codec,
      fullCodecString: codec.codecString,
      quality: new Quality({ bitrate, bitrateMode: 'variable' }),
      // all frames are decoded at the export size; an odd one is letterboxed, not an error
      sizeChangeBehavior: 'contain',
    });
    output.addVideoTrack(video, { frameRate: fps });
    try {
      await output.start();
    } catch (e) {
      await output.cancel().catch(noop);
      throw e;
    }
    return {
      async add(image, timestamp, duration) {
        const sample = toSample(image, timestamp, duration);
        try {
          await video.add(sample);
        } finally {
          sample.close();
        }
      },
      finalize: () => output.finalize(),
      cancel: () => output.cancel(),
    };
  };
}

export const createMediabunnyEncoder: CreateEncoder = mediabunnyEncoderFactory();
