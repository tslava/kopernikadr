/**
 * Capture flow (ARCHITECTURE §5.6). One press:
 *   beginCapture mutation (awaited: outstanding + camera bound + geometry frozen)
 *   -> `capture{projectId, rotation}` with a NEW reqId
 *   -> result: mutation removes the entry and merges -> Transfer.enqueue
 * No answer within `sendTimeoutMs` (or a lost socket): resolve THAT reqId with `getOperation`.
 * A camera error answer for the new reqId (admission rejections, CAPTURE_FAILED) means no frame:
 * the entry is dropped. Never an automatic retake.
 *
 * Wiring (CameraClient needs `resolveOutstanding`, capture needs the client):
 *   let client!: CameraClient;
 *   const cap = createCapture({ store, transfer, camera: { request: (...a) => client.request(...a), get snapshot() { return client.snapshot; } } });
 *   client = new CameraClient({ ..., resolveOutstanding: cap.resolveOutstanding });
 */
import type { SessionContext } from '../camera/client';
import type { Rotation } from '../projects/model';
import { beginCapture } from '../projects/reducers';
import { SEND_TIMEOUT_MS, createResolver, failure, reasonForCode, type CaptureEnv, type CaptureOutcome } from './outstanding';

export { REASON_KEY, type CameraLike, type CaptureEnv, type CaptureOutcome, type CaptureReason } from './outstanding';

export interface Capture {
  /** The shutter press. Never rejects: a failure outcome carries a kid-level `messageKey`. */
  press(projectId: string): Promise<CaptureOutcome>;
  resolveOutstanding(ctx: SessionContext): Promise<void>;
}

type Begin = { kind: 'ok'; rotation: Rotation } | { kind: 'busy' } | { kind: 'mismatch' };

export function createCapture(env: CaptureEnv): Capture {
  const { store, camera } = env;
  const now = env.now ?? Date.now;
  const newId = env.newId ?? (() => crypto.randomUUID());
  const sendTimeoutMs = env.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const resolver = createResolver(env);

  async function press(projectId: string): Promise<CaptureOutcome> {
    const snap = camera.snapshot;
    const hello = snap.hello;
    if (snap.status !== 'online' || !hello) return failure('offline');
    if (snap.reconciling) return failure('not_ready');
    const cameraId = hello.cameraId;
    const reqId = newId(); // a new reqId per press: a `failed` reqId replays its error

    let begin: Begin;
    try {
      begin = await store.mutate<Begin>((s) => {
        const p = s.projects[projectId];
        if (!p) throw new Error(`unknown project: ${projectId}`);
        // limit 1: one outstanding capture per camera (the camera takes one photo at a time)
        const busy = Object.values(s.projects).some((q) => q.outstanding.some((o) => o.cameraId === cameraId));
        if (busy) return { result: { kind: 'busy' } };
        const r = beginCapture(p, { reqId, cameraId, nowMs: now() });
        if (!r.ok) return { result: { kind: 'mismatch' } };
        return { result: { kind: 'ok', rotation: r.rotation }, projects: [r.project] };
      });
    } catch {
      return failure('generic');
    }
    if (begin.kind === 'busy') return failure('in_progress');
    if (begin.kind === 'mismatch') return failure('new_movie_needed');

    let info;
    try {
      info = await camera.request('capture', { projectId, rotation: begin.rotation }, { reqId, timeoutMs: sendTimeoutMs });
    } catch (e: any) {
      const code: string | undefined = typeof e?.code === 'string' ? e.code : undefined;
      // No answer (timeout, closed socket) or an answer that does not settle this reqId: ask the camera.
      const uncertain = e?.local === true || code === undefined || code === 'LEASE_LOST' || code === 'INTERNAL' || code === 'UNKNOWN';
      if (uncertain) return guard(() => resolver.resolveReqId(projectId, reqId, cameraId), reqId);
      // The camera answered with an error for this reqId: no frame exists.
      return guard(async () => {
        await resolver.drop(projectId, reqId);
        return failure(reasonForCode(code), { code, reqId });
      }, reqId);
    }
    return guard(() => resolver.settleFrame(projectId, reqId, cameraId, info), reqId);
  }

  /** A store failure after the camera answered: the entry stays and the next session resolves it. */
  async function guard(fn: () => Promise<CaptureOutcome>, reqId: string): Promise<CaptureOutcome> {
    try {
      return await fn();
    } catch {
      return failure('later', { reqId });
    }
  }

  return { press, resolveOutstanding: resolver.resolveOutstanding };
}
