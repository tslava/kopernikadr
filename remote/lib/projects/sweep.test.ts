import { describe, expect, it } from 'vitest';
import { CrashError, FakeFs } from './fakeFs.testutil';
import { INDEX_PATH, projectJsonPath } from './files';
import type { FrameInfo, Project } from './model';
import { hideFrame, hideProject, mergeFrame, renameProject, setLocal } from './reducers';
import { ProjectStore } from './store';
import { createFetchBytes, createWebVerify, runStartupSweep, type VerifyFn } from './sweep';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
let n = 0;
const sha = (c: string) => c.repeat(64);
const info = (projectId: string, frameId: string, seq: number, c = 'a', bytes = 10): FrameInfo => ({
  frameId,
  seq,
  projectId,
  clientId: 'c',
  rotation: 0,
  capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes, sha256: sha(c) },
});
const open = async (fs: FakeFs) => {
  const store = new ProjectStore(fs, { now: () => T0, newId: () => `id-${++n}` });
  await store.load();
  return store;
};
/** A file whose content encodes what the test `verify` checks. */
const content = (c = 'a', bytes = 10) => `${sha(c)}:${bytes}`;
const verifyFor =
  (fs: FakeFs): VerifyFn =>
  async (path, bytes, s) =>
    fs.files.get(path) === `${s}:${bytes}`;
const sweep = (store: ProjectStore, fs: FakeFs, now = T0) =>
  runStartupSweep(store, fs, { verify: verifyFor(fs), now: () => now });
const fp = (pid: string, frameId: string, kind: 'full' | 'play' | 'thumb' = 'full') =>
  `projects/${pid}/frames/${frameId}.${kind}.jpg`;
/** hiddenUntil already passed at T0 */
const EXPIRED = T0 - 10_000;

/** A project with the given frames (merged as pending), on disk. */
async function seed(fs: FakeFs, frames: [string, string?][] = []) {
  const store = await open(fs);
  const p = await store.createProject('Film');
  await store.updateProject(p.id, (cur) => {
    let x: Project = { ...cur, cameraId: 'cam' };
    frames.forEach(([id, c], i) => (x = mergeFrame(x, info(p.id, id, i + 1, c ?? 'a'), 'cam').project));
    return x;
  });
  return { store, pid: p.id };
}
/** "The process was killed and started again". */
const restart = async (fs: FakeFs) => {
  fs.restart();
  return open(fs);
};

describe('interrupted install (pending -> local)', () => {
  it('crash point: kill after installFile, before state local -> promoted at the next start', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content()); // installFile done, `local` never committed
    const store = await restart(fs);
    expect(store.state.get().projects[pid]!.frames[0]!.state).toBe('pending');
    const r = await sweep(store, fs);
    expect(r.promoted).toEqual([{ projectId: pid, frameId: 'F1' }]);
    expect(store.state.get().projects[pid]!.frames[0]!.state).toBe('local');
    expect((fs.json(projectJsonPath(pid)) as Project).frames[0]!.state).toBe('local');
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
  });

  it('mismatch: the file is quarantined (never deleted) and the frame stays pending', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content('b')); // wrong sha
    const store = await restart(fs);
    const r = await sweep(store, fs);
    expect(r.mismatched).toEqual([{ projectId: pid, frameId: 'F1' }]);
    expect(fs.files.has(fp(pid, 'F1'))).toBe(false);
    expect(fs.files.get(`quarantine/${pid}-F1.full.jpg`)).toBe(content('b'));
    expect(r.warnings.map((w) => w.kind)).toContain('quarantined');
    expect(store.state.get().projects[pid]!.frames[0]!.state).toBe('pending');
  });

  it('a verify that throws keeps the file and the frame, and warns', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content());
    const store = await restart(fs);
    const r = await runStartupSweep(store, fs, {
      verify: async () => {
        throw new Error('fetch failed');
      },
      now: () => T0,
    });
    expect(r.warnings.map((w) => w.kind)).toEqual(['verify_failed']);
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
    expect(store.state.get().projects[pid]!.frames[0]!.state).toBe('pending');
  });

  it('a pending frame with no file is left alone; a local frame is not re-verified', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['F1'], ['F2']]);
    await s0.updateProject(pid, (p) => setLocal(p, 'F2'));
    fs.files.set(fp(pid, 'F2'), 'whatever');
    const store = await restart(fs);
    const calls: string[] = [];
    const r = await runStartupSweep(store, fs, {
      verify: async (p) => (calls.push(p), true),
      now: () => T0,
    });
    expect(calls).toEqual([]);
    expect(r.promoted).toEqual([]);
    expect(store.state.get().projects[pid]!.frames.map((f) => f.state)).toEqual(['pending', 'local']);
  });

  it('a promotion that fails to commit leaves frame pending and file in place; retried next time', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content());
    const store = await restart(fs);
    fs.failOn({ op: 'writeTextAtomic', path: projectJsonPath(pid) });
    const r = await sweep(store, fs);
    expect(r.warnings.some((w) => w.kind === 'sweep_step_failed')).toBe(true);
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
    fs.clearFailures();
    const again = await sweep(store, fs);
    expect(again.promoted).toHaveLength(1);
  });
});

