import { describe, expect, it } from 'vitest';
import type { CutEntry, FrameEntry } from '../projects/model';
import { createPlayer, playableFrames, timelineOf, type Player } from './player';
import { createRing } from './ring';
import { asBitmap, bmp, FakeClock, flush, frame, type FakeBitmap } from './play.testutil';

/** The old whole-project call: the timeline the app derives from frames (+ optional cut). */
function setFrames(p: Player, frames: FrameEntry[], cut?: CutEntry[]): void {
  const t = timelineOf({ frames, cut });
  p.setTimeline(t.items, t.downloading);
}
const entry = (id: string, frameId: string, hold = 1): CutEntry => ({ id, frameId, hold });

function setup(fps: number, opts: { loop?: boolean; failIds?: string[] } = {}) {
  const clock = new FakeClock();
  const made: Record<string, FakeBitmap> = {};
  const drawn: { id: string; t: number }[] = [];
  const ring = createRing({
    load: async (k) => {
      if (opts.failIds?.includes(k)) throw new Error('boom');
      return asBitmap((made[k] = bmp(k)));
    },
  });
  const player = createPlayer({
    ring,
    clock,
    fps,
    loop: opts.loop,
    draw: (b) => drawn.push({ id: (b as unknown as FakeBitmap).id, t: clock.t }),
  });
  return { clock, made, drawn, ring, player };
}

const four = [frame(1), frame(2), frame(3), frame(4)];

