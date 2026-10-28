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

/** One shown slot of the movie (the edit list over the frame pool; see `timeline.ts`). */
export interface CutEntry {
  /** == frameId for a frame's first entry; a new ULID for a duplicate. */
  id: string;
  frameId: string;
  /** Ticks the entry stays on screen (a tick = 1/fps). */
  hold: number;
  /** Not in the movie (trim / "remove from movie"); the frame itself is kept. */
  off?: true;
}

export interface Sticker {
  id: string;
  /** OpenMoji hexcode, e.g. "1F436", or a custom sticker `my:<uuid>` (see `isCustomSticker`). */
  emoji: string;
  /** Centre, 0..1 of the 4:3 frame (may hang partly off-frame). */
  x: number;
  y: number;
  /** Width as a fraction of the frame width. */
  size: number;
  /** Degrees. */
  rot: number;
  /** CutEntry ids it is shown on. */
  on: string[];
}

/** A custom (photo) sticker id; the uuid names `projects/{pid}/stickers/<uuid>.webp`. Paths are built only from ids that match. */
export const MY_STICKER_RE = /^my:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isCustomSticker = (emoji: string): boolean => MY_STICKER_RE.test(emoji);
/** Anything that claims to be custom (`my:` prefix) but is not a valid id. */
export const isBadCustomSticker = (emoji: string): boolean => emoji.startsWith('my:') && !MY_STICKER_RE.test(emoji);

export const HOLD_MIN = 1;
export const HOLD_MAX = 8;
export const STICKER_SIZE_MIN = 0.05;
export const STICKER_SIZE_MAX = 1;
export const STICKER_POS_MIN = -0.25;
export const STICKER_POS_MAX = 1.25;

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
  /** Edit list over `frames`; absent until the first edit (additive, optional). */
  cut?: CutEntry[];
  /** Emoji stickers, drawn in array order (last = on top) (additive, optional). */
  stickers?: Sticker[];
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

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Lenient: a malformed entry is dropped, and so is a later duplicate id; a non-array field is `undefined`. */
function parseCut(raw: unknown): CutEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: CutEntry[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue;
    const { off, ...c } = e as Obj; // unknown keys of a kept entry ride along (a newer app's fields survive our rewrite)
    if (!nonEmpty(c.id) || !nonEmpty(c.frameId) || !finite(c.hold) || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({
      ...c,
      id: c.id,
      frameId: c.frameId,
      hold: clamp(Math.round(c.hold), HOLD_MIN, HOLD_MAX),
      ...(off === true ? { off: true as const } : {}),
    });
  }
  return out;
}

function parseStickers(raw: unknown): Sticker[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: Sticker[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue;
    const s = e as Obj;
    if (!nonEmpty(s.id) || !nonEmpty(s.emoji) || !finite(s.x) || !finite(s.y) || !finite(s.size) || !finite(s.rot)) continue;
    if (!Array.isArray(s.on) || seen.has(s.id) || isBadCustomSticker(s.emoji)) continue;
    seen.add(s.id);
    out.push({
      ...s,
      id: s.id,
      emoji: s.emoji,
      x: clamp(s.x, STICKER_POS_MIN, STICKER_POS_MAX),
      y: clamp(s.y, STICKER_POS_MIN, STICKER_POS_MAX),
      size: clamp(s.size, STICKER_SIZE_MIN, STICKER_SIZE_MAX),
      rot: s.rot,
      on: s.on.filter(nonEmpty),
    });
  }
  return out;
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
  // non-critical: a malformed edit list or sticker list is ignored, the project stays readable
  const cut = parseCut(o.cut);
  const stickers = parseStickers(o.stickers);
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
    ...(cut ? { cut } : {}),
    ...(stickers ? { stickers } : {}),
  };
}

/**
 * Which of `cut` / `stickers` the lenient parse changed on the way in: a malformed field that became
 * `undefined`, or entries that were dropped (a clamp is not a loss). The store keeps a copy of the
 * original file before its next write when this is not empty.
 */
export function droppedEditFields(raw: unknown, parsed: Project): ('cut' | 'stickers')[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const o = raw as Obj;
  const out: ('cut' | 'stickers')[] = [];
  for (const key of ['cut', 'stickers'] as const) {
    const r = o[key];
    if (r === undefined) continue;
    const p = parsed[key];
    if (!Array.isArray(r) || p === undefined || p.length !== r.length) out.push(key);
  }
  return out;
}