describe('tmp/ and frames/ garbage', () => {
  it('empties tmp/ (files and subdirectories)', async () => {
    const fs = new FakeFs();
    await seed(fs);
    fs.files.set('tmp/a.part', 'x');
    fs.files.set('tmp/sub/b', 'y');
    const store = await restart(fs);
    const r = await sweep(store, fs);
    expect(r.tmpRemoved.sort()).toEqual(['a.part', 'sub']);
    expect(await fs.list('tmp')).toEqual([]);
  });

  it('deletes files of tombstoned frames and unreferenced caches; keeps live and hidden frames', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['LIVE'], ['HID'], ['DEAD']]);
    await s0.updateProject(pid, (p) => hideFrame(p, 'HID', T0 + 60_000)); // inside the Undo window
    await s0.updateProject(pid, (p) => hideFrame(p, 'DEAD', EXPIRED)); // past its deadline
    await s0.updateProject(pid, (p) => ({ ...p, deletedFrameIds: [...p.deletedFrameIds, 'TOMB'] }));
    for (const id of ['LIVE', 'HID', 'DEAD', 'GONE', 'TOMB']) {
      for (const k of ['full', 'play', 'thumb'] as const) fs.files.set(fp(pid, id, k), 'x');
    }
    fs.files.set(fp(pid, 'LIVE'), content()); // installed and valid (promoted)
    fs.files.set(fp(pid, 'HID'), content());
    const store = await restart(fs);
    const r = await sweep(store, fs);
    expect((await fs.list(`projects/${pid}/frames`)).sort()).toEqual([
      'GONE.full.jpg', // neither live nor tombstoned: a full is kept (warning)
      'HID.full.jpg',
      'HID.play.jpg',
      'HID.thumb.jpg',
      'LIVE.full.jpg',
      'LIVE.play.jpg',
      'LIVE.thumb.jpg',
    ]);
    expect(r.framesExpired).toEqual([{ projectId: pid, frameId: 'DEAD' }]);
    expect(r.warnings.filter((w) => w.kind === 'full_kept_unreferenced').map((w) => w.path)).toEqual([fp(pid, 'GONE')]);
    expect(store.state.get().projects[pid]!.deletedFrameIds).toContain('DEAD');
  });

  it('unknown file names in frames/ are kept with a warning', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs);
    fs.files.set(`projects/${pid}/frames/notes.txt`, 'x');
    fs.files.set(`${fp(pid, 'X')}.tmp`, 'x');
    const store = await restart(fs);
    const r = await sweep(store, fs);
    expect(r.warnings.filter((w) => w.kind === 'unknown_file_kept')).toHaveLength(2);
    expect(await fs.list(`projects/${pid}/frames`)).toHaveLength(2);
  });

  it('crash point: tombstone committed, kill before the unlink -> the next sweep unlinks', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), 'x');
    fs.files.set(fp(pid, 'F1', 'play'), 'x');
    // the expiry commit (what the UI timer does), then killed before removing the files
    await s0.updateProject(pid, (p) => ({ ...p, frames: [], deletedFrameIds: ['F1'] }));
    const store = await restart(fs);
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
    await sweep(store, fs);
    expect(await fs.list(`projects/${pid}/frames`)).toEqual([]);
  });

  it('files are removed only after the commit that made them garbage (expiry)', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['F1']]);
    await s0.updateProject(pid, (p) => hideFrame(p, 'F1', EXPIRED));
    fs.files.set(fp(pid, 'F1'), 'x');
    const store = await restart(fs);
    fs.log.length = 0;
    await sweep(store, fs);
    const iWrite = fs.log.indexOf(`write ${projectJsonPath(pid)}`);
    const iRemove = fs.log.indexOf(`remove ${fp(pid, 'F1')}`);
    expect(iWrite).toBeGreaterThanOrEqual(0);
    expect(iRemove).toBeGreaterThan(iWrite);
  });

  it('a failed expiry commit leaves the file (frame still hidden, still live)', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['F1']]);
    await s0.updateProject(pid, (p) => hideFrame(p, 'F1', EXPIRED));
    fs.files.set(fp(pid, 'F1'), 'x');
    const store = await restart(fs);
    fs.failOn({ op: 'writeTextAtomic', path: projectJsonPath(pid) });
    await sweep(store, fs);
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
  });
});

