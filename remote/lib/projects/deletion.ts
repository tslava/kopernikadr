/**
 * Project deletion with Undo (ARCHITECTURE §5.8). Timer/expiry orchestration, everything injected.
 *
 *   delete  -> hideProject (pendingProjectDeletes; NOT ack-eligible) -> timer(UNDO_WINDOW_MS)
 *   undo    -> unhideProject (only while still pending)
 *   expiry  -> commit expireProjects (tombstone) -> remove the directory -> ack pass for the
 *              project's frame ids (`transfer.ackNow`; frames the camera still lists are acked by
 *              reconcile). Never the other way round: nothing is acked or removed inside the window.
 * Expiry at startup is the sweep's job (`runStartupSweep`).
 */
import { projectDir, type FileAdapter } from './files';
import { UNDO_WINDOW_MS } from './model';
import { expireProjects, hideProject, unhideProject } from './reducers';
import type { ProjectStore } from './store';

export interface DeletionDeps {
  store: Pick<ProjectStore, 'mutate' | 'state'>;
  fs: Pick<FileAdapter, 'remove'>;
  transfer: { ackNow(frameIds: string[], projectOf?: Readonly<Record<string, string>>): void | Promise<void> };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  undoMs?: number;
  onError?: (e: unknown) => void;
}

export class ProjectDeletion {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly undoMs: number;
  private timer: unknown = null;

  constructor(private readonly d: DeletionDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.undoMs = d.undoMs ?? UNDO_WINDOW_MS;
  }

  /** Starts the Undo window. Resolves false when there is nothing to delete (unknown / already pending). */
  async requestDelete(projectId: string): Promise<boolean> {
    const nowMs = this.now();
    const started = await this.d.store.mutate((s) => {
      const index = hideProject(s.index, projectId, nowMs, this.undoMs);
      return { result: index !== s.index, index };
    });
    if (started) this.schedule();
    return started;
  }

  /** Resolves true when the project was restored (false: it was not pending, e.g. already expired). */
  async undo(projectId: string): Promise<boolean> {
    const restored = await this.d.store.mutate((s) => {
      const index = unhideProject(s.index, projectId);
      return { result: index !== s.index, index };
    });
    this.schedule();
    return restored;
  }

  /** Expires every project whose window has passed; resolves with their ids. */
  async expireDue(): Promise<string[]> {
    const nowMs = this.now();
    const { expired, frameIds } = await this.d.store.mutate((s) => {
      const r = expireProjects(s.index, nowMs);
      const frames = new Map<string, string[]>();
      for (const id of r.expired) frames.set(id, (s.projects[id]?.frames ?? []).map((f) => f.frameId));
      return {
        result: { expired: r.expired, frameIds: frames },
        ...(r.expired.length > 0 ? { index: r.index, dropProjects: r.expired } : {}),
      };
    });
    for (const id of expired) {
      try {
        await this.d.fs.remove(projectDir(id), { recursive: true }); // the sweep retries at startup
      } catch (e) {
        this.d.onError?.(e);
      }
      const ids = frameIds.get(id) ?? [];
      if (ids.length > 0) {
        try {
          // The project has left the store, so Transfer needs the frame → project map to see the
          // tombstone (`deletedProjects`) when it re-checks eligibility.
          await this.d.transfer.ackNow(ids, Object.fromEntries(ids.map((f) => [f, id])));
        } catch (e) {
          this.d.onError?.(e);
        }
      }
    }
    this.schedule();
    return expired;
  }

  /** (Re)arms one timer for the earliest pending deadline. */
  schedule(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const pending = this.d.store.state.get().index.pendingProjectDeletes;
    if (pending.length === 0) return;
    const next = Math.min(...pending.map((p) => Date.parse(p.deadline)));
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.expireDue().catch((e) => this.d.onError?.(e));
    }, Math.max(0, next - this.now()));
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
