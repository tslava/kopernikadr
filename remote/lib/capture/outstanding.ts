/**
 * Outstanding captures (ARCHITECTURE §5.6, PROTOCOL v1 §6 `capture`/`getOperation`).
 *
 * An outstanding entry lives in `project.outstanding` from `beginCapture` until the camera gives a
 * terminal answer for THAT reqId. It is resolved with `getOperation`, never re-sent. No auto-retake.
 *
 * `settleFrame` is the one place a capture result lands (the press, the timeout path and the
 * per-session `resolveOutstanding` hook all use it), so a duplicate result is harmless: the merge is
 * monotonic and only a freshly inserted frame is handed to `Transfer.enqueue`.
 */
import type { ConnectionLike, SessionContext } from '../camera/client';
import type { Key } from '../i18n';
import type { FrameInfo } from '../projects/model';
import { mergeFrame, removeOutstanding, routeResult, type MergeStatus } from '../projects/reducers';
import type { ProjectStore } from '../projects/store';
import type { Transfer } from '../transfer/types';

export const SEND_TIMEOUT_MS = 10_000;
export const POLL_MS = 1_000;
export const GIVE_UP_MS = 30_000;
const OP_TIMEOUT_MS = 4_000;

export type CaptureReason =
  | 'in_progress'
  | 'not_ready'
  | 'storage_low'
  | 'geometry_mismatch'
  | 'generic' // "nie wyszło, spróbuj jeszcze raz"
  | 'later' // "sprawdzimy tę klatkę później"
  | 'new_movie_needed'
  | 'offline';

export const REASON_KEY: Record<CaptureReason, Key> = {
  in_progress: 'capture.err.inProgress',
  not_ready: 'capture.err.notReady',
  storage_low: 'capture.err.storageLow',
  geometry_mismatch: 'capture.err.geometry',
  generic: 'capture.err.generic',
  later: 'capture.err.later',
  new_movie_needed: 'capture.err.newMovie',
  offline: 'capture.err.offline',
};

/** PROTOCOL error code -> reason (everything else is `generic`). */
export function reasonForCode(code: unknown): CaptureReason {
  switch (code) {
    case 'CAPTURE_IN_PROGRESS':
      return 'in_progress';
    case 'CAMERA_NOT_READY':
      return 'not_ready';
    case 'STORAGE_LOW':
      return 'storage_low';
    case 'GEOMETRY_MISMATCH':
      return 'geometry_mismatch';
    default:
      return 'generic';
  }
}

export type CaptureOutcome =
  | {
      ok: true;
      frameId: string;
      projectId: string;
      /** `inserted`/`exists`: merged. Anything else: not merged (acked via Transfer when safe). */
      merge: MergeStatus | 'deleted_project' | 'unknown_project';
    }
  | { ok: false; reason: CaptureReason; messageKey: Key; code?: string; reqId?: string };

export const failure = (reason: CaptureReason, extra: { code?: string; reqId?: string } = {}): CaptureOutcome => ({
  ok: false,
  reason,
  messageKey: REASON_KEY[reason],
  ...extra,
});

/** The part of CameraClient the capture flow uses. `snapshot.hello` is the current session's hello. */
export interface CameraLike {
  request: ConnectionLike['request'];
  readonly snapshot: { status: string; hello: { cameraId: string; bootId: string } | null; reconciling: boolean };
}

export interface CaptureEnv {
  store: ProjectStore;
  camera: CameraLike;
  transfer: Transfer;
  now?: () => number;
  newId?: () => string;
  sendTimeoutMs?: number;
  pollMs?: number;
  giveUpMs?: number;
  /** Outcomes of entries resolved by the per-session hook (nobody awaits a press for them). */
  notify?: (o: CaptureOutcome) => void;
}

