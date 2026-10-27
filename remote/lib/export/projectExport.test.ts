import { describe, expect, it } from 'vitest';
import type { FrameEntry, Project } from '../projects/model';
import type { FrameSource } from '../play/frameSource';
import { createStore } from '../state/store';
import type { CreateEncoder, ExportImage, ExportWriter } from './mediabunnyExport';
import {
  canCancel,
  createExportController,
  exportDisplayName,
  exportGate,
  sanitizeName,
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
  setProject(p: Project | null): void;
}

function rig(
  initial: Project,
  o: { hold?: Hold[]; pickNone?: boolean; failLoad?: string; failPublish?: Error; failPause?: Error } = {},
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

  const frameSource: FrameSource = {
    async load(projectId, frameId) {
      loaded.push(`${projectId}/${frameId}`);
      if (frameId === o.failLoad) throw new Error('boom');
      const img = {
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
  const createEncoder: CreateEncoder = async () => ({
    async add(_img: ExportImage) {
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
      },
    },
    exporting,
    releasePlayer: () => log.push('release'),
    frameSource,
    createWriter: () => writer,
    now: () => new Date(2026, 9, 27),
    isConfigSupported: async () => ({ supported: !o.pickNone }) as VideoEncoderSupport,
    createEncoder,
  };
  const ctl = createExportController(deps);
  const states: ExportState[] = [];
  ctl.state.subscribe(() => states.push(ctl.state.get()));
  return { log, deps, ctl, exportingLog, holds, loaded, images, states, setProject: (p) => (current = p) };
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
