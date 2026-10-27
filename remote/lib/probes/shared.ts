// What the probes hand each other during one run, and the probe order the Diagnostics screen
// lists. No Capacitor imports here: Diagnostics imports this statically (prerendered at build).
import type { ParsedService } from '@kopernikadr/remote-core/nsd';

/** Probe names in run order; `probe.<name>` is the i18n label. Interactive `reconnect` runs last. */
export const PROBE_ORDER = ['env', 'storage', 'nsd', 'camera', 'download', 'videoFrame', 'export', 'reconnect'] as const;
export type ProbeName = (typeof PROBE_ORDER)[number];

/** localStorage keys (the probe identity survives runs; the address is a convenience). */
export const PROBE_STORAGE = {
  clientId: 'kopernikadr.probe.clientId',
  projectId: 'kopernikadr.probe.projectId',
  address: 'kopernikadr.diag.cameraAddress',
} as const;

/** localStorage read; null when absent or when storage is unavailable. */
export function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** localStorage write; silently does nothing when storage is unavailable. */
export function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // private mode / blocked storage: the value lives only in memory
  }
}

export interface ProbeShared {
  /** `host[:port]` typed on the Diagnostics screen; used when NSD finds nothing. */
  manualAddress: string;
  /** Cameras NSD found (set by the `nsd` probe). */
  nsdServices?: ParsedService[];
  /** Frames the `camera` probe captured (with the probe clientId). */
  capturedFrameIds?: string[];
  /** The `full` the `download` probe installed (native only), for `videoFrame`. */
  downloaded?: { frameId: string; path: string; uri: string; bytes: number };
}
