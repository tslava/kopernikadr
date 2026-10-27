import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NsdAdapter, NsdEvent } from '../discovery';
import { CameraClient, type CameraClientDeps, type ClientEvent, type ConnectionLike, type HelloData } from './client';
import { parseAddress, selectTarget, verifyManual, type RememberedCamera } from './discover';

// --- fakes ---

class FakeConn implements ConnectionLike {
  state = 'connecting';
  session: unknown = null;
  started = false;
  stopped = false;
  reconnects = 0;
  takeovers = 0;
  requests: Array<[string, unknown]> = [];
  #l = new Map<string, Set<(...a: any[]) => void>>();
  constructor(readonly url: string, readonly clientId: string) {}
  on(name: string, fn: (...a: any[]) => void) {
    if (!this.#l.has(name)) this.#l.set(name, new Set());
    this.#l.get(name)!.add(fn);
    return () => this.#l.get(name)!.delete(fn);
  }
  emit(name: string, ...a: any[]) {
    for (const f of [...(this.#l.get(name) ?? [])]) f(...a);
  }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  reconnectNow() { this.reconnects++; }
  takeOver() { this.takeovers++; }
  async request(op: string, args?: object) {
    this.requests.push([op, args]);
    return { op };
  }
  setState(s: string, detail = {}) { this.state = s; this.emit('state', s, detail); }
  /** As CameraConnection does: state 'online', then 'session'. */
  hello(h: Partial<HelloData> = {}) {
    const data = { cameraId: 'cam-A', bootId: 'boot-1', sessionId: 's-' + Math.random(), ...h } as HelloData;
    this.state = 'online';
    this.session = data;
    this.emit('state', 'online', {});
    this.emit('session', data);
    return data;
  }
}

class FakeNsd implements NsdAdapter {
  onEvent: ((e: NsdEvent) => void) | null = null;
  stopped = false;
  async start(_t: string, onEvent: (e: NsdEvent) => void) { this.onEvent = onEvent; }
  async stop() { this.stopped = true; }
  found(name: string, cameraId: string, host: string, port = 8765) {
    this.onEvent!({ type: 'found', service: { name, host, port, txt: { id: cameraId, pv: '1-1', name } } });
  }
  lost(name: string) { this.onEvent!({ type: 'lost', name }); }
}

const A: RememberedCamera = { cameraId: 'cam-A', host: '10.0.0.5', port: 8765 };

interface Rig {
  client: CameraClient;
  nsd: FakeNsd;
  conns: FakeConn[];
  saved: RememberedCamera[];
  log: string[];
  events: ClientEvent[];
  conn: () => FakeConn;
}

function rig(over: Partial<CameraClientDeps> = {}): Rig {
  const nsd = new FakeNsd();
  const conns: FakeConn[] = [];
  const saved: RememberedCamera[] = [];
  const log: string[] = [];
  const events: ClientEvent[] = [];
  const client = new CameraClient({
    clientId: 'client-1',
    saveRememberedCamera: (c) => void saved.push(c),
    resolveOutstanding: () => void log.push('resolve'),
    reconcile: () => void log.push('reconcile'),
    nsd,
    createConnection: (url, id) => {
      const c = new FakeConn(url, id);
      conns.push(c);
      return c;
    },
    searchWindowMs: 1000,
    ...over,
  });
  client.onEvent((e) => events.push(e));
  return { client, nsd, conns, saved, log, events, conn: () => conns[conns.length - 1] };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// --- pure selection ---

describe('selectTarget matrix', () => {
  const svc = (cameraId: string, host: string) => ({ cameraId, name: cameraId, protocolVersions: { min: 1, max: 1 }, host, port: 8765 });
  const sel = (i: Partial<Parameters<typeof selectTarget>[0]>) =>
    selectTarget({ requiredCameraId: null, remembered: null, found: [], settled: false, ...i });

  it('bound project: that camera from NSD', () => {
    const r = sel({ requiredCameraId: 'B', remembered: A, found: [svc('A', '1.1.1.1'), svc('B', '2.2.2.2')] });
    expect(r).toEqual({ kind: 'target', target: { cameraId: 'B', host: '2.2.2.2', port: 8765, source: 'nsd' } });
  });
  it('bound project: the remembered camera only if it is that camera', () => {
    expect(sel({ requiredCameraId: 'cam-A', remembered: A })).toMatchObject({ kind: 'target', target: { source: 'remembered', host: '10.0.0.5' } });
    expect(sel({ requiredCameraId: 'B', remembered: A, found: [svc('A', '1.1.1.1')] })).toEqual({ kind: 'searching' });
    expect(sel({ requiredCameraId: 'B', remembered: A, found: [svc('A', '1.1.1.1')], settled: true })).toEqual({ kind: 'connect' });
  });
  it('unbound: remembered first, at its NSD address if seen', () => {
    expect(sel({ remembered: A, found: [svc('X', '9.9.9.9')] })).toMatchObject({ target: { cameraId: 'cam-A', source: 'remembered' } });
    expect(sel({ remembered: A, found: [svc('cam-A', '10.0.0.77')] })).toMatchObject({ target: { host: '10.0.0.77', source: 'nsd' } });
  });
  it('unbound, nothing remembered: the single camera, once settled', () => {
    expect(sel({ found: [svc('A', '1.1.1.1')] })).toEqual({ kind: 'searching' });
    expect(sel({ found: [svc('A', '1.1.1.1')], settled: true })).toMatchObject({ kind: 'target', target: { cameraId: 'A' } });
  });
  it('unbound: the remembered camera is not around but exactly one other is → that one, once settled', () => {
    expect(sel({ remembered: A, found: [svc('X', '9.9.9.9')], settled: true })).toMatchObject({ target: { cameraId: 'X', source: 'nsd' } });
    expect(sel({ remembered: A, settled: true })).toMatchObject({ target: { cameraId: 'cam-A', source: 'remembered' } });
    expect(sel({ remembered: A, found: [svc('X', '9.9.9.9'), svc('Y', '8.8.8.8')], settled: true })).toMatchObject({ target: { cameraId: 'cam-A' } });
    // a bound project never switches cameras on its own
    expect(sel({ requiredCameraId: 'cam-A', remembered: A, found: [svc('X', '9.9.9.9')], settled: true })).toMatchObject({ target: { cameraId: 'cam-A' } });
  });
  it('unbound: none or several found → connect screen', () => {
    expect(sel({ settled: true })).toEqual({ kind: 'connect' });
    expect(sel({ found: [svc('A', '1.1.1.1'), svc('B', '2.2.2.2')], settled: true })).toEqual({ kind: 'connect' });
  });
});

describe('manual address', () => {
  it('parses host, host:port, [v6]:port', () => {
    expect(parseAddress('192.168.1.5')).toEqual({ host: '192.168.1.5', port: 8765 });
    expect(parseAddress('http://cam.local:9000/x')).toEqual({ host: 'cam.local', port: 9000 });
    expect(parseAddress('[fe80::1]:1234')).toEqual({ host: 'fe80::1', port: 1234 });
    expect(parseAddress('a:99999')).toBeNull();
  });
  const info = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
  const good = { cameraId: 'cam-A', name: 'Moto', bootId: 'b1', protocolVersions: { min: 1, max: 1 } };
  it('validates with GET /info', async () => {
    const f = vi.fn(info(good));
    const r = await verifyManual('10.0.0.5:8765', { fetch: f });
    expect(r).toMatchObject({ ok: true, target: { cameraId: 'cam-A', host: '10.0.0.5', port: 8765, source: 'manual' } });
    expect(f.mock.calls[0][0]).toBe('http://10.0.0.5:8765/info');
  });
  it('rejects bad address, HTTP error, junk body, wrong protocol, wrong camera, network failure', async () => {
    expect(await verifyManual('::: x')).toMatchObject({ reason: 'invalid-address' });
    expect(await verifyManual('h', { fetch: info({}, false) })).toMatchObject({ reason: 'bad-response' });
    expect(await verifyManual('h', { fetch: info({ hello: 1 }) })).toMatchObject({ reason: 'bad-response' });
    expect(await verifyManual('h', { fetch: info({ ...good, protocolVersions: { min: 2, max: 3 } }) })).toMatchObject({ reason: 'unsupported-version' });
    expect(await verifyManual('h', { fetch: info(good), requiredCameraId: 'B' })).toMatchObject({ reason: 'wrong-camera' });
    const down = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await verifyManual('h', { fetch: down })).toMatchObject({ reason: 'unreachable' });
  });
});

// --- client ---

describe('CameraClient target selection', () => {
  it('connects to the remembered camera at once, one connection', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    expect(r.conns).toHaveLength(1);
    expect(r.conn().url).toBe('ws://10.0.0.5:8765/ws/control');
    expect(r.conn().clientId).toBe('client-1');
    expect(r.conn().started).toBe(true);
    expect(r.client.snapshot.status).toBe('connecting');
  });

  it('bound project ignores a different remembered camera and waits for NSD', async () => {
    const r = rig({ remembered: A, requiredCameraId: 'cam-B' });
    r.client.start();
    expect(r.conns).toHaveLength(0);
    expect(r.client.snapshot).toMatchObject({ status: 'searching', needsConnect: false });
    r.nsd.found('cam-A-svc', 'cam-A', '10.0.0.5');
    expect(r.conns).toHaveLength(0);
    r.nsd.found('cam-B-svc', 'cam-B', '10.0.0.9');
    expect(r.conn().url).toBe('ws://10.0.0.9:8765/ws/control');
  });

  it('single camera found: connects after the search window; none: asks for the connect screen', async () => {
    const r = rig();
    r.client.start();
    r.nsd.found('only', 'cam-A', '10.0.0.5');
    expect(r.conns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.conns).toHaveLength(1);

    const r2 = rig();
    r2.client.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r2.conns).toHaveLength(0);
    expect(r2.client.snapshot).toMatchObject({ status: 'searching', needsConnect: true });
  });

  it('two cameras and nothing remembered: connect screen with the list', async () => {
    const r = rig();
    r.client.start();
    r.nsd.found('a', 'cam-A', '10.0.0.5');
    r.nsd.found('b', 'cam-B', '10.0.0.6');
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.conns).toHaveLength(0);
    expect(r.client.snapshot.needsConnect).toBe(true);
    expect(r.client.snapshot.found.map((s) => s.cameraId)).toEqual(['cam-A', 'cam-B']);
  });

  it('a remembered camera that moved: retargets to the NSD address while not online', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    const first = r.conn();
    r.nsd.found('a', 'cam-A', '10.0.0.77');
    expect(first.stopped).toBe(true);
    expect(r.conns).toHaveLength(2);
    expect(r.conn().url).toBe('ws://10.0.0.77:8765/ws/control');
  });

  it('remembered camera gone, the only camera around is another one: switches to it after the window', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    const first = r.conn();
    r.nsd.found('kid', 'cam-K', '10.0.0.34');
    expect(r.conns).toHaveLength(1); // still trying the remembered one inside the window
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.stopped).toBe(true);
    expect(r.conn().url).toBe('ws://10.0.0.34:8765/ws/control');
  });

  it('connectTo: a tapped found camera replaces the current one; refused for unknown or wrong-project cameras', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().hello();
    r.nsd.found('b', 'cam-B', '10.0.0.6');
    expect(r.client.connectTo('nope')).toBe(false);
    expect(r.client.connectTo('cam-B')).toBe(true);
    expect(r.conns).toHaveLength(2);
    expect(r.conns[0].stopped).toBe(true);
    expect(r.conn().url).toBe('ws://10.0.0.6:8765/ws/control');
    r.conn().hello({ cameraId: 'cam-B' });
    expect(r.saved.at(-1)).toEqual({ cameraId: 'cam-B', host: '10.0.0.6', port: 8765 });

    const bound = rig({ requiredCameraId: 'cam-A' });
    bound.client.start();
    bound.nsd.found('b', 'cam-B', '10.0.0.6');
    expect(bound.client.connectTo('cam-B')).toBe(false);
  });

  it('an NSD change never drops an online session', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().hello();
    r.nsd.found('a', 'cam-A', '10.0.0.77');
    expect(r.conns).toHaveLength(1);
    expect(r.conn().stopped).toBe(false);
  });

  it('manual address: validated with /info, then connects; saves it as remembered', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ cameraId: 'cam-M', bootId: 'b', protocolVersions: { min: 1, max: 1 } }) })) as unknown as typeof fetch;
    const r = rig({ fetch: fetchFn });
    r.client.start();
    const res = await r.client.connectManual('192.168.0.9:9001');
    expect(res.ok).toBe(true);
    expect(r.conn().url).toBe('ws://192.168.0.9:9001/ws/control');
    r.conn().hello({ cameraId: 'cam-M' });
    expect(r.saved).toEqual([{ cameraId: 'cam-M', host: '192.168.0.9', port: 9001 }]);
  });

  it('manual address of the wrong camera for a bound project is refused without connecting', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ cameraId: 'cam-M', bootId: 'b', protocolVersions: { min: 1, max: 1 } }) })) as unknown as typeof fetch;
    const r = rig({ fetch: fetchFn, requiredCameraId: 'cam-A' });
    r.client.start();
    expect(await r.client.connectManual('1.2.3.4')).toMatchObject({ ok: false, reason: 'wrong-camera' });
    expect(r.conns).toHaveLength(0);
  });

  it('saves rememberedCamera only when it changed; a failing save does not break anything', async () => {
    const r = rig({ remembered: A, saveRememberedCamera: () => { throw new Error('disk'); } });
    r.client.start();
    r.conn().hello({ cameraId: 'cam-A' });
    expect(r.events.some((e) => e.type === 'remembered')).toBe(false); // unchanged: no save
    r.conn().hello({ cameraId: 'cam-Z' }); // camera at the same address is another one
    expect(r.events.filter((e) => e.type === 'remembered')).toHaveLength(1);
    expect(r.client.snapshot.status).toBe('online');
  });

  it('setRequiredCameraId drops the connection and selects again', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    const first = r.conn();
    r.client.setRequiredCameraId('cam-B');
    expect(first.stopped).toBe(true);
    expect(r.client.snapshot.status).toBe('searching');
    r.nsd.found('b', 'cam-B', '10.0.0.9');
    expect(r.conn().url).toContain('10.0.0.9');
  });

  it('stop() stops connection and discovery', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.client.stop();
    expect(r.conn().stopped).toBe(true);
    await flush();
    expect(r.nsd.stopped).toBe(true);
  });
});