describe('projects: tombstones and expiry', () => {
  it('crash point: tombstone committed, kill before the directory removal -> removed', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), 'x');
    await s0.mutate((s) => ({
      result: 0,
      index: { ...s.index, projects: [], deletedProjects: [pid] },
      dropProjects: [pid],
    }));
    const store = await restart(fs);
    expect(fs.dirs.has(`projects/${pid}`)).toBe(true);
    const r = await sweep(store, fs);
    expect(r.projectDirsRemoved).toEqual([pid]);
    expect(fs.dirs.has(`projects/${pid}`)).toBe(false);
    expect(fs.files.has(projectJsonPath(pid))).toBe(false);
    expect(store.state.get().index.projects).toEqual([]);
  });

  it('expires a pending delete past its deadline: commit first, then the directory goes', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs);
    await s0.updateIndex((i) => hideProject(i, pid, EXPIRED));
    const store = await restart(fs);
    fs.log.length = 0;
    const r = await sweep(store, fs);
    expect(r.projectsExpired).toEqual([pid]);
    const s = store.state.get();
    expect(s.index.deletedProjects).toEqual([pid]);
    expect(s.index.pendingProjectDeletes).toEqual([]);
    expect(s.projects[pid]).toBeUndefined();
    expect(fs.dirs.has(`projects/${pid}`)).toBe(false);
    expect(fs.log.indexOf(`write ${INDEX_PATH}`)).toBeLessThan(fs.log.indexOf(`remove projects/${pid}`));
  });

  it('a pending delete still inside the Undo window is left alone', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs);
    await s0.updateIndex((i) => hideProject(i, pid, T0));
    const store = await restart(fs);
    const r = await sweep(store, fs, T0 + 1000);
    expect(r.projectsExpired).toEqual([]);
    expect(store.state.get().index.pendingProjectDeletes).toHaveLength(1);
    expect(fs.dirs.has(`projects/${pid}`)).toBe(true);
  });

  it('a failed index commit at expiry removes nothing', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['F1']]);
    await s0.updateIndex((i) => hideProject(i, pid, EXPIRED));
    const store = await restart(fs);
    fs.failOn({ op: 'writeTextAtomic', path: INDEX_PATH });
    const r = await sweep(store, fs);
    expect(r.projectDirsRemoved).toEqual([]);
    expect(fs.files.has(projectJsonPath(pid))).toBe(true);
  });
});

