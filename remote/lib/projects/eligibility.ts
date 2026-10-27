import type { Project, ProjectIndex } from './model';

/**
 * The ONLY place that decides whether a frame may be acked (a frame acked by mistake is later
 * reclaimed from the child's phone and is gone).
 *
 * Eligible iff the project is not in the Undo window and one of:
 *  - the frame is `local` in `project`;
 *  - its frameId is in `project.deletedFrameIds`;
 *  - its project is in `index.deletedProjects` (a result for a deleted project is not merged,
 *    but it is eligible).
 * Anything else (pending, unknown frame, unknown project) is not eligible.
 *
 * A project in `pendingProjectDeletes` is not eligible at all, even for its `local` frames: the
 * decision waits for the expiry, when the project lands in `deletedProjects`.
 */
export function ackEligible(
  frame: { frameId: string; projectId: string },
  project: Project | null | undefined,
  index: ProjectIndex,
): boolean {
  if (index.pendingProjectDeletes.some((p) => p.id === frame.projectId)) return false;
  if (index.deletedProjects.includes(frame.projectId)) return true;
  if (!project || project.id !== frame.projectId) return false;
  if (project.deletedFrameIds.includes(frame.frameId)) return true;
  const entry = project.frames.find((f) => f.frameId === frame.frameId);
  return entry !== undefined && entry.state === 'local';
}
