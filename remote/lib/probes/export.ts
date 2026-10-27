// `export` probe (plan 0b Task 12): the probe's own ~20 frames are captured (probe clientId) and
// their `full` downloaded + verified (size + sha256) into `tmp/`; `convertFileSrc` turns the files
// into URLs the WebView can fetch; then `runExportBenchmark` cycles them to N = 20 and N = 100
// (fresh native writer each), encoding to MP4 in the gallery. Only the probe's own frames are acked
// at the end and its temp files deleted, whatever happened. Keep-awake is held by the runner.
import { runExportBenchmark, NoEncoderError, type ExportBenchmarkOptions, type ExportBenchmarkResult } from '../export/benchmark';
import { ExportFrameError, type ExportWriter } from '../export/mediabunnyExport';
import { nativeErrorCode } from '../native';
import { captureFrame, hostPort, NO_TARGET, openSession, resolveTarget, type FrameInfo, type SessionDeps } from './camera';
import type { DownloadNative } from './download';
import { errorText, ProbeFailure, ProbeSkip, type Probe } from './runner';
import type { ProbeShared } from './shared';
import { sha256Hex, throwIfAborted } from './util';

export const EXPORT_RUNS = [20, 100] as const;
export const EXPORT_FRAMES = 20;
const EXPORT_FPS = 8;

export interface ExportProbeDeps extends SessionDeps {
  /** null in a plain browser. */
  native: DownloadNative | null;
  projectId: string;
  /** `Capacitor.convertFileSrc`. */
  convertFileSrc: (fileUri: string) => string;
  /** `createNativeWriter` (fresh per run). */
  createWriter: () => ExportWriter;
  /** Default `runExportBenchmark`. */
  runBenchmark?: (o: ExportBenchmarkOptions) => Promise<ExportBenchmarkResult>;
  frames?: number;
  runs?: readonly number[];
  sha256?: (bytes: Uint8Array) => Promise<string>;
  newReqId?: () => string;
  wallClock?: () => Date;
}

export interface ExportRunData {
  n: number;
  ok: boolean;
  uri?: string;
  codec?: string;
  tried?: unknown[];
  failed?: unknown[];
  bytes?: number;
  ms?: number;
  summary?: ExportBenchmarkResult['summary'];
  error?: { code: string | null; message: string; pick?: { tried: unknown[]; failed: unknown[] }; index?: number };
}

export interface ExportData {
  target: { host: string; port: number; source: string };
  sourceFrames: number;
  runs: ExportRunData[];
  ack: { requested: number; acked: number; unknown: string[] } | null;
  cleanupErrors: string[];
  errors: string[];
}

const safeId = (id: string) => id.replace(/[^\w-]/g, '_');

/** The report-sized description of a failed run: `err.code` plus what the code carries. */
export function describeExportError(e: unknown): NonNullable<ExportRunData['error']> {
  const message = errorText(e);
  if (e instanceof NoEncoderError) return { code: e.code, message, pick: { tried: e.pick.tried, failed: e.pick.failed } };
  if (e instanceof ExportFrameError) return { code: e.code, message, index: e.index };
  const code = (e as { code?: unknown } | null)?.code;
  return { code: nativeErrorCode(e) ?? (typeof code === 'string' ? code : null), message };
}

export function exportProbe(deps: ExportProbeDeps): Probe<ProbeShared> {
  const sha256 = deps.sha256 ?? ((b: Uint8Array) => sha256Hex(b));
  const bench = deps.runBenchmark ?? runExportBenchmark;
  const wallClock = deps.wallClock ?? (() => new Date());

  return {
    name: 'export',
    async run(ctx) {
      const native = deps.native;
      if (!native) throw new ProbeSkip('native-only');
      const target = resolveTarget(ctx.shared);
      if (!target) throw new ProbeFailure(NO_TARGET);
      const data: ExportData = { target, sourceFrames: 0, runs: [], ack: null, cleanupErrors: [], errors: [] };

      const verified: string[] = [];
      const paths: string[] = [];
      let failure: unknown = null;
      try {
        // 1. capture + download + verify the probe's own frames
        const urls: string[] = [];
        const frames: FrameInfo[] = [];
        const session = await openSession(target, deps).catch((e) => {
          throw new Error(`hello: ${errorText(e)}`);
        });
        try {
          const rotation = session.hello.controls?.rotation ?? 0;
          for (let i = 0; i < (deps.frames ?? EXPORT_FRAMES); i++) {
            throwIfAborted(ctx.signal);
            const { frame } = await captureFrame(session, { projectId: deps.projectId, rotation }, { now: deps.now, signal: ctx.signal, newReqId: deps.newReqId });
            frames.push(frame);
          }
        } finally {
          session.close();
        }
        await native.ensureTmpDir();
        for (const f of frames) {
          throwIfAborted(ctx.signal);
          const tmp = `tmp/probe-export-${safeId(f.frameId)}.jpg`;
          paths.push(tmp);
          const uri = await native.uriOf(tmp);
          await native.download(`http://${hostPort(target)}/frames/${encodeURIComponent(f.frameId)}/full.jpg`, uri);
          const bytes = await native.read(uri);
          if (bytes.length !== f.full.bytes || (await sha256(bytes)) !== f.full.sha256.toLowerCase()) {
            throw new Error(`${f.frameId}: size/sha256 mismatch after download`);
          }
          verified.push(f.frameId);
          urls.push(deps.convertFileSrc(uri));
        }
        data.sourceFrames = urls.length;

        // 2. export runs
        const stamp = wallClock().toISOString().replace(/\D/g, '').slice(0, 14);
        for (const n of deps.runs ?? EXPORT_RUNS) {
          throwIfAborted(ctx.signal);
          try {
            const r = await bench({ frames: urls, repeatTo: n, writer: deps.createWriter(), fps: EXPORT_FPS, displayName: `probe-${n}-${stamp}`, signal: ctx.signal });
            data.runs.push({ n, ok: true, uri: r.uri, codec: r.codec, tried: r.pick.tried, failed: r.pick.failed, bytes: r.bytes, ms: r.ms, summary: r.summary });
          } catch (e) {
            const error = describeExportError(e);
            data.runs.push({ n, ok: false, error });
            data.errors.push(`export ${n}: ${error.code ? `${error.code}: ` : ''}${error.message}`);
            failure = e;
            break; // a longer run would fail the same way
          }
        }
      } catch (e) {
        failure = e;
        data.errors.push(errorText(e));
      } finally {
        // Ack only the probe's own frames that were downloaded and verified.
        if (verified.length) {
          try {
            const s = await openSession(target, deps);
            try {
              const r = await s.request<{ acked: number; unknown: string[] }>('ack', { frameIds: verified });
              data.ack = { requested: verified.length, acked: r.acked, unknown: r.unknown ?? [] };
              if (r.acked !== verified.length) data.errors.push(`ack: ${r.acked} of ${verified.length} acked`);
            } finally {
              s.close();
            }
          } catch (e) {
            data.errors.push(`ack: ${errorText(e)}`);
          }
        }
        for (const p of paths) await native.remove(p).catch((e) => data.cleanupErrors.push(`${p}: ${errorText(e)}`));
      }

      if (failure || data.errors.length) throw new ProbeFailure(data.errors.join('; ') || errorText(failure), data);
      return data;
    },
  };
}
