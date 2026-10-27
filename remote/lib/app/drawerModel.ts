// Parent drawer logic (plan Task 15), pure so it runs without a DOM. PROTOCOL v1 §6.
import { isLockFailed } from '@kopernikadr/remote-core/protocol';
import type { Key } from '../i18n';
import { isGeometryFrozen, setFps, setRotation } from '../projects/reducers';
import type { Project, Rotation } from '../projects/model';

export type LockKey = 'exposure' | 'whiteBalance' | 'focus';
export type PreviewQuality = 'low' | 'normal' | 'high';
export const PREVIEW_QUALITIES: readonly PreviewQuality[] = ['low', 'normal', 'high'];

export interface LockControl {
  mode?: string;
  confirmed?: boolean;
  focusOk?: boolean;
  compensationSteps?: number;
  compensationEnabled?: boolean;
}
export interface Controls {
  generation?: number;
  settling?: boolean;
  exposure?: LockControl;
  whiteBalance?: LockControl;
  focus?: LockControl;
  rotation?: number;
  previewQuality?: string;
}
export interface Capabilities {
  exposure?: {
    lock?: boolean;
    method?: string | null;
    compensation?: { supported?: boolean; minSteps: number; maxSteps: number; stepEv?: { num: number; den: number } };
  };
  whiteBalance?: { lock?: boolean; method?: string | null };
  focus?: { modes?: string[] };
  rotations?: number[];
  previewQualities?: string[];
}

export type LockStateName = 'unknown' | 'unsupported' | 'fixed' | 'failed' | 'locking' | 'locked' | 'auto';
export interface LockView {
  state: LockStateName;
  /** Which segment is selected (null when nothing can be selected). */
  current: 'auto' | 'locked' | null;
  /** The auto/lock toggle is offered. */
  canSet: boolean;
}

/**
 * One lock row. "Lock failed" needs `isLockFailed` AND `settling === false`: `focusOk:false` is
 * transient while autofocus is still confirming. "Locked" only once `confirmed`.
 */
export function lockView(key: LockKey, controls: Controls | null | undefined, caps: Capabilities | null | undefined): LockView {
  const c = controls?.[key];
  if (!c) return { state: 'unknown', current: null, canSet: false };
  const supported =
    key === 'exposure' ? caps?.exposure?.lock !== false && caps?.exposure?.method !== null
    : key === 'whiteBalance' ? caps?.whiteBalance?.lock !== false && caps?.whiteBalance?.method !== null
    : true;
  if (!supported || c.mode === 'unsupported') return { state: 'unsupported', current: null, canSet: false };
  if (c.mode === 'fixed') return { state: 'fixed', current: null, canSet: false };
  const current = c.mode === 'locked' ? 'locked' : c.mode === 'auto' ? 'auto' : null;
  if (controls?.settling !== true && isLockFailed(key, c)) return { state: 'failed', current, canSet: true };
  if (c.mode === 'locked') return { state: c.confirmed ? 'locked' : 'locking', current, canSet: true };
  if (c.mode === 'failed') return { state: 'locking', current: 'locked', canSet: true }; // failed, but still settling
  return { state: 'auto', current, canSet: true };
}

export const LOCK_STATE_KEY: Record<LockStateName, Key> = {
  unknown: 'drawer.st.unknown',
  unsupported: 'drawer.st.unsupported',
  fixed: 'drawer.st.fixed',
  failed: 'drawer.st.failed',
  locking: 'drawer.st.locking',
  locked: 'drawer.st.locked',
  auto: 'drawer.st.auto',
};

export interface CompensationView {
  min: number;
  max: number;
  steps: number;
  label: string;
}

/** The slider only exists when the camera supports it and exposure is not frozen. */
export function compensationView(controls: Controls | null | undefined, caps: Capabilities | null | undefined): CompensationView | null {
  const comp = caps?.exposure?.compensation;
  const exp = controls?.exposure;
  if (!comp?.supported || !exp || exp.compensationEnabled !== true) return null;
  const steps = Math.min(comp.maxSteps, Math.max(comp.minSteps, exp.compensationSteps ?? 0));
  return { min: comp.minSteps, max: comp.maxSteps, steps, label: evLabel(steps, comp.stepEv) };
}

