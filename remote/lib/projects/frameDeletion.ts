/**
 * Runtime frame expiry (plan "Frame expiry at runtime"), modeled on `ProjectDeletion`.
 *
 *   hide    -> hideFrame (hiddenUntil; NOT ack-eligible) -> timer at the earliest deadline
 *   undo    -> unhideFrame (only while still hidden)
 *   expiry  -> commit expireFrames (tombstone + cut/sticker pruning) -> unlink full/play/thumb
 *              -> `transfer.ackNow`. Never the other way round: nothing is unlinked or acked
 *              inside the window, and the files outlive the commit by only one step.
 * While an export runs, expiry waits for it to end (the export may be loading those files).
 * The startup sweep stays the crash backstop (`runStartupSweep`).
 */
import { projectDir, type FileAdapter } from './files';
import { UNDO_WINDOW_MS } from './model';
import { expireFrames, hideFrame, unhideFrame } from './reducers';
import type { ProjectStore } from './store';

const KINDS = ['full', 'play', 'thumb'] as const;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface FrameDeletionDeps {
  store: Pick<ProjectStore, 'mutate' | 'updateProject' | 'state'>;
  fs: Pick<FileAdapter, 'remove'>;
  transfer: { ackNow(frameIds: string[], projectOf?: Readonly<Record<string, string>>): void | Promise<void> };
  /** App-wide "an export is running" flag. */
  exporting?: { get(): boolean; subscribe(listener: () => void): () => void };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  undoMs?: number;
  onError?: (e: unknown) => void;
}

export class FrameDeletion {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly undoMs: number;
  private timer: unknown = null;
  private failures = 0;
  private disposed = false;
  private readonly unsubscribe: (() => void) | null;

  constructor(private readonly d: FrameDeletionDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.undoMs = d.undoMs ?? UNDO_WINDOW_MS;
    // an export that ends re-arms the timer it held back
    this.unsubscribe = d.exporting ? d.exporting.subscribe(() => { if (!d.exporting!.get()) this.schedule(); }) : null;
    this.schedule(); // a deadline left pending by a previous run fires
  }

  /** Starts the Undo window of a frame. Resolves false when it was unknown or already hidden. */
  async hide(projectId: string, frameId: string): Promise<boolean> {
    const nowMs = this.now();
    const before = this.d.store.state.get().projects[projectId];
    const after = await this.d.store.updateProject(projectId, (p) => hideFrame(p, frameId, nowMs, this.undoMs));
    this.schedule();
    return before !== undefined && before !== after;
  }

  /** Resolves true when the frame was restored. Refused once its deadline has passed. */
  async undo(projectId: string, frameId: string): Promise<boolean> {
    const nowMs = this.now();
    const restored = await this.d.store.mutate((s) => {
      const p = s.projects[projectId];
      const f = p?.frames.find((x) => x.frameId === frameId);
      if (!p || !f || f.hiddenUntil === null || Date.parse(f.hiddenUntil) <= nowMs) return { result: false };
      return { result: true, projects: [unhideFrame(p, frameId)] };
    });
    this.schedule();
    return restored;
  }

  /** Expires every hidden frame whose window has passed; resolves with their ids (empty while an export runs). */
  async expireDue(): Promise<string[]> {
    if (this.d.exporting?.get()) return [];
    const nowMs = this.now();
    const projectOf: Record<string, string> = {};
    const expired = await this.d.store.mutate((s) => {
      // an export may have started since the check above: it loads these files, so nothing commits under it
      if (this.d.exporting?.get()) return { result: [] as string[] };
      const projects = [];
      const ids: string[] = [];
      for (const p of Object.values(s.projects)) {
        const r = expireFrames(p, nowMs);
        if (r.expired.length === 0) continue;
        projects.push(r.project);
        for (const id of r.expired) {
          ids.push(id);
          projectOf[id] = p.id;
        }
      }
      return { result: ids, ...(projects.length > 0 ? { projects } : {}) };
    });
    for (const frameId of expired) {
      for (const kind of KINDS) {
        try {
          await this.d.fs.remove(`${projectDir(projectOf[frameId]!)}/frames/${frameId}.${kind}.jpg`); // the sweep retries at startup
        } catch (e) {
          this.d.onError?.(e);
        }
      }
    }
    if (expired.length > 0) {
      try {
        await this.d.transfer.ackNow(expired, projectOf);
      } catch (e) {
        this.d.onError?.(e);
      }
    }
    this.failures = 0;
    this.schedule();
    return expired;
  }

  /** (Re)arms one timer for the earliest hidden deadline over all projects. */
  schedule(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.d.exporting?.get()) return; // re-armed when the export ends
    let next = Infinity;
    for (const p of Object.values(this.d.store.state.get().projects)) {
      for (const f of p.frames) {
        const at = f.hiddenUntil === null ? NaN : Date.parse(f.hiddenUntil);
        if (Number.isFinite(at)) next = Math.min(next, at); // a corrupt deadline would re-arm a 0 ms timer forever
      }
    }
    if (next === Infinity) return;
    this.arm(Math.max(0, next - this.now()));
  }

  private arm(ms: number): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.expireDue().catch((e) => {
        this.d.onError?.(e);
        // a rejected commit (disk error, read-only store) is retried with a growing pause, not forgotten
        this.failures++;
        if (this.timer === null && !this.disposed) this.arm(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1)));
      });
    }, ms);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.unsubscribe?.();
  }
}
