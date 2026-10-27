// While the camera is online and settled but a capture of this camera is still outstanding, the
// per-session hook alone would leave the shutter disabled until the next session. Retry
// `resolveOutstanding` on a timer instead. Owned by the app (boot), not by a view.
import type { ClientSnapshot, SessionContext } from '../camera/client';
import type { Project } from '../projects/model';
import type { Store } from '../state/store';
import { hasOutstandingFor } from './captureModel';

export const OUTSTANDING_RETRY_MS = 5000;

export interface OutstandingRetryDeps {
  client: { store: Store<ClientSnapshot>; request: SessionContext['request'] };
  projects: Store<{ projects: Record<string, Pick<Project, 'outstanding'>> }>;
  resolve: (ctx: SessionContext) => void | Promise<void>;
  /** False in the background: no retries then. */
  active?: () => boolean;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export function createOutstandingRetry(d: OutstandingRetryDeps): { dispose(): void } {
  const setTimer = d.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = d.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let timer: unknown = null;
  let busy = false;

  const wanted = (): boolean => {
    const s = d.client.store.get();
    return s.status === 'online' && s.hello !== null && !s.reconciling && hasOutstandingFor(d.projects.get().projects, s.hello.cameraId);
  };
  const tick = () => {
    if (busy || !wanted() || d.active?.() === false) return;
    const hello = d.client.store.get().hello!;
    busy = true;
    void Promise.resolve()
      .then(() => d.resolve({ hello, bootId: hello.bootId, bootIdChanged: false, request: d.client.request }))
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  };
  const sync = () => {
    const want = wanted();
    if (want && timer === null) timer = setTimer(tick, d.intervalMs ?? OUTSTANDING_RETRY_MS);
    else if (!want && timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const offs = [d.client.store.subscribe(sync), d.projects.subscribe(sync)];
  sync();
  return {
    dispose() {
      for (const o of offs) o();
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