describe('CameraClient status', () => {
  it('maps connection states and stays online only after the session', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    expect(r.client.snapshot.status).toBe('connecting');
    r.conn().hello();
    expect(r.client.snapshot).toMatchObject({ status: 'online', hello: { cameraId: 'cam-A' } });
    expect(r.client.session?.bootId).toBe('boot-1');
    r.conn().setState('offline');
    expect(r.client.snapshot.status).toBe('offline');
    expect(r.client.session).toBeNull();
    r.conn().hello();
    expect(r.client.snapshot.status).toBe('online');
    expect(r.conns).toHaveLength(1); // one connection, its own loop reconnected
  });

  it('BUSY: status busy with retryAfterMs, then online', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().setState('busy', { retryAfterMs: 2500 });
    expect(r.client.snapshot).toMatchObject({ status: 'busy', retryAfterMs: 2500 });
    r.conn().hello();
    expect(r.client.snapshot).toMatchObject({ status: 'online', retryAfterMs: undefined });
  });

  it('unsupported protocol is reported as offline + flag', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().setState('unsupported');
    expect(r.client.snapshot).toMatchObject({ status: 'offline', unsupported: true });
  });

  it('request() passes through while online, rejects CLOSED otherwise', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    await expect(r.client.request('getStatus')).rejects.toMatchObject({ code: 'CLOSED' });
    r.conn().hello();
    await expect(r.client.request('capture', { projectId: 'p' })).resolves.toEqual({ op: 'capture' });
    expect(r.conn().requests).toEqual([['capture', { projectId: 'p' }]]);
  });
});

