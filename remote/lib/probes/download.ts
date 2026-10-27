// `download` probe (ARCHITECTURE §5.6): the probe's own unacked frames (`listFrames` under the
// probe clientId; one is captured if there are none) are downloaded natively — `Filesystem.getUri`
// + `mkdir`, `FileTransfer.downloadFile` of `full` into `tmp/`, sha256 via `fetch(convertFileSrc)`
// + `crypto.subtle`, `KopernikadrNative.installFile` — and only the verified ones are acked.
// In a plain browser the native path is skipped; the frames are still fetched and verified (and
// then acked) so a Chrome run does not leave the probe's frames on the phone forever.
import type { InstallResult } from '../native';
import { captureFrame, NO_TARGET, openSession, hostPort, resolveTarget, type FrameInfo, type ProbeSession, type SessionDeps } from './camera';
import { errorText, ProbeFailure, ProbeSkip, type Probe } from './runner';
import type { ProbeShared } from './shared';
import { mbPerS, raceAbort, sha256Hex, throwIfAborted } from './util';

/** Where the last verified `full` is installed (relative to `filesDir/kopernikadr/`). */
export const DOWNLOAD_DEST = 'probe/frame.jpg';

/** The native file plumbing (Capacitor Filesystem + FileTransfer + KopernikadrNative). */
export interface DownloadNative {
  /** `Filesystem.mkdir({directory: Data, path: 'kopernikadr/tmp', recursive: true})`. */
  ensureTmpDir(): Promise<void>;
  /** `file://` URI of `filesDir/kopernikadr/<path>` (`Filesystem.getUri`). */
  uriOf(path: string): Promise<string>;
  /** `FileTransfer.downloadFile({url, path: uri})`. */
  download(url: string, uri: string): Promise<void>;
  /** The file's bytes via `fetch(Capacitor.convertFileSrc(uri))`. */
  read(uri: string): Promise<Uint8Array>;
  installFile(o: { tmp: string; dest: string; bytes: number; sha256: string }): Promise<InstallResult>;
  /** Best-effort delete of `filesDir/kopernikadr/<path>`. */
  remove(path: string): Promise<void>;
}

export interface DownloadProbeDeps extends SessionDeps {
  fetch: typeof fetch;
  /** null in a plain browser. */
  native: DownloadNative | null;
  projectId: string;
  /** Frames per run (the rest stay listed for the next run). */
  maxFrames?: number;
  sha256?: (bytes: Uint8Array) => Promise<string>;
  newReqId?: () => string;
  /** Deadline for one frame's download and read (headers and body). */
  frameTimeoutMs?: number;
}

/** A 3264×2448 JPEG is ~2–4 MB; 30 s is far beyond any healthy Wi-Fi download of one. */
export const FRAME_TIMEOUT_MS = 30_000;

export interface FrameCheck {
  frameId: string;
  seq: number;
  expectedBytes: number;
  bytes: number | null;
  ms: number | null;
  mbPerS: number | null;
  sizeOk: boolean;
  sha256Ok: boolean;
  install?: InstallResult;
  verified: boolean;
  error?: string;
}

export interface DownloadData {
  mode: 'native' | 'fetch';
  target: { host: string; port: number; source: string };
  listed: number;
  hasMore: boolean;
  /** Set when there was nothing to list and the probe captured its own frame. */
  capturedFrameId?: string;
  frames: FrameCheck[];
  totalBytes: number;
  totalMs: number;
  mbPerS: number | null;
  ack: { requested: number; acked: number; unknown: string[] } | null;
  errors: string[];
}

const safeId = (id: string) => id.replace(/[^\w-]/g, '_');

