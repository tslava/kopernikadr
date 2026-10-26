import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discover, type NsdAdapter, type NsdEvent } from './discovery';

/** A camera as the native plugin reports it (camera-android TxtRecord / instanceName). */
const cam = (suffix: string, host = `192.168.1.${suffix.length + 20}`) => ({
  name: `Kopernikadr Kamera (${suffix})`,
  host,
  port: 8765,
  txt: { id: `cam-${suffix}`, pv: '1-1', name: 'Kopernikadr Kamera' },
});

/** A fake plugin: `script` runs after start() with an `emit` and the fake clock. */
function fakeAdapter(script: (emit: (e: NsdEvent) => void) => void = () => {}, opts: { start?: () => Promise<void>; stop?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  let listener: ((e: NsdEvent) => void) | null = null;
  const adapter: NsdAdapter = {
    async start(type, onEvent) {
      calls.push(`start ${type}`);
      listener = onEvent;
      await (opts.start?.() ?? Promise.resolve());
      script((e) => listener?.(e));
    },
    async stop() {
      calls.push('stop');
      await (opts.stop?.() ?? Promise.resolve());
      listener = null;
    },
  };
  return { adapter, calls, emit: (e: NsdEvent) => listener?.(e) };
}

/** Runs discover() to completion on fake timers. */
async function run(adapter: NsdAdapter, seconds = 3) {
  const p = discover({ seconds, adapter, now: () => Date.now() });
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('discover', () => {
  it('finds a camera, reports the latency of the first one and stops the plugin', async () => {
    const { adapter, calls } = fakeAdapter((emit) => {
      setTimeout(() => emit({ type: 'found', service: cam('a1b2') }), 420);
    });
    const r = await run(adapter);
    expect(r.services).toEqual([
      { cameraId: 'cam-a1b2', name: 'Kopernikadr Kamera', protocolVersions: { min: 1, max: 1 }, host: '192.168.1.24', port: 8765 },
    ]);
    expect(r.firstFoundMs).toBe(420);
    expect(r.errors).toEqual([]);
    expect(r.durationMs).toBe(3000);
    expect(calls).toEqual(['start _kopernikadr._tcp', 'stop']);
  });

  it('finds nothing: empty list, no latency, no errors', async () => {
    const r = await run(fakeAdapter().adapter, 2);
    expect(r).toEqual({ services: [], firstFoundMs: null, errors: [], durationMs: 2000 });
  });

  it('two cameras, the same camera reported twice (resolve update) is listed once', async () => {
    const { adapter } = fakeAdapter((emit) => {
      setTimeout(() => emit({ type: 'found', service: cam('a1b2') }), 100);
      setTimeout(() => emit({ type: 'found', service: cam('c3d4', '10.0.0.9') }), 300);
      setTimeout(() => emit({ type: 'found', service: { ...cam('a1b2'), host: '192.168.1.99' } }), 500);
    });
    const r = await run(adapter);
    expect(r.services.map((s) => [s.cameraId, s.host])).toEqual([
      ['cam-a1b2', '192.168.1.99'],
      ['cam-c3d4', '10.0.0.9'],
    ]);
    expect(r.firstFoundMs).toBe(100);
  });

  it('a bad TXT is ignored and reported; a good camera after it still counts', async () => {
    const { adapter } = fakeAdapter((emit) => {
      setTimeout(() => emit({ type: 'found', service: { ...cam('dead'), txt: { pv: '1-1' } } }), 50);
      setTimeout(() => emit({ type: 'found', service: { ...cam('beef'), txt: { id: 'x', pv: '2-3' } } }), 60);
      setTimeout(() => emit({ type: 'found', service: cam('a1b2') }), 700);
    });
    const r = await run(adapter);
    expect(r.services.map((s) => s.cameraId)).toEqual(['cam-a1b2']);
    expect(r.firstFoundMs).toBe(700);
    expect(r.errors).toEqual([
      { stage: 'parse', code: 'NO_ID', service: 'Kopernikadr Kamera (dead)', message: expect.stringMatching(/id is missing/) },
      { stage: 'parse', code: 'UNSUPPORTED_PV', service: 'Kopernikadr Kamera (beef)', message: expect.stringMatching(/version 1/) },
    ]);
  });

  it('a lost camera is dropped; native errors are reported', async () => {
    const { adapter } = fakeAdapter((emit) => {
      setTimeout(() => emit({ type: 'found', service: cam('a1b2') }), 100);
      setTimeout(() => emit({ type: 'found', service: cam('c3d4') }), 200);
      setTimeout(() => emit({ type: 'lost', name: 'Kopernikadr Kamera (a1b2).' }), 900);
      setTimeout(() => emit({ type: 'error', stage: 'resolve', code: '3', message: 'resolve failed', service: 'x' }), 950);
    });
    const r = await run(adapter);
    expect(r.services.map((s) => s.cameraId)).toEqual(['cam-c3d4']);
    expect(r.firstFoundMs).toBe(100);
    expect(r.errors).toEqual([{ stage: 'resolve', code: '3', message: 'resolve failed', service: 'x' }]);
  });

  it('events after the window are ignored', async () => {
    const { adapter, emit } = fakeAdapter();
    const r = await run(adapter, 1);
    emit({ type: 'found', service: cam('late') });
    expect(r.services).toEqual([]);
  });

  it('timeout: a start() that never settles ends with the window and is reported', async () => {
    const { adapter, calls } = fakeAdapter(() => {}, { start: () => new Promise(() => {}) });
    const r = await run(adapter, 2);
    expect(r.services).toEqual([]);
    expect(r.durationMs).toBe(2000);
    expect(r.errors).toEqual([{ stage: 'start', message: 'start did not finish within 2 s' }]);
    expect(calls).toEqual(['start _kopernikadr._tcp', 'stop']);
  });

  it('timeout: a stop() that never settles is bounded and reported', async () => {
    const { adapter } = fakeAdapter(() => {}, { stop: () => new Promise(() => {}) });
    const r = await run(adapter, 1);
    expect(r.errors).toEqual([{ stage: 'stop', message: 'stop did not finish within 2 s' }]);
  });

  it('a rejected start() ends early and is reported; stop() still runs', async () => {
    const { adapter, calls } = fakeAdapter(() => {}, { start: () => Promise.reject(new Error('NsdManager error 0')) });
    const r = await run(adapter, 5);
    expect(r.errors).toEqual([{ stage: 'start', message: 'NsdManager error 0' }]);
    expect(r.durationMs).toBe(0);
    expect(calls).toEqual(['start _kopernikadr._tcp', 'stop']);
  });

  it('rejects a bad window', async () => {
    const { adapter } = fakeAdapter();
    await expect(discover({ seconds: 0, adapter })).rejects.toThrow(RangeError);
    await expect(discover({ seconds: Number.NaN, adapter })).rejects.toThrow(RangeError);
  });
});
