/**
 * Edit reducers over `Project.cut` (plan "Edit list over the frame pool"). Pure: ids are injected,
 * no clock. Every reducer returns the SAME project reference when nothing changes. The first
 * effective edit materializes `cut = timeline(project)`, so every non-hidden frame has at least
 * one entry afterwards (the invariant that keeps `timeline()` from re-appending a removed frame).
 */
import { HOLD_MAX, HOLD_MIN, type CutEntry, type Project } from './model';
import { timeline } from './timeline';

type Cut = CutEntry[];

/** Materialize, apply `fn`, and keep the project untouched when `fn` returns its input. */
function editCut(project: Project, fn: (cut: Cut) => Cut): Project {
  const base = timeline(project);
  const next = fn(base);
  if (next === base) return project;
  return { ...project, cut: next };
}

const indexOf = (cut: Cut, entryId: string): number => cut.findIndex((e) => e.id === entryId);

const clampHold = (n: number): number => Math.min(HOLD_MAX, Math.max(HOLD_MIN, Math.round(n)));

/** Replaces one entry (same position); `fn` returns its input for "no change". */
function patchEntry(project: Project, entryId: string, fn: (e: CutEntry) => CutEntry): Project {
  return editCut(project, (cut) => {
    const i = indexOf(cut, entryId);
    if (i < 0) return cut;
    const next = fn(cut[i]!);
    if (next === cut[i]) return cut;
    const out = cut.slice();
    out[i] = next;
    return out;
  });
}

/** A new entry right after `entryId` (same frame, hold and on/off); the copy inherits the stickers of its source. */
export function duplicateEntry(project: Project, entryId: string, newId: string): Project {
  const edited = editCut(project, (cut) => {
    const i = indexOf(cut, entryId);
    if (i < 0 || cut.some((e) => e.id === newId)) return cut;
    const src = cut[i]!;
    const copy: CutEntry = { id: newId, frameId: src.frameId, hold: src.hold, ...(src.off ? { off: true as const } : {}) };
    return [...cut.slice(0, i + 1), copy, ...cut.slice(i + 1)];
  });
  if (edited === project || !edited.stickers?.some((s) => s.on.includes(entryId))) return edited;
  return { ...edited, stickers: edited.stickers.map((s) => (s.on.includes(entryId) ? { ...s, on: s.on.flatMap((id) => (id === entryId ? [id, newId] : [id])) } : s)) };
}

/** Absolute hold, clamped to 1..8. */
export function setHold(project: Project, entryId: string, hold: number): Project {
  const h = clampHold(hold);
  return patchEntry(project, entryId, (e) => (e.hold === h ? e : { ...e, hold: h }));
}

/** Hold +1 / -1, clamped to 1..8. */
export function changeHold(project: Project, entryId: string, delta: number): Project {
  const cur = timeline(project).find((e) => e.id === entryId);
  return cur ? setHold(project, entryId, cur.hold + delta) : project;
}

/**
 * One step left (-1) or right (+1). Entries of frames in their Undo window are stepped over
 * (they are invisible, so a swap with them would look like nothing happened).
 */
export function moveEntry(project: Project, entryId: string, dir: -1 | 1): Project {
  const hidden = new Set(project.frames.filter((f) => f.hiddenUntil !== null).map((f) => f.frameId));
  return editCut(project, (cut) => {
    const i = indexOf(cut, entryId);
    if (i < 0) return cut;
    let j = i + dir;
    while (j >= 0 && j < cut.length && hidden.has(cut[j]!.frameId)) j += dir;
    if (j < 0 || j >= cut.length) return cut;
    const out = cut.slice();
    const [moved] = out.splice(i, 1);
    out.splice(j, 0, moved!);
    return out;
  });
}

/** Not in the movie (`off`) or back in it. The frame and its files are kept. */
export function setOff(project: Project, entryId: string, off: boolean): Project {
  return patchEntry(project, entryId, (e) => {
    if ((e.off === true) === off) return e;
    if (off) return { ...e, off: true };
    const { off: _o, ...rest } = e;
    return rest;
  });
}

function trim(project: Project, entryId: string, before: boolean): Project {
  return editCut(project, (cut) => {
    const at = indexOf(cut, entryId);
    if (at < 0) return cut;
    let changed = false;
    const out = cut.map((e, i) => {
      if ((before ? i >= at : i <= at) || e.off) return e;
      changed = true;
      return { ...e, off: true as const };
    });
    return changed ? out : cut;
  });
}

/** Trim the start: everything before the entry goes off. */
export function startHere(project: Project, entryId: string): Project {
  return trim(project, entryId, true);
}

/** Trim the end: everything after the entry goes off. */
export function endHere(project: Project, entryId: string): Project {
  return trim(project, entryId, false);
}

export interface DeleteResult {
  project: Project;
  /** The entry was the last of its frame: the caller runs `hideFrame` (5 s Undo, then expiry). */
  hideFrameId: string | null;
}

/**
 * A duplicate entry (other entries share its frame) is removed from `cut` and from the stickers'
 * `on` (a sticker left with no entries goes too). The last entry of a frame is NOT touched: the
 * frame delete owns it (`hideFrameId`), so Undo brings it back whole.
 */
export function deleteEntry(project: Project, entryId: string): DeleteResult {
  const cut = timeline(project);
  const e = cut.find((x) => x.id === entryId);
  if (!e) return { project, hideFrameId: null };
  if (cut.filter((x) => x.frameId === e.frameId).length <= 1) return { project, hideFrameId: e.frameId };
  return { project: pruneEdits(editCut(project, (c) => c.filter((x) => x.id !== entryId))), hideFrameId: null };
}

/**
 * Drops what no longer points at a live frame: cut entries of frames gone from the pool, ids gone
 * from the stickers' `on`, and a sticker that lost entries and has none left. Same reference when
 * nothing changes. Used by delete, frame expiry and history restore.
 */
export function pruneEdits(project: Project): Project {
  let next = project;
  const known = new Set(project.frames.map((f) => f.frameId));
  if (project.cut?.some((e) => !known.has(e.frameId))) {
    next = { ...next, cut: project.cut.filter((e) => known.has(e.frameId)) };
  }
  if (next.stickers && next.stickers.length > 0) {
    const live = new Set(timeline(next).map((e) => e.id));
    let changed = false;
    const stickers = [];
    for (const s of next.stickers) {
      const on = s.on.filter((id) => live.has(id));
      if (on.length === s.on.length) {
        stickers.push(s);
        continue;
      }
      changed = true;
      if (on.length > 0) stickers.push({ ...s, on });
    }
    if (changed) next = { ...next, stickers };
  }
  return next;
}
