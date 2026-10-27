/**
 * "Cofnij": an in-memory undo stack of `{cut, stickers}` snapshots per project (last 30, not
 * persisted, no redo). A frame Delete has its own Undo and is not recorded here; every other edit,
 * duplicate-entry delete included, is.
 */
import { pruneEdits } from './edit';
import type { CutEntry, Project, Sticker } from './model';

export const HISTORY_CAP = 30;

export interface EditSnapshot {
  cut: CutEntry[] | undefined;
  stickers: Sticker[] | undefined;
}

export class EditHistory {
  private readonly stacks = new Map<string, EditSnapshot[]>();

  constructor(private readonly cap = HISTORY_CAP) {}

  /** Remember `before` when `after` differs in `cut` or `stickers` (reducers return the same reference for a no-op). */
  record(projectId: string, before: Project, after: Project): void {
    if (before.cut === after.cut && before.stickers === after.stickers) return;
    const stack = this.stacks.get(projectId) ?? [];
    stack.push({ cut: before.cut, stickers: before.stickers });
    if (stack.length > this.cap) stack.splice(0, stack.length - this.cap);
    this.stacks.set(projectId, stack);
  }

  canUndo(projectId: string): boolean {
    return (this.stacks.get(projectId)?.length ?? 0) > 0;
  }

  /** Pops the newest snapshot (the caller applies it with `restoreSnapshot` inside `updateProject`). */
  pop(projectId: string): EditSnapshot | undefined {
    return this.stacks.get(projectId)?.pop();
  }

  /** The newest snapshot without removing it: undo drops it only once its write is committed (`discard`). */
  peek(projectId: string): EditSnapshot | undefined {
    const stack = this.stacks.get(projectId);
    return stack?.[stack.length - 1];
  }

  /** Removes one snapshot object (the one `peek` returned), wherever it sits now. */
  discard(projectId: string, snap: EditSnapshot): void {
    const stack = this.stacks.get(projectId);
    const i = stack?.lastIndexOf(snap) ?? -1;
    if (stack && i >= 0) stack.splice(i, 1);
  }

  clear(projectId: string): void {
    this.stacks.delete(projectId);
  }
}

/**
 * Applies a snapshot to the CURRENT project and re-prunes against its frames: a frame that expired
 * after the snapshot was taken does not come back, and a sticker left with no live entry stays gone.
 */
export function restoreSnapshot(project: Project, snap: EditSnapshot): Project {
  const { cut: _c, stickers: _s, ...rest } = project;
  return pruneEdits({
    ...rest,
    ...(snap.cut ? { cut: snap.cut } : {}),
    ...(snap.stickers ? { stickers: snap.stickers } : {}),
  });
}