describe('missing index entry / project.json', () => {
  it('re-adds a project directory missing from the index (not tombstoned)', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs, [['F1']]);
    await s0.updateIndex((i) => ({ ...i, projects: [] })); // the entry is gone, the directory stays
    const store = await restart(fs);
    expect(store.state.get().projects[pid]).toBeUndefined();
    const r = await sweep(store, fs);
    expect(r.projectsReadded).toEqual([pid]);
    const s = store.state.get();
    expect(s.index.projects.map((p) => p.id)).toEqual([pid]);
    expect(s.projects[pid]!.frames).toHaveLength(1);
    expect((fs.json(INDEX_PATH) as { projects: unknown[] }).projects).toHaveLength(1);
  });

  it('does not re-add a tombstoned project directory (it is removed)', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs);
    await s0.updateIndex((i) => ({ ...i, projects: [], deletedProjects: [pid] }));
    const store = await restart(fs);
    await sweep(store, fs);
    expect(store.state.get().index.projects).toEqual([]);
  });

  it('an unreadable project.json in an orphan dir: warning, nothing deleted', async () => {
    const fs = new FakeFs();
    await seed(fs);
    fs.files.set('projects/orphan/project.json', '{not json');
    fs.files.set('projects/orphan/frames/F.full.jpg', 'x');
    fs.files.set('projects/future/project.json', JSON.stringify({ version: 9 }));
    fs.files.set('projects/noid/frames/F.full.jpg', 'x');
    const store = await restart(fs);
    const r = await sweep(store, fs);
    expect(
      r.warnings
        .filter((w) => w.kind === 'orphan_dir_unreadable')
        .map((w) => w.id)
        .sort(),
    ).toEqual(['future', 'noid', 'orphan']);
    expect(fs.files.has('projects/orphan/project.json')).toBe(true);
    expect(fs.files.has('projects/orphan/frames/F.full.jpg')).toBe(true);
    expect(fs.files.has('projects/future/project.json')).toBe(true);
    expect(fs.files.has('projects/noid/frames/F.full.jpg')).toBe(true);
    expect(store.state.get().index.projects).toHaveLength(1);
  });

  it('an orphan dir whose project.json carries another id is kept and not re-added', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs);
    fs.files.set('projects/zzz/project.json', fs.files.get(projectJsonPath(pid))!);
    const store = await restart(fs);
    const r = await sweep(store, fs);
    expect(r.warnings.map((w) => w.kind)).toEqual(['orphan_dir_mismatch']);
    expect(fs.files.has('projects/zzz/project.json')).toBe(true);
  });

  it('an EMPTY orphan dir (rolled-back create) is removed', async () => {
    const fs = new FakeFs();
    await seed(fs);
    fs.dirs.add('projects/empty');
    const store = await restart(fs);
    await sweep(store, fs);
    expect(fs.dirs.has('projects/empty')).toBe(false);
  });

  it('crash point: createProject killed after the index entry -> project.json recreated', async () => {
    const fs = new FakeFs();
    const s0 = await open(fs);
    fs.crashAfter(1); // index written, then the kill
    await expect(s0.createProject('Film')).rejects.toBeInstanceOf(CrashError);
    const store = await restart(fs);
    const [entry] = store.state.get().index.projects;
    expect(entry).toBeDefined();
    expect(store.state.get().warnings.map((w) => w.kind)).toEqual(['project_missing']);
    const r = await sweep(store, fs);
    expect(r.projectsRecreated).toEqual([entry!.id]);
    const p = store.state.get().projects[entry!.id]!;
    expect(p).toMatchObject({ name: 'Film', createdAt: entry!.createdAt, frames: [], fps: 8 });
    expect(fs.json(projectJsonPath(entry!.id))).toEqual(p);
    const again = await sweep(await restart(fs), fs); // idempotent
    expect(again.projectsRecreated).toEqual([]);
  });

  it('crash point: createProject killed after mkdir, before project.json', async () => {
    const fs = new FakeFs();
    const s0 = await open(fs);
    fs.crashAfter(2);
    await expect(s0.createProject('Film')).rejects.toBeInstanceOf(CrashError);
    const store = await restart(fs);
    const r = await sweep(store, fs);
    expect(r.projectsRecreated).toHaveLength(1);
  });

  it('crash point: corrupt project.json -> kept as .corrupt, rebuilt empty; frame files survive, also the next start', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content());
    fs.files.set(projectJsonPath(pid), '{"version":1,');
    const store = await restart(fs);
    expect(store.state.get().warnings.map((w) => w.kind)).toEqual(['project_corrupt']);
    const r = await sweep(store, fs);
    expect(r.projectsRecreated).toEqual([pid]);
    expect([...fs.files.keys()].some((k) => k.includes('project.json.corrupt-'))).toBe(true);
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
    const again = await sweep(await restart(fs), fs);
    expect(again.filesRemoved).toEqual([]);
    expect(again.warnings.map((w) => w.kind)).toEqual(['full_kept_unreferenced']);
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
  });

  it('crash point: a rename wrote the index only -> project.json gets the index name', async () => {
    const fs = new FakeFs();
    const { store: s0, pid } = await seed(fs);
    const cur = s0.state.get();
    const renamed = renameProject(cur.index, cur.projects[pid]!, 'Nowa nazwa')!;
    await s0.mutate(() => ({ result: 0, index: renamed.index })); // the project.json write never happened
    const store = await restart(fs);
    expect(store.state.get().projects[pid]!.name).toBe('Film');
    const r = await sweep(store, fs);
    expect(r.namesAligned).toEqual([pid]);
    expect(store.state.get().projects[pid]!.name).toBe('Nowa nazwa');
    expect((fs.json(projectJsonPath(pid)) as Project).name).toBe('Nowa nazwa');
  });
});