export function evLabel(steps: number, stepEv?: { num: number; den: number }): string {
  const ev = (steps * (stepEv?.num ?? 1)) / (stepEv?.den ?? 2);
  const s = Number.isInteger(ev * 10) ? ev.toFixed(1) : ev.toFixed(2);
  return `${ev > 0 ? '+' : ''}${s} EV`;
}

export interface RotationView {
  options: Rotation[];
  current: Rotation;
  /** Only an empty project (no frames, nothing outstanding, no tombstones) may rotate. */
  locked: boolean;
}
export function rotationView(project: Project, caps?: Capabilities | null): RotationView {
  const opts = (caps?.rotations ?? [0, 180]).filter((r): r is Rotation => r === 0 || r === 180);
  return { options: opts.length ? opts : [0, 180], current: project.geometry.rotation, locked: isGeometryFrozen(project) };
}

export function unavailableCount(project: Project): number {
  return project.frames.filter((f) => f.unavailable).length;
}

// --- setControl -----------------------------------------------------------------------------

export type ControlChange =
  | { control: LockKey; mode: 'auto' | 'locked' }
  | { control: 'exposureCompensation'; steps: number }
  | { control: 'previewQuality'; value: PreviewQuality };

type Request = (op: string, args?: object) => Promise<any>;

/** Sends one flat `setControl`; resolves with the returned Controls, or a message key on error. */
export async function sendControl(
  request: Request,
  change: ControlChange,
): Promise<{ ok: true; controls: Controls } | { ok: false; messageKey: Key; code: string }> {
  try {
    const controls = (await request('setControl', change)) as Controls;
    return { ok: true, controls };
  } catch (e) {
    const code = String((e as { code?: unknown } | null)?.code ?? 'UNKNOWN');
    return { ok: false, code, messageKey: controlErrorKey(code) };
  }
}

export function controlErrorKey(code: string): Key {
  switch (code) {
    case 'UNSUPPORTED_CONTROL': return 'drawer.err.unsupported';
    case 'INVALID_VALUE':
    case 'INVALID_ARGS': return 'drawer.err.invalid';
    case 'CAPTURE_IN_PROGRESS': return 'drawer.err.busy';
    case 'TIMEOUT':
    case 'CLOSED': return 'drawer.err.offline';
    default: return 'drawer.err.generic';
  }
}

/** getControls cadence: fast while a lock is settling so "locked"/"failed" appear promptly. */
export function controlsPollMs(controls: Controls | null | undefined): number {
  return controls?.settling ? 700 : 3000;
}

// --- info -------------------------------------------------------------------------------------

export interface TransferStatusInfo {
  queued: number;
  failed?: number;
}

export function formatBytes(bytes: number | null | undefined, lang = 'pl'): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toLocaleString(lang, { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(bytes / 1e6).toLocaleString(lang)} MB`;
}

export interface ProjectUpdater {
  updateProject(id: string, fn: (p: Project) => Project): Promise<Project>;
}

/** Rotation goes through the reducer, which refuses once the geometry is frozen. */
export function applyRotation(store: ProjectUpdater, projectId: string, rotation: Rotation): Promise<Project> {
  return store.updateProject(projectId, (p) => setRotation(p, rotation));
}

export function applyFps(store: ProjectUpdater, projectId: string, fps: number): Promise<Project> {
  return store.updateProject(projectId, (p) => setFps(p, fps));
}

/** Tells the camera, and only on success lets the local preview follow. */
export async function applyPreviewQuality(
  request: Request,
  quality: PreviewQuality,
  onPreviewQuality: (q: PreviewQuality) => void,
): Promise<{ ok: true; controls: Controls } | { ok: false; messageKey: Key; code: string }> {
  const r = await sendControl(request, { control: 'previewQuality', value: quality });
  if (r.ok) onPreviewQuality(quality);
  return r;
}

/** Tablet free storage; null when not native or the call fails. */
export async function readFreeBytes(freeBytes: (() => Promise<{ bytes: number }>) | null | undefined): Promise<number | null> {
  if (!freeBytes) return null;
  try {
    return (await freeBytes()).bytes;
  } catch {
    return null;
  }
}
