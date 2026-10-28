import { describe, expect, it } from 'vitest';
import { createSegClient, FakeSegClient, SegError, SegSupersededError, type SegDeps } from './segClient';

const stroke = (x: number) => ({ mode: 'add' as const, points: [[x, 0.5]] as [number, number][] });

function nativeError(code: string): Error {
  return Object.assign(new Error(`native ${code}`), { code });
}

/** A fake native side whose calls can be held open and released by the test. */
function setup(opts: { maskBytes?: (w: number, h: number) => Uint8Array } = {}) {
  const log: string[] = [];
  const gates: Array<() => void> = [];
  const hold = (label: string) =>
    new Promise<void>((resolve) => {
      log.push(`start ${label}`);
      gates.push(resolve);
    });
  const state = { failRun: undefined as unknown, failClose: false, runs: 0 };
  const deps: SegDeps = {
    native: {
      async segOpen(o) {
        log.push(`open ${o.path} ${o.maxSide ?? '-'}`);
        return { handle: `h${log.length}`, image: 'tmp/seg-x.png', width: 4, height: 2, hasAlpha: false };
      },
      async segRun(o) {
        const n = ++state.runs;
        await hold(`run${n}`);
        log.push(`end run${n} ${o.handle} ${JSON.stringify(o.strokes.map((s) => s.points[0][0]))}`);
        if (state.failRun) throw state.failRun;
        return { mask: 'tmp/seg-x.mask', width: 4, height: 2, ms: 12, delegate: 'gpu' };
      },
      async segClose(o) {
        log.push(`close ${o.handle}`);
        if (state.failClose) throw new Error('boom');
      },
    },
    async readBytes() {
      return opts.maskBytes ? opts.maskBytes(4, 2) : new Uint8Array(8).fill(7);
    },
  };
  const release = async () => {
    // let queued microtasks reach the gate, then open the oldest one
    await new Promise((r) => setTimeout(r, 0));
    gates.shift()?.();
  };
  return { deps, log, release, state };
}

describe('segClient', () => {
  it('opens a session and returns the image info', async () => {
    const t = setup();
    const c = createSegClient(t.deps);
    expect(await c.open('tmp/pick-1.jpg')).toEqual({ image: 'tmp/seg-x.png', width: 4, height: 2, hasAlpha: false });
    expect(t.log).toEqual(['open tmp/pick-1.jpg -']);
    await c.open('tmp/pick-2.jpg', 512);
    // the old session is closed first
    expect(t.log.slice(1)).toEqual(['close h1', 'open tmp/pick-2.jpg 512']);
  });

  it('runs and reads the raw mask', async () => {
    const t = setup();
    const c = createSegClient(t.deps);
    await c.open('tmp/p.jpg');
    const p = c.run([stroke(0.25)]);
    await t.release();
    const r = await p;
    expect(r).toMatchObject({ width: 4, height: 2, ms: 12, delegate: 'gpu' });
    expect(Array.from(r.mask)).toEqual(new Array(8).fill(7));
    expect(t.log).toContain('end run1 h1 [0.25]');
  });

  it('serializes runs and lets a newer run supersede a queued one', async () => {
    const t = setup();
    const c = createSegClient(t.deps);
    await c.open('tmp/p.jpg');
    const first = c.run([stroke(0.1)]);
    await new Promise((r) => setTimeout(r, 0));
    const second = c.run([stroke(0.2)]);
    const third = c.run([stroke(0.3)]);
    const secondResult = second.then(
      () => 'ok',
      (e) => e,
    );
    expect(await secondResult).toBeInstanceOf(SegSupersededError);
    await t.release(); // first finishes
    await first;
    await t.release(); // third runs, the second never did
    await third;
    expect(t.state.runs).toBe(2);
    expect(t.log.filter((l) => l.startsWith('end'))).toEqual(['end run1 h1 [0.1]', 'end run2 h1 [0.3]']);
  });

  it('never starts two native calls at once', async () => {
    const t = setup();
    const c = createSegClient(t.deps);
    await c.open('tmp/p.jpg');
    const a = c.run([stroke(0.1)]);
    await new Promise((r) => setTimeout(r, 0)); // the run is in flight
    const closing = c.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.log.filter((l) => l.startsWith('close'))).toEqual([]);
    await t.release();
    await a;
    await closing;
    expect(t.log.at(-1)).toBe('close h1');
  });

  it('maps native rejections to SegError with the code', async () => {
    const t = setup();
    const c = createSegClient(t.deps);
    await c.open('tmp/p.jpg');
    t.state.failRun = nativeError('SEG_FAILED');
    const p = c.run([stroke(0.5)]);
    await t.release();
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(SegError);
    expect(e.code).toBe('SEG_FAILED');

    t.state.failRun = new TypeError('weird');
    const p2 = c.run([stroke(0.5)]);
    await t.release();
    expect((await p2.catch((x) => x)).code).toBe('UNKNOWN');
  });

  it('maps an open failure and keeps no session', async () => {
    const t = setup();
    t.deps.native.segOpen = async () => {
      throw nativeError('UNSUPPORTED');
    };
    const c = createSegClient(t.deps);
    const e = await c.open('tmp/bad.bmp').catch((x) => x);
    expect(e.code).toBe('UNSUPPORTED');
    expect((await c.run([stroke(0.5)]).catch((x) => x)).code).toBe('NO_SESSION');
  });

  it('a run without a session is NO_SESSION, and so is one after the native session vanished', async () => {
    const t = setup();
    const c = createSegClient(t.deps);
    expect((await c.run([stroke(0.5)]).catch((x) => x)).code).toBe('NO_SESSION');
    await c.open('tmp/p.jpg');
    t.state.failRun = nativeError('NO_SESSION');
    const p = c.run([stroke(0.5)]);
    await t.release();
    expect((await p.catch((x) => x)).code).toBe('NO_SESSION');
    // the dead handle is forgotten: close has nothing to send
    t.log.length = 0;
    await c.close();
    expect(t.log).toEqual([]);
  });

  it('rejects a mask of the wrong size', async () => {
    const t = setup({ maskBytes: () => new Uint8Array(3) });
    const c = createSegClient(t.deps);
    await c.open('tmp/p.jpg');
    const p = c.run([stroke(0.5)]);
    await t.release();
    expect((await p.catch((x) => x)).code).toBe('SEG_FAILED');
  });

  it('close is idempotent, never rejects, and cancels a queued run', async () => {
    const t = setup();
    t.state.failClose = true;
    const c = createSegClient(t.deps);
    await c.open('tmp/p.jpg');
    const running = c.run([stroke(0.1)]);
    await new Promise((r) => setTimeout(r, 0));
    const queued = c.run([stroke(0.2)]);
    const queuedResult = queued.catch((x) => x);
    const closing = c.close();
    expect(await queuedResult).toBeInstanceOf(SegSupersededError);
    await t.release();
    await running;
    await closing;
    await c.close();
    expect(t.log.filter((l) => l.startsWith('close'))).toEqual(['close h1']);
    expect((await c.run([stroke(0.3)]).catch((x) => x)).code).toBe('NO_SESSION');
  });
});

describe('FakeSegClient', () => {
  it('records calls and answers by default', async () => {
    const f = new FakeSegClient();
    expect((await f.open('tmp/a.jpg')).hasAlpha).toBe(false);
    expect((await f.run([stroke(0.5)])).delegate).toBe('cpu');
    await f.close();
    expect(f.opened).toEqual(['tmp/a.jpg']);
    expect(f.runs).toHaveLength(1);
    expect(f.closes).toBe(1);
  });
});
