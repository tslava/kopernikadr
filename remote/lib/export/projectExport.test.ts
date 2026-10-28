import { describe, expect, it, vi } from 'vitest';
import type { FrameEntry, Project } from '../projects/model';
import type { FrameSource } from '../play/frameSource';
import { projectSpriteUrlOf } from '../render/catalog';
import { SpriteCache, type PinnedSprites } from '../render/sprites';
import { createStore } from '../state/store';
import type { CreateEncoder, ExportImage, ExportWriter } from './mediabunnyExport';
import {
  canCancel,
  createExportController,
  type ComposeCanvas,
  exportDisplayName,
  exportGate,
  sanitizeName,
  SpriteLoadError,
  classifyFailure,
  type ExportDeps,
  type ExportState,
} from './projectExport';

const frame = (n: number, over: Partial<FrameEntry> = {}): FrameEntry => ({
  frameId: `f${n}`,
  seq: n,
  bytes: 1,
  sha256: 'x',
  state: 'local',
  hiddenUntil: null,
  ...over,
});
const project = (frames: FrameEntry[], over: Partial<Project> = {}): Project => ({
  version: 1,
  id: 'p1',
  name: 'Mój film',
  createdAt: '2026-10-27T10:00:00Z',
  fps: 8,
  geometry: { aspect: '4:3', rotation: 0 },
  cameraId: 'cam',
  frames,
  deletedFrameIds: [],
  outstanding: [],
  ...over,
});
const unavailable = { reason: 'x', since: 's' };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe('classifyFailure for sprites', () => {
  it('a missing custom sticker gets its own reason; an OpenMoji failure stays generic', () => {
    const mk = (failed: string[]) => new SpriteLoadError(Object.assign(new Error('sprites failed to load'), { failed }));
    expect(classifyFailure(mk(['my:0123abcd-0123-4abc-8abc-0123456789ab', '1F436']))).toBe('stickerMissing');
    expect(classifyFailure(mk(['1F436']))).toBe('sprite');
    expect(classifyFailure(mk([]))).toBe('sprite');
  });
});

describe('sanitizeName', () => {
  it('transliterates Polish letters', () => {
    expect(sanitizeName('Zażółć gęślą jaźń')).toBe('Zazolc_gesla_jazn');
    expect(sanitizeName('ŁÓDŹ')).toBe('LODZ');
  });
  it('transliterates Cyrillic letters', () => {
    expect(sanitizeName('Мой фильм')).toBe('Moy_film');
    expect(sanitizeName('Щука и Ёж')).toBe('Shchuka_i_Ezh');
  });
  it('removes slashes, reserved characters and controls', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
    expect(sanitizeName('x\u0000y\nz\u007f')).toBe('xyz');
    expect(sanitizeName('../../etc/passwd')).toBe('etcpasswd');
  });
  it('never returns an empty name, trims dots, drops emoji', () => {
    expect(sanitizeName('')).toBe('film');
    expect(sanitizeName(' / ')).toBe('film');
    expect(sanitizeName('...')).toBe('film');
    expect(sanitizeName('🎬')).toBe('film');
    expect(sanitizeName('  ..a.. ')).toBe('a');
  });
  it('caps the length', () => {
    expect(sanitizeName('a'.repeat(200))).toHaveLength(60);
  });
  it('the result has no character the native normalizer would replace', () => {
    expect(sanitizeName('Łódź / Москва: "test"\n')).toMatch(/^[A-Za-z0-9_.\- ]+$/);
  });
  it('adds the date', () => {
    expect(exportDisplayName('Mój film', new Date(2026, 9, 7))).toBe('Moj_film-2026-10-07');
  });
});

