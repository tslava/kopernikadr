/**
 * ProjectStore data model (ARCHITECTURE §5.4) and validation of `index.json` / `project.json`
 * version 1. Pure: no I/O, no clock.
 */

export type Rotation = 0 | 180;
export type FrameState = 'pending' | 'local';
/** Frame rates a movie can play at (the play view's speed slider steps through these). */
export const FPS_CHOICES = [2, 3, 4, 5, 6, 8, 10, 12, 15] as const;
export const DEFAULT_FPS = 8;
export const UNDO_WINDOW_MS = 5_000;

export interface Unavailable {
  reason: string;
  since: string;
}

export interface FrameEntry {
  frameId: string;
  seq: number;
  bytes: number;
  sha256: string;
  state: FrameState;
  hiddenUntil: string | null;
  /** UI/store flag (download gave up). Never acked, never sent anywhere. */
  unavailable?: Unavailable;
}

export interface Outstanding {
  reqId: string;
  cameraId: string;
  sentAt: string;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  fps: number;
  geometry: { aspect: '4:3'; rotation: Rotation };
  cameraId: string | null;
  /** Set once any capture was sent: geometry stays frozen even after the outstanding entry is dropped (additive, optional). */
  geometryFrozen?: true;
  frames: FrameEntry[];
  deletedFrameIds: string[];
  outstanding: Outstanding[];
}

export interface IndexProject {
  id: string;
  name: string;
  createdAt: string;
}

export interface RememberedCamera {
  cameraId: string;
  host: string;
  port: number;
}

export interface PendingProjectDelete {
  id: string;
  deadline: string;
}

export interface ProjectIndex {
  version: 1;
  clientId: string;
  rememberedCamera: RememberedCamera | null;
  projects: IndexProject[];
  deletedProjects: string[];
  pendingProjectDeletes: PendingProjectDelete[];
}

/** PROTOCOL v1 `FrameInfo` (the fields the remote uses). */
export interface FrameInfo {
  frameId: string;
  seq: number;
  projectId: string;
  clientId: string;
  rotation: number;
  capturedAt: string;
  full: { w: number; h: number; bytes: number; sha256: string };
  derived?: { play: { w: number; h: number }; thumb: { w: number; h: number } };
  exposure?: { iso: number; exposureTimeNs: number };
}

export type ModelErrorCode = 'not_object' | 'missing_field' | 'bad_type' | 'unknown_version';

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `${code} at ${path}`);
    this.name = 'ModelError';
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ModelError('not_object', path);
  return v as Obj;
}
function field(o: Obj, key: string, path: string): unknown {
  if (!(key in o) || o[key] === undefined) throw new ModelError('missing_field', `${path}.${key}`);
  return o[key];
}
function str(o: Obj, key: string, path: string): string {
  const v = field(o, key, path);
  if (typeof v !== 'string') throw new ModelError('bad_type', `${path}.${key}`);
  return v;
}
function nonEmptyStr(o: Obj, key: string, path: string): string {
  const v = str(o, key, path);
  if (v === '') throw new ModelError('bad_type', `${path}.${key}`);
  return v;
}
function int(o: Obj, key: string, path: string, min = 0): number {
  const v = field(o, key, path);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new ModelError('bad_type', `${path}.${key}`);
  return v;
}
function arr(o: Obj, key: string, path: string): unknown[] {
  const v = field(o, key, path);
  if (!Array.isArray(v)) throw new ModelError('bad_type', `${path}.${key}`);
  return v;
}
function strOrNull(o: Obj, key: string, path: string): string | null {
  const v = field(o, key, path);
  if (v === null) return null;
  if (typeof v !== 'string' || v === '') throw new ModelError('bad_type', `${path}.${key}`);
  return v;
}
function version1(o: Obj, path: string): void {
  const v = field(o, 'version', path);
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ModelError('bad_type', `${path}.version`);
  if (v !== 1) throw new ModelError('unknown_version', `${path}.version`, `unsupported version ${v}`);
}
function strList(o: Obj, key: string, path: string): string[] {
  return arr(o, key, path).map((x, i) => {
    if (typeof x !== 'string' || x === '') throw new ModelError('bad_type', `${path}.${key}[${i}]`);
    return x;
  });
}