describe('wrong camera', () => {
  it('hello cameraId differs from the project camera: wrong-camera, connection stopped, no hooks', async () => {
    const r = rig({ remembered: { ...A, cameraId: 'cam-B' }, requiredCameraId: 'cam-B' });
    r.client.start();
    const c = r.conn();
    c.hello({ cameraId: 'cam-A' });
    await flush();
    expect(r.client.snapshot.status).toBe('wrong-camera');
    expect(r.client.session).toBeNull();
    expect(c.stopped).toBe(true);
    expect(r.log).toEqual([]);
    await expect(r.client.request('capture')).rejects.toMatchObject({ code: 'CLOSED' });
    expect(r.saved).toEqual([]);
    // an NSD event for the same wrong address does not reconnect to it
    r.nsd.found('x', 'cam-A', '10.0.0.5');
    expect(r.conns).toHaveLength(1);
  });

  it('recovers when NSD shows the right camera elsewhere', async () => {
    const r = rig({ remembered: { ...A, cameraId: 'cam-B' }, requiredCameraId: 'cam-B' });
    r.client.start();
    r.conn().hello({ cameraId: 'cam-A' });
    r.nsd.found('b', 'cam-B', '10.0.0.9');
    expect(r.conns).toHaveLength(2);
    expect(r.client.snapshot.status).toBe('connecting');
    r.conn().hello({ cameraId: 'cam-B' });
    await flush();
    expect(r.client.snapshot.status).toBe('online');
    expect(r.log).toEqual(['resolve', 'reconcile']);
  });

  it('resume retries a wrong-camera target', async () => {
    const r = rig({ remembered: { ...A, cameraId: 'cam-B' }, requiredCameraId: 'cam-B' });
    r.client.start();
    r.conn().hello({ cameraId: 'cam-A' });
    r.client.resume();
    expect(r.conns).toHaveLength(2);
  });
});