describe('exportGate', () => {
  it('waits while frames are downloading', () => {
    const g = exportGate(project([frame(1), frame(2, { state: 'pending' }), frame(3, { state: 'pending' })]));
    expect(g).toEqual({ kind: 'waiting', downloading: 2 });
  });
  it('does not count hidden (being deleted) frames', () => {
    const g = exportGate(project([frame(1), frame(2, { state: 'pending', hiddenUntil: '2099' })]));
    expect(g).toEqual({ kind: 'ready', frames: 1, skipped: 0 });
  });
  it('unavailable frames never deadlock: they ask for confirmation, then are skipped', () => {
    const p = project([frame(1), frame(2, { state: 'pending', unavailable }), frame(3, { state: 'pending', unavailable })]);
    expect(exportGate(p)).toEqual({ kind: 'confirm', unavailable: 2, frames: 1 });
    expect(exportGate(p, true)).toEqual({ kind: 'ready', frames: 1, skipped: 2 });
  });
  it('waiting wins over confirm', () => {
    const p = project([frame(1), frame(2, { state: 'pending' }), frame(3, { state: 'pending', unavailable })]);
    expect(exportGate(p).kind).toBe('waiting');
  });
  it('nothing playable', () => {
    expect(exportGate(project([])).kind).toBe('empty');
    expect(exportGate(project([frame(1, { state: 'pending', unavailable })]), true).kind).toBe('empty');
  });
});

type Hold = 'pause' | 'add' | 'finalize' | 'publish';
interface Rig {
  log: string[];
  deps: ExportDeps;
  ctl: ReturnType<typeof createExportController>;
  exportingLog: boolean[];
  holds: Record<Hold, ReturnType<typeof deferred<void>> | null>;
  loaded: string[];
  images: { closed: number }[];
  states: ExportState[];
  adds: string[][];
  canvases: { draws: string[]; closed?: number }[];
  setProject(p: Project | null): void;
}

function rig(
  initial: Project,
  o: { hold?: Hold[]; sprites?: Pick<import('../render/sprites').SpriteCache, 'preload'>; pickNone?: boolean; failLoad?: string; failPublish?: Error; failPause?: Error; failResume?: Error } = {},
): Rig {
  const log: string[] = [];
  let current: Project | null = initial;
  const exporting = createStore(false);
  const exportingLog: boolean[] = [];
  exporting.subscribe(() => exportingLog.push(exporting.get()));
  const holds: Rig['holds'] = { pause: null, add: null, finalize: null, publish: null };
  for (const h of o.hold ?? []) holds[h] = deferred();
  const loaded: string[] = [];
  const images: { closed: number }[] = [];
  const adds: string[][] = [];

  const frameSource: FrameSource = {
    async load(projectId, frameId) {
      loaded.push(`${projectId}/${frameId}`);
      if (frameId === o.failLoad) throw new Error('boom');
      const img = {
        frame: frameId,
        tag: frameId,
        width: 1440,
        height: 1080,
        closed: 0,
        close() {
          this.closed++;
        },
      };
      images.push(img);
      return img as unknown as ImageBitmap;
    },
  };
  const writer: ExportWriter = {
    async open() {
      log.push('open');
    },
    async writeAt() {},
    async close() {
      log.push('close');
    },
    async publish(name) {
      log.push(`publish ${name}`);
      await holds.publish?.promise;
      if (o.failPublish) throw o.failPublish;
      return { uri: 'content://v/1' };
    },
    async abort() {
      log.push('abort');
    },
  };
  // a recording canvas: a snapshot is the list of draw calls since the last clear (one frame)
  const canvases: { draws: string[] }[] = [];
  const createCanvas = (): ComposeCanvas => {
    let draws: string[] = [];
    const ctx = {
      canvas: { width: 1440, height: 1080 },
      fillStyle: '',
      fillRect() {},
      drawImage(img: { tag?: string }, _x: number, _y: number, w: number) {
        draws.push(`${img.tag ?? 'img'}@${w}`);
      },
      save() {},
      restore() {},
      translate() {},
      rotate() {},
    };
    // a frame draw starts a new composition (drawFrame is the first pass)
    const drawImage = ctx.drawImage.bind(ctx);
    ctx.drawImage = (img, x, y, w) => {
      if ((img as { frame?: string }).frame !== undefined) draws = [];
      drawImage(img, x, y, w);
    };
    return {
      ctx: ctx as unknown as ComposeCanvas['ctx'],
      snapshot: () => {
        const snap = { closed: 0, draws: [...draws], close() { this.closed++; } };
        canvases.push(snap);
        return snap as unknown as ExportImage;
      },
    };
  };
  const createEncoder: CreateEncoder = async () => ({
    async add(img: ExportImage) {
      adds.push((img as unknown as { draws: string[] }).draws);
      log.push('add');
      await holds.add?.promise;
    },
    async finalize() {
      log.push('finalize');
      await holds.finalize?.promise;
    },
    async cancel() {
      log.push('encoder.cancel');
    },
  });
  const deps: ExportDeps = {
    getProject: () => current,
    transfer: {
      async pause() {
        log.push('pause');
        await holds.pause?.promise;
        if (o.failPause) throw o.failPause;
      },
      resume() {
        log.push('resume');
        if (o.failResume) throw o.failResume;
      },
    },
    exporting,
    releasePlayer: () => log.push('release'),
    frameSource,
    createWriter: () => writer,
    now: () => new Date(2026, 9, 27),
    isConfigSupported: async () => ({ supported: !o.pickNone }) as VideoEncoderSupport,
    createEncoder,
    createCanvas,
    sprites: o.sprites,
  };
  const ctl = createExportController(deps);
  const states: ExportState[] = [];
  ctl.state.subscribe(() => states.push(ctl.state.get()));
  return { log, deps, ctl, exportingLog, holds, loaded, images, states, adds, canvases, setProject: (p) => (current = p) };
}

