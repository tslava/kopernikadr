/**
 * Pure reducers over the ProjectStore model (ARCHITECTURE §5.4-5.8). No I/O, no clock: time is
 * injected (`nowMs`, epoch milliseconds). Every reducer returns a new object, or the SAME
 * reference when nothing changes. The store (Task 6) serializes them and persists the result.
 */
import {
  DEFAULT_FPS,
  FPS_CHOICES,
  UNDO_WINDOW_MS,
  type FrameEntry,
  type FrameInfo,
  type Project,
  type ProjectIndex,
  type Rotation,
} from './model';
import { pruneEdits } from './edit';

const iso = (ms: number): string => new Date(ms).toISOString();

// --- projects -----------------------------------------------------------------------------

export function createProject(
  index: ProjectIndex,
  args: { id: string; name: string; nowMs: number; rotation?: Rotation },
): { index: ProjectIndex; project: Project } {
  if (index.projects.some((p) => p.id === args.id) || index.deletedProjects.includes(args.id)) {
    throw new Error(`project id already used: ${args.id}`);
  }
  const createdAt = iso(args.nowMs);
  const project: Project = {
    version: 1,
    id: args.id,
    name: args.name,
    createdAt,
    fps: DEFAULT_FPS,
    geometry: { aspect: '4:3', rotation: args.rotation ?? 0 },
    cameraId: null,
    frames: [],
    deletedFrameIds: [],
    outstanding: [],
  };
  return {
    index: { ...index, projects: [...index.projects, { id: args.id, name: args.name, createdAt }] },
    project,
  };
}

/** The name lives in both files. A blank name is refused (`null`). */
export function renameProject(
  index: ProjectIndex,
  project: Project,
  name: string,
): { index: ProjectIndex; project: Project } | null {
  const n = name.trim();
  if (n === '') return null;
  return {
    index: { ...index, projects: index.projects.map((p) => (p.id === project.id ? { ...p, name: n } : p)) },
    project: { ...project, name: n },
  };
}

export function setFps(project: Project, fps: number): Project {
  if (!(FPS_CHOICES as readonly number[]).includes(fps) || fps === project.fps) return project;
  return { ...project, fps };
}

/** Geometry is frozen once the project has any capture trace (outstanding, frame or tombstone). */
export function isGeometryFrozen(project: Project): boolean {
  return project.geometryFrozen === true || project.outstanding.length > 0 || project.frames.length > 0 || project.deletedFrameIds.length > 0;
}

/** UI rotation change. Ignored once the geometry is frozen. */
export function setRotation(project: Project, rotation: Rotation): Project {
  if (isGeometryFrozen(project) || project.geometry.rotation === rotation) return project;
  return { ...project, geometry: { ...project.geometry, rotation } };
}

// --- capture ------------------------------------------------------------------------------

export type BeginCaptureResult =
  | { ok: true; project: Project; rotation: Rotation }
  | { ok: false; reason: 'camera_mismatch' };

/**
 * ONE state change: add outstanding {reqId, cameraId, sentAt}, bind `cameraId` if null, and (by
 * the outstanding entry) freeze geometry/rotation. `rotation` in the result is what to send in
 * `capture`: always the project's own, never a newer UI value. A project bound to another camera
 * refuses. The same reqId twice is a no-op.
 */
export function beginCapture(
  project: Project,
  args: { reqId: string; cameraId: string; nowMs: number },
): BeginCaptureResult {
  if (project.cameraId !== null && project.cameraId !== args.cameraId) return { ok: false, reason: 'camera_mismatch' };
  const rotation = project.geometry.rotation;
  if (project.outstanding.some((o) => o.reqId === args.reqId) && project.cameraId === args.cameraId) {
    return { ok: true, project, rotation };
  }
  const outstanding = project.outstanding.some((o) => o.reqId === args.reqId)
    ? project.outstanding
    : [...project.outstanding, { reqId: args.reqId, cameraId: args.cameraId, sentAt: iso(args.nowMs) }];
  return { ok: true, project: { ...project, cameraId: args.cameraId, outstanding, geometryFrozen: true }, rotation };
}

/** Resolving an outstanding request only removes that request. */
export function removeOutstanding(project: Project, reqId: string): Project {
  if (!project.outstanding.some((o) => o.reqId === reqId)) return project;
  return { ...project, outstanding: project.outstanding.filter((o) => o.reqId !== reqId) };
}