describe('session hooks', () => {
  it('run resolveOutstanding then reconcile, sequentially (reconcile waits for resolve)', async () => {
    const log: string[] = [];
    let release!: () => void;
    const r = rig({
      remembered: A,
      resolveOutstanding: async () => { log.push('resolve:start'); await new Promise<void>((res) => (release = res)); log.push('resolve:end'); },
      reconcile: () => void log.push('reconcile'),
    });
    r.client.start();
    r.conn().hello();
    await flush();
    expect(log).toEqual(['resolve:start']);
    expect(r.client.snapshot.reconciling).toBe(true);
    release();
    await flush();
    expect(log).toEqual(['resolve:start', 'resolve:end', 'reconcile']);
    expect(r.client.snapshot.reconciling).toBe(false);
  });

  it('run on EVERY session, also a reconnect with the same bootId', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().hello({ bootId: 'same' });
    await flush();
    r.conn().setState('offline');
    r.conn().hello({ bootId: 'same' });
    await flush();
    r.conn().setState('offline');
    r.conn().hello({ bootId: 'same' });
    await flush();
    expect(r.log).toEqual(['resolve', 'reconcile', 'resolve', 'reconcile', 'resolve', 'reconcile']);
    expect(r.events.some((e) => e.type === 'bootIdChanged')).toBe(false);
  });

  it('hook errors do not break the loop; reconcile still runs, next session still hooks', async () => {
    const log: string[] = [];
    const r = rig({
      remembered: A,
      resolveOutstanding: () => { log.push('resolve'); throw new Error('boom'); },
      reconcile: async () => { log.push('reconcile'); throw new Error('boom2'); },
    });
    r.client.start();
    r.conn().hello();
    await flush();
    r.conn().setState('offline');
    r.conn().hello();
    await flush();
    expect(log).toEqual(['resolve', 'reconcile', 'resolve', 'reconcile']);
    expect(r.events.filter((e) => e.type === 'hookError')).toHaveLength(4);
    expect(r.client.snapshot).toMatchObject({ status: 'online', reconciling: false });
  });

  it('a session lost while hooks run skips the stale hooks; the next session runs them all', async () => {
    const log: string[] = [];
    let release!: () => void;
    let first = true;
    const r = rig({
      remembered: A,
      resolveOutstanding: async () => {
        log.push('resolve');
        if (first) { first = false; await new Promise<void>((res) => (release = res)); }
      },
      reconcile: () => void log.push('reconcile'),
    });
    r.client.start();
    r.conn().hello();
    await flush();
    r.conn().setState('offline'); // session gone while resolveOutstanding is still pending
    release();
    await flush();
    expect(log).toEqual(['resolve']); // stale reconcile skipped
    r.conn().hello();
    await flush();
    expect(log).toEqual(['resolve', 'resolve', 'reconcile']);
  });

  it('bootId change is surfaced as an event (and flagged in the hook context)', async () => {
    const seen: boolean[] = [];
    const r = rig({ remembered: A, resolveOutstanding: (c) => void seen.push(c.bootIdChanged) });
    r.client.start();
    r.conn().hello({ bootId: 'b1' });
    await flush();
    r.conn().setState('offline');
    r.conn().hello({ bootId: 'b2' });
    await flush();
    expect(r.events.filter((e) => e.type === 'bootIdChanged')).toEqual([{ type: 'bootIdChanged', from: 'b1', to: 'b2' }]);
    expect(seen).toEqual([false, true]);
  });
});

