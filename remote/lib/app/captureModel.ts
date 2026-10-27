// View-model of the capture view: pure functions, no React, no I/O.
import type { Key } from '../i18n';
import type { CaptureOutcome } from '../capture/outstanding';
import { selectOnionSource, type OnionSource } from '../camera/onion';
import type { Project } from '../projects/model';
import type { FrameUrlFn } from './frames';

export type ShutterBlock = 'offline' | 'reconciling' | 'outstanding' | 'exporting' | 'pressing';
export interface ShutterState {
  enabled: boolean;
  /** Why it is disabled (the first reason in priority order). */
  blocked: ShutterBlock | null;
}

export interface ShutterInput {
  /** The camera is online with a valid hello. */
  online: boolean;
  /** Per-session hooks (resolveOutstanding/reconcile) are running. */
  reconciling: boolean;
  /** An outstanding capture of this camera exists (limit 1 per camera, any project). */
  outstanding: boolean;
  exporting: boolean;
  /** A press of this view is in flight. */
  pressing: boolean;
}

export function shutterState(i: ShutterInput): ShutterState {
  const blocked: ShutterBlock | null = !i.online
    ? 'offline'
    : i.exporting
      ? 'exporting'
      : i.reconciling
        ? 'reconciling'
        : i.outstanding
          ? 'outstanding'
          : i.pressing
            ? 'pressing'
            : null;
  return { enabled: blocked === null, blocked };
}

/** Is any project holding an outstanding capture for this camera? */
export function hasOutstandingFor(projects: Record<string, Pick<Project, 'outstanding'>>, cameraId: string | null | undefined): boolean {
  if (!cameraId) return false;
  return Object.values(projects).some((p) => p.outstanding.some((o) => o.cameraId === cameraId));
}

/** The toast of a press outcome: a kid-level message for failures, nothing for a frame. */
export function toastKey(o: CaptureOutcome): Key | null {
  return o.ok ? null : o.messageKey;
}

const visible = (f: Project['frames'][number], now: number) => !(f.hiddenUntil && Date.parse(f.hiddenUntil) > now);

/** The frame counter: frames of the movie not hidden by a pending undo (downloading ones count). */
export function frameCount(project: Pick<Project, 'frames'>, now: number = Date.now()): number {
  return project.frames.filter((f) => visible(f, now)).length;
}

/** Placeholders: captures still on the way (an outstanding request, or a frame still downloading). */
export function pendingCount(project: Pick<Project, 'frames' | 'outstanding'>, now: number = Date.now()): number {
  return project.outstanding.length + project.frames.filter((f) => f.state === 'pending' && visible(f, now)).length;
}

/** The onion source for the project being shot (last local frame: play, else thumb). */
export function onionSourceFor(project: Pick<Project, 'id' | 'frames'> | null, frameUrl: FrameUrlFn | null, now?: number): OnionSource {
  if (!project || !frameUrl) return null;
  return selectOnionSource(project.id, project.frames, frameUrl, now);
}