const three = () => project([frame(2), frame(1), frame(3)]);

describe('export controller: the run', () => {
  it('release -> pause -> frames in seq order -> publish with the name -> resume + flag off', async () => {
    const r = rig(three());
    expect(await r.ctl.start()).toEqual({ started: true });
    expect(r.log).toEqual([
      'release', 'pause', 'open', 'add', 'add', 'add', 'finalize', 'close', 'publish Moj_film-2026-10-27', 'resume',
    ]);
    expect(r.loaded).toEqual(['p1/f1', 'p1/f2', 'p1/f3']);
    expect(r.images.every((i) => i.closed === 1)).toBe(true);
    expect(r.exportingLog).toEqual([true, false]);
    expect(r.ctl.state.get()).toEqual({ phase: 'done', uri: 'content://v/1', frames: 3, skipped: 0 });
    const phases = r.states.map((s) => s.phase);
    expect(phases[0]).toBe('preparing');
    expect(phases.slice(-3)).toEqual(['finalizing', 'publishing', 'done']);
  });

  it('the flag is on while encoding and off at the end', async () => {
    const r = rig(three(), { hold: ['add'] });
    const run = r.ctl.start();
    await tick();
    expect(r.deps.exporting.get()).toBe(true);
    expect(r.ctl.state.get().phase).toBe('encoding');
    r.holds.add!.resolve();
    await run;
    expect(r.deps.exporting.get()).toBe(false);
  });

  it('skips unavailable frames after the parent confirmed, and reports how many', async () => {
    const r = rig(project([frame(1), frame(2, { state: 'pending', unavailable }), frame(3), frame(4, { unavailable })]));
    expect(await r.ctl.start()).toEqual({ started: false, reason: 'confirm' });
    expect(r.log).toEqual([]); // nothing paused, nothing blocked
    expect(r.exportingLog).toEqual([]);
    expect(await r.ctl.start({ confirmedSkip: true })).toEqual({ started: true });
    expect(r.loaded).toEqual(['p1/f1', 'p1/f3']);
    expect(r.ctl.state.get()).toMatchObject({ phase: 'done', frames: 2, skipped: 2 });
  });

  it('does not start while frames are downloading (no pause, no flag)', async () => {
    const r = rig(project([frame(1), frame(2, { state: 'pending' })]));
    expect(await r.ctl.start()).toEqual({ started: false, reason: 'waiting' });
    expect(r.log).toEqual([]);
    expect(r.exportingLog).toEqual([]);
    // the frame arrives: the same call now runs
    r.setProject(project([frame(1), frame(2)]));
    expect(await r.ctl.start()).toEqual({ started: true });
  });

  it('empty and missing project do not start', async () => {
    expect(await rig(project([])).ctl.start()).toEqual({ started: false, reason: 'empty' });
    const r = rig(three());
    r.setProject(null);
    expect(await r.ctl.start()).toEqual({ started: false, reason: 'no-project' });
  });

  it('a frame downloaded while pausing is included', async () => {
    const r = rig(project([frame(1), frame(2)]), { hold: ['pause'] });
    const run = r.ctl.start();
    await tick();
    r.setProject(project([frame(1), frame(2), frame(3)]));
    r.holds.pause!.resolve();
    await run;
    expect(r.loaded).toEqual(['p1/f1', 'p1/f2', 'p1/f3']);
  });

  it('refuses a second start while one runs', async () => {
    const r = rig(three(), { hold: ['add'] });
    const run = r.ctl.start();
    await tick();
    expect(await r.ctl.start()).toEqual({ started: false, reason: 'busy' });
    r.holds.add!.resolve();
    await run;
  });
});

