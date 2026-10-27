// Onion skin source selection (plan Task 13). Pure: the caller injects the file lookup.
import type { FrameEntry } from '../projects/model';

export type OnionKind = 'play' | 'thumb';
export type OnionSource = { kind: OnionKind; frameId: string; url: string } | null;

/** URL of a LOCAL file of a frame variant, or null when that file does not exist. */
export type FrameUrl = (projectId: string, frameId: string, kind: OnionKind) => string | null;

/** The newest (highest seq) frame that is `local` and not hidden by a pending undo. */
export function lastLocalFrame(frames: readonly FrameEntry[], now: number = Date.now()): FrameEntry | null {
  let best: FrameEntry | null = null;
  for (const f of frames) {
    if (f.state !== 'local') continue;
    if (f.hiddenUntil && Date.parse(f.hiddenUntil) > now) continue;
    if (!best || f.seq > best.seq) best = f;
  }
  return best;
}

/** The last local frame's `play`, else its `thumb`, else null ("no frames yet"). */
export function selectOnionSource(projectId: string, frames: readonly FrameEntry[], frameUrl: FrameUrl, now?: number): OnionSource {
  const f = lastLocalFrame(frames, now);
  if (!f) return null;
  for (const kind of ['play', 'thumb'] as const) {
    const url = frameUrl(projectId, f.frameId, kind);
    if (url) return { kind, frameId: f.frameId, url };
  }
  return null;
}

export const ONION_OPACITY_MIN = 10;
export const ONION_OPACITY_MAX = 80;
export const ONION_OPACITY_DEFAULT = 30;

/** Slider percent -> CSS opacity, clamped to the slider range. */
export function onionOpacityValue(percent: number): number {
  const p = Number.isFinite(percent) ? percent : ONION_OPACITY_DEFAULT;
  return Math.min(ONION_OPACITY_MAX, Math.max(ONION_OPACITY_MIN, p)) / 100;
}
