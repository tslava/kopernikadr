/**
 * Transfer A (ARCHITECTURE §5.6): a one-at-a-time download queue of ids (newest first).
 *
 *   full -> tmp/ (deadline + abort) -> installFile (native size+sha256, no JS hash) -> commit
 *   `state: local` (re-checks tombstones inside the mutation) -> THEN the ack pass (ack.ts)
 *   -> best-effort play/thumb caches (never blocking: after every pending `full`).
 *
 * `ack` is sent only by `createAcker` and only for `ackEligible` frames; this file never calls it.
 * A frame that cannot be downloaded (3 retries) is marked `unavailable` and never acked;
 * `retryUnavailable()` (reconcile) clears the flag and requeues.
 *
 * Time is injected (`Clock`): backoff and storage re-checks are timers, not sleeps in a loop.
 */
import { createStore, type Store } from '../state/store';
import { clearUnavailable, markUnavailable, setLocal as setLocalReducer } from '../projects/reducers';
import type { FrameEntry, Project } from '../projects/model';
import { projectDir } from '../projects/files';
import type { ProjectStore } from '../projects/store';
import { createAcker, realClock, type Acker, type Clock } from './ack';
import {
  CACHE_SLACK_BYTES,
  CACHE_TIMEOUT_MS,
  FULL_TIMEOUT_MS,
  RESERVE_BYTES,
  classify,
  describeFailure,
  downloadWithDeadline,
  frameUrl,
  type Failure,
  type TransferIO,
  type Variant,
} from './download';
import type { Transfer } from './types';

export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = [1_000, 4_000, 10_000] as const;
export const CACHE_MAX_RETRIES = 2;
export const STORAGE_RECHECK_MS = 30_000;
const DEFAULT_503_MS = 1_000;

export type PausedReason = 'export' | 'storage_full';

export interface TransferStatus {
  /** Jobs waiting (full + caches), not counting the current one. */
  queued: number;
  current: { frameId: string; projectId: string; variant: Variant } | null;
  paused: PausedReason | null;
  /** Frames (live projects) the download gave up on. */
  unavailable: number;
  /** Frames waiting for an ack. */
  ackPending: number;
}

export interface TransferDeps {
  store: ProjectStore;
  io: TransferIO;
  /** `client.request` (rejects while offline). */
  request: (op: string, args: object, opts?: { timeoutMs?: number }) => Promise<any>;
  /** The connected camera's address, or null while offline. */
  target: () => { host: string; port: number } | null;
  /** The connected camera's id (read lazily), or null while offline. Only frames of that camera are downloaded/acked. */
  cameraId: () => string | null;
  clock?: Clock;
  fullTimeoutMs?: number;
}

export interface TransferService extends Transfer {
  readonly status: Store<TransferStatus>;
  enqueue(frameId: string, projectId: string): void;
  ackNow(frameIds: string[], projectOf?: Readonly<Record<string, string>>): Promise<void>;
  /** Stop starting new jobs; resolves when the current one has finished (export: one bulk writer). Acks still run. */
  pause(): Promise<void>;
  resume(): void;
  /** A new session (or any reason to retry now): restart offline/backoff waits and failed acks. */
  kick(): void;
  /** reconcile: clear `unavailable` on pending frames and requeue them. Resolves with how many. */
  retryUnavailable(): Promise<number>;
  /** The project is going away: drop its jobs and abort/clean the current download. Also done automatically when it leaves the store. */
  dropProject(projectId: string): void;
  /** Resolves when the queue is drained or blocked and no ack pass runs (tests). */
  idle(): Promise<void>;
  stop(): void;
}

interface Job {
  variant: Variant;
  frameId: string;
  projectId: string;
  retries: number;
  notBefore: number;
}

const dir = (pid: string) => `${projectDir(pid)}/frames`;
const destOf = (pid: string, id: string, v: Variant) => `${dir(pid)}/${id}.${v}.jpg`;