export function downloadProbe(deps: DownloadProbeDeps): Probe<ProbeShared> {
  const sha256 = deps.sha256 ?? ((b: Uint8Array) => sha256Hex(b));
  const now = deps.now;

  /** Downloads one `full` and checks size + sha256; native: then installs it. Never throws. */
  async function check(f: FrameInfo, url: string, shared: ProbeShared, cancel: AbortSignal): Promise<FrameCheck> {
    const rec: FrameCheck = {
      frameId: f.frameId,
      seq: f.seq,
      expectedBytes: f.full.bytes,
      bytes: null,
      ms: null,
      mbPerS: null,
      sizeOk: false,
      sha256Ok: false,
      verified: false,
    };
    const tmp = `tmp/probe-${safeId(f.frameId)}.jpg`;
    // Stop and a stalled phone must not hold the session and keep-awake (Codex 0b review).
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(deps.frameTimeoutMs ?? FRAME_TIMEOUT_MS)]);
    let download: Promise<void> | undefined;
    try {
      let bytes: Uint8Array;
      const t0 = now();
      if (deps.native) {
        const uri = await deps.native.uriOf(tmp);
        download = deps.native.download(url, uri);
        await raceAbort(download, signal);
        rec.ms = Math.round(now() - t0);
        bytes = await raceAbort(deps.native.read(uri), signal);
      } else {
        // The signal also aborts the body read below.
        const res = await deps.fetch(url, { signal });
        if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
        rec.ms = Math.round(now() - t0);
      }
      rec.bytes = bytes.length;
      rec.mbPerS = mbPerS(bytes.length, rec.ms);
      rec.sizeOk = bytes.length === f.full.bytes;
      rec.sha256Ok = (await sha256(bytes)) === f.full.sha256.toLowerCase();
      if (!rec.sizeOk || !rec.sha256Ok) {
        rec.error = `${rec.sizeOk ? '' : `size ${bytes.length} ≠ ${f.full.bytes}`}${!rec.sizeOk && !rec.sha256Ok ? ', ' : ''}${rec.sha256Ok ? '' : 'sha256 mismatch'}`;
        await deps.native?.remove(tmp).catch(() => {});
        return rec;
      }
      if (deps.native) {
        rec.install = await deps.native.installFile({ tmp, dest: DOWNLOAD_DEST, bytes: f.full.bytes, sha256: f.full.sha256 });
        shared.downloaded = { frameId: f.frameId, path: DOWNLOAD_DEST, uri: await deps.native.uriOf(DOWNLOAD_DEST), bytes: f.full.bytes };
      }
      rec.verified = true;
    } catch (e) {
      rec.error = errorText(e);
      const native = deps.native;
      if (native) {
        if (signal.aborted && download) {
          // The native download can't be cancelled: delete its file once it settles, not before.
          void download.catch(() => {}).then(() => native.remove(tmp)).catch(() => {});
        } else {
          await native.remove(tmp).catch(() => {});
        }
      }
    }
    return rec;
  }

  return {
    name: 'download',
    async run(ctx) {
      const target = resolveTarget(ctx.shared);
      if (!target) throw new ProbeFailure(NO_TARGET);
      const data: DownloadData = {
        mode: deps.native ? 'native' : 'fetch',
        target,
        listed: 0,
        hasMore: false,
        frames: [],
        totalBytes: 0,
        totalMs: 0,
        mbPerS: null,
        ack: null,
        errors: [],
      };

      let session: ProbeSession;
      try {
        session = await openSession(target, deps);
      } catch (e) {
        throw new ProbeFailure(`hello: ${errorText(e)}`, data);
      }
      try {
        // listFrames is scoped to the caller's clientId (PROTOCOL §6): only the probe's frames.
        const list = await session.request<{ frames: FrameInfo[]; hasMore: boolean }>('listFrames', { limit: deps.maxFrames ?? 25 });
        let frames = list.frames;
        data.listed = frames.length;
        data.hasMore = list.hasMore;
        if (!frames.length) {
          const rotation = session.hello.controls?.rotation ?? 0;
          const { frame } = await captureFrame(session, { projectId: deps.projectId, rotation }, { now, signal: ctx.signal, newReqId: deps.newReqId });
          data.capturedFrameId = frame.frameId;
          frames = [frame];
        }
        if (deps.native) await deps.native.ensureTmpDir();

        const verified: string[] = [];
        for (const f of frames) {
          throwIfAborted(ctx.signal);
          const url = `http://${hostPort(target)}/frames/${encodeURIComponent(f.frameId)}/full.jpg`;
          const rec = await check(f, url, ctx.shared, ctx.signal);
          data.frames.push(rec);
          if (rec.verified) verified.push(f.frameId);
          else data.errors.push(`${f.frameId}: ${rec.error ?? 'not verified'}`);
        }
        data.totalBytes = data.frames.reduce((a, r) => a + (r.bytes ?? 0), 0);
        data.totalMs = data.frames.reduce((a, r) => a + (r.ms ?? 0), 0);
        data.mbPerS = mbPerS(data.totalBytes, data.totalMs);

        // Ack only what was verified (and, natively, installed): ack eligibility, PROTOCOL §8.
        if (verified.length) {
          const r = await session.request<{ acked: number; unknown: string[] }>('ack', { frameIds: verified });
          data.ack = { requested: verified.length, acked: r.acked, unknown: r.unknown ?? [] };
          if (r.acked !== verified.length) data.errors.push(`ack: ${r.acked} of ${verified.length} acked, unknown ${JSON.stringify(r.unknown)}`);
        }
      } catch (e) {
        data.errors.push(errorText(e));
      } finally {
        session.close();
      }

      if (!deps.native) throw new ProbeSkip('native-only', data);
      if (data.errors.length) throw new ProbeFailure(data.errors.join('; '), data);
      return data;
    },
  };
}
