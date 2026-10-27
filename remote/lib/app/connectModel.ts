// View-model of the connect screen and the connection badge: pure functions over the
// CameraClient snapshot, so the components stay thin (no DOM test environment in this repo).
import type { ClientSnapshot, CameraStatus } from '../camera/client';
import type { ManualResult } from '../camera/discover';
import type { Key } from '../i18n';

export type StatusKind = CameraStatus | 'unsupported';

export const statusKind = (s: Pick<ClientSnapshot, 'status' | 'unsupported'>): StatusKind =>
  s.unsupported ? 'unsupported' : s.status;

const MESSAGE: Record<StatusKind, Key> = {
  searching: 'connect.status.searching',
  connecting: 'connect.status.connecting',
  online: 'connect.status.online',
  offline: 'connect.status.offline',
  busy: 'connect.status.busy',
  replaced: 'connect.status.replaced',
  'wrong-camera': 'connect.status.wrongCamera',
  unsupported: 'connect.status.unsupported',
};

/** Seconds left of the BUSY retry delay (never below 1 while waiting). */
export const retrySeconds = (retryAfterMs: number | undefined, elapsedMs: number): number | undefined =>
  retryAfterMs === undefined ? undefined : Math.max(1, Math.ceil((retryAfterMs - elapsedMs) / 1000));

export interface StatusView {
  kind: StatusKind;
  messageKey: Key;
  params?: { s: number };
  /** "Przejmij" is offered. */
  canTakeOver: boolean;
  /** Spinner / waiting look. */
  working: boolean;
}

export function statusView(s: ClientSnapshot, elapsedMs = 0): StatusView {
  const kind = statusKind(s);
  const secs = kind === 'busy' ? retrySeconds(s.retryAfterMs, elapsedMs) : undefined;
  return {
    kind,
    // BUSY without a known delay uses the plain message.
    messageKey: kind === 'busy' && secs === undefined ? 'connect.status.busyNoTime' : MESSAGE[kind],
    ...(secs !== undefined ? { params: { s: secs } } : {}),
    canTakeOver: kind === 'replaced',
    working: kind === 'searching' || kind === 'connecting' || kind === 'busy',
  };
}

export interface CameraRow {
  cameraId: string;
  name: string;
  host: string;
  port: number;
  state: 'online' | 'connecting' | 'available';
}

/** Found cameras with the state of each: the one we are on is online/connecting, others are available. */
export function cameraRows(s: ClientSnapshot): CameraRow[] {
  return s.found.map((f) => {
    const current = s.target?.cameraId === f.cameraId;
    const state = current && s.status === 'online' ? 'online' : current && s.status === 'connecting' ? 'connecting' : 'available';
    return { cameraId: f.cameraId, name: f.name || f.cameraId, host: f.host, port: f.port, state };
  });
}

const MANUAL_ERROR: Record<Extract<ManualResult, { ok: false }>['reason'], Key> = {
  'invalid-address': 'connect.err.invalidAddress',
  unreachable: 'connect.err.unreachable',
  'bad-response': 'connect.err.notCamera',
  'unsupported-version': 'connect.err.version',
  'wrong-camera': 'connect.err.wrongCamera',
};

export const manualErrorKey = (r: Extract<ManualResult, { ok: false }>): Key => MANUAL_ERROR[r.reason];

/** The connect screen goes back to projects when the camera comes online (it was not before). */
export const justWentOnline = (prev: StatusKind | undefined, next: StatusKind): boolean =>
  prev !== undefined && prev !== 'online' && next === 'online';

export type BadgeTone = 'ok' | 'wait' | 'bad';
export interface Badge {
  key: Key;
  tone: BadgeTone;
}

export function badge(s: Pick<ClientSnapshot, 'status' | 'unsupported'>): Badge {
  switch (statusKind(s)) {
    case 'online':
      return { key: 'conn.online', tone: 'ok' };
    case 'searching':
    case 'connecting':
      return { key: 'conn.connecting', tone: 'wait' };
    case 'busy':
    case 'replaced':
      return { key: 'conn.busy', tone: 'bad' };
    default:
      return { key: 'conn.offline', tone: 'bad' };
  }
}
