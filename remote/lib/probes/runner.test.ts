import { describe, expect, it } from 'vitest';
import { ProbeFailure, ProbeSkip, runProbes, summarize, type KeepAwakeAdapter, type Probe, type ProbeUpdate } from './runner';

type Shared = { seen: string[] };

/** A clock that advances 10 ms per read, so every probe takes a predictable time. */
function stepClock(step = 10) {
  let t = 0;
  return () => (t += step);
}

const probe = (name: string, run: Probe<Shared>['run']): Probe<Shared> => ({ name, run });

function fakeKeepAwake(opts: { acquire?: () => Promise<void>; release?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const adapter: KeepAwakeAdapter = {
    async acquire() {
      calls.push('acquire');
      await opts.acquire?.();
    },
    async release() {
      calls.push('release');
      await opts.release?.();
    },
  };
  return { adapter, calls };
}

describe('runProbes', () => {
  it('runs probes in order, one at a time, and shares state between them', async () => {
    const order: string[] = [];
    let active = 0;
    const p = (name: string) =>
      probe(name, async (ctx) => {
        active++;
        expect(active).toBe(1);
        order.push(`start ${name}`);
        ctx.shared.seen.push(name);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${name}`);
        active--;
        return { name, before: [...ctx.shared.seen] };
      });
    const run = await runProbes([p('a'), p('b'), p('c')], { shared: { seen: [] }, now: stepClock() });
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(run.results.map((r) => [r.name, r.ok])).toEqual([['a', true], ['b', true], ['c', true]]);
    expect(run.results[2].data).toEqual({ name: 'c', before: ['a', 'b', 'c'] });
    expect(run.cancelled).toBe(false);
  });

  it('each result is {name, ok, ms, data}, with error on failure', async () => {
    const run = await runProbes(
      [
        probe('good', async () => ({ x: 1 })),
        probe('bad', async () => {
          throw new Error('boom');
        }),
      ],
      { shared: { seen: [] }, now: stepClock() },
    );
    expect(run.results).toEqual([
      { name: 'good', ok: true, ms: 10, data: { x: 1 } },
      { name: 'bad', ok: false, ms: 10, data: null, error: 'boom' },
    ]);
  });

  it('one failure does not stop the others', async () => {
    const ran: string[] = [];
    const run = await runProbes(
      [
        probe('a', async () => void ran.push('a')),
        probe('b', async () => {
          ran.push('b');
          throw new TypeError('bad thing');
        }),
        probe('c', async () => void ran.push('c')),
      ],
      { shared: { seen: [] }, now: stepClock() },
    );
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(run.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(run.results[1].error).toBe('TypeError: bad thing');
  });

  it('ProbeFailure keeps the partial data; ProbeSkip is neither a pass nor a failure', async () => {
    const run = await runProbes(
      [
        probe('partial', async () => {
          throw new ProbeFailure('preview high failed', { low: { fps: 12 } });
        }),
        probe('web', async () => {
          throw new ProbeSkip('native-only', { acked: 2 });
        }),
        probe('thrownString', async () => {
          throw 'plain string';
        }),
      ],
      { shared: { seen: [] }, now: stepClock() },
    );
    expect(run.results).toEqual([
      { name: 'partial', ok: false, ms: 10, data: { low: { fps: 12 } }, error: 'preview high failed' },
      { name: 'web', ok: false, ms: 10, data: { acked: 2 }, skipped: 'native-only' },
      { name: 'thrownString', ok: false, ms: 10, data: null, error: 'plain string' },
    ]);
    expect(summarize(run.results)).toEqual({ total: 3, passed: 0, failed: 2, skipped: 1 });
  });

  it('holds keep-awake for the whole run and releases it after a failure', async () => {
    const { adapter, calls } = fakeKeepAwake();
    await runProbes(
      [
        probe('a', async () => void calls.push('probe a')),
        probe('b', async () => {
          calls.push('probe b');
          throw new Error('x');
        }),
      ],
      { shared: { seen: [] }, keepAwake: adapter },
    );
    expect(calls).toEqual(['acquire', 'probe a', 'probe b', 'release']);
  });

  it('a keep-awake error is recorded but the probes still run', async () => {
    const { adapter, calls } = fakeKeepAwake({
      acquire: () => Promise.reject(new Error('no wake lock')),
      release: () => Promise.reject(new Error('release failed')),
    });
    const run = await runProbes([probe('a', async () => void calls.push('probe a'))], { shared: { seen: [] }, keepAwake: adapter });
    expect(calls).toEqual(['acquire', 'probe a', 'release']);
    expect(run.keepAwake).toEqual({ held: false, error: 'no wake lock', releaseError: 'release failed' });
    expect(run.results[0].ok).toBe(true);
  });

  it('without an adapter keep-awake is reported as not held', async () => {
    const run = await runProbes([], { shared: { seen: [] } });
    expect(run.keepAwake).toEqual({ held: false, error: 'no keep-awake adapter' });
    expect(run.results).toEqual([]);
  });

  it('reports running/done updates for the UI', async () => {
    const updates: ProbeUpdate[] = [];
    await runProbes([probe('a', async () => 1), probe('b', async () => 2)], {
      shared: { seen: [] },
      now: stepClock(),
      onUpdate: (u) => updates.push(u),
    });
    expect(updates).toEqual([
      { name: 'a', state: 'running' },
      { name: 'a', state: 'done', result: { name: 'a', ok: true, ms: 10, data: 1 } },
      { name: 'b', state: 'running' },
      { name: 'b', state: 'done', result: { name: 'b', ok: true, ms: 10, data: 2 } },
    ]);
  });

  it('cancel: the running probe sees the signal, the rest are skipped as cancelled', async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const run = await runProbes(
      [
        probe('a', async (ctx) => {
          ran.push('a');
          ac.abort();
          expect(ctx.signal.aborted).toBe(true);
          throw new Error('aborted inside');
        }),
        probe('b', async () => void ran.push('b')),
      ],
      { shared: { seen: [] }, signal: ac.signal, now: stepClock() },
    );
    expect(ran).toEqual(['a']);
    expect(run.cancelled).toBe(true);
    expect(run.results).toEqual([
      { name: 'a', ok: false, ms: 10, data: null, skipped: 'cancelled', error: 'aborted inside' },
      { name: 'b', ok: false, ms: 0, data: null, skipped: 'cancelled' },
    ]);
  });

  it('passes the prompt adapter and earlier results to each probe', async () => {
    const asked: string[] = [];
    const run = await runProbes(
      [
        probe('a', async () => 'A'),
        probe('b', async (ctx) => {
          const answer = await ctx.prompt('lockScreen');
          return { answer, earlier: ctx.results.map((r) => r.name) };
        }),
      ],
      {
        shared: { seen: [] },
        prompt: async (key) => {
          asked.push(key);
          return 'next';
        },
      },
    );
    expect(asked).toEqual(['lockScreen']);
    expect(run.results[1].data).toEqual({ answer: 'next', earlier: ['a'] });
  });

  it('without a prompt adapter an interactive probe gets "skip"', async () => {
    const run = await runProbes([probe('a', async (ctx) => ctx.prompt('closeCamera'))], { shared: { seen: [] } });
    expect(run.results[0].data).toBe('skip');
  });

  it('records the wall-clock start and the total duration', async () => {
    const run = await runProbes([probe('a', async () => 1)], {
      shared: { seen: [] },
      now: stepClock(),
      wallClock: () => new Date('2026-10-27T07:52:01.000Z'),
    });
    expect(run.startedAt).toBe('2026-10-27T07:52:01.000Z');
    // start, probe start, probe end, finish → 4 reads × 10 ms
    expect(run.durationMs).toBe(30);
  });
});
