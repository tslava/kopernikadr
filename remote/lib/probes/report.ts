// The diagnostics report (`remote-diag-<ts>.json`): built from a run, written atomically into the
// app's private `kopernikadr/probe/` (KopernikadrNative.writeTextAtomic) and copied to the app's
// external files dir (`Filesystem.writeFile({directory: External})`), where
// `scripts/collect-diagnostics.sh` pulls it with `adb pull` (/sdcard/Android/data/<pkg>/files/).
import { errorText, summarize, type ProbeResult, type RunReport, type Summary } from './runner';

export const REPORT_KIND = 'kopernikadr-remote-diag';
export const REPORT_SCHEMA = 1;
/** Report directory, relative to `filesDir/kopernikadr/` and to the external files dir. */
export const REPORT_DIR = 'probe';

export interface ReportMeta {
  appVersion: string;
  platform: string;
  native: boolean;
  /** The probe's own clientId (its frames are the only ones it acks). */
  probeClientId: string;
  manualAddress: string;
}

export interface Report {
  kind: typeof REPORT_KIND;
  schema: typeof REPORT_SCHEMA;
  createdAt: string;
  startedAt: string;
  durationMs: number;
  cancelled: boolean;
  meta: ReportMeta;
  keepAwake: RunReport['keepAwake'];
  summary: Summary;
  /** Results keyed by probe name (`env`, `nsd`, `camera`, …), in run order. */
  probes: Record<string, ProbeResult>;
}

export function buildReport(run: RunReport, meta: ReportMeta, createdAt: Date = new Date()): Report {
  return {
    kind: REPORT_KIND,
    schema: REPORT_SCHEMA,
    createdAt: createdAt.toISOString(),
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    cancelled: run.cancelled,
    meta,
    keepAwake: run.keepAwake,
    summary: summarize(run.results),
    probes: Object.fromEntries(run.results.map((r) => [r.name, r])),
  };
}

/** `remote-diag-20261027T075201Z.json` (UTC, sortable, no `:` for adb/macOS). */
export function reportFileName(at: Date): string {
  const ts = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `remote-diag-${ts}.json`;
}

/** The two writes; null in a plain browser (no native filesystem). */
export interface ReportWriter {
  /** Atomic write under `filesDir/kopernikadr/` (KopernikadrNative.writeTextAtomic). */
  writeInternal(path: string, text: string): Promise<void>;
  /** A copy under the external files dir; resolves with its URI. */
  writeExternal(path: string, text: string): Promise<string>;
}

export interface WriteOutcome {
  path: string;
  ok: boolean;
  uri?: string;
  error?: string;
}

export type SaveResult =
  | { saved: false; reason: 'native-only'; name: string }
  | { saved: boolean; name: string; internal: WriteOutcome; external: WriteOutcome };

/** Writes the report both ways; one failing write doesn't prevent the other. Never throws. */
export async function saveReport(report: Report, writer: ReportWriter | null): Promise<SaveResult> {
  const name = reportFileName(new Date(report.createdAt));
  if (!writer) return { saved: false, reason: 'native-only', name };
  const path = `${REPORT_DIR}/${name}`;
  const text = JSON.stringify(report, null, 2) + '\n';

  const internal: WriteOutcome = { path, ok: false };
  try {
    await writer.writeInternal(path, text);
    internal.ok = true;
  } catch (e) {
    internal.error = errorText(e);
  }
  const external: WriteOutcome = { path, ok: false };
  try {
    external.uri = await writer.writeExternal(path, text);
    external.ok = true;
  } catch (e) {
    external.error = errorText(e);
  }
  return { saved: internal.ok || external.ok, name, internal, external };
}
