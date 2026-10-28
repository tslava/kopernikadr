/**
 * The sticker tools (plan "Sticker UI"): add, delete, range, and the drag/handle gestures. Every
 * change runs one reducer from `lib/projects/stickers.ts` through `store.updateProject` and is
 * recorded in the SAME Cofnij history as the frame edits. A gesture only tracks a live pose while
 * the finger moves; the store is touched once, on commit, so one gesture is one history entry and a
 * cancelled gesture leaves nothing behind. Everything does nothing while an export runs.
 */
import type { EditHistory } from '../projects/history';
import { isCustomSticker, type Project, type Sticker } from '../projects/model';
import type { ProjectStore } from '../projects/store';
import { timeline } from '../projects/timeline';
import { addSticker, clampPose, removeSticker, setRange, updateSticker, type Pose } from '../projects/stickers';
import { dragHandle, hitTopSticker, type Pt } from '../render/stickerGeometry';

export type GestureKind = 'move' | 'handle';

/** The stickers shown on one timeline entry, in drawing order. */
export function stickersOn(project: { stickers?: readonly Sticker[] }, entryId: string | null): Sticker[] {
  return entryId === null ? [] : (project.stickers ?? []).filter((s) => s.on.includes(entryId));
}

/** The topmost sticker on `entryId` under a point (px of a `w` x `h` stage), or null. */
export function pickSticker(project: Pick<Project, 'stickers'>, entryId: string | null, p: Pt, w: number, h: number): Sticker | null {
  return hitTopSticker(stickersOn(project, entryId), p, w, h);
}

/** The selection survives edits by id and clears when its sticker is gone. */
export function reconcileSticker(selected: string | null, project: Pick<Project, 'stickers'> | null): string | null {
  return selected !== null && project?.stickers?.some((s) => s.id === selected) ? selected : null;
}

/** The stickers with a live pose laid over one of them (what the stage draws while a finger is down). */
export function withLivePose(stickers: Sticker[], live: { id: string; pose: Pose } | null): Sticker[] {
  return live ? stickers.map((s) => (s.id === live.id ? { ...s, ...live.pose } : s)) : stickers;
}

export interface StickerControllerDeps {
  store: Pick<ProjectStore, 'updateProject'>;
  exporting: { get(): boolean };
  /** Shared with the EditController: Cofnij undoes sticker edits too. */
  history: EditHistory;
  /**
   * Copies library sticker `id` (the uuid, no `my:`) into movie `projectId` (`projects/{pid}/stickers/<uuid>.png`).
   * Idempotent. Without it a custom sticker cannot be placed.
   */
  copySticker?: (id: string, projectId: string) => Promise<void>;
  newId?: () => string;
}

/** A custom sticker's PNG could not be copied into the movie: nothing was placed. */
export class StickerCopyError extends Error {
  constructor(readonly emoji: string, cause?: unknown) {
    super(`could not copy sticker ${emoji} into the movie`, { cause });
    this.name = 'StickerCopyError';
  }
}

export class StickerController {
  private readonly newId: () => string;