export function createTransfer(deps: TransferDeps): TransferService {
  const { store, io } = deps;
  const clock = deps.clock ?? realClock;
  const acker: Acker = createAcker({ store, request: deps.request, cameraId: deps.cameraId, clock, onChange: () => refresh() });

  const fulls: Job[] = [];
  const caches: Job[] = [];
  let current: { job: Job; ctl: AbortController } | null = null;
  let exportPaused = false;
  let storageFull = false;
  let pumping = false;
  let rerun = false;
  let wakeCancel: (() => void) | null = null;
  let tmpN = 0;
  const waiters: (() => void)[] = [];

  const status = createStore<TransferStatus>({ queued: 0, current: null, paused: null, unavailable: 0, ackPending: 0 });

  function refresh(): void {
    let unavailable = 0;
    for (const p of Object.values(store.state.get().projects)) for (const f of p.frames) if (f.unavailable) unavailable++;
    const next: TransferStatus = {
      queued: fulls.length + caches.length - (current && (fulls.includes(current.job) || caches.includes(current.job)) ? 1 : 0),
      current: current ? { frameId: current.job.frameId, projectId: current.job.projectId, variant: current.job.variant } : null,
      paused: exportPaused ? 'export' : storageFull ? 'storage_full' : null,
      unavailable,
      ackPending: acker.pending,
    };
    const c = status.get();
    if (c.queued !== next.queued || c.paused !== next.paused || c.unavailable !== next.unavailable || c.ackPending !== next.ackPending || c.current?.frameId !== next.current?.frameId || c.current?.variant !== next.current?.variant) {
      status.set(next);
    }
  }

  // --- lookup -----------------------------------------------------------------------------

  function liveFrame(job: Job): { project: Project; frame: FrameEntry } | null {
    const project = store.state.get().projects[job.projectId];
    if (!project || project.deletedFrameIds.includes(job.frameId)) return null;
    const frame = project.frames.find((f) => f.frameId === job.frameId);
    return frame ? { project, frame } : null;
  }

  // --- scheduling -------------------------------------------------------------------------

  function wakeAt(ms: number): void {
    wakeCancel?.();
    wakeCancel = clock.schedule(Math.max(0, ms), () => {
      wakeCancel = null;
      void pump();
    });
  }

  /** A job is workable now only for the connected camera's project (others wait, queued, until that camera is back). */
  function forConnected(job: Job): boolean {
    const p = store.state.get().projects[job.projectId];
    if (!p) return true; // gone: the job handler drops it
    const c = deps.cameraId();
    return c !== null && p.cameraId === c;
  }

  function pickReady(): Job | null {
    const t = clock.now();
    const f = fulls.filter(forConnected);
    return f.find((j) => j.notBefore <= t) ?? (f.length === 0 ? (caches.filter(forConnected).find((j) => j.notBefore <= t) ?? null) : null);
  }

  /** Earliest `notBefore` among waiting jobs of the connected camera (so a timer can restart the loop). */
  function nextDue(): number | null {
    const f = fulls.filter(forConnected);
    const list = f.length > 0 ? f : caches.filter(forConnected);
    return list.length === 0 ? null : Math.min(...list.map((j) => j.notBefore));
  }

  function pump(): Promise<void> {
    if (pumping) {
      rerun = true;
      return Promise.resolve();
    }
    pumping = true;
    return (async () => {
      try {
        do {
          rerun = false;
          await drain();
        } while (rerun);
      } finally {
        pumping = false;
        current = null;
        refresh();
        for (const w of waiters.splice(0)) w();
      }
    })();
  }

  async function drain(): Promise<void> {
    for (;;) {
      if (exportPaused) return;
      if (storageFull) return; // the recheck timer clears it
      if (!deps.target()) return; // offline: `kick()` on the next session
      const job = pickReady();
      if (!job) {
        const due = nextDue();
        if (due !== null) wakeAt(due - clock.now());
        return;
      }
      current = { job, ctl: new AbortController() };
      refresh();
      try {
        if (job.variant === 'full') await runFull(job, current.ctl);
        else await runCache(job, current.ctl);
      } catch {
        /* every path inside handles its own errors; never let one job stop the queue */
      } finally {
        current = null;
        refresh();
      }
    }
  }

  const remove = (job: Job) => {
    for (const list of [fulls, caches]) {
      const i = list.indexOf(job);
      if (i >= 0) list.splice(i, 1);
    }
  };

  function setStorageFull(): void {
    storageFull = true;
    refresh();
    wakeCancel?.();
    wakeCancel = clock.schedule(STORAGE_RECHECK_MS, () => {
      wakeCancel = null;
      storageFull = false;
      refresh();
      void pump();
    });
  }

  /** Counts a failure of a job; gives up after the retry budget. */
  async function fail(job: Job, f: Failure, max: number): Promise<void> {
    if (f.kind === 'no_space') return setStorageFull();
    if (f.kind === 'cancelled') return remove(job);
    // offline (Wi-Fi drop): the attempt does not count, `kick()` resumes
    if ((f.kind === 'network' || f.kind === 'http') && !deps.target()) return;
    job.retries++;
    if (job.retries > max) {
      remove(job);
      if (job.variant === 'full') {
        try {
          await store.mutate((s) => {
            const p = s.projects[job.projectId];
            if (!p) return { result: undefined };
            return { result: undefined, projects: [markUnavailable(p, job.frameId, describeFailure(f), clock.now())] };
          });
        } catch {
          /* the frame stays pending; reconcile requeues it */
        }
      }
      return;
    }
    const base = RETRY_BACKOFF_MS[Math.min(job.retries - 1, RETRY_BACKOFF_MS.length - 1)]!;
    job.notBefore = clock.now() + (f.kind === 'http' && f.status === 503 ? (f.retryAfterMs ?? DEFAULT_503_MS) : base);
  }

  // --- full -------------------------------------------------------------------------------

  async function runFull(job: Job, ctl: AbortController): Promise<void> {
    const live = liveFrame(job);
    if (!live || live.frame.unavailable) {
      remove(job);
      if (!live) void acker.want([{ frameId: job.frameId, projectId: job.projectId }]); // tombstoned / project gone: eligible, maybe
      return;
    }
    if (live.frame.state === 'local') {
      remove(job);
      return; // installed meanwhile (sweep); the ack pass sees the transition
    }
    const { frame } = live;

    // admission
    let free: number;
    try {
      free = await io.freeBytes();
    } catch (e) {
      return fail(job, classify(e), MAX_RETRIES);
    }
    if (free < RESERVE_BYTES + frame.bytes + CACHE_SLACK_BYTES) return setStorageFull();

    const target = deps.target();
    if (!target) return;
    const tmp = `tmp/${job.frameId}.full.${++tmpN}.jpg`;
    const dest = destOf(job.projectId, job.frameId, 'full');
    try {
      await io.mkdir('tmp');
      await io.mkdir(dir(job.projectId));
      await downloadWithDeadline(io, frameUrl(target, job.frameId, 'full'), tmp, { cancel: ctl.signal, timeoutMs: deps.fullTimeoutMs ?? FULL_TIMEOUT_MS });
      if (ctl.signal.aborted || !liveFrame(job)) {
        await io.remove(tmp).catch(() => {});
        remove(job);
        void acker.want([{ frameId: job.frameId, projectId: job.projectId }]);
        return;
      }
      await io.installFile({ tmp, dest, bytes: frame.bytes, sha256: frame.sha256 });
    } catch (e) {
      await io.remove(tmp).catch(() => {});
      return fail(job, classify(e), MAX_RETRIES);
    }

    // the install mutation: tombstones are re-checked INSIDE it; only then `local`
    let r: 'installed' | 'gone' | 'gone_delete';
    try {
      r = await store.mutate((s) => {
        const p = s.projects[job.projectId];
        const tombstoned = !!p && p.deletedFrameIds.includes(job.frameId);
        if (!p || tombstoned || !p.frames.some((f) => f.frameId === job.frameId)) {
          // the verified file is deleted only when it is garbage for sure (never "unknown frame": may be the only copy)
          const garbage = tombstoned || s.index.deletedProjects.includes(job.projectId);
          return { result: garbage ? ('gone_delete' as const) : ('gone' as const) };
        }
        return { result: 'installed' as const, projects: [setLocalReducer(p, job.frameId)] };
      });
    } catch (e) {
      // not committed: the verified file stays (the startup sweep promotes it); try again later
      return fail(job, classify(e), MAX_RETRIES);
    }
    remove(job);
    if (r === 'installed') {
      void acker.want([{ frameId: job.frameId, projectId: job.projectId }]); // strictly after the commit
      for (const variant of ['play', 'thumb'] as const) caches.push({ variant, frameId: job.frameId, projectId: job.projectId, retries: 0, notBefore: 0 });
    } else {
      if (r === 'gone_delete') await io.remove(dest).catch(() => {});
      void acker.want([{ frameId: job.frameId, projectId: job.projectId }]);
    }
  }

  // --- play / thumb (best effort) -----------------------------------------------------------

  async function runCache(job: Job, ctl: AbortController): Promise<void> {
    const live = liveFrame(job);
    const target = deps.target();
    if (!live || live.frame.state !== 'local') return void remove(job);
    if (!target) return; // offline: stays queued
    try {
      if ((await io.freeBytes()) < RESERVE_BYTES + CACHE_SLACK_BYTES) return void remove(job); // caches never pause anything
    } catch {
      return void remove(job);
    }
    const tmp = `tmp/${job.frameId}.${job.variant}.${++tmpN}.jpg`;
    try {
      await io.mkdir('tmp');
      await downloadWithDeadline(io, frameUrl(target, job.frameId, job.variant), tmp, { cancel: ctl.signal, timeoutMs: CACHE_TIMEOUT_MS });
      if (!(await io.validateJpeg(tmp))) throw new Error('cache is not an image');
      if (!liveFrame(job)) {
        await io.remove(tmp).catch(() => {});
        return void remove(job);
      }
      await io.moveCache(tmp, destOf(job.projectId, job.frameId, job.variant));
      remove(job);
    } catch (e) {
      await io.remove(tmp).catch(() => {});
      const f = classify(e);
      // 404: the camera has no such file (reclaimed): skip. 503: retry later, then skip.
      if (f.kind === 'http' && f.status === 404) return void remove(job);
      await fail(job, f, CACHE_MAX_RETRIES);
    }
  }

  // --- public API -------------------------------------------------------------------------

  function enqueue(frameId: string, projectId: string): void {
    if (current && current.job.variant === 'full' && current.job.frameId === frameId) return;
    if (fulls.some((j) => j.frameId === frameId)) return;
    fulls.unshift({ variant: 'full', frameId, projectId, retries: 0, notBefore: 0 }); // newest first
    refresh();
    void pump();
  }

  function dropProject(projectId: string): void {
    for (const list of [fulls, caches]) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.projectId === projectId) list.splice(i, 1);
    }
    if (current?.job.projectId === projectId) current.ctl.abort(); // its tmp is deleted when the call settles
    refresh();
  }

  const unsub = store.state.subscribe(() => {
    const projects = store.state.get().projects;
    const gone = new Set<string>();
    for (const j of [...fulls, ...caches, ...(current ? [current.job] : [])]) if (!projects[j.projectId]) gone.add(j.projectId);
    // a project not in the store yet (before load) has no jobs; only act on ids that actually leave
    for (const id of gone) dropProject(id);
    refresh();
  });

  return {
    status,
    enqueue,
    ackNow: (ids, projectOf) => acker.ackNow(ids, projectOf),
    pause() {
      exportPaused = true;
      refresh();
      return pumping ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve();
    },
    resume() {
      exportPaused = false;
      refresh();
      void pump();
    },
    kick() {
      wakeCancel?.();
      wakeCancel = null;
      storageFull = false;
      for (const j of [...fulls, ...caches]) j.notBefore = 0;
      acker.kick();
      refresh();
      void pump();
    },
    async retryUnavailable() {
      const cleared = await store.mutate((s) => {
        const out: { frameId: string; projectId: string; seq: number }[] = [];
        const projects: Project[] = [];
        for (const p of Object.values(s.projects)) {
          let x = p;
          for (const f of p.frames) {
            if (f.unavailable && f.state === 'pending') {
              x = clearUnavailable(x, f.frameId);
              out.push({ frameId: f.frameId, projectId: p.id, seq: f.seq });
            }
          }
          if (x !== p) projects.push(x);
        }
        return { result: out, projects };
      });
      cleared.sort((a, b) => b.seq - a.seq); // newest first
      const fresh = cleared.filter((c) => !fulls.some((j) => j.frameId === c.frameId) && current?.job.frameId !== c.frameId);
      fulls.unshift(...fresh.map((c) => ({ variant: 'full' as const, frameId: c.frameId, projectId: c.projectId, retries: 0, notBefore: 0 })));
      refresh();
      void pump();
      return cleared.length;
    },
    dropProject,
    async idle() {
      for (;;) {
        await acker.idle();
        if (!pumping) return;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    stop() {
      unsub();
      acker.stop();
      wakeCancel?.();
      wakeCancel = null;
      current?.ctl.abort();
    },
  };
}
