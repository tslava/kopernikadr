import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewController, type BitmapLike, type LoopLike, type LoopOptions } from './previewController';

class FakeLoop implements LoopLike {
  running = false;
  sessions: Array<string | null> = [];
  constructor(public opts: LoopOptions) {}
  start() { this.running = true; }
  stop() { this.running = false; }
  setSession(s: string | null) { this.sessions.push(s); }
}

function setup(extra: Record<string, unknown> = {}) {
  const loops: FakeLoop[] = [];
  const c = new PreviewController({
    urlFor: (s) => `ws://cam/ws/preview?session=${s}`,
    createLoop: (o) => { const l = new FakeLoop(o); loops.push(l); return l; },
    ...extra,
  });
  return { c, loops };
}

describe('PreviewController (fake loop)', () => {
  it('waits without a valid session, runs with one', () => {
    const { c, loops } = setup();
    c.start();
    expect(loops).toHaveLength(0);
    c.setSession('s1');
    expect(loops).toHaveLength(1);
    expect(loops[0].running).toBe(true);
    expect(loops[0].sessions.at(-1)).toBe('s1');
    c.setSession(null);
    expect(loops[0].sessions.at(-1)).toBeNull();
  });

  it('never two loops across sessions, restarts and stop/start', () => {
    const { c, loops } = setup();
    c.start();
    c.setSession('s1');
    c.setSession('s2');
    c.restart();
    c.resume();
    c.stop();
    c.start();
    c.setSession(null);
    c.setSession('s3');
    expect(loops).toHaveLength(1);
    expect(c.loop).toBe(loops[0]);
  });

  it('restart (resume / bootId) closes then reopens the same session', () => {
    const { c, loops } = setup();
    c.start();
    c.setSession('s1');
    loops[0].sessions.length = 0;
    c.resume();
    expect(loops[0].sessions).toEqual([null, 's1']);
    loops[0].sessions.length = 0;
    c.restart();
    expect(loops[0].sessions).toEqual([null, 's1']);
  });

  it('restart does nothing without session or when stopped', () => {
    const { c, loops } = setup();
    c.restart();
    c.start();
    c.restart();
    c.setSession('s1');
    c.stop();
    loops[0].sessions.length = 0;
    c.restart();
    expect(loops[0].sessions).toEqual([]);
  });

  it('attach: session / bootIdChanged / leaving online', () => {
    const { c, loops } = setup();
    let cb: (e: any) => void = () => {};
    let sub: () => void = () => {};
    const snap = { status: 'searching', hello: null as { sessionId: string } | null };
    c.attach({ onEvent: (f) => { cb = f; return () => {}; }, store: { get: () => snap, subscribe: (l) => { sub = l; return () => {}; } } });
    c.start();
    expect(loops).toHaveLength(0);
    snap.status = 'online';
    cb({ type: 'session', hello: { sessionId: 'a' } });
    expect(loops[0].sessions.at(-1)).toBe('a');
    loops[0].sessions.length = 0;
    cb({ type: 'bootIdChanged', from: 'x', to: 'y' });
    expect(loops[0].sessions).toEqual([null, 'a']);
    snap.status = 'offline';
    sub();
    expect(loops[0].sessions.at(-1)).toBeNull();
    expect(c.session).toBeNull();
  });

  it('quality is pushed on new session and on change', () => {
    const applied: string[] = [];
    const { c } = setup({ quality: 'low', applyQuality: (q: string) => { applied.push(q); } });
    c.start();
    c.setQuality('high'); // no session yet: nothing to push
    c.setSession('s1');
    c.setQuality('high'); // unchanged
    c.setQuality('normal');
    c.setSession('s2');
    expect(applied).toEqual(['high', 'normal', 'normal']);
    expect(c.quality).toBe('normal');
  });
});