describe('player scheduling', () => {
  for (const fps of [5, 8, 12]) {
    it(`draws at ${fps} fps and loops`, async () => {
      const { clock, drawn, player } = setup(fps);
      setFrames(player, four);
      await flush();
      player.play();
      await clock.advance(2000);
      const period = 1000 / fps;
      expect(drawn.length).toBeGreaterThanOrEqual(Math.floor((2000 / period) * 0.95));
      expect(drawn.length).toBeLessThanOrEqual(Math.ceil(2000 / period) + 2);
      for (let i = 2; i < drawn.length; i++) {
        const dt = drawn[i].t - drawn[i - 1].t;
        expect(Math.abs(dt - period)).toBeLessThanOrEqual(4);
      }
      expect(drawn.slice(0, 6).map((d) => d.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f1', 'f2']);
    });
  }

  it('shows the first frame while paused, and nothing more', async () => {
    const { clock, drawn, player } = setup(8);
    setFrames(player, four);
    await clock.advance(500);
    expect(drawn.map((d) => d.id)).toEqual(['f1']);
    expect(clock.pending).toBe(0);
  });

  it('pauses and resumes where it stopped', async () => {
    const { clock, drawn, player } = setup(12);
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(200);
    player.pause();
    const n = drawn.length;
    await clock.advance(500);
    expect(drawn.length).toBe(n);
    player.play();
    await clock.advance(100);
    expect(drawn[n].id).toBe(`f${(n % 4) + 1}`);
  });

  it('without loop stops after the last frame; seekToStart shows frame 1', async () => {
    const { clock, drawn, player } = setup(12, { loop: false });
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(1000);
    expect(drawn.map((d) => d.id)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(player.status().playing).toBe(false);
    player.seekToStart();
    await clock.advance(50);
    expect(drawn.at(-1)!.id).toBe('f1');
  });

  it('turning loop on after the movie ended: play starts again from frame 1', async () => {
    const { clock, drawn, player } = setup(12, { loop: false });
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(1000);
    expect(player.status().playing).toBe(false);
    player.setLoop(true);
    player.play();
    drawn.length = 0;
    await clock.advance(1000);
    expect(drawn.slice(0, 6).map((d) => d.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f1', 'f2']);
    expect(player.status().playing).toBe(true);
  });

  it('seekToStart while playing restarts from frame 1', async () => {
    const { clock, drawn, player } = setup(8);
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(300);
    player.seekToStart();
    await clock.advance(20);
    expect(drawn.at(-1)!.id).toBe('f1');
  });

  it('waits for a frame that is still decoding instead of skipping it', async () => {
    const clock = new FakeClock();
    const drawn: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ring = createRing({
      load: async (k) => {
        if (k === 'f2') await gate;
        return asBitmap(bmp(k));
      },
    });
    const player = createPlayer({ ring, clock, fps: 12, draw: (b) => drawn.push((b as unknown as FakeBitmap).id) });
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(400);
    expect(drawn).toEqual(['f1']);
    release();
    await clock.advance(40);
    expect(drawn.slice(0, 2)).toEqual(['f1', 'f2']);
  });
});

describe('player frame selection', () => {
  it('skips non-local, unavailable and hidden frames, in seq order, and counts downloads', async () => {
    const { clock, drawn, player } = setup(12);
    setFrames(player, [
      frame(4),
      frame(1),
      frame(2, { state: 'pending' }),
      frame(3, { unavailable: { reason: 'x', since: 'now' } }),
      frame(5, { hiddenUntil: '2030-01-01T00:00:00Z' }),
      frame(6, { state: 'pending', hiddenUntil: '2030-01-01T00:00:00Z' }),
      frame(7, { state: 'pending', unavailable: { reason: 'x', since: 'now' } }),
    ]);
    await flush();
    expect(player.status()).toMatchObject({ playable: 2, downloading: 1 });
    player.play();
    await clock.advance(400);
    expect(drawn.map((d) => d.id).slice(0, 4)).toEqual(['f1', 'f4', 'f1', 'f4']);
    expect(playableFrames([frame(2), frame(1)]).map((f) => f.frameId)).toEqual(['f1', 'f2']);
  });

  it('picks up frames that become local while playing', async () => {
    const { clock, drawn, player } = setup(12);
    setFrames(player, [frame(1), frame(2, { state: 'pending' })]);
    await flush();
    player.play();
    await clock.advance(200);
    expect(new Set(drawn.map((d) => d.id))).toEqual(new Set(['f1']));
    setFrames(player, [frame(1), frame(2)]);
    expect(player.status().downloading).toBe(0);
    await clock.advance(300);
    expect(drawn.some((d) => d.id === 'f2')).toBe(true);
  });

  it('skips a frame that fails to load', async () => {
    const { clock, drawn, player } = setup(12, { failIds: ['f2'] });
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(400);
    expect(drawn.map((d) => d.id).slice(0, 4)).toEqual(['f1', 'f3', 'f4', 'f1']);
  });
});

describe('player timeline', () => {
  /** draws as `entryId:frameId` */
  function rig(fps = 10) {
    const clock = new FakeClock();
    const loads: string[] = [];
    const drawn: { entry: string; frame: string; t: number }[] = [];
    const ring = createRing({
      load: async (k) => {
        loads.push(k);
        return asBitmap(bmp(k));
      },
    });
    const player = createPlayer({
      ring,
      clock,
      fps,
      loop: false,
      draw: (b, entryId) => drawn.push({ entry: entryId, frame: (b as unknown as FakeBitmap).id, t: clock.t }),
    });
    return { clock, loads, drawn, ring, player };
  }
  const three = [frame(1), frame(2), frame(3)];

  it('an entry stays hold ticks', async () => {
    const { clock, drawn, player } = rig(10); // tick = 100 ms
    setFrames(player, three, [entry('f1', 'f1'), entry('f2', 'f2', 3), entry('f3', 'f3', 2)]);
    await flush();
    player.play();
    await clock.advance(1000);
    expect(drawn.map((d) => d.entry)).toEqual(['f1', 'f2', 'f3']);
    const dt = drawn.slice(1).map((d, i) => d.t - drawn[i].t);
    expect(dt.every((v, i) => Math.abs(v - [100, 300][i]) <= 4)).toBe(true);
    expect(player.status().playing).toBe(false);
  });

  it('duplicates share one ring bitmap but show their own entry id', async () => {
    const { clock, loads, drawn, player } = rig(20);
    setFrames(player, three, [entry('f1', 'f1'), entry('d1', 'f1'), entry('f2', 'f2'), entry('d2', 'f1'), { ...entry('f3', 'f3'), off: true }]);
    await flush();
    player.play();
    await clock.advance(400);
    expect(drawn.map((d) => `${d.entry}:${d.frame}`)).toEqual(['f1:f1', 'd1:f1', 'f2:f2', 'd2:f1']);
    expect(loads.filter((k) => k === 'f1')).toHaveLength(1);
    expect(player.status().shown).toBe('d2');
  });

  it('turned-off entries do not play', async () => {
    const { clock, drawn, player } = rig(20);
    setFrames(player, three, [entry('f1', 'f1'), { ...entry('f2', 'f2'), off: true }, entry('f3', 'f3')]);
    await flush();
    player.play();
    await clock.advance(300);
    expect(drawn.map((d) => d.entry)).toEqual(['f1', 'f3']);
    expect(player.status().playable).toBe(2);
  });

  it('seekTo pauses and shows that entry, a duplicate included', async () => {
    const { clock, drawn, player } = rig(20);
    setFrames(player, three, [entry('f1', 'f1'), entry('f2', 'f2'), entry('d2', 'f2'), entry('f3', 'f3')]);
    await flush();
    player.play();
    await clock.advance(30);
    player.seekTo('d2');
    expect(player.status().playing).toBe(false);
    drawn.length = 0;
    await clock.advance(400);
    expect(drawn.map((d) => d.entry)).toEqual(['d2']);
    expect(player.status().shown).toBe('d2');
    player.play(); // continues after the seeked entry
    await clock.advance(200);
    expect(drawn.map((d) => d.entry)).toEqual(['d2', 'f3']);
  });

  it('seekTo an unknown entry changes nothing', async () => {
    const { clock, drawn, player } = rig(20);
    setFrames(player, three);
    await clock.advance(100);
    player.seekTo('nope');
    await clock.advance(100);
    expect(drawn.map((d) => d.entry)).toEqual(['f1']);
  });

  it('a new timeline keeps the position by entry id', async () => {
    const { clock, drawn, player } = rig(20);
    setFrames(player, three);
    await flush();
    player.play();
    await clock.advance(60); // f1, f2 shown
    player.pause();
    expect(player.status().shown).toBe('f2');
    setFrames(player, three, [entry('f1', 'f1'), entry('x', 'f3'), entry('f2', 'f2'), entry('f3', 'f3')]);
    player.play();
    drawn.length = 0;
    await clock.advance(200);
    expect(drawn.map((d) => d.entry)).toEqual(['f3']); // continues after f2
  });
});

describe('player memory', () => {
  it('keeps at most 8 bitmaps open over a long project and closes evicted ones', async () => {
    const { clock, made, ring, player } = setup(12);
    setFrames(player, Array.from({ length: 100 }, (_, i) => frame(i + 1)));
    await flush();
    player.play();
    for (let i = 0; i < 10; i++) {
      await clock.advance(500);
      const open = Object.values(made).filter((b) => !b.closed).length;
      expect(open).toBeLessThanOrEqual(8);
      expect(ring.size).toBeLessThanOrEqual(8);
    }
    expect(made.f1.closed).toBe(true);
  });

  it('release closes all, stops playing, and play reloads', async () => {
    const { clock, made, drawn, player } = setup(12);
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(100);
    const first = { ...made };
    player.release();
    expect(Object.values(first).every((b) => b.closed)).toBe(true);
    expect(player.status().playing).toBe(false);
    expect(clock.pending).toBe(0);
    const n = drawn.length;
    player.play();
    await clock.advance(100);
    expect(drawn.length).toBeGreaterThan(n);
  });

  it('destroy closes all and cancels the loop', async () => {
    const { clock, made, player } = setup(12);
    setFrames(player, four);
    await flush();
    player.play();
    await clock.advance(50);
    player.destroy();
    expect(Object.values(made).every((b) => b.closed)).toBe(true);
    expect(clock.pending).toBe(0);
  });
});