describe('corrupt index.json: rebuild from the directory listing', () => {
  it('keeps the salvaged clientId and re-adds every readable project', async () => {
    const fs = new FakeFs();
    const s0 = await open(fs);
    const a = await s0.createProject('A');
    const b = await s0.createProject('B');
    const clientId = s0.state.get().index.clientId;
    fs.files.set(INDEX_PATH, JSON.stringify({ version: 1, clientId, projects: 'oops' }));
    fs.files.set('projects/broken/project.json', 'nope');
    const store = await restart(fs);
    expect(store.state.get().warnings.map((w) => w.kind)).toEqual(['index_corrupt']);
    expect(store.state.get().index.projects).toEqual([]);
    const r = await sweep(store, fs);
    const idx = store.state.get().index;
    expect(idx.clientId).toBe(clientId);
    expect(idx.projects.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(Object.keys(store.state.get().projects).sort()).toEqual([a.id, b.id].sort());
    expect(r.warnings.map((w) => w.id)).toEqual(['broken']);
    expect(fs.files.has('projects/broken/project.json')).toBe(true);
    expect([...fs.files.keys()].some((k) => k.startsWith('index.json.corrupt-'))).toBe(true);
    expect((fs.json(INDEX_PATH) as { projects: unknown[] }).projects).toHaveLength(2);
  });

  it('works with the onIndexCorrupt hook installed (the sweep, not the hook, rebuilds)', async () => {
    const fs = new FakeFs();
    const s0 = await open(fs);
    const a = await s0.createProject('A');
    fs.files.set(INDEX_PATH, '{garbage');
    fs.restart();
    let hooked = 0;
    const store = new ProjectStore(fs, { newId: () => `id-${++n}`, onIndexCorrupt: () => void hooked++ });
    await store.load();
    expect(hooked).toBe(1);
    await sweep(store, fs);
    expect(store.state.get().index.projects.map((p) => p.id)).toEqual([a.id]);
  });
});

describe('safety', () => {
  it('a read-only store (unknown version) is not touched at all', async () => {
    const fs = new FakeFs();
    fs.files.set(INDEX_PATH, JSON.stringify({ version: 2 }));
    fs.files.set('tmp/x', 'x');
    fs.files.set('projects/p/frames/F.play.jpg', 'x');
    const store = await open(fs);
    fs.log.length = 0;
    const r = await sweep(store, fs);
    expect(r.skipped).toBe('read_only');
    expect(fs.log).toEqual([]);
    expect(fs.files.has('tmp/x')).toBe(true);
  });

  it('is idempotent: a second sweep changes nothing', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content());
    fs.files.set('tmp/x', 'x');
    const store = await restart(fs);
    await sweep(store, fs);
    fs.log.length = 0;
    const r = await sweep(store, fs);
    expect(fs.log).toEqual([]);
    expect(r.promoted).toEqual([]);
  });

  it('a failing step does not stop the others', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content());
    fs.files.set('tmp/x', 'x');
    const store = await restart(fs);
    fs.failOn({ op: 'list', path: 'tmp' });
    const r = await sweep(store, fs);
    expect(r.warnings.map((w) => w.kind)).toEqual(['sweep_step_failed']);
    expect(r.promoted).toHaveLength(1);
  });
});

describe('createWebVerify', () => {
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  const hex = async (b: ArrayBuffer) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');
  const fs = new FakeFs();

  it('true for matching size and sha256', async () => {
    const buf = enc('jpeg-bytes');
    const v = createWebVerify(fs, async () => buf);
    expect(await v('p', 10, await hex(buf))).toBe(true);
  });

  it('false for a wrong size or hash; fetch errors propagate', async () => {
    const buf = enc('jpeg-bytes');
    const v = createWebVerify(fs, async () => buf);
    expect(await v('p', 9, await hex(buf))).toBe(false);
    expect(await v('p', 10, 'b'.repeat(64))).toBe(false);
    const bad = createWebVerify(fs, async () => {
      throw new Error('404');
    });
    await expect(bad('p', 10, 'x')).rejects.toThrow('404');
  });
});

describe('createFetchBytes', () => {
  it('throws on a non-2xx answer (so verify keeps the file) and returns the bytes on 200', async () => {
    const buf = new ArrayBuffer(3);
    const ok = createFetchBytes((async () => ({ ok: true, status: 200, arrayBuffer: async () => buf })) as any, (u) => u);
    expect(await ok('file:///x')).toBe(buf);
    const bad = createFetchBytes((async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })) as any, (u) => u);
    await expect(bad('file:///x')).rejects.toThrow('404');
  });

  it('a 404 from the webview keeps the install file and the frame (verify throws -> warn)', async () => {
    const fs = new FakeFs();
    const { pid } = await seed(fs, [['F1']]);
    fs.files.set(fp(pid, 'F1'), content());
    const store = await restart(fs);
    const verify = createWebVerify(fs, createFetchBytes((async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })) as any, (u) => u));
    const r = await runStartupSweep(store, fs, { verify, now: () => T0 });
    expect(fs.files.has(fp(pid, 'F1'))).toBe(true);
    expect(r.mismatched).toEqual([]);
    expect(r.warnings.map((w) => w.kind)).toContain('verify_failed');
  });
});
