// Target selection for the native remote (plan Task 8): which camera to connect to. Pure
// `selectTarget` plus the manual `host:port` check against `GET /info` (PROTOCOL §3).
import { PROTOCOL_VERSION } from '@kopernikadr/remote-core/protocol';
import type { ParsedService } from '@kopernikadr/remote-core/nsd';

export const DEFAULT_PORT = 8765;
const INFO_TIMEOUT_MS = 5_000;

export interface RememberedCamera {
  cameraId: string;
  host: string;
  port: number;
}

export interface Target {
  cameraId: string;
  host: string;
  port: number;
  source: 'nsd' | 'remembered' | 'manual';
}

export type Selection =
  | { kind: 'target'; target: Target }
  /** Nothing to connect to yet; discovery is still inside its window. */
  | { kind: 'searching' }
  /** Discovery window over and nothing selectable: the UI shows the connect screen. */
  | { kind: 'connect' };

export interface SelectInput {
  /** The active project's bound camera, if any. */
  requiredCameraId: string | null;
  remembered: RememberedCamera | null;
  /** NSD results so far (one per camera). */
  found: readonly ParsedService[];
  /** The NSD window has elapsed (we may now settle for "the single camera found"). */
  settled: boolean;
}

const fromService = (s: ParsedService): Target => ({ cameraId: s.cameraId, host: s.host, port: s.port, source: 'nsd' });

/**
 * 1. a project bound to a camera looks for that one: NSD, else the remembered one if it is that camera;
 * 2. otherwise the remembered camera (at its NSD address if NSD sees it now);
 * 3. otherwise the single camera found once the window is over;
 * 4. otherwise the connect screen.
 */
export function selectTarget({ requiredCameraId, remembered, found, settled }: SelectInput): Selection {
  const want = requiredCameraId ?? remembered?.cameraId ?? null;
  if (want) {
    const hit = found.find((s) => s.cameraId === want);
    if (hit) return { kind: 'target', target: fromService(hit) };
    if (remembered && remembered.cameraId === want) return { kind: 'target', target: { ...remembered, source: 'remembered' } };
    return settled ? { kind: 'connect' } : { kind: 'searching' };
  }
  if (!settled) return { kind: 'searching' };
  return found.length === 1 ? { kind: 'target', target: fromService(found[0]) } : { kind: 'connect' };
}

export const targetKey = (t: { host: string; port: number }): string => `${t.host}:${t.port}`;

/** Host with the port for a URL (IPv6 gets brackets, a zone `%` is escaped). */
export function hostPort(t: { host: string; port: number }): string {
  return t.host.includes(':') ? `[${t.host.replace(/%/g, '%25')}]:${t.port}` : `${t.host}:${t.port}`;
}

/** `host`, `host:port`, `[v6]:port`, with or without a scheme and path; null if invalid. */
export function parseAddress(text: string): { host: string; port: number } | null {
  const s = text.trim().replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '');
  const m = /^\[([^\]\s]+)\](?::(\d+))?$/.exec(s) ?? /^([^:\s[\]]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { host: m[1], port } : null;
}

export type ManualResult =
  | { ok: true; target: Target; name?: string; bootId: string }
  | { ok: false; reason: 'invalid-address' | 'unreachable' | 'bad-response' | 'unsupported-version' | 'wrong-camera'; message: string };

export interface VerifyOptions {
  /** If set, a camera with another id is rejected (`wrong-camera`). */
  requiredCameraId?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Validates a typed address with `GET /info`: reachable, a camera, speaks our protocol, the right one. */
export async function verifyManual(text: string, opts: VerifyOptions = {}): Promise<ManualResult> {
  const addr = parseAddress(text);
  if (!addr) return { ok: false, reason: 'invalid-address', message: `not an address: ${text}` };
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  let body: any;
  try {
    const res = await doFetch(`http://${hostPort(addr)}/info`, { signal: AbortSignal.timeout(opts.timeoutMs ?? INFO_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: 'bad-response', message: `GET /info: HTTP ${res.status}` };
    body = await res.json();
  } catch (e) {
    const unreachable = !(e instanceof SyntaxError);
    return { ok: false, reason: unreachable ? 'unreachable' : 'bad-response', message: e instanceof Error ? e.message : String(e) };
  }
  const pv = body?.protocolVersions;
  if (typeof body?.cameraId !== 'string' || !body.cameraId || typeof body?.bootId !== 'string' || !pv) {
    return { ok: false, reason: 'bad-response', message: 'GET /info: not a Kopernikadr camera' };
  }
  if (PROTOCOL_VERSION < pv.min || PROTOCOL_VERSION > pv.max) {
    return { ok: false, reason: 'unsupported-version', message: `camera speaks protocol ${pv.min}-${pv.max}` };
  }
  if (opts.requiredCameraId && body.cameraId !== opts.requiredCameraId) {
    return { ok: false, reason: 'wrong-camera', message: `camera ${body.cameraId}, project needs ${opts.requiredCameraId}` };
  }
  return { ok: true, target: { cameraId: body.cameraId, ...addr, source: 'manual' }, name: body.name, bootId: body.bootId };
}