  constructor(private readonly d: StickerControllerDeps) {
    this.newId = d.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Adds `emoji` on `entryId` and every entry after it; resolves the new sticker's id (null: nothing added).
   * A custom sticker (`my:<uuid>`) is first copied into the movie, so deleting it from the library never
   * breaks the movie; if that copy fails nothing is placed and `StickerCopyError` is thrown.
   */
  async add(projectId: string, entryId: string, emoji: string): Promise<string | null> {
    if (this.d.exporting.get()) return null;
    if (isCustomSticker(emoji)) {
      try {
        if (!this.d.copySticker) throw new Error('no copySticker');
        await this.d.copySticker(emoji.slice(3), projectId); // outside the store mutation, before the write
      } catch (e) {
        throw new StickerCopyError(emoji, e);
      }
    }
    const id = this.newId();
    return (await this.edit(projectId, (p) => addSticker(p, entryId, emoji, id))) ? id : null;
  }

  remove(projectId: string, stickerId: string): Promise<boolean> {
    return this.edit(projectId, (p) => removeSticker(p, stickerId));
  }

  /** "Od tego kadru": the sticker starts at `entryId` and keeps its last entry (at least `entryId` itself). */
  rangeFrom(projectId: string, stickerId: string, entryId: string): Promise<boolean> {
    return this.edit(projectId, (p) => {
      const ends = this.ends(p, stickerId);
      if (!ends) return p;
      const cut = timeline(p);
      const at = cut.findIndex((e) => e.id === entryId);
      return at < 0 ? p : setRange(p, stickerId, entryId, cut[Math.max(at, ends.last)]!.id);
    });
  }

  /** "Do tego kadru": the sticker keeps its first entry and ends at `entryId` (at most `entryId` itself). */
  rangeTo(projectId: string, stickerId: string, entryId: string): Promise<boolean> {
    return this.edit(projectId, (p) => {
      const ends = this.ends(p, stickerId);
      if (!ends) return p;
      const cut = timeline(p);
      const at = cut.findIndex((e) => e.id === entryId);
      return at < 0 ? p : setRange(p, stickerId, cut[Math.min(at, ends.first)]!.id, entryId);
    });
  }

  /** Starts a drag of the sticker body (`move`) or its corner handle (`handle`) at `p`. */
  begin(sticker: Sticker, kind: GestureKind, p: Pt, w: number, h: number): StickerGesture {
    return new StickerGesture(this, sticker, kind, p, w, h);
  }

  /** @internal Called by a gesture's commit. */
  commitPose(projectId: string, stickerId: string, pose: Pose): Promise<boolean> {
    return this.edit(projectId, (p) => updateSticker(p, stickerId, pose));
  }

  /** Timeline indices of the sticker's first and last entry. */
  private ends(p: Project, stickerId: string): { first: number; last: number } | null {
    const st = p.stickers?.find((s) => s.id === stickerId);
    if (!st) return null;
    const cut = timeline(p);
    const idx = st.on.map((id) => cut.findIndex((e) => e.id === id)).filter((i) => i >= 0);
    return idx.length === 0 ? null : { first: Math.min(...idx), last: Math.max(...idx) };
  }

  private async edit(projectId: string, fn: (p: Project) => Project): Promise<boolean> {
    if (this.d.exporting.get()) return false;
    const box: { change?: { before: Project; after: Project } } = {};
    await this.d.store.updateProject(projectId, (p) => {
      const next = fn(p);
      if (next === p) return p;
      box.change = { before: p, after: next };
      return next;
    });
    if (!box.change) return false;
    this.d.history.record(projectId, box.change.before, box.change.after); // only once the write is committed
    return true;
  }
}

/** One finger-down to finger-up drag. `update` is pure view state; `commit` is the only store write. */
export class StickerGesture {
  private cur: Pose;
  private done = false;

  constructor(
    private readonly c: StickerController,
    private readonly sticker: Sticker,
    private readonly kind: GestureKind,
    private readonly start: Pt,
    private readonly w: number,
    private readonly h: number,
  ) {
    this.cur = { x: sticker.x, y: sticker.y, size: sticker.size, rot: sticker.rot };
  }

  get id(): string {
    return this.sticker.id;
  }

  /** The live pose after the finger moved to `p` (px of the same stage as `begin`). */
  update(p: Pt): Pose {
    if (this.done) return this.cur;
    const s = this.sticker;
    const next: Pose =
      this.kind === 'move'
        ? { x: s.x + (p.x - this.start.x) / this.w, y: s.y + (p.y - this.start.y) / this.h, size: s.size, rot: s.rot }
        : { x: s.x, y: s.y, ...dragHandle(s, p, this.w, this.h) };
    const c = clampPose(next);
    this.cur = { x: c.x ?? s.x, y: c.y ?? s.y, size: c.size ?? s.size, rot: c.rot ?? s.rot };
    return this.cur;
  }

  /** Finger up: one update, one history entry (nothing when the pose did not change). */
  commit(projectId: string): Promise<boolean> {
    if (this.done) return Promise.resolve(false);
    this.done = true;
    return this.c.commitPose(projectId, this.sticker.id, this.cur);
  }

  /** Pointer cancelled: nothing was written, the sticker stays as before. */
  cancel(): Pose {
    this.done = true;
    const s = this.sticker;
    this.cur = { x: s.x, y: s.y, size: s.size, rot: s.rot };
    return this.cur;
  }
}