export type MergeStatus =
  | 'inserted'
  | 'exists' // already known: nothing changes (monotonic)
  | 'tombstoned' // the frame was deleted for good: not re-inserted
  | 'wrong_camera' // the frame's camera is not the project's camera
  | 'wrong_project';

export interface MergeResult {
  project: Project;
  status: MergeStatus;
}

/**
 * Monotonic merge, keyed by `frameId`, ordered by `seq`. Inserted as `pending` only if absent and
 * not tombstoned; an existing entry is never touched (`local` never goes back to `pending`, keeps
 * `hiddenUntil`, position). `cameraId` is the camera that produced the frame (the connected one
 * or the outstanding entry's); refused unless it equals the project's bound camera.
 * Does not remove outstanding entries (see `removeOutstanding`).
 */
export function mergeFrame(project: Project, info: FrameInfo, cameraId: string): MergeResult {
  if (info.projectId !== project.id) return { project, status: 'wrong_project' };
  if (project.cameraId === null || project.cameraId !== cameraId) return { project, status: 'wrong_camera' };
  if (project.deletedFrameIds.includes(info.frameId)) return { project, status: 'tombstoned' };
  if (project.frames.some((f) => f.frameId === info.frameId)) return { project, status: 'exists' };
  const entry: FrameEntry = {
    frameId: info.frameId,
    seq: info.seq,
    bytes: info.full.bytes,
    sha256: info.full.sha256,
    state: 'pending',
    hiddenUntil: null,
  };
  // after the last frame with seq <= entry.seq (stable for equal seq)
  let at = project.frames.length;
  while (at > 0 && project.frames[at - 1]!.seq > entry.seq) at--;
  const frames = [...project.frames.slice(0, at), entry, ...project.frames.slice(at)];
  return { project: { ...project, frames }, status: 'inserted' };
}

export type ResultRoute = 'merge' | 'deleted_project' | 'unknown_project';

/**
 * Where a frame result (capture result or `listFrames` row) goes. A result for a deleted project
 * is NOT merged (`deleted_project`; it is ack-eligible, see `ackEligible`). A project in the Undo
 * window still merges: its files are downloaded like any other.
 */
export function routeResult(index: ProjectIndex, projectId: string): ResultRoute {
  if (index.deletedProjects.includes(projectId)) return 'deleted_project';
  return index.projects.some((p) => p.id === projectId) ? 'merge' : 'unknown_project';
}

/** Install committed: `pending` -> `local`. A frame that is absent/tombstoned is left alone. */
export function setLocal(project: Project, frameId: string): Project {
  return updateFrame(project, frameId, (f) => {
    if (f.state === 'local' && f.unavailable === undefined) return f;
    const { unavailable: _u, ...rest } = f; // a stale give-up flag must not outlive the install
    return { ...rest, state: 'local' };
  });
}

/** The download gave up. Never acked. Only a `pending` frame can become unavailable. */
export function markUnavailable(project: Project, frameId: string, reason: string, nowMs: number): Project {
  return updateFrame(project, frameId, (f) =>
    f.state === 'pending' && f.unavailable === undefined ? { ...f, unavailable: { reason, since: iso(nowMs) } } : f,
  );
}

export function clearUnavailable(project: Project, frameId: string): Project {
  return updateFrame(project, frameId, (f) => {
    if (f.unavailable === undefined) return f;
    const { unavailable: _u, ...rest } = f;
    return rest;
  });
}

function updateFrame(project: Project, frameId: string, fn: (f: FrameEntry) => FrameEntry): Project {
  const i = project.frames.findIndex((f) => f.frameId === frameId);
  if (i < 0) return project;
  const next = fn(project.frames[i]!);
  if (next === project.frames[i]) return project;
  const frames = project.frames.slice();
  frames[i] = next;
  return { ...project, frames };
}

// --- frame deletion / Undo (§5.8) --------------------------------------------------------

export function hideFrame(project: Project, frameId: string, nowMs: number, undoMs = UNDO_WINDOW_MS): Project {
  return updateFrame(project, frameId, (f) => (f.hiddenUntil === null ? { ...f, hiddenUntil: iso(nowMs + undoMs) } : f));
}

export function unhideFrame(project: Project, frameId: string): Project {
  return updateFrame(project, frameId, (f) => (f.hiddenUntil === null ? f : { ...f, hiddenUntil: null }));
}

