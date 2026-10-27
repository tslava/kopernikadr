// The probes wired to the real adapters (Capacitor plugins, WebView globals). Diagnostics loads
// this with a dynamic import on "run", so nothing here runs during the static prerender.
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { uuid } from '@kopernikadr/remote-core/protocol';
import { discover } from '../discovery';
import { createNativeWriter } from '../export/nativeWriter';
import { KopernikadrNative } from '../native';
import { cameraProbe, type SessionDeps } from './camera';
import { downloadProbe, type DownloadNative } from './download';
import { envProbe, storageProbe, type EnvGlobals } from './env';
import { exportProbe } from './export';
import { nsdProbe } from './nsd';
import { reconnectProbe, cameraConnection } from './reconnect';
import { buildReport, saveReport, type Report, type ReportWriter, type SaveResult } from './report';
import { runProbes, type KeepAwakeAdapter, type Probe, type ProbeUpdate, type PromptFn } from './runner';
import { PROBE_STORAGE, readStored, writeStored, type ProbeShared } from './shared';
import { videoFrameProbe, type VideoFrameDeps } from './videoFrame';

export const PROBE_APP_VERSION = 'kopernikadr-remote/0b-probe';

/** The probe's own clientId/projectId, kept across runs so leftover probe frames get acked later. */
export function probeIdentity(): { clientId: string; projectId: string } {
  const get = (key: string) => {
    const v = readStored(key);
    if (v) return v;
    const id = uuid();
    writeStored(key, id);
    return readStored(key) ?? (memo[key] ??= id);
  };
  return { clientId: get(PROBE_STORAGE.clientId), projectId: get(PROBE_STORAGE.projectId) };
}
// Fallback when localStorage is unavailable: stable for this page load.
const memo: Record<string, string> = {};

const inData = (path: string) => ({ directory: Directory.Data, path: `kopernikadr/${path}` });

/** Filesystem + FileTransfer + KopernikadrNative behind the download probe. */
export function nativeDownload(): DownloadNative {
  return {
    async ensureTmpDir() {
      try {
        await Filesystem.mkdir({ ...inData('tmp'), recursive: true });
      } catch (e) {
        if (!/already exists/i.test(String((e as Error)?.message))) throw e;
      }
    },
    uriOf: async (path) => (await Filesystem.getUri(inData(path))).uri,
    download: async (url, uri) => void (await FileTransfer.downloadFile({ url, path: uri })),
    async read(uri) {
      const res = await fetch(Capacitor.convertFileSrc(uri));
      if (!res.ok) throw new Error(`read ${uri}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    installFile: async (o) => (await KopernikadrNative.installFile(o)).result,
    remove: (path) => Filesystem.deleteFile(inData(path)),
  };
}

export function keepAwake(): KeepAwakeAdapter {
  return { acquire: () => KeepAwake.keepAwake(), release: () => KeepAwake.allowSleep() };
}

export function reportWriter(native: boolean): ReportWriter | null {
  if (!native) return null;
  return {
    writeInternal: (path, text) => KopernikadrNative.writeTextAtomic({ path, text }),
    async writeExternal(path, text) {
      const r = await Filesystem.writeFile({ path, data: text, directory: Directory.External, encoding: Encoding.UTF8, recursive: true });
      return r.uri;
    },
  };
}

/** Times what the preview really costs: decoding each JPEG like the remote will draw it. */
async function decodeJpeg(jpeg: Uint8Array): Promise<void> {
  const bitmap = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
  bitmap.close();
}

/** All probes in run order (shared.PROBE_ORDER), with the app's adapters. */
export function buildProbes(native = Capacitor.isNativePlatform()): Probe<ProbeShared>[] {
  const { clientId, projectId } = probeIdentity();
  const platform = Capacitor.getPlatform();
  const now = () => performance.now();
  const session: SessionDeps = { WebSocketImpl: WebSocket, clientId, appVersion: PROBE_APP_VERSION, platform, now };
  const fetchFn: typeof fetch = (...args) => fetch(...args);
  const g = globalThis as unknown as EnvGlobals & { VideoFrame?: VideoFrameDeps['VideoFrame'] };

  return [
    envProbe({ globals: g, platform, native }),
    storageProbe({ freeBytes: native ? async () => (await KopernikadrNative.freeBytes()).bytes : null }),
    nsdProbe({ discover: native ? (seconds) => discover({ seconds }) : null }),
    cameraProbe({ ...session, fetch: fetchFn, projectId, decode: typeof createImageBitmap === 'function' ? decodeJpeg : undefined }),
    downloadProbe({ ...session, fetch: fetchFn, native: native ? nativeDownload() : null, projectId }),
    videoFrameProbe({
      native,
      async readBlob(uri) {
        const res = await fetch(Capacitor.convertFileSrc(uri));
        if (!res.ok) throw new Error(`read ${uri}: HTTP ${res.status}`);
        return res.blob();
      },
      createImageBitmap: (blob, opts) => createImageBitmap(blob, opts),
      VideoFrame: g.VideoFrame,
      now,
    }),
    exportProbe({
      ...session,
      native: native ? nativeDownload() : null,
      projectId,
      convertFileSrc: (uri) => Capacitor.convertFileSrc(uri),
      createWriter: () => createNativeWriter(),
    }),
    reconnectProbe({ connect: cameraConnection({ clientId, appVersion: PROBE_APP_VERSION, platform }), now }),
  ];
}

export interface DiagnosticsRun {
  report: Report;
  save: SaveResult;
}

/** Runs every probe, builds the report and saves it (natively). Never throws for a probe. */
export async function runDiagnostics(opts: {
  manualAddress: string;
  signal: AbortSignal;
  prompt: PromptFn;
  onUpdate: (u: ProbeUpdate) => void;
}): Promise<DiagnosticsRun> {
  const native = Capacitor.isNativePlatform();
  const shared: ProbeShared = { manualAddress: opts.manualAddress };
  const run = await runProbes(buildProbes(native), {
    shared,
    keepAwake: keepAwake(),
    signal: opts.signal,
    prompt: opts.prompt,
    onUpdate: opts.onUpdate,
  });
  const report = buildReport(run, {
    appVersion: PROBE_APP_VERSION,
    platform: Capacitor.getPlatform(),
    native,
    probeClientId: probeIdentity().clientId,
    manualAddress: opts.manualAddress,
  });
  return { report, save: await saveReport(report, reportWriter(native)) };
}