export function parseIndex(raw: unknown): ProjectIndex {
  const o = obj(raw, 'index');
  version1(o, 'index');
  const clientId = nonEmptyStr(o, 'clientId', 'index');
  const rcRaw = field(o, 'rememberedCamera', 'index');
  let rememberedCamera: RememberedCamera | null = null;
  if (rcRaw !== null) {
    const rc = obj(rcRaw, 'index.rememberedCamera');
    rememberedCamera = {
      cameraId: nonEmptyStr(rc, 'cameraId', 'index.rememberedCamera'),
      host: nonEmptyStr(rc, 'host', 'index.rememberedCamera'),
      port: int(rc, 'port', 'index.rememberedCamera', 1),
    };
  }
  const projects = arr(o, 'projects', 'index').map((p, i) => {
    const path = `index.projects[${i}]`;
    const po = obj(p, path);
    return { id: nonEmptyStr(po, 'id', path), name: str(po, 'name', path), createdAt: nonEmptyStr(po, 'createdAt', path) };
  });
  const pendingProjectDeletes = arr(o, 'pendingProjectDeletes', 'index').map((p, i) => {
    const path = `index.pendingProjectDeletes[${i}]`;
    const po = obj(p, path);
    return { id: nonEmptyStr(po, 'id', path), deadline: nonEmptyStr(po, 'deadline', path) };
  });
  return {
    version: 1,
    clientId,
    rememberedCamera,
    projects,
    deletedProjects: strList(o, 'deletedProjects', 'index'),
    pendingProjectDeletes,
  };
}

export function parseProject(raw: unknown): Project {
  const o = obj(raw, 'project');
  version1(o, 'project');
  // non-critical: an invalid fps or name must not make the whole project unreadable
  const fpsRaw = o.fps;
  const fps = typeof fpsRaw === 'number' && (FPS_CHOICES as readonly number[]).includes(fpsRaw) ? fpsRaw : DEFAULT_FPS;
  const g = obj(field(o, 'geometry', 'project'), 'project.geometry');
  if (str(g, 'aspect', 'project.geometry') !== '4:3') throw new ModelError('bad_type', 'project.geometry.aspect');
  const rot = field(g, 'rotation', 'project.geometry');
  if (rot !== 0 && rot !== 180) throw new ModelError('bad_type', 'project.geometry.rotation');
  const frames = arr(o, 'frames', 'project').map((f, i): FrameEntry => {
    const path = `project.frames[${i}]`;
    const fo = obj(f, path);
    const state = str(fo, 'state', path);
    if (state !== 'pending' && state !== 'local') throw new ModelError('bad_type', `${path}.state`);
    const entry: FrameEntry = {
      frameId: nonEmptyStr(fo, 'frameId', path),
      seq: int(fo, 'seq', path),
      bytes: int(fo, 'bytes', path),
      sha256: nonEmptyStr(fo, 'sha256', path),
      state,
      hiddenUntil: strOrNull(fo, 'hiddenUntil', path),
    };
    if (fo.unavailable !== undefined && fo.unavailable !== null) {
      const u = obj(fo.unavailable, `${path}.unavailable`);
      entry.unavailable = { reason: str(u, 'reason', `${path}.unavailable`), since: str(u, 'since', `${path}.unavailable`) };
    }
    return entry;
  });
  const outstanding = arr(o, 'outstanding', 'project').map((x, i): Outstanding => {
    const path = `project.outstanding[${i}]`;
    const oo = obj(x, path);
    return { reqId: nonEmptyStr(oo, 'reqId', path), cameraId: nonEmptyStr(oo, 'cameraId', path), sentAt: nonEmptyStr(oo, 'sentAt', path) };
  });
  return {
    version: 1,
    id: nonEmptyStr(o, 'id', 'project'),
    name: typeof o.name === 'string' ? o.name : '',
    createdAt: nonEmptyStr(o, 'createdAt', 'project'),
    fps,
    geometry: { aspect: '4:3', rotation: rot },
    cameraId: strOrNull(o, 'cameraId', 'project'),
    ...(o.geometryFrozen === true ? { geometryFrozen: true as const } : {}),
    frames,
    deletedFrameIds: strList(o, 'deletedFrameIds', 'project'),
    outstanding,
  };
}
