/**
 * `reconcile()` (ARCHITECTURE §5.6, plan Task 11): runs on EVERY session, after `resolveOutstanding`.
 * It lists the camera's unacked frames of our clientId (all pages) and brings the store in line:
 *
 *  - frame known locally: `local` / tombstoned -> `ackNow` (ack.ts re-checks `ackEligible`);
 *    `pending` -> (re)enqueue;
 *  - unknown frame, project deleted (`deletedProjects`) -> `ackNow` (eligible, never merged);
 *  - unknown frame, live project -> merge only when `project.cameraId` is null or the connected
 *    camera, then enqueue; another camera's project -> a recovered project ("Odzyskany <date>");
 *  - unknown projectId that is not tombstoned -> `recoverProject`, bound to the connected camera;
 *  - a `pending` frame of this camera that vanished from the listing -> `unavailable`
 *    ("lost on the phone"); never acked, shown to the parent through the unavailable count;
 *  - `retryUnavailable()` when a frame the camera lists again is flagged; finally `kick()`.
 *
 * This file never sends `ack` itself; the only path is `transfer.ackNow` (-> ack.ts).
 */
import type { SessionContext } from '../camera/client';
import type { FrameInfo, Project } from '../projects/model';
import { createProject, markUnavailable, mergeFrame, recoverProject, routeResult } from '../projects/reducers';
import type { ProjectStore } from '../projects/store';

export const LOST_REASON = 'lost on the phone';
export const LIST_PAGE_LIMIT = 100;
const MAX_PAGES = 1_000;

/** What reconcile needs from the transfer service (`TransferService` satisfies it). */
export interface ReconcileTransfer {
  enqueue(frameId: string, projectId: string): void | Promise<void>;
  ackNow(frameIds: string[], projectOf?: Readonly<Record<string, string>>): void | Promise<void>;
  kick(): void;
  retryUnavailable(): Promise<number>;
}

export interface ReconcileReport {
  listed: number;
  ack: string[];
  enqueued: string[];
  merged: string[];
  recoveredProjects: string[];
  lost: string[];
  retried: number;
}

export interface ReconcileDeps {
  store: ProjectStore;
  transfer: ReconcileTransfer;
  now?: () => number;
  newId?: () => string;
  /** The date in "Odzyskany <date>". */
  formatDate?: (ms: number) => string;
  pageLimit?: number;
  onReport?: (r: ReconcileReport) => void;
}

const defaultDate = (ms: number): string => new Date(ms).toLocaleDateString('pl-PL');

export type Reconcile = (ctx: SessionContext) => Promise<void>;

