// Projects ("movies") owned by the remote, kept in localStorage. Pure functions over a plain
// state object; the caller saves after each change.
//
// state   = {v: 1, projects: Project[]}
// Project = {id, name, createdAt, fps, frames: [{frameId, seq}], deleted: [frameId],
//            rotation: 0|180|null, cameraId: string|null, recovered?: true, trashed?: true, trashedAt?}
//
// Frame deletion is local: the id goes to `deleted` (a tombstone) and stays in `frames`, so
// Undo puts it back in the same place and a later listFrames never re-adds it. A deleted
// project keeps its id with `trashed: true` for the same reason.

export const STORAGE_KEY = 'kopernikadr.remoteLite.v1';
export const DEFAULT_FPS = 8;
export const MIN_FPS = 4;
export const MAX_FPS = 12;

export function emptyState() {
  return { v: 1, projects: [] };
}

export function loadState(storage, key = STORAGE_KEY) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return emptyState();
    const s = JSON.parse(raw);
    if (!s || s.v !== 1 || !Array.isArray(s.projects)) return emptyState();
    for (const p of s.projects) {
      p.frames = Array.isArray(p.frames) ? p.frames : [];
      p.deleted = Array.isArray(p.deleted) ? p.deleted : [];
      p.fps = clampFps(p.fps);
      p.rotation ??= null;
      p.cameraId ??= null;
    }
    return s;
  } catch {
    return emptyState();
  }
}

export function saveState(storage, state, key = STORAGE_KEY) {
  try {
    storage?.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clampFps(fps) {
  const n = Math.round(Number(fps));
  if (!Number.isFinite(n)) return DEFAULT_FPS;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, n));
}

export function createProject(state, { id, now, name, fps = DEFAULT_FPS, recovered = false }) {
  const p = { id, name, createdAt: now, fps: clampFps(fps), frames: [], deleted: [], rotation: null, cameraId: null };
  if (recovered) p.recovered = true;
  state.projects.push(p);
  return p;
}

export function findProject(state, id) {
  return state.projects.find((p) => p.id === id) ?? null;
}

/** Projects to show, newest first. */
export function listProjects(state) {
  return state.projects.filter((p) => !p.trashed).sort((a, b) => b.createdAt - a.createdAt);
}

export function renameProject(project, name) {
  const n = String(name ?? '').trim().slice(0, 60);
  if (n) project.name = n;
  return project.name;
}

export function trashProject(state, id, now) {
  const p = findProject(state, id);
  if (!p || p.trashed) return false;
  p.trashed = true;
  p.trashedAt = now;
  return true;
}

export function restoreProject(state, id) {
  const p = findProject(state, id);
  if (!p?.trashed) return false;
  delete p.trashed;
  delete p.trashedAt;
  return true;
}

/** Drops the frame lists of projects trashed longer than `undoMs` ago (the tombstone stays). */
export function purgeTrashed(state, now, undoMs = 5000) {
  let n = 0;
  for (const p of state.projects) {
    if (p.trashed && now - p.trashedAt >= undoMs && p.frames.length) {
      p.frames = [];
      p.deleted = [];
      n++;
    }
  }
  return n;
}

export function setFps(project, fps) {
  project.fps = clampFps(fps);
  return project.fps;
}

export function visibleFrames(project) {
  if (!project.deleted.length) return project.frames.slice();
  const dead = new Set(project.deleted);
  return project.frames.filter((f) => !dead.has(f.frameId));
}

export function lastVisibleFrame(project) {
  const v = visibleFrames(project);
  return v.length ? v[v.length - 1] : null;
}

export function hasFrame(project, frameId) {
  return project.frames.some((f) => f.frameId === frameId);
}

/**
 * Monotonic merge (PROTOCOL.md §8): inserts the frame by `seq` only if it is absent and not
 * tombstoned. Binds the project to the frame's camera and rotation on the first frame.
 * @returns {boolean} whether it was inserted
 */
export function insertFrame(project, frame) {
  if (!frame?.frameId || !Number.isFinite(frame.seq)) return false;
  if (project.deleted.includes(frame.frameId) || hasFrame(project, frame.frameId)) return false;
  const entry = { frameId: frame.frameId, seq: frame.seq };
  let i = project.frames.length;
  while (i > 0 && project.frames[i - 1].seq > frame.seq) i--;
  project.frames.splice(i, 0, entry);
  if (project.rotation == null && Number.isFinite(frame.rotation)) project.rotation = frame.rotation;
  if (project.cameraId == null && frame.cameraId) project.cameraId = frame.cameraId;
  return true;
}

/** Hides a frame (tombstone). Returns false if it is unknown or already hidden. */
export function hideFrame(project, frameId) {
  if (!hasFrame(project, frameId) || project.deleted.includes(frameId)) return false;
  project.deleted.push(frameId);
  return true;
}

export function unhideFrame(project, frameId) {
  const i = project.deleted.indexOf(frameId);
  if (i < 0) return false;
  project.deleted.splice(i, 1);
  return true;
}

/**
 * Merges frames from `listFrames` (or a recovered capture result). Frames of a known project are
 * inserted by seq; frames of a trashed project are ignored; frames of an unknown project create a
 * recovered project that keeps the original projectId, so later frames land in the same place.
 * @param {object[]} frames FrameInfo[]
 * @param {{now: number, cameraId?: string, recoveredName: (capturedAtMs: number) => string}} ctx
 * @returns {{added: number, recovered: string[]}} recovered = ids of projects created here
 */
export function mergeListedFrames(state, frames, { now, cameraId, recoveredName }) {
  let added = 0;
  const recovered = [];
  for (const f of frames) {
    if (!f?.projectId) continue;
    let p = findProject(state, f.projectId);
    if (p?.trashed) continue;
    if (!p) {
      const at = Date.parse(f.capturedAt);
      const createdAt = Number.isFinite(at) ? at : now;
      p = createProject(state, { id: f.projectId, now: createdAt, name: recoveredName(createdAt), recovered: true });
      recovered.push(p.id);
    }
    if (insertFrame(p, { ...f, cameraId: f.cameraId ?? cameraId })) added++;
  }
  return { added, recovered };
}

/** The rotation a capture into this project must use: the project's once it has frames. */
export function captureRotation(project, cameraRotation) {
  return project.frames.length && project.rotation != null ? project.rotation : cameraRotation ?? 0;
}