describe('PreviewController drawing', () => {
  const bmp = (): BitmapLike & { closed: number } => ({ width: 640, height: 480, closed: 0, close() { this.closed++; } });

  it('draws, sizes the canvas, closes each bitmap, reports live', async () => {
    const calls: unknown[] = [];
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (b: unknown) => { calls.push(b); } }) };
    const made: ReturnType<typeof bmp>[] = [];
    const live: boolean[] = [];
    const { c, loops } = setup({ canvas, createBitmap: async () => { const b = bmp(); made.push(b); return b; }, onLive: (v: boolean) => live.push(v) });
    c.start();
    c.setSession('s1');
    await loops[0].opts.onFrame({}, new Uint8Array(1));
    await loops[0].opts.onFrame({}, new Uint8Array(1));
    expect(canvas.width).toBe(640);
    expect(calls).toEqual(made);
    expect(made.map((b) => b.closed)).toEqual([1, 1]);
    expect(live).toEqual([true]);
    c.setSession(null);
    expect(live).toEqual([true, false]);
  });

  it('closes the bitmap without a canvas', async () => {
    const b = bmp();
    const { c, loops } = setup({ createBitmap: async () => b });
    c.start();
    c.setSession('s1');
    await loops[0].opts.onFrame({}, new Uint8Array(1));
    expect(b.closed).toBe(1);
  });

  it('closes the bitmap when drawing throws; a decode failure propagates to the loop', async () => {
    const b = bmp();
    const { c, loops } = setup({
      canvas: { width: 0, height: 0, getContext: () => ({ drawImage: () => { throw new Error('draw'); } }) },
      createBitmap: async () => b,
    });
    c.start();
    c.setSession('s1');
    await expect(loops[0].opts.onFrame({}, new Uint8Array(1))).rejects.toThrow('draw');
    expect(b.closed).toBe(1);

    const { c: c3, loops: l3 } = setup({ createBitmap: async () => { throw new Error('decode'); } });
    c3.start();
    c3.setSession('s1');
    await expect(l3[0].opts.onFrame({}, new Uint8Array(1))).rejects.toThrow('decode');
  });
});

// ---- the real PreviewLoop (watchdog) with a fake WebSocket and fake timers ----

class FakeWS {
  static all: FakeWS[] = [];
  listeners: Record<string, Array<(e: any) => void>> = {};
  sent: string[] = [];
  closed = false;
  binaryType = '';
  constructor(public url: string) { FakeWS.all.push(this); }
  addEventListener(n: string, f: (e: any) => void) { (this.listeners[n] ??= []).push(f); }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; }
  emit(n: string, e: any = {}) { for (const f of this.listeners[n] ?? []) f(e); }
}
const frameBuf = () => {
  const h = new TextEncoder().encode('{"seq":1}');
  const b = new Uint8Array(4 + h.length + 2);
  new DataView(b.buffer).setUint32(0, h.length);
  b.set(h, 4);
  b.set([0xff, 0xd8], 4 + h.length);
  return b.buffer;
};

describe('PreviewController + real PreviewLoop watchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeWS.all = []; vi.stubGlobal('WebSocket', FakeWS); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const real = (extra: Record<string, unknown> = {}) =>
    new PreviewController({ urlFor: (s) => `ws://cam/ws/preview?session=${s}`, createBitmap: async () => ({ width: 4, height: 3, close() {} }), ...extra });

  it('a silent socket is dropped after 3 s and reopened', async () => {
    const c = real();
    c.start();
    c.setSession('s1');
    expect(FakeWS.all).toHaveLength(1);
    FakeWS.all[0].emit('open');
    expect(FakeWS.all[0].sent).toEqual(['{"t":"next"}']);
    await vi.advanceTimersByTimeAsync(2900);
    expect(FakeWS.all[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeWS.all[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeWS.all).toHaveLength(2);
    expect(FakeWS.all[1].url).toBe('ws://cam/ws/preview?session=s1');
  });

  it('a decode failure drops and reopens; restart leaves exactly one open socket', async () => {
    const errors: Error[] = [];
    const c = real({ createBitmap: async () => { throw new Error('bad jpeg'); }, onError: (e: Error) => errors.push(e) });
    c.start();
    c.setSession('s1');
    FakeWS.all[0].emit('open');
    FakeWS.all[0].emit('message', { data: frameBuf() });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0].message).toBe('bad jpeg');
    expect(FakeWS.all[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeWS.all).toHaveLength(2);

    c.restart(); // bootId change / resume
    expect(FakeWS.all[1].closed).toBe(true);
    expect(FakeWS.all).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWS.all.filter((w) => !w.closed)).toHaveLength(1);
  });
});
