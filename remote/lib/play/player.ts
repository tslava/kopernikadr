// rAF-driven playback at the project fps over a Ring. No DOM: the clock and the draw callback are
// injected. Only `local`, available, visible frames play, in `seq` order.

import type { FrameEntry } from '../projects/model';
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
  /** frameId on screen, or null. */
  shown: string | null;
}

export interface PlayerOptions {
  ring: Ring;
  clock: Clock;
  draw: (bitmap: ImageBitmap) => void;
  fps: number;
  loop?: boolean;
  onChange?: (s: PlayerStatus) => void;
}

export interface Player {
  setFrames(frames: readonly FrameEntry[]): void;
  setFps(fps: number): void;
  /** Loop back to the first frame at the end, or stop there. */
  setLoop(on: boolean): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seekToStart(): void;
  /** Pauses and closes every bitmap (before export / on leaving). `play()` or `setFrames` reload lazily. */
  release(): void;
  destroy(): void;
  status(): PlayerStatus;
}

export function playableFrames(frames: readonly FrameEntry[]): FrameEntry[] {
  return frames
    .filter((f) => f.hiddenUntil === null && f.state === 'local' && !f.unavailable)
    .sort((a, b) => a.seq - b.seq);
}

export function createPlayer(o: PlayerOptions): Player {
  let fps = o.fps;
  let loop = o.loop ?? true;
  let ids: string[] = [];
  let downloading = 0;
  let cursor = 0; // index of the next frame to show
  let shown: string | null = null;
  let playing = false;
  let wantShow = false; // draw a frame even while paused (first frames, seek)
  let nextDue = 0;
  let handle: number | null = null;
  let dead = false;
  let last: PlayerStatus | null = null;

  const status = (): PlayerStatus => ({ playing, downloading, playable: ids.length, shown });
  function emit(): void {
    const s = status();
    if (last && last.playing === s.playing && last.downloading === s.downloading && last.playable === s.playable && last.shown === s.shown) return;
    last = s;
    o.onChange?.(s);
  }

  function refill(): void {
    const out: string[] = [];
    for (let i = 0; i < Math.min(RING_SIZE, ids.length); i++) {
      if (cursor + i >= ids.length && !loop) break;
      out.push(ids[(cursor + i) % ids.length]);
    }
    o.ring.want(out);
  }

  function schedule(): void {
    if (dead || handle !== null || !(playing || wantShow) || ids.length === 0) return;
    handle = o.clock.request(tick);
  }

  function tick(): void {
    handle = null;
    if (dead) return;
    const now = o.clock.now();
    const period = 1000 / fps;
    if (ids.length > 0 && (wantShow || (playing && now >= nextDue))) {
      // skip frames that failed to load
      for (let g = 0; g < ids.length && cursor < ids.length && o.ring.failed(ids[cursor]); g++) {
        cursor++;
        if (cursor >= ids.length && loop) cursor = 0;
      }
      const id = cursor < ids.length ? ids[cursor] : null;
      const bmp = id === null ? undefined : o.ring.get(id);
      if (id !== null && bmp) {
        o.draw(bmp);
        shown = id;
        cursor++;
        const lag = now - nextDue;
        // keep the cadence; after a stall (or a seek) restart it from now instead of bursting
        nextDue = !wantShow && playing && lag >= 0 && lag < period ? nextDue + period : now + period;
        wantShow = false;
        if (cursor >= ids.length) {
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
    setFrames(frames) {
      const next = playableFrames(frames).map((f) => f.frameId);
      downloading = frames.filter((f) => f.hiddenUntil === null && f.state !== 'local' && !f.unavailable).length;
      const at = shown === null ? -1 : next.indexOf(shown);
      const hadFrames = ids.length > 0;
      ids = next;
      o.ring.clearFailed();
      if (at >= 0) cursor = at + 1;
      cursor = Math.min(cursor, ids.length);
      if (cursor >= ids.length && loop) cursor = 0;
      // the first frames arrived, or the one on screen is gone: show something
      if (ids.length > 0 && (!hadFrames || (shown !== null && at < 0))) wantShow = true;
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
      if (cursor >= ids.length) cursor = 0;
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
