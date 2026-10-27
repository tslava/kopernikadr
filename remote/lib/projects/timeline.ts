/**
 * The movie as an edit list over the frame pool (plan "Edit list over the frame pool"). Pure.
 * `frames` stays the pool of captures; `cut` (optional) orders, repeats and switches entries off.
 */
import type { CutEntry, FrameEntry, Project } from './model';

/**
 * What plays, in order: the `cut` entries whose frame is still in the pool, then every frame
 * no entry references (new captures after the last edit) in seq order as `{id: frameId, hold: 1}`.
 */
export function timeline(project: Pick<Project, 'frames' | 'cut'>): CutEntry[] {
  const known = new Set(project.frames.map((f) => f.frameId));
  const cut = project.cut ?? [];
  const out: CutEntry[] = cut.filter((e) => known.has(e.frameId));
  const referenced = new Set(cut.map((e) => e.frameId));
  const rest = project.frames.filter((f) => !referenced.has(f.frameId)).sort((a, b) => a.seq - b.seq);
  for (const f of rest) out.push({ id: f.frameId, frameId: f.frameId, hold: 1 });
  return out;
}

/** The timeline entries that play and export: on, local, visible and available. */
export function playableItems(project: Pick<Project, 'frames' | 'cut'>): CutEntry[] {
  const byId = new Map<string, FrameEntry>(project.frames.map((f) => [f.frameId, f]));
  return timeline(project).filter((e) => {
    if (e.off) return false;
    const f = byId.get(e.frameId);
    return !!f && f.hiddenUntil === null && f.state === 'local' && !f.unavailable;
  });
}
