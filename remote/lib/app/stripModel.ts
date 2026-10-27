// View-model of the frame strip under the movie: pure functions, no React, no I/O.
import type { Project } from '../projects/model';
import { timeline } from '../projects/timeline';
import type { FrameFileKind } from './frames';

export type TileState = 'ready' | 'off' | 'deleting' | 'unavailable' | 'downloading';

export interface Tile {
  /** The timeline entry (selection and stickers key on it). */
  entryId: string;
  frameId: string;
  state: TileState;
  hold: number;
  /** The selected sticker is shown on this entry. */
  marked: boolean;
}

/** One tile per timeline entry. Priority: deleting > unavailable > off > downloading > ready. */
export function stripTiles(project: Pick<Project, 'frames' | 'cut' | 'stickers'>, stickerId?: string | null): Tile[] {
  const byId = new Map(project.frames.map((f) => [f.frameId, f]));
  const on = new Set(stickerId ? (project.stickers?.find((s) => s.id === stickerId)?.on ?? []) : []);
  return timeline(project).map((e): Tile => {
    const f = byId.get(e.frameId);
    const state: TileState =
      f?.hiddenUntil != null ? 'deleting' : f?.unavailable ? 'unavailable' : e.off ? 'off' : f && f.state !== 'local' ? 'downloading' : 'ready';
    return { entryId: e.id, frameId: e.frameId, state, hold: e.hold, marked: on.has(e.id) };
  });
}

export interface WindowInput {
  count: number;
  scrollLeft: number;
  viewport: number;
  /** Tile width plus gap. */
  pitch: number;
  overscan: number;
}

/** The index window `[start, end)` to render in a horizontal scroller of equal-width tiles. */
export function visibleWindow({ count, scrollLeft, viewport, pitch, overscan }: WindowInput): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const left = Math.max(0, scrollLeft);
  const first = Math.floor(left / pitch);
  const last = Math.ceil((left + viewport) / pitch);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}

/** The selection survives timeline changes by entry id and clears when its entry is gone. */
export function reconcileSelection(selected: string | null, tiles: readonly Tile[]): string | null {
  return selected !== null && tiles.some((t) => t.entryId === selected) ? selected : null;
}

/** thumb, then play, else a placeholder: never `full` (32 MB decoded per tile). */
export function tileImage(
  url: ((projectId: string, frameId: string, kind: FrameFileKind) => string | null | undefined) | undefined,
  projectId: string,
  frameId: string,
): { kind: 'thumb' | 'play'; url: string } | null {
  for (const kind of ['thumb', 'play'] as const) {
    const u = url?.(projectId, frameId, kind);
    if (u) return { kind, url: u };
  }
  return null;
}