export interface Resolver {
  /** Plug into `CameraClientDeps.resolveOutstanding`. */
  resolveOutstanding(ctx: SessionContext): Promise<void>;
  /** Resolve one entry through `getOperation`. Concurrent calls for a reqId share one run. */
  resolveReqId(projectId: string, reqId: string, cameraId: string, opts?: { bootIdChanged?: boolean }): Promise<CaptureOutcome>;
  /** A capture result (from `capture` or `getOperation`): remove the entry, merge, hand to Transfer. */
  settleFrame(projectId: string, reqId: string, cameraId: string, info: FrameInfo): Promise<CaptureOutcome>;
  /** Drop an entry whose outcome is known to be "no frame". */
  drop(projectId: string, reqId: string): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createResolver(env: CaptureEnv): Resolver {
  const { store, camera, transfer } = env;
  const now = env.now ?? Date.now;
  const pollMs = env.pollMs ?? POLL_MS;
  const giveUpMs = env.giveUpMs ?? GIVE_UP_MS;
  const inflight = new Map<string, Promise<CaptureOutcome>>();

  async function drop(projectId: string, reqId: string): Promise<void> {
    await store.mutate((s) => {
      const p = s.projects[projectId];
      if (!p) return { result: undefined };
      return { result: undefined, projects: [removeOutstanding(p, reqId)] };
    });
  }

  async function settleFrame(projectId: string, reqId: string, cameraId: string, info: FrameInfo): Promise<CaptureOutcome> {
    const r = await store.mutate((s) => {
      const route = routeResult(s.index, projectId);
      if (route !== 'merge') return { result: { merge: route as MergeStatus | 'deleted_project' | 'unknown_project', inserted: false } };
      const p = s.projects[projectId]!;
      // the entry is removed even if the frame cannot merge: the camera answered for this reqId
      const merged = mergeFrame(removeOutstanding(p, reqId), info, cameraId);
      return { result: { merge: merged.status as MergeStatus | 'deleted_project' | 'unknown_project', inserted: merged.status === 'inserted' }, projects: [merged.project] };
    });
    if (r.inserted) await transfer.enqueue(info.frameId, projectId);
    else if (r.merge === 'deleted_project' || r.merge === 'tombstoned') await transfer.ackNow([info.frameId]);
    return { ok: true, frameId: info.frameId, projectId, merge: r.merge };
  }

  async function run(projectId: string, reqId: string, cameraId: string, bootIdChanged: boolean): Promise<CaptureOutcome> {
    const startBoot = camera.snapshot.hello?.bootId ?? null;
    const startedAt = now();
    for (;;) {
      let op: any;
      try {
        op = await camera.request('getOperation', { reqId }, { timeoutMs: OP_TIMEOUT_MS });
      } catch {
        // not connected / no answer: the entry stays; the next session's hook resolves it
        return failure('later', { reqId });
      }
      switch (op?.state) {
        case 'done':
          return settleFrame(projectId, reqId, cameraId, op.result as FrameInfo);
        case 'failed':
        case 'unknown':
          await drop(projectId, reqId);
          return failure('generic', { reqId, ...(op.error?.code ? { code: String(op.error.code) } : {}) });
        case 'pending': {
          const boot = camera.snapshot.hello?.bootId ?? null;
          const restarted = bootIdChanged || (startBoot !== null && boot !== null && boot !== startBoot);
          if (restarted || now() - startedAt >= giveUpMs) {
            // reconcile (`listFrames`) still recovers a frame the camera committed after all
            await drop(projectId, reqId);
            return failure('later', { reqId });
          }
          await sleep(pollMs);
          break;
        }
        default:
          return failure('later', { reqId });
      }
    }
  }

  function resolveReqId(projectId: string, reqId: string, cameraId: string, opts: { bootIdChanged?: boolean } = {}): Promise<CaptureOutcome> {
    const have = inflight.get(reqId);
    if (have) return have;
    const p = run(projectId, reqId, cameraId, opts.bootIdChanged ?? false).finally(() => inflight.delete(reqId));
    inflight.set(reqId, p);
    return p;
  }

  async function resolveOutstanding(ctx: SessionContext): Promise<void> {
    const cameraId = ctx.hello.cameraId;
    const entries: { projectId: string; reqId: string }[] = [];
    for (const p of Object.values(store.state.get().projects)) {
      // an entry of another camera waits for that camera
      for (const o of p.outstanding) if (o.cameraId === cameraId) entries.push({ projectId: p.id, reqId: o.reqId });
    }
    for (const e of entries) {
      const o = await resolveReqId(e.projectId, e.reqId, cameraId, { bootIdChanged: ctx.bootIdChanged });
      env.notify?.(o);
    }
  }

  return { resolveOutstanding, resolveReqId, settleFrame, drop };
}
