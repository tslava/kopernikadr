import { describe, expect, it } from 'vitest';
import { createStore } from '../state/store';
import { sharedExportFor, type SharedExportEnv } from './sharedExport';

const env = (): SharedExportEnv => ({
  transfer: { async pause() {}, resume() {} },
  exporting: createStore(false),
  createWriter: () => {
    throw new Error('unused');
  },
});

describe('shared export controller', () => {
  it('is one per app: re-entering Play sees the same controller (and its running state)', () => {
    const app = {};
    const a = sharedExportFor(app, env());
    a.controller.state.set({ phase: 'encoding', i: 1, n: 5 });
    const b = sharedExportFor(app, env());
    expect(b).toBe(a);
    expect(b.controller.state.get()).toEqual({ phase: 'encoding', i: 1, n: 5 });
    expect(sharedExportFor({}, env())).not.toBe(a);
  });

  it('a second start through the re-entered screen is refused while exporting', async () => {
    const app = {};
    const e = env();
    const s = sharedExportFor(app, e);
    e.exporting.set(true);
    s.bind({ getProject: () => null, releasePlayer() {}, frameSource: { load: async () => ({}) as ImageBitmap } });
    expect(await sharedExportFor(app, e).controller.start()).toEqual({ started: false, reason: 'busy' });
  });
});