export function createReconcile(deps: ReconcileDeps): Reconcile {
  const { store, transfer } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const formatDate = deps.formatDate ?? defaultDate;
  const limit = deps.pageLimit ?? LIST_PAGE_LIMIT;

  async function listAll(ctx: SessionContext, clientId: string): Promise<FrameInfo[]> {
    const out = new Map<string, FrameInfo>();
    let afterSeq = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = (await ctx.request('listFrames', afterSeq > 0 ? { afterSeq, limit } : { limit })) as { frames?: FrameInfo[]; hasMore?: boolean };
      const frames = data?.frames ?? [];
      for (const f of frames) if (f.clientId === clientId) out.set(f.frameId, f);
      const last = frames[frames.length - 1];
      if (!data?.hasMore || !last || last.seq <= afterSeq) break;
      afterSeq = last.seq;
    }
    return [...out.values()].sort((a, b) => a.seq - b.seq);
  }

  return async function reconcile(ctx) {
    try {
      const cameraId = ctx.hello.cameraId;
      const clientId = store.state.get().index.clientId;
      // frames merged AFTER this point (a capture racing the listing) must never count as "vanished"
      const pendingBefore = new Set<string>();
      for (const p of Object.values(store.state.get().projects)) {
        if (p.cameraId === cameraId) for (const f of p.frames) if (f.state === 'pending') pendingBefore.add(f.frameId);
      }

      const listed = await listAll(ctx, clientId); // a failed page throws: nothing below runs on a partial view
      const listedIds = new Set(listed.map((f) => f.frameId));

      // a frame the camera lists again clears an earlier give-up (before the lost check below)
      const s0 = store.state.get();
      const flagged = listed.some((i) =>
        Object.values(s0.projects).some((p) => p.frames.some((f) => f.frameId === i.frameId && f.state === 'pending' && f.unavailable)),
      );
      const retried = flagged ? await transfer.retryUnavailable() : 0;

      const report: ReconcileReport = { listed: listed.length, ack: [], enqueued: [], merged: [], recoveredProjects: [], lost: [], retried };
      const projectOf: Record<string, string> = {};
      const toEnqueue: { frameId: string; projectId: string }[] = [];

      await store.mutate((s) => {
        let index = s.index;
        const changed = new Map<string, Project>();
        const cur = (id: string): Project | undefined => changed.get(id) ?? s.projects[id];
        const put = (p: Project) => void changed.set(p.id, p);
        const known = new Map<string, string>(); // frameId -> projectId (frames and tombstones)
        for (const p of Object.values(s.projects)) {
          for (const f of p.frames) known.set(f.frameId, p.id);
          for (const id of p.deletedFrameIds) known.set(id, p.id);
        }
        const mismatchTo = new Map<string, string>(); // another camera's projectId -> recovered project

        const recoverInto = (info: FrameInfo, intoId: string): void => {
          const created = createProject(index, {
            id: intoId,
            name: `Odzyskany ${formatDate(now())}`,
            nowMs: now(),
            rotation: info.rotation === 180 ? 180 : 0,
          });
          const bound: Project = { ...created.project, cameraId };
          const m = mergeFrame(bound, { ...info, projectId: intoId }, cameraId);
          index = created.index;
          put(m.project);
          report.recoveredProjects.push(intoId);
          report.merged.push(info.frameId);
          known.set(info.frameId, intoId);
          toEnqueue.push({ frameId: info.frameId, projectId: intoId });
        };

        for (const info of listed) {
          const have = known.get(info.frameId);
          if (have !== undefined) {
            const entry = cur(have)?.frames.find((f) => f.frameId === info.frameId);
            if (entry?.state === 'pending') toEnqueue.push({ frameId: info.frameId, projectId: have });
            else {
              report.ack.push(info.frameId); // local or tombstoned; ack.ts decides
              projectOf[info.frameId] = have;
            }
            continue;
          }
          const route = routeResult(index, info.projectId);
          if (route === 'deleted_project') {
            report.ack.push(info.frameId);
            projectOf[info.frameId] = info.projectId;
          } else if (route === 'unknown_project') {
            const r = recoverProject(index, info, { cameraId, nowMs: now(), formatDate });
            if (!r.ok) continue; // never guess: not acked, not merged
            index = r.index;
            put(r.project);
            report.recoveredProjects.push(info.projectId);
            report.merged.push(info.frameId);
            known.set(info.frameId, info.projectId);
            toEnqueue.push({ frameId: info.frameId, projectId: info.projectId });
          } else {
            const into = mismatchTo.get(info.projectId);
            let p = cur(into ?? info.projectId);
            if (!p) continue;
            if (into === undefined && p.cameraId === null) p = { ...p, cameraId };
            if (p.cameraId === cameraId) {
              const m = mergeFrame(p, { ...info, projectId: p.id }, cameraId);
              if (m.status === 'inserted') {
                put(m.project);
                report.merged.push(info.frameId);
                known.set(info.frameId, p.id);
                toEnqueue.push({ frameId: info.frameId, projectId: p.id });
              }
            } else if (info.rotation === 0 || info.rotation === 180) {
              const id = newId();
              mismatchTo.set(info.projectId, id);
              recoverInto(info, id);
            }
          }
        }

        // pending frames of this camera that the camera no longer lists
        for (const id of Object.keys(s.projects)) {
          const before = cur(id)!;
          if (before.cameraId !== cameraId) continue;
          let p = before;
          for (const f of before.frames) {
            if (f.state === 'pending' && !f.unavailable && pendingBefore.has(f.frameId) && !listedIds.has(f.frameId)) {
              p = markUnavailable(p, f.frameId, LOST_REASON, now());
              report.lost.push(f.frameId);
            }
          }
          if (p !== before) put(p);
        }
        return { result: undefined, index, projects: [...changed.values()] };
      });

      // ascending seq: `enqueue` puts the latest call at the front, so the newest frame downloads first
      for (const j of toEnqueue) {
        report.enqueued.push(j.frameId);
        void Promise.resolve(transfer.enqueue(j.frameId, j.projectId)).catch(() => {});
      }
      if (report.ack.length > 0) void Promise.resolve(transfer.ackNow(report.ack, projectOf)).catch(() => {});
      deps.onReport?.(report);
    } finally {
      transfer.kick(); // every session, even when the listing failed
    }
  };
}
