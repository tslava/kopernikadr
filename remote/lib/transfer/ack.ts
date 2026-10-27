/**
 * The ack pass (ARCHITECTURE §5.6, PLAN "Ack eligibility"). The ONLY code that sends `ack`.
 *
 * Invariants:
 *  - every id is re-checked with `ackEligible` against the CURRENT store state in the same
 *    synchronous step that builds the request (nothing is awaited in between);
 *  - an id that is not eligible is never sent. In `pendingProjectDeletes` it is kept until the
 *    Undo window ends (restore -> eligible again, expiry -> `deletedProjects` -> eligible);
 *    otherwise it is forgotten (a later commit that makes it eligible re-adds it);
 *  - a failed `ack` keeps the id and retries later (backoff, or `kick()` on a new session).
 *    The want-set is in memory: after a restart `reconcile()` (Task 11) re-derives it from `listFrames`.
 *
 * Commits that make frames eligible are noticed from store state changes (no caller needed):
 * a frame going `pending` -> `local` (install, startup sweep), a new tombstone in `deletedFrameIds`,
 * a project landing in `deletedProjects` (all of its frames are wanted). Each triggers a pass.
 */
import { ackEligible } from '../projects/eligibility';
import type { ProjectsState, ProjectStore } from '../projects/store';

export const ACK_CHUNK = 200;
export const ACK_RETRY_MS = [1_000, 5_000, 15_000, 30_000] as const;
const ACK_TIMEOUT_MS = 10_000;

export interface Clock {
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface AckRef {
  frameId: string;
  projectId: string;
}

export interface AckerDeps {
  store: ProjectStore;
  /** `client.request`; rejects while offline. */
  request: (op: string, args: object, opts?: { timeoutMs?: number }) => Promise<any>;
  clock?: Clock;
  /** Called after the want-set changes (status UI). */
  onChange?: () => void;
}

export interface Acker {
  /** Remember that these should be acked as soon as they are eligible, and run a pass. */
  want(refs: AckRef[]): Promise<void>;
  /** Ids only: the project is found in the store (or via `projectOf`). Unresolvable ids are skipped (reconcile covers them). */
  ackNow(frameIds: string[], projectOf?: Readonly<Record<string, string>>): Promise<void>;
  /** A new session / the network is back: retry now. */
  kick(): void;
  readonly pending: number;
  /** Resolves when no pass is running (tests). */
  idle(): Promise<void>;
  stop(): void;
}

function eligible(s: ProjectsState, frameId: string, projectId: string): boolean {
  return ackEligible({ frameId, projectId }, s.projects[projectId], s.index);
}

export function createAcker(deps: AckerDeps): Acker {
  const { store } = deps;
  const clock = deps.clock ?? realClock;
  const wants = new Map<string, string>(); // frameId -> projectId
  const inflight = new Set<string>(); // in a request right now
  const acked = new Set<string>(); // acked this session (idempotent on the camera, but no need to repeat)
  let passing: Promise<void> | null = null;
  let again = false;
  let retryCancel: (() => void) | null = null;
  let attempt = 0;
  let scheduled = false;
  let prev = store.state.get();

  const changed = () => deps.onChange?.();

  function add(refs: AckRef[]): void {
    for (const r of refs) if (!acked.has(r.frameId) && !inflight.has(r.frameId)) wants.set(r.frameId, r.projectId);
    changed();
  }

  function pass(): Promise<void> {
    if (passing) {
      again = true;
      return passing;
    }
    passing = (async () => {
      do {
        again = false;
        await passOnce();
      } while (again);
    })().finally(() => {
      passing = null;
    });
    return passing;
  }

  async function passOnce(): Promise<void> {
    const ids = [...wants.keys()];
    let failed = false;
    for (let i = 0; i < ids.length; i += ACK_CHUNK) {
      const s = store.state.get(); // fresh for every chunk; used synchronously below
      const send: string[] = [];
      for (const id of ids.slice(i, i + ACK_CHUNK)) {
        const pid = wants.get(id);
        if (pid === undefined) continue;
        if (eligible(s, id, pid)) send.push(id);
        else if (!s.index.pendingProjectDeletes.some((p) => p.id === pid)) wants.delete(id);
      }
      if (send.length === 0) continue;
      for (const id of send) inflight.add(id);
      try {
        await deps.request('ack', { frameIds: send }, { timeoutMs: ACK_TIMEOUT_MS });
        // `unknown` ids are ones the camera does not have (reclaimed): nothing left to ack either
        for (const id of send) {
          wants.delete(id);
          acked.add(id);
        }
      } catch {
        failed = true;
      } finally {
        for (const id of send) inflight.delete(id);
      }
    }
    changed();
    if (failed) scheduleRetry();
    else attempt = 0;
  }

  function scheduleRetry(): void {
    if (retryCancel || wants.size === 0) return;
    const delay = ACK_RETRY_MS[Math.min(attempt++, ACK_RETRY_MS.length - 1)]!;
    retryCancel = clock.schedule(delay, () => {
      retryCancel = null;
      void pass();
    });
  }

  function lookup(s: ProjectsState, frameId: string): string | undefined {
    for (const p of Object.values(s.projects)) {
      if (p.deletedFrameIds.includes(frameId) || p.frames.some((f) => f.frameId === frameId)) return p.id;
    }
    return undefined;
  }

  /** What newly became ack-eligible between two states -> wanted (eligibility itself is checked at send time). */
  function onState(): void {
    const next = store.state.get();
    const before = prev;
    prev = next;
    if (next === before) return;
    const found: AckRef[] = [];
    for (const [pid, bp] of Object.entries(before.projects)) {
      const np = next.projects[pid];
      if (!np) {
        if (next.index.deletedProjects.includes(pid)) {
          for (const f of bp.frames) found.push({ frameId: f.frameId, projectId: pid });
          for (const id of bp.deletedFrameIds) found.push({ frameId: id, projectId: pid });
        }
        continue;
      }
      if (np === bp) continue;
      const was = new Map(bp.frames.map((f) => [f.frameId, f.state]));
      for (const f of np.frames) if (f.state === 'local' && was.get(f.frameId) === 'pending') found.push({ frameId: f.frameId, projectId: pid });
      if (np.deletedFrameIds !== bp.deletedFrameIds) {
        for (const id of np.deletedFrameIds) if (!bp.deletedFrameIds.includes(id)) found.push({ frameId: id, projectId: pid });
      }
    }
    if (found.length > 0) add(found);
    const indexMoved = next.index.pendingProjectDeletes !== before.index.pendingProjectDeletes || next.index.deletedProjects !== before.index.deletedProjects;
    if ((found.length > 0 || indexMoved) && wants.size > 0 && !scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void pass();
      });
    }
  }

  const unsub = store.state.subscribe(onState);

  return {
    async want(refs) {
      add(refs);
      await pass();
    },
    async ackNow(frameIds, projectOf = {}) {
      const s = store.state.get();
      const refs: AckRef[] = [];
      for (const id of frameIds) {
        const pid = projectOf[id] ?? lookup(s, id);
        if (pid !== undefined) refs.push({ frameId: id, projectId: pid });
      }
      add(refs);
      await pass();
    },
    kick() {
      retryCancel?.();
      retryCancel = null;
      attempt = 0;
      if (wants.size > 0) void pass();
    },
    get pending() {
      return wants.size;
    },
    async idle() {
      while (passing) await passing;
    },
    stop() {
      unsub();
      retryCancel?.();
      retryCancel = null;
    },
  };
}
