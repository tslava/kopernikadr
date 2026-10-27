import { describe, expect, it } from 'vitest';
import { createStore } from '../state/store';
import { createBootRunner, type BootStateLike } from './bootRunner';

describe('boot runner', () => {
  it('memoises, shows the failure, and retry re-runs boot', async () => {
    const state = createStore<BootStateLike<string>>({ phase: 'booting' });
    let calls = 0;
    let fail = true;
    const r = createBootRunner(state, async () => {
      calls++;
      if (fail) throw new Error('disk full');
      return 'app';
    });
    await Promise.all([r.start(), r.start()]);
    expect(calls).toBe(1);
    expect(state.get()).toEqual({ phase: 'failed', error: 'disk full' });
    fail = false;
    const p = r.retry();
    expect(state.get()).toEqual({ phase: 'booting' });
    await p;
    expect(calls).toBe(2);
    expect(state.get()).toEqual({ phase: 'ready', app: 'app' });
    await r.retry(); // not failed: no new boot
    expect(calls).toBe(2);
  });
});
