/**
 * Sticker reducers (plan "Stickers"). Pure: ids are injected. A sticker's `on` is a set of cut
 * entry ids, kept in timeline order. Adding or re-ranging materializes `cut` first (ids stay
 * stable: the first entry of a frame has id == frameId either way), so `on` always points at ids
 * that persist. Every reducer returns the SAME reference when nothing changes.
 */
import { normalizeRot } from '../render/stickerGeometry';
import {
  STICKER_POS_MAX,
  STICKER_POS_MIN,
  STICKER_SIZE_MAX,
  STICKER_SIZE_MIN,
  type Project,
  type Sticker,
} from './model';
import { timeline } from './timeline';

export type Pose = Pick<Sticker, 'x' | 'y' | 'size' | 'rot'>;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Clamped to the model ranges; a non-finite value is dropped (the field keeps its value). */
export function clampPose(p: Partial<Pose>): Partial<Pose> {
  const out: Partial<Pose> = {};
  if (Number.isFinite(p.x)) out.x = clamp(p.x!, STICKER_POS_MIN, STICKER_POS_MAX);
  if (Number.isFinite(p.y)) out.y = clamp(p.y!, STICKER_POS_MIN, STICKER_POS_MAX);
  if (Number.isFinite(p.size)) out.size = clamp(p.size!, STICKER_SIZE_MIN, STICKER_SIZE_MAX);
  if (Number.isFinite(p.rot)) out.rot = normalizeRot(p.rot!);
  return out;
}

export const STICKER_DEFAULT: Pose = { x: 0.5, y: 0.5, size: 0.25, rot: 0 };

/**
 * A new sticker on top, shown on `entryId` and every later entry to the end of the movie
 * (what the timeline holds now; frames shot later are not in `on`).
 */
export function addSticker(project: Project, entryId: string, emoji: string, id: string, pose: Partial<Pose> = {}): Project {
  const cut = timeline(project);
  const at = cut.findIndex((e) => e.id === entryId);
  if (at < 0 || !emoji || (project.stickers ?? []).some((s) => s.id === id)) return project;
  const sticker: Sticker = { id, emoji, ...STICKER_DEFAULT, ...clampPose(pose), on: cut.slice(at).map((e) => e.id) };
  return { ...project, cut, stickers: [...(project.stickers ?? []), sticker] };
}

/** Moves/resizes/rotates a sticker; values are clamped. */
export function updateSticker(project: Project, stickerId: string, patch: Partial<Pose>): Project {
  const list = project.stickers;
  const i = list?.findIndex((s) => s.id === stickerId) ?? -1;
  if (!list || i < 0) return project;
  const cur = list[i]!;
  const next = { ...cur, ...clampPose(patch) };
  if (next.x === cur.x && next.y === cur.y && next.size === cur.size && next.rot === cur.rot) return project;
  const out = list.slice();
  out[i] = next;
  return { ...project, stickers: out };
}

export function removeSticker(project: Project, stickerId: string): Project {
  if (!project.stickers?.some((s) => s.id === stickerId)) return project;
  return { ...project, stickers: project.stickers.filter((s) => s.id !== stickerId) };
}

/** The sticker is shown on the entries from `fromEntryId` to `toEntryId` inclusive, in timeline order, either direction. */
export function setRange(project: Project, stickerId: string, fromEntryId: string, toEntryId: string): Project {
  const list = project.stickers;
  const i = list?.findIndex((s) => s.id === stickerId) ?? -1;
  if (!list || i < 0) return project;
  const cut = timeline(project);
  const a = cut.findIndex((e) => e.id === fromEntryId);
  const b = cut.findIndex((e) => e.id === toEntryId);
  if (a < 0 || b < 0) return project;
  const on = cut.slice(Math.min(a, b), Math.max(a, b) + 1).map((e) => e.id);
  const cur = list[i]!;
  const had = new Set(cur.on);
  if (on.length === had.size && on.every((id) => had.has(id))) return project; // same set: the order of `on` carries no meaning
  const out = list.slice();
  out[i] = { ...cur, on };
  return { ...project, cut, stickers: out };
}