describe('export controller: shared flag and resume failure', () => {
  it('a second start is refused while the app-wide exporting flag is on (another controller exports)', async () => {
    const r = rig(three());
    r.deps.exporting.set(true);
    expect(await r.ctl.start()).toEqual({ started: false, reason: 'busy' });
    expect(r.log).toEqual([]);
  });

  it('transfer.resume() throwing does not swallow the final state or the flag', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = rig(three(), { failResume: new Error('resume boom') });
    expect(await r.ctl.start()).toEqual({ started: true });
    expect(r.ctl.state.get()).toMatchObject({ phase: 'done', frames: 3 });
    expect(r.deps.exporting.get()).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('exportGate with the camera link', () => {
  const waiting = () => project([frame(1), frame(2, { state: 'pending' }), frame(3, { state: 'pending' })]);
  it('still waits while the same camera is online', () => {
    expect(exportGate(waiting(), false, { online: true, cameraId: 'cam' })).toEqual({ kind: 'waiting', downloading: 2 });
  });
  it('offline: the not-yet-local frames become a skip confirm, then ready', () => {
    const link = { online: false, cameraId: null };
    expect(exportGate(waiting(), false, link)).toEqual({ kind: 'confirm', unavailable: 2, frames: 1 });
    expect(exportGate(waiting(), true, link)).toEqual({ kind: 'ready', frames: 1, skipped: 2 });
  });
  it('another camera is connected: same skip confirm', () => {
    expect(exportGate(waiting(), false, { online: true, cameraId: 'other' })).toMatchObject({ kind: 'confirm', unavailable: 2 });
  });
  it('the controller starts after confirmation when the camera is gone', async () => {
    const r = rig(waiting());
    const ctl = createExportController({ ...r.deps, link: () => ({ online: false, cameraId: null }) });
    expect(await ctl.start()).toEqual({ started: false, reason: 'confirm' });
    expect(await ctl.start({ confirmedSkip: true })).toEqual({ started: true });
    expect(ctl.state.get()).toMatchObject({ phase: 'done', frames: 1, skipped: 2 });
  });
});

describe('export controller: transfers resume on every outcome', () => {
  const resumed = (r: Rig) => r.log.filter((l) => l === 'resume').length;

  it('success: paused first, resumed once', async () => {
    const r = rig(three());
    await r.ctl.start();
    expect(resumed(r)).toBe(1);
    expect(r.log.indexOf('pause')).toBeLessThan(r.log.indexOf('resume'));
  });

  it('a frame that cannot be loaded fails the export, aborts the temp file, resumes', async () => {
    const r = rig(three(), { failLoad: 'f2' });
    await r.ctl.start();
    expect(r.ctl.state.get()).toMatchObject({ phase: 'failed', reason: 'frame' });
    expect(r.log).toContain('abort');
    expect(r.log.some((l) => l.startsWith('publish'))).toBe(false);
    expect(resumed(r)).toBe(1);
    expect(r.exportingLog).toEqual([true, false]);
  });

  it('no supported codec fails before anything is written', async () => {
    const r = rig(three(), { pickNone: true });
    await r.ctl.start();
    expect(r.ctl.state.get()).toMatchObject({ phase: 'failed', reason: 'codec' });
    expect(r.log).not.toContain('open');
    expect(resumed(r)).toBe(1);
    expect(r.exportingLog).toEqual([true, false]);
  });

  it('a publish failure (no space) is classified and resumes', async () => {
    const r = rig(three(), { failPublish: Object.assign(new Error('full'), { code: 'NO_SPACE' }) });
    await r.ctl.start();
    expect(r.ctl.state.get()).toMatchObject({ phase: 'failed', reason: 'space' });
    expect(resumed(r)).toBe(1);
  });

  it('a failing pause fails the export, still resumes and clears the flag', async () => {
    const r = rig(three(), { failPause: new Error('pause') });
    await r.ctl.start();
    expect(r.ctl.state.get()).toMatchObject({ phase: 'failed', reason: 'unknown' });
    expect(resumed(r)).toBe(1);
    expect(r.deps.exporting.get()).toBe(false);
  });

  it('cancel', async () => {
    const r = rig(three(), { hold: ['add'] });
    const run = r.ctl.start();
    await tick();
    expect(r.ctl.cancel()).toBe(true);
    await run;
    expect(r.ctl.state.get()).toEqual({ phase: 'cancelled' });
    expect(resumed(r)).toBe(1);
    expect(r.exportingLog).toEqual([true, false]);
  });

  it('reset after a failure goes back to idle; a retry then runs', async () => {
    const r = rig(three(), { failLoad: 'f1' });
    await r.ctl.start();
    expect(r.ctl.state.get().phase).toBe('failed');
    r.ctl.reset();
    expect(r.ctl.state.get().phase).toBe('idle');
    r.setProject(project([frame(2), frame(3)]));
    expect(await r.ctl.start()).toEqual({ started: true });
    expect(r.ctl.state.get().phase).toBe('done');
  });
});

describe('export controller: cancel by state', () => {
  it('idle: refused', () => {
    expect(rig(three()).ctl.cancel()).toBe(false);
  });

  it('preparing (pausing transfers): refused, the export carries on', async () => {
    const r = rig(three(), { hold: ['pause'] });
    const run = r.ctl.start();
    await tick();
    expect(r.ctl.state.get().phase).toBe('preparing');
    expect(r.ctl.cancel()).toBe(false);
    r.holds.pause!.resolve();
    await run;
    expect(r.ctl.state.get().phase).toBe('done');
  });

  it('encoding: accepted -> aborted, never published', async () => {
    const r = rig(three(), { hold: ['add'] });
    const run = r.ctl.start();
    await tick();
    expect(canCancel(r.ctl.state.get())).toBe(true);
    expect(r.ctl.cancel()).toBe(true);
    await run;
    expect(r.ctl.state.get().phase).toBe('cancelled');
    expect(r.log).toContain('abort');
    expect(r.log).toContain('encoder.cancel');
    expect(r.log.some((l) => l.startsWith('publish'))).toBe(false);
    expect(r.ctl.cancel()).toBe(false); // already over
  });

  it('finalizing: refused, runs to done and publishes (publish and abort are exclusive)', async () => {
    const r = rig(three(), { hold: ['finalize'] });
    const run = r.ctl.start();
    await tick();
    expect(r.ctl.state.get().phase).toBe('finalizing');
    expect(canCancel(r.ctl.state.get())).toBe(false);
    expect(r.ctl.cancel()).toBe(false);
    r.holds.finalize!.resolve();
    await run;
    expect(r.ctl.state.get().phase).toBe('done');
    expect(r.log).not.toContain('abort');
    expect(r.log.some((l) => l.startsWith('publish'))).toBe(true);
  });

  it('publishing: refused, the file is published and not aborted', async () => {
    const r = rig(three(), { hold: ['publish'] });
    const run = r.ctl.start();
    await tick();
    expect(r.ctl.state.get().phase).toBe('publishing');
    expect(r.ctl.cancel()).toBe(false);
    r.holds.publish!.resolve();
    await run;
    expect(r.ctl.state.get().phase).toBe('done');
    expect(r.log).not.toContain('abort');
  });

  it('done / failed: refused', async () => {
    const done = rig(three());
    await done.ctl.start();
    expect(done.ctl.cancel()).toBe(false);
    const failed = rig(three(), { failLoad: 'f1' });
    await failed.ctl.start();
    expect(failed.ctl.cancel()).toBe(false);
  });

  it('canCancel is true only in encoding', () => {
    const states: ExportState[] = [
      { phase: 'idle' },
      { phase: 'preparing' },
      { phase: 'encoding', i: 1, n: 2 },
      { phase: 'finalizing', n: 2 },
      { phase: 'publishing', n: 2 },
      { phase: 'done', uri: 'u', frames: 2, skipped: 0 },
      { phase: 'cancelled' },
      { phase: 'failed', reason: 'unknown', detail: '' },
    ];
    expect(states.filter(canCancel).map((s) => s.phase)).toEqual(['encoding']);
  });
});

// --- the timeline: holds, off, duplicates, stickers ------------------------------------------

const entry = (frameId: string, over: Partial<{ id: string; hold: number; off: true }> = {}) => ({
  id: frameId,
  frameId,
  hold: 1,
  ...over,
});
const sticker = (id: string, emoji: string, on: string[]) => ({ id, emoji, x: 0.5, y: 0.5, size: 0.25, rot: 0, on });

/** Sprite seam: records the preload and hands out tagged fake bitmaps. */
function fakeSprites(o: { fail?: boolean; unknown?: boolean } = {}) {
  const calls: { hexcodes: string[]; bucket: number }[] = [];
  const released = { n: 0 };
  const sprites = {
    async preload(hexcodes: readonly string[], bucket: number): Promise<PinnedSprites> {
      calls.push({ hexcodes: [...hexcodes], bucket });
      if (o.fail) throw new Error('sprites failed to load: 1F436');
      return {
        get: (h) => (o.unknown ? undefined : ({ tag: `s-${h}` } as unknown as ImageBitmap)),
        release: () => void released.n++,
      };
    },
  };
  return { sprites, calls, released };
}

describe('exportGate on the timeline', () => {
  it('off frames do not block and do not count', () => {
    const p = project([frame(1), frame(2, { state: 'pending' }), frame(3)], {
      cut: [entry('f1'), entry('f2', { off: true }), entry('f3')],
    });
    expect(exportGate(p)).toEqual({ kind: 'ready', frames: 2, skipped: 0 });
  });
  it('an off unavailable frame needs no confirmation', () => {
    const p = project([frame(1), frame(2, { state: 'pending', unavailable })], { cut: [entry('f1'), entry('f2', { off: true })] });
    expect(exportGate(p)).toEqual({ kind: 'ready', frames: 1, skipped: 0 });
  });
  it('a frame with both an on and an off entry still blocks while downloading', () => {
    const p = project([frame(1), frame(2, { state: 'pending' })], {
      cut: [entry('f1'), entry('f2', { id: 'a', off: true }), entry('f2', { id: 'b' })],
    });
    expect(exportGate(p)).toEqual({ kind: 'waiting', downloading: 1 });
  });
  it('frames = entries on the timeline (duplicates count)', () => {
    const p = project([frame(1)], { cut: [entry('f1'), entry('f1', { id: 'c' })] });
    expect(exportGate(p)).toEqual({ kind: 'ready', frames: 2, skipped: 0 });
  });
  it('everything off: empty', () => {
    expect(exportGate(project([frame(1)], { cut: [entry('f1', { off: true })] })).kind).toBe('empty');
  });
});

describe('export controller: the timeline', () => {
  it('exports in timeline order with the entries of a duplicate, off entries left out', async () => {
    const p = project([frame(1), frame(2), frame(3)], {
      cut: [entry('f3'), entry('f1'), entry('f2', { off: true }), entry('f3', { id: 'dup' })],
    });
    const r = rig(p);
    await r.ctl.start();
    expect(r.adds.map((d) => d[0])).toEqual(['f3@1440', 'f1@1440', 'f3@1440']);
    expect(r.ctl.state.get()).toMatchObject({ phase: 'done', frames: 3 });
  });

  it('a frame not in the cut goes to the end', async () => {
    const r = rig(project([frame(1), frame(2)], { cut: [entry('f2')] }));
    await r.ctl.start();
    expect(r.adds.map((d) => d[0])).toEqual(['f2@1440', 'f1@1440']);
  });

  it('a consecutive duplicate decodes once, the decoded frames are all closed', async () => {
    const p = project([frame(1), frame(2)], { cut: [entry('f1'), entry('f1', { id: 'd1' }), entry('f1', { id: 'd2' }), entry('f2')] });
    const r = rig(p);
    await r.ctl.start();
    expect(r.loaded).toEqual(['p1/f1', 'p1/f2']);
    expect(r.images.every((i) => i.closed === 1)).toBe(true);
    expect(r.canvases.every((c) => c.closed === 1)).toBe(true); // every snapshot closed by the export
  });

  it('holds become durations: hold/fps with cumulative timestamps', async () => {
    const stamps: { timestamp: number; duration: number }[] = [];
    const base = rig(project([frame(1), frame(2), frame(3)], { cut: [entry('f1'), entry('f2', { hold: 4 }), entry('f3', { hold: 2 })] }));
    const ctl = createExportController({
      ...base.deps,
      createEncoder: async () => ({
        async add(_i, timestamp, duration) {
          stamps.push({ timestamp, duration });
        },
        async finalize() {},
        async cancel() {},
      }),
    });
    await ctl.start();
    expect(ctl.state.get()).toMatchObject({ phase: 'done', frames: 3 });
    expect(stamps).toEqual([
      { timestamp: 0, duration: 1 / 8 },
      { timestamp: 1 / 8, duration: 4 / 8 },
      { timestamp: 5 / 8, duration: 2 / 8 },
    ]);
  });

  it('an empty timeline (all off) does not start: the existing empty gate', async () => {
    const r = rig(project([frame(1)], { cut: [entry('f1', { off: true })] }));
    expect(await r.ctl.start()).toEqual({ started: false, reason: 'empty' });
    expect(r.log).toEqual([]);
  });
});

describe('export controller: stickers', () => {
  const stickered = () =>
    project([frame(1), frame(2), frame(3)], {
      cut: [entry('f1'), entry('f2'), entry('f3')],
      stickers: [sticker('s1', '1F436', ['f2', 'f3']), sticker('s2', '1F431', ['f3'])],
    });

  it('stickers are composed over the frame, per entry, in array order, as separate snapshots', async () => {
    const sp = fakeSprites();
    const r = rig(stickered(), { sprites: sp.sprites });
    await r.ctl.start();
    // sticker side = size * width = 360
    expect(r.adds).toEqual([['f1@1440'], ['f2@1440', 's-1F436@360'], ['f3@1440', 's-1F436@360', 's-1F431@360']]);
    expect(new Set(r.canvases).size).toBe(3); // three snapshots, none shared
  });

  it('preloads exactly the sprites used by exported entries at the 1024 bucket, before the first frame, and releases them', async () => {
    const sp = fakeSprites();
    const p = stickered();
    p.cut = [entry('f1'), entry('f2'), entry('f3', { off: true })]; // s2 only on the off entry
    const r = rig(p, { sprites: sp.sprites });
    await r.ctl.start();
    expect(sp.calls).toEqual([{ hexcodes: ['1F436'], bucket: 1024 }]);
    expect(sp.released.n).toBe(1);
  });

  it('a sprite that was not loaded before is in frame 1 (preload runs before encoding)', async () => {
    const sp = fakeSprites();
    const p = project([frame(1)], { cut: [entry('f1')], stickers: [sticker('s1', '1F436', ['f1'])] });
    const r = rig(p, { sprites: sp.sprites });
    await r.ctl.start();
    expect(r.adds[0]).toEqual(['f1@1440', 's-1F436@360']);
  });

  it('a failing sprite fails the export with the sprite reason, before anything is written', async () => {
    const sp = fakeSprites({ fail: true });
    const r = rig(stickered(), { sprites: sp.sprites });
    await r.ctl.start();
    expect(r.ctl.state.get()).toMatchObject({ phase: 'failed', reason: 'sprite' });
    expect((r.ctl.state.get() as { detail: string }).detail).toContain('1F436');
    expect(r.log).not.toContain('open');
    expect(r.log).toContain('resume');
    expect(r.exportingLog).toEqual([true, false]);
  });

  it('pinned sprites are released on failure and on cancel too', async () => {
    const sp = fakeSprites();
    const failed = rig(stickered(), { sprites: sp.sprites, failLoad: 'f2' });
    await failed.ctl.start();
    expect(failed.ctl.state.get()).toMatchObject({ phase: 'failed', reason: 'frame' });
    expect(sp.released.n).toBe(1);
    const sp2 = fakeSprites();
    const cancelled = rig(stickered(), { sprites: sp2.sprites, hold: ['add'] });
    const run = cancelled.ctl.start();
    await tick();
    cancelled.ctl.cancel();
    await run;
    expect(cancelled.ctl.state.get().phase).toBe('cancelled');
    expect(sp2.released.n).toBe(1);
  });

  it('no stickers on the movie: no preload', async () => {
    const sp = fakeSprites();
    const r = rig(three(), { sprites: sp.sprites });
    await r.ctl.start();
    expect(sp.calls).toEqual([]);
  });

  const MY = 'my:0123abcd-0123-4abc-8abc-0123456789ab';
  const withCustom = () => project([frame(1)], { cut: [entry('f1')], stickers: [sticker('s1', MY, ['f1'])] });

  it('export with a custom sticker draws it like any other', async () => {
    const sp = fakeSprites();
    const r = rig(withCustom(), { sprites: sp.sprites });
    await r.ctl.start();
    expect(sp.calls).toEqual([{ hexcodes: [MY], bucket: 1024 }]);
    expect(r.adds[0]).toEqual(['f1@1440', `s-${MY}@360`]);
  });

  it('a missing movie copy fails the export naming the sticker', async () => {
    const missing = async (): Promise<ImageBitmap> => {
      throw new Error('sprite image failed');
    };
    const cache = new SpriteCache(missing, undefined, projectSpriteUrlOf('P', 'file:///d', (u) => u));
    const r = rig(withCustom(), { sprites: cache });
    await r.ctl.start();
    const s = r.ctl.state.get() as { phase: string; reason: string; detail: string };
    expect(s).toMatchObject({ phase: 'failed', reason: 'stickerMissing' });
    expect(s.detail).toContain(MY);
    expect(r.log).not.toContain('open');
  });

  it('SpriteLoadError carries the failed ids', () => {
    const e = new SpriteLoadError(Object.assign(new Error('sprites failed to load: a'), { failed: ['a'] }));
    expect(e.failed).toEqual(['a']);
    expect(new SpriteLoadError('x').failed).toEqual([]);
  });

  it('a sprite missing from the pinned set is skipped, not fatal', async () => {
    const r = rig(stickered(), { sprites: fakeSprites({ unknown: true }).sprites });
    await r.ctl.start();
    expect(r.adds[1]).toEqual(['f2@1440']);
  });
});