describe('replaced and resume', () => {
  it('4001 replaced: status replaced, no reconnect/hooks until takeOver()', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().hello();
    await flush();
    r.conn().setState('replaced', { closeCode: 4001 });
    expect(r.client.snapshot.status).toBe('replaced');
    r.client.resume(); // forwarded, CameraConnection itself ignores it while replaced
    expect(r.conns).toHaveLength(1);
    expect(r.conn().takeovers).toBe(0);
    r.client.takeOver();
    expect(r.conn().takeovers).toBe(1);
    r.conn().hello({ sessionId: 'new' });
    await flush();
    expect(r.client.snapshot.status).toBe('online');
    expect(r.log).toEqual(['resolve', 'reconcile', 'resolve', 'reconcile']);
  });

  it('takeOver() is a no-op unless replaced', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().hello();
    r.client.takeOver();
    expect(r.conn().takeovers).toBe(0);
  });

  it('app resume calls reconnectNow() on the one connection (no second loop)', async () => {
    const r = rig({ remembered: A });
    r.client.start();
    r.conn().hello();
    r.client.resume();
    expect(r.conn().reconnects).toBe(1);
    expect(r.conns).toHaveLength(1);
  });

  it('resume before any target restarts selection', async () => {
    const r = rig();
    r.client.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.client.snapshot.needsConnect).toBe(true);
    r.nsd.found('a', 'cam-A', '10.0.0.5');
    r.client.resume();
    expect(r.conns).toHaveLength(1);
  });
});
