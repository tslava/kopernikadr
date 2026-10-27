import { describe, expect, it, vi } from 'vitest';
import type { ConnectionLike, HelloData } from '../camera/client';
import type { Capture } from '../capture/capture';
import type { NsdAdapter, NsdEvent } from '../discovery';
import { FakeFs } from '../projects/fakeFs.testutil';
import type { SweepReport } from '../projects/sweep';
import type { Transfer } from '../transfer/types';
import { boot } from './boot';

class FakeConn implements ConnectionLike {
  state = 'connecting';
  session: unknown = null;
  #l = new Map<string, Set<(...a: any[]) => void>>();
  on(name: string, fn: (...a: any[]) => void) {
    if (!this.#l.has(name)) this.#l.set(name, new Set());
    this.#l.get(name)!.add(fn);
    return () => this.#l.get(name)!.delete(fn);
  }
  start() {}
  stop() {}
  reconnectNow() {}
  takeOver() {}
  async request() {
    return {};
  }
  hello(h: Partial<HelloData> = {}) {
    const data = { cameraId: 'cam-A', bootId: 'b1', sessionId: 's1', ...h } as HelloData;
    this.state = 'online';
    for (const f of this.#l.get('session') ?? []) f(data);
  }
}

const emptyReport = (): SweepReport => ({
  tmpRemoved: [], projectsExpired: [], projectDirsRemoved: [], projectsReadded: [], projectsRecreated: [],
  namesAligned: [], framesExpired: [], promoted: [], mismatched: [], filesRemoved: [], warnings: [],
});

function rig() {
  const log: string[] = [];
  const conns: FakeConn[] = [];
  const fs = new FakeFs();
  let onEvent: ((e: NsdEvent) => void) | null = null;
  const nsd: NsdAdapter = {
    start: async (_t, cb) => {
      log.push('client.start');
      onEvent = cb;
    },
    stop: async () => {},
  };
  const transfer: Transfer = { enqueue: vi.fn(), ackNow: vi.fn() };
  const reconcile = vi.fn(async () => void log.push('reconcile'));
  return { log, conns, fs, nsd, transfer, reconcile, nsdEvent: (e: NsdEvent) => onEvent!(e) };
}

describe('boot', () => {
  it('runs load -> sweep -> client start, and exposes the context', async () => {
    const r = rig();
    let loadedAtSweep: boolean | undefined;
    const app = await boot({
      fs: r.fs,
      verify: async () => true,
      nsd: r.nsd,
      createTransfer: () => r.transfer,
      reconcile: r.reconcile,
      sweep: async (store) => {
        loadedAtSweep = store.state.get().ready;
        r.log.push('sweep');
        return emptyReport();
      },
    });
    expect(loadedAtSweep).toBe(true);
    expect(r.log.slice(0, 2)).toEqual(['sweep', 'client.start']);
    expect(app.transfer).toBe(r.transfer);
    expect(app.store.state.get().index.clientId).not.toBe('');
    expect(app.client.snapshot.status).toBe('searching');
    app.client.stop();
  });

  it('a failing sweep rejects boot and the client never starts', async () => {
    const r = rig();
    await expect(
      boot({
        fs: r.fs, verify: async () => true, nsd: r.nsd, createTransfer: () => r.transfer, reconcile: r.reconcile,
        sweep: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(r.log).not.toContain('client.start');
  });

  it('on every session: resolveOutstanding (capture), then reconcile; the camera is remembered', async () => {
    const r = rig();
    const capture: Capture = {
      press: async () => {
        throw new Error('unused');
      },
      resolveOutstanding: async () => void r.log.push('resolveOutstanding'),
    };
    const app = await boot({
      fs: r.fs,
      verify: async () => true,
      nsd: r.nsd,
      createTransfer: () => r.transfer,
      reconcile: r.reconcile,
      createCapture: () => capture,
      clientDeps: {
        searchWindowMs: 5,
        createConnection: () => {
          const c = new FakeConn();
          r.conns.push(c);
          return c;
        },
      },
    });
    expect(app.capture).toBe(capture);
    r.nsdEvent({ type: 'found', service: { name: 'cam', host: '10.0.0.7', port: 8765, txt: { id: 'cam-A', pv: '1-1', name: 'cam' } } });
    await vi.waitFor(() => expect(r.conns).toHaveLength(1));
    r.conns[0]!.hello();
    await vi.waitFor(() => expect(app.client.snapshot.reconciling).toBe(false));
    expect(r.log.filter((l) => l !== 'client.start')).toEqual(['resolveOutstanding', 'reconcile']);

    // a second session runs both again, in the same order
    r.conns[0]!.hello({ sessionId: 's2' });
    await vi.waitFor(() => expect(r.reconcile).toHaveBeenCalledTimes(2));
    expect(r.log.filter((l) => l !== 'client.start')).toEqual(['resolveOutstanding', 'reconcile', 'resolveOutstanding', 'reconcile']);

    await app.store.idle();
    expect(app.store.state.get().index.rememberedCamera).toMatchObject({ cameraId: 'cam-A', host: '10.0.0.7', port: 8765 });
    app.client.stop();
  });
});
