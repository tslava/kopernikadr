/**
 * The movie's edit tools (plan "Edit history", "Delete is per entry"): each tool runs one reducer
 * from `lib/projects/edit.ts` through `store.updateProject`, pushes the change to the Cofnij
 * history, and does nothing while an export runs. Delete of a frame's last entry is not a reducer:
 * it starts the frame's Undo window (`FrameDeletion`), which has its own toast. Pure view
 * logic (`toolStates`) decides which buttons make sense, so the UI never offers a no-op.
 */
import { changeHold, deleteEntry, duplicateEntry, endHere, moveEntry, setOff, startHere } from '../projects/edit';
import type { FrameDeletion } from '../projects/frameDeletion';
import { EditHistory, restoreSnapshot, type EditSnapshot } from '../projects/history';
import { HOLD_MAX, HOLD_MIN, type Project } from '../projects/model';
import type { ProjectStore } from '../projects/store';
import { timeline } from '../projects/timeline';

export type EditTool = 'delete' | 'duplicate' | 'holdDown' | 'holdUp' | 'moveLeft' | 'moveRight' | 'off' | 'startHere' | 'endHere' | 'undo';

export type ToolStates = Record<EditTool, boolean>;

const NONE: ToolStates = { delete: false, duplicate: false, holdDown: false, holdUp: false, moveLeft: false, moveRight: false, off: false, startHere: false, endHere: false, undo: false };

/**
 * Which tools are enabled (true) for the selected entry. Everything is off while an export runs,
 * and for an entry whose frame is in its Undo window. A reducer that would change nothing
 * (move at the edge, hold at 8, trim with nothing to trim) leaves its button off.
 */
export function toolStates(project: Project | null, entryId: string | null, o: { exporting: boolean; canUndo: boolean }): ToolStates {
  if (!project || o.exporting) return NONE;
  const undo = o.canUndo;
  const entry = entryId === null ? undefined : timeline(project).find((e) => e.id === entryId);
  if (!entry || project.frames.find((f) => f.frameId === entry.frameId)?.hiddenUntil != null) return { ...NONE, undo };
  const changes = (next: Project) => next !== project;
  return {
    delete: true,
    duplicate: true,
    holdDown: entry.hold > HOLD_MIN,
    holdUp: entry.hold < HOLD_MAX,
    moveLeft: changes(moveEntry(project, entry.id, -1)),
    moveRight: changes(moveEntry(project, entry.id, 1)),
    off: true,
    startHere: changes(startHere(project, entry.id)),
    endHere: changes(endHere(project, entry.id)),
    undo,
  };
}

export interface EditControllerDeps {
  store: Pick<ProjectStore, 'updateProject' | 'state'>;
  frameDeletion: Pick<FrameDeletion, 'hide'>;
  exporting: { get(): boolean };
  history?: EditHistory;
  newId?: () => string;
}

export class EditController {
  readonly history: EditHistory;
  private readonly newId: () => string;

  constructor(private readonly d: EditControllerDeps) {
    this.history = d.history ?? new EditHistory();
    this.newId = d.newId ?? (() => crypto.randomUUID());
  }

  canUndo(projectId: string): boolean {
    return this.history.canUndo(projectId);
  }

  duplicate(projectId: string, entryId: string): Promise<boolean> {
    const id = this.newId();
    return this.edit(projectId, (p) => duplicateEntry(p, entryId, id));
  }

  /** Hold +1 / -1 (clamped to 1..8). */
  hold(projectId: string, entryId: string, delta: number): Promise<boolean> {
    return this.edit(projectId, (p) => changeHold(p, entryId, delta));
  }

  move(projectId: string, entryId: string, dir: -1 | 1): Promise<boolean> {
    return this.edit(projectId, (p) => moveEntry(p, entryId, dir));
  }

  off(projectId: string, entryId: string, off: boolean): Promise<boolean> {
    return this.edit(projectId, (p) => setOff(p, entryId, off));
  }

  startHere(projectId: string, entryId: string): Promise<boolean> {
    return this.edit(projectId, (p) => startHere(p, entryId));
  }

  endHere(projectId: string, entryId: string): Promise<boolean> {
    return this.edit(projectId, (p) => endHere(p, entryId));
  }

  /**
   * A duplicate entry leaves the cut (in the history); the last entry of a frame starts the
   * frame's Undo window instead. Resolves what happened.
   */
  async delete(projectId: string, entryId: string): Promise<'entry' | 'frame' | 'none'> {
    if (this.d.exporting.get()) return 'none';
    let hideFrameId: string | null = null;
    const box: { change?: { before: Project; after: Project } } = {};
    await this.d.store.updateProject(projectId, (p) => {
      const r = deleteEntry(p, entryId);
      hideFrameId = r.hideFrameId;
      if (r.project === p) return p;
      box.change = { before: p, after: r.project };
      return r.project;
    });
    const changed = box.change !== undefined;
    if (box.change) this.history.record(projectId, box.change.before, box.change.after); // only once the write is committed
    if (hideFrameId !== null) return (await this.d.frameDeletion.hide(projectId, hideFrameId)) ? 'frame' : 'none';
    return changed ? 'entry' : 'none';
  }

  /** Cofnij: restores the previous `{cut, stickers}` against the current project. */
  async undo(projectId: string): Promise<boolean> {
    if (this.d.exporting.get()) return false;
    const box: { used?: EditSnapshot } = {};
    await this.d.store.updateProject(projectId, (p) => {
      const snap = this.history.peek(projectId);
      if (!snap) return p;
      box.used = snap;
      return restoreSnapshot(p, snap);
    });
    if (!box.used) return false;
    this.history.discard(projectId, box.used); // only once the write is committed
    return true;
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
    this.history.record(projectId, box.change.before, box.change.after); // only once the write is committed
    return true;
  }
}
