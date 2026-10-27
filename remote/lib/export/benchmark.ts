// The export measurement the diagnostics export probe runs (plan 0b Task 12): a few downloaded
// `full` frames cycled to N, decoded at the export size, encoded with the best codec the device
// has, written through the native writer and published to the gallery.
import { pickCodec, type CodecPickInput, type CodecPickResult } from './codecPick';
import {
  exportVideo,
  type CreateEncoder,
  type ExportImage,
  type ExportProgress,
  type ExportResult,
  type ExportWriter,
} from './mediabunnyExport';

export type DecodeImage = (
  url: string,
  opts: { width: number; height: number; signal: AbortSignal },
) => Promise<ExportImage>;

/** `fetch(url)` → `createImageBitmap(blob, {resizeWidth, resizeHeight})` (ARCHITECTURE §5.7 step 3). */
export const decodeImage: DecodeImage = async (url, { width, height, signal }) => {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob, { resizeWidth: width, resizeHeight: height });
};

export interface ExportBenchmarkOptions {
  /** URLs the WebView can fetch (e.g. `Capacitor.convertFileSrc(fileUri)` of downloaded `full`s). */
  frames: readonly string[];
  /** Export length: frame i is `frames[i % frames.length]`. */
  repeatTo: number;
  /** `createNativeWriter()` on the device. */
  writer: ExportWriter;
  /** Default 8 (the project default). */
  fps?: number;
  /** Default 1440×1080 (§5.7). */
  width?: number;
  height?: number;
  /** Bits per second; default 8 Mbit/s. */
  bitrate?: number;
  /** Default `probe-<repeatTo>`. */
  displayName?: string;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  decode?: DecodeImage;
  isConfigSupported?: CodecPickInput['isConfigSupported'];
  createEncoder?: CreateEncoder;
  now?: () => number;
}

export interface Stats {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface ExportBenchmarkResult extends ExportResult {
  pick: CodecPickResult;
  fps: number;
  width: number;
  height: number;
  bitrate: number;
  sourceFrames: number;
  summary: {
    decodeMs: Stats;
    waitMs: Stats;
    encodeMs: Stats;
    /** Wall time per exported frame, everything included. */
    msPerFrame: number;
    /** Exported seconds of video per wall-clock second. */
    speed: number;
  };
}

/** No encoder config in the ladder is supported; `pick` says what was tried. */
export class NoEncoderError extends Error {
  readonly code = 'NO_ENCODER';
  constructor(readonly pick: CodecPickResult) {
    super(`no supported video encoder (tried ${pick.tried.map((t) => t.codecString).join(', ')})`);
    this.name = 'NoEncoderError';
  }
}

/** Nearest-rank statistics; zeros for an empty list. */
export function stats(values: readonly number[]): Stats {
  if (values.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: rank(0.5), p95: rank(0.95), max: s[s.length - 1] };
}

export async function runExportBenchmark(o: ExportBenchmarkOptions): Promise<ExportBenchmarkResult> {
  const fps = o.fps ?? 8;
  const width = o.width ?? 1440;
  const height = o.height ?? 1080;
  const bitrate = o.bitrate ?? 8_000_000;
  if (o.frames.length === 0) throw new Error('no source frames');
  if (!(Number.isInteger(o.repeatTo) && o.repeatTo > 0)) throw new RangeError(`bad repeatTo: ${o.repeatTo}`);

  const pick = await pickCodec({ width, height, fps, bitrate, isConfigSupported: o.isConfigSupported });
  if (!pick.chosen) throw new NoEncoderError(pick);

  const decode = o.decode ?? decodeImage;
  const r = await exportVideo({
    source: {
      count: o.repeatTo,
      load: (i, { signal }) => decode(o.frames[i % o.frames.length], { width, height, signal }),
    },
    fps,
    width,
    height,
    bitrate,
    codec: pick.chosen,
    writer: o.writer,
    displayName: o.displayName ?? `probe-${o.repeatTo}`,
    signal: o.signal,
    onProgress: o.onProgress,
    createEncoder: o.createEncoder,
    now: o.now,
  });
  return {
    ...r,
    pick,
    fps,
    width,
    height,
    bitrate,
    sourceFrames: o.frames.length,
    summary: {
      decodeMs: stats(r.perFrame.map((f) => f.decodeMs)),
      waitMs: stats(r.perFrame.map((f) => f.waitMs)),
      encodeMs: stats(r.perFrame.map((f) => f.encodeMs)),
      msPerFrame: r.ms / r.frames,
      speed: r.ms > 0 ? r.frames / fps / (r.ms / 1000) : 0,
    },
  };
}