/**
 * Expiry: hidden frames whose deadline passed move to `deletedFrameIds` (tombstone) and leave
 * `frames`, together with their cut entries and sticker ids (see `pruneEdits`). The caller
 * commits, THEN unlinks `expired` files (idempotent).
 */
export function expireFrames(project: Project, nowMs: number): { project: Project; expired: string[] } {
  const expired = project.frames
    .filter((f) => f.hiddenUntil !== null && Date.parse(f.hiddenUntil) <= nowMs)
    .map((f) => f.frameId);
  if (expired.length === 0) return { project, expired };
  return {
    // the frames' cut entries go with them, and so do their ids in the stickers' `on`
    project: pruneEdits({
      ...project,
      frames: project.frames.filter((f) => !expired.includes(f.frameId)),
      deletedFrameIds: [...project.deletedFrameIds, ...expired.filter((id) => !project.deletedFrameIds.includes(id))],
    }),
    expired,
  };
}

// --- project deletion / Undo -------------------------------------------------------------

/** pendingProjectDeletes: the project stays in `projects` until expiry (the UI hides it). */
export function hideProject(index: ProjectIndex, projectId: string, nowMs: number, undoMs = UNDO_WINDOW_MS): ProjectIndex {
  if (!index.projects.some((p) => p.id === projectId)) return index;
  if (index.pendingProjectDeletes.some((p) => p.id === projectId)) return index;
  return {
    ...index,
    pendingProjectDeletes: [...index.pendingProjectDeletes, { id: projectId, deadline: iso(nowMs + undoMs) }],
  };
}

/** Undo. With `nowMs`, refused (same index) once the deadline has passed: the window is over. */
export function unhideProject(index: ProjectIndex, projectId: string, nowMs?: number): ProjectIndex {
  const pending = index.pendingProjectDeletes.find((p) => p.id === projectId);
  if (!pending) return index;
  if (nowMs !== undefined && Date.parse(pending.deadline) <= nowMs) return index;
  return { ...index, pendingProjectDeletes: index.pendingProjectDeletes.filter((p) => p.id !== projectId) };
}

/**
 * pendingProjectDeletes -> deletedProjects, removed from `projects`. The caller commits, THEN
 * removes the project directory.
 */
export function expireProjects(index: ProjectIndex, nowMs: number): { index: ProjectIndex; expired: string[] } {
  const due = index.pendingProjectDeletes.filter((p) => Date.parse(p.deadline) <= nowMs).map((p) => p.id);
  if (due.length === 0) return { index, expired: due };
  return {
    index: {
      ...index,
      projects: index.projects.filter((p) => !due.includes(p.id)),
      pendingProjectDeletes: index.pendingProjectDeletes.filter((p) => !due.includes(p.id)),
      deletedProjects: [...index.deletedProjects, ...due.filter((id) => !index.deletedProjects.includes(id))],
    },
    expired: due,
  };
}

// --- recovery (§5.6) ---------------------------------------------------------------------

export type RecoverResult =
  | { ok: true; index: ProjectIndex; project: Project }
  | { ok: false; reason: 'tombstoned' | 'pending_delete' | 'exists' | 'bad_rotation' };

/**
 * `listFrames` returned a frame of an unknown, non-tombstoned project (tablet metadata loss):
 * create "Odzyskany <date>" with that id, bound to the CURRENT camera, rotation from the
 * FrameInfo, and merge the frame. `formatDate` is injected (locale/tz belong to the caller).
 */
export function recoverProject(
  index: ProjectIndex,
  info: FrameInfo,
  args: { cameraId: string; nowMs: number; formatDate: (ms: number) => string },
): RecoverResult {
  if (index.deletedProjects.includes(info.projectId)) return { ok: false, reason: 'tombstoned' };
  if (index.pendingProjectDeletes.some((p) => p.id === info.projectId)) return { ok: false, reason: 'pending_delete' };
  if (index.projects.some((p) => p.id === info.projectId)) return { ok: false, reason: 'exists' };
  if (info.rotation !== 0 && info.rotation !== 180) return { ok: false, reason: 'bad_rotation' };
  const created = createProject(index, {
    id: info.projectId,
    name: `Odzyskany ${args.formatDate(args.nowMs)}`,
    nowMs: args.nowMs,
    rotation: info.rotation,
  });
  const bound: Project = { ...created.project, cameraId: args.cameraId };
  const merged = mergeFrame(bound, info, args.cameraId);
  return { ok: true, index: created.index, project: merged.project };
}
