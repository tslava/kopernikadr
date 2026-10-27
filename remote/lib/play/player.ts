// rAF-driven playback at the project fps over a Ring. No DOM: the clock and the draw callback are
// injected. It plays a timeline of entries (see lib/projects/timeline.ts `playableItems`): an entry
// stays on screen `hold` ticks; entries that share a frame share one ring bitmap.

import type { FrameEntry, Project } from '../projects/model';
import { downloadingCount, playableItems } from '../projects/timeline';
import { RING_SIZE, type Ring } from './ring';

export interface Clock {
  now(): number;
  request(cb: () => void): number;
  cancel(handle: number): void;
}

export interface PlayerStatus {
  playing: boolean;
  /** Visible frames that are not `unavailable` and not downloaded yet. */
  downloading: number;
  playable: number;
  /** entryId on screen, or null. */
  shown: string | null;
}

/** One step of the movie: which frame, for how many ticks (1/fps each). */
export interface TimelineItem {
  entryId: string;
  frameId: string;
  hold: number;
}

export interface PlayerOptions {
  ring: Ring;
  clock: Clock;
  /** `entryId` drives the sticker canvas (the bitmap itself is closed by the ring soon after). */
  draw: (bitmap: ImageBitmap, entryId: string) => void;
  fps: number;
  loop?: boolean;
  onChange?: (s: PlayerStatus) => void;
}

export interface Player {
  /** Replaces what plays. `downloading` is how many wanted frames are still on their way. */
  setTimeline(items: readonly TimelineItem[], downloading?: number): void;
  setFps(fps: number): void;
  /** Loop back to the first frame at the end, or stop there. */
  setLoop(on: boolean): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seekToStart(): void;
  /** Pauses and shows that entry (the strip). Unknown entry: nothing happens. */
  seekTo(entryId: string): void;
  /** Pauses and closes every bitmap (before export / on leaving). `play()` or `setTimeline` reload lazily. */
  release(): void;
  destroy(): void;
  status(): PlayerStatus;
}

/** What the player gets from a project: the on, local, visible, available entries, and how many frames are still coming. */
export function timelineOf(project: Pick<Project, 'frames' | 'cut'>): { items: TimelineItem[]; downloading: number } {
  return {
    items: playableItems(project).map((e) => ({ entryId: e.id, frameId: e.frameId, hold: e.hold })),
    downloading: downloadingCount(project),
  };
}

export function playableFrames(frames: readonly FrameEntry[]): FrameEntry[] {
  return frames
    .filter((f) => f.hiddenUntil === null && f.state === 'local' && !f.unavailable)
    .sort((a, b) => a.seq - b.seq);
}

export function createPlayer(o: PlayerOptions): Player {
  let fps = o.fps;
  let loop = o.loop ?? true;
  let items: TimelineItem[] = [];
  let downloading = 0;
  let cursor = 0; // index of the next frame to show
  let shown: string | null = null;
  let playing = false;
  let wantShow = false; // draw a frame even while paused (first frames, seek)
  let nextDue = 0;
  let handle: number | null = null;
  let dead = false;
  let last: PlayerStatus | null = null;

  const status = (): PlayerStatus => ({ playing, downloading, playable: items.length, shown });
  function emit(): void {
    const s = status();
    if (last && last.playing === s.playing && last.downloading === s.downloading && last.playable === s.playable && last.shown === s.shown) return;
    last = s;
    o.onChange?.(s);
  }

  function refill(): void {
    const out = new Set<string>(); // duplicates share one bitmap
    for (let i = 0; i < items.length && out.size < RING_SIZE; i++) {
      if (cursor + i >= items.length && !loop) break;
      out.add(items[(cursor + i) % items.length].frameId);
    }
    o.ring.want([...out]);
  }

  function schedule(): void {
    if (dead || handle !== null || !(playing || wantShow) || items.length === 0) return;
    handle = o.clock.request(tick);
  }

  function tick(): void {
    handle = null;
    if (dead) return;
    const now = o.clock.now();
    const period = 1000 / fps;
    if (items.length > 0 && (wantShow || (playing && now >= nextDue))) {
      // skip frames that failed to load
      for (let g = 0; g < items.length && cursor < items.length && o.ring.failed(items[cursor].frameId); g++) {
        cursor++;
        if (cursor >= items.length && loop) cursor = 0;
      }
      const item = cursor < items.length ? items[cursor] : null;
      const bmp = item === null ? undefined : o.ring.get(item.frameId);
      if (item !== null && bmp) {
        o.draw(bmp, item.entryId);
        shown = item.entryId;
        cursor++;
        const lag = now - nextDue;
        const span = item.hold * period;
        // keep the cadence; after a stall (or a seek) restart it from now instead of bursting
        nextDue = !wantShow && playing && lag >= 0 && lag < period ? nextDue + span : now + span;
        wantShow = false;
        if (cursor >= items.length) {
          if (loop) cursor = 0;
          else playing = false;
        }
        refill();
      }
      // else: not decoded yet; the previous frame stays and the next tick retries
    }
    emit();
    schedule();
  }

  return {
    setTimeline(next, wait = 0) {
      downloading = wait;
      const at = shown === null ? -1 : next.findIndex((i) => i.entryId === shown);
      const hadFrames = items.length > 0;
      items = [...next];
      o.ring.clearFailed();
      if (at >= 0) cursor = at + 1;
      cursor = Math.min(cursor, items.length);
      if (cursor >= items.length && loop) cursor = 0;
      // the first frames arrived, or the one on screen is gone: show something
      if (items.length > 0 && (!hadFrames || (shown !== null && at < 0))) wantShow = true;
      refill();
      emit();
      schedule();
    },
    setFps(v) {
      fps = v;
    },
    setLoop(v) {
      loop = v;
      refill();
    },
    play() {
      if (playing || dead) return;
      playing = true;
      nextDue = o.clock.now();
      // at the end (a non-looping run finished, maybe before loop was turned on): start over
      if (cursor >= items.length) cursor = 0;
      refill();
      emit();
      schedule();
    },
    pause() {
      playing = false;
      emit();
    },
    toggle() {
      if (playing) this.pause();
      else this.play();
    },
    seekToStart() {
      cursor = 0;
      wantShow = true;
      nextDue = o.clock.now();
      refill();
      schedule();
    },
    seekTo(entryId) {
      const at = items.findIndex((i) => i.entryId === entryId);
      if (at < 0 || dead) return;
      playing = false;
      cursor = at;
      wantShow = true;
      nextDue = o.clock.now();
      refill();
      emit();
      schedule();
    },
    release() {
      playing = false;
      wantShow = false;
      shown = null;
      o.ring.release();
      if (handle !== null) o.clock.cancel(handle);
      handle = null;
      emit();
    },
    destroy() {
      dead = true;
      playing = false;
      if (handle !== null) o.clock.cancel(handle);
      handle = null;
      o.ring.release();
    },
    status,
  };
}
