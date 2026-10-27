import { describe, expect, it, vi } from 'vitest';
import { CrashError, FakeFs, noSpace } from './fakeFs.testutil';
import { INDEX_PATH, projectJsonPath } from './files';
import type { FrameInfo } from './model';
import { beginCapture, mergeFrame, removeOutstanding, renameProject, routeResult } from './reducers';
import { ProjectStore, ReadOnlyError, type StoreOptions } from './store';

let n = 0;
const mk = (fs = new FakeFs(), opts: StoreOptions = {}) => {
  const store = new ProjectStore(fs, { now: () => 1_700_000_000_000, newId: () => `id-${++n}`, ...opts });
  return { fs, store };
};
const loaded = async (fs = new FakeFs(), opts: StoreOptions = {}) => {
  const m = mk(fs, opts);
  await m.store.load();
  return m;
};
const info = (projectId: string, frameId: string, seq: number): FrameInfo => ({
  frameId,
  seq,
  projectId,
  clientId: 'c',
  rotation: 0,
  capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: 'a'.repeat(64) },
});

describe('load', () => {
  it('creates a fresh index with a new clientId when index.json is missing', async () => {
    const { fs, store } = await loaded();
    const s = store.state.get();
    expect(s.ready).toBe(true);
    expect(s.readOnly).toBe(false);
    expect(s.index.clientId).toMatch(/^id-/);
    expect(fs.json(INDEX_PATH)).toEqual(s.index);
  });

  it('uses a random UUID by default and keeps the clientId across restarts', async () => {
    const fs = new FakeFs();
    const a = new ProjectStore(fs);
    await a.load();
    const b = new ProjectStore(fs);
    await b.load();
    expect(a.state.get().index.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.state.get().index.clientId).toBe(a.state.get().index.clientId);
  });

  it('round-trips projects through disk', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    const again = await loaded(fs);
    expect(again.store.state.get().projects[p.id]).toEqual(p);
    expect(again.store.state.get().index).toEqual(store.state.get().index);
  });

  it('unknown index version: read-only, warning, nothing written, mutations reject', async () => {
    const fs = new FakeFs();
    const future = JSON.stringify({ version: 2, whatever: true });
    fs.files.set(INDEX_PATH, future);
    const { store } = await loaded(fs);
    const s = store.state.get();
    expect(s.readOnly).toBe(true);
    expect(s.warnings.map((w) => w.kind)).toEqual(['index_unknown_version']);
    expect(fs.files.get(INDEX_PATH)).toBe(future);
    expect(fs.log).toEqual([]);
    await expect(store.createProject('x')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(store.updateIndex((i) => ({ ...i, deletedProjects: ['z'] }))).rejects.toBeInstanceOf(ReadOnlyError);
    expect(fs.files.get(INDEX_PATH)).toBe(future);
  });

  it('unknown project version: read-only, the file is left alone', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    const future = JSON.stringify({ version: 3 });
    fs.files.set(projectJsonPath(p.id), future);
    const again = await loaded(fs);
    expect(again.store.state.get().readOnly).toBe(true);
    expect(again.store.state.get().warnings[0]).toMatchObject({ kind: 'project_unknown_version', id: p.id });
    expect(fs.files.get(projectJsonPath(p.id))).toBe(future);
  });

  it('corrupt index.json: renamed to *.corrupt-<ts>, warning, fresh index, hook called', async () => {
    const fs = new FakeFs();
    fs.files.set(INDEX_PATH, '{"version":1,"clientId":"keep-me","projects":[');
    const hook = vi.fn();
    const { store } = await loaded(fs, { onIndexCorrupt: hook });
    const s = store.state.get();
    expect(s.readOnly).toBe(false);
    expect(s.warnings).toHaveLength(1);
    const w = s.warnings[0]!;
    expect(w).toMatchObject({ kind: 'index_corrupt', corruptPath: `${INDEX_PATH}.corrupt-1700000000000` });
    expect(fs.files.get(w.corruptPath!)).toBe('{"version":1,"clientId":"keep-me","projects":[');
    expect(s.index.clientId).toMatch(/^id-/); // not parseable: a new one
    expect(fs.json(INDEX_PATH)).toEqual(s.index);
    expect(hook).toHaveBeenCalledWith(w, store);
  });

  it('corrupt index with a parseable clientId keeps it', async () => {
    const fs = new FakeFs();
    fs.files.set(INDEX_PATH, JSON.stringify({ version: 1, clientId: 'keep-me', projects: 'nope' }));
    const { store } = await loaded(fs);
    expect(store.state.get().index.clientId).toBe('keep-me');
    expect(store.state.get().warnings[0]!.kind).toBe('index_corrupt');
  });

  it('clientId is also kept in client-id.txt (written once); used when index.json is unsalvageable', async () => {
    const { fs, store } = await loaded();
    const id = store.state.get().index.clientId;
    expect(fs.files.get('client-id.txt')).toBe(id);
    fs.files.set(INDEX_PATH, '{{{');
    const again = await loaded(fs);
    expect(again.store.state.get().index.clientId).toBe(id);
    expect(fs.files.get('client-id.txt')).toBe(id); // not rewritten
  });

  it('client-id.txt is created for an existing index (upgrade) and never overwritten', async () => {
    const { fs, store } = await loaded();
    const id = store.state.get().index.clientId;
    fs.files.delete('client-id.txt');
    await loaded(fs);
    expect(fs.files.get('client-id.txt')).toBe(id);
    fs.files.set('client-id.txt', 'older');
    await loaded(fs);
    expect(fs.files.get('client-id.txt')).toBe('older');
  });

  it('a failing client-id.txt write does not stop load', async () => {
    const fs = new FakeFs();
    fs.failOn({ op: 'writeTextAtomic', path: 'client-id.txt' });
    const { store } = await loaded(fs);
    expect(store.state.get().ready).toBe(true);
  });

  it('corrupt project.json: renamed, warning, the project is absent from memory', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    fs.files.set(projectJsonPath(p.id), 'not json');
    const again = await loaded(fs);
    const s = again.store.state.get();
    expect(s.projects[p.id]).toBeUndefined();
    expect(s.warnings[0]).toMatchObject({ kind: 'project_corrupt', id: p.id });
    expect(fs.files.has(projectJsonPath(p.id))).toBe(false);
    expect(fs.files.get(s.warnings[0]!.corruptPath!)).toBe('not json');
    await expect(again.store.updateProject(p.id, (x) => x)).rejects.toThrow(/unknown project/);
  });

  it('missing project.json of an indexed project: project_missing warning (Task 7 repairs)', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    fs.files.delete(projectJsonPath(p.id));
    const again = await loaded(fs);
    expect(again.store.state.get().warnings).toEqual([
      expect.objectContaining({ kind: 'project_missing', id: p.id }),
    ]);
  });

  it('mutations before load reject', async () => {
    const { store } = mk();
    await expect(store.createProject('x')).rejects.toThrow(/not loaded/);
  });
});

describe('mutation queue', () => {
  it('writes before it updates memory and notifies; resolves after the write', async () => {
    const { fs, store } = await loaded();
    const seen: string[] = [];
    store.state.subscribe(() => seen.push(`notify:${fs.log.length}`));
    const before = fs.log.length;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = fs.writeTextAtomic.bind(fs);
    fs.writeTextAtomic = async (p, t) => {
      await gate;
      return orig(p, t);
    };
    let resolved = false;
    const pr = store.createProject('Film').then((p) => ((resolved = true), p));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.state.get().index.projects).toHaveLength(0);
    expect(seen).toEqual([]);
    expect(resolved).toBe(false);
    release();
    const p = await pr;
    expect(store.state.get().projects[p.id]).toBe(p);
    expect(seen).toEqual([`notify:${before + 3}`]); // index, mkdir, project.json: one notify, after all
    expect(fs.json(projectJsonPath(p.id))).toEqual(p);
  });

  it('serializes concurrent callers: each sees the previous result, writes never interleave', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    let active = 0;
    let maxActive = 0;
    const orig = fs.writeTextAtomic.bind(fs);
    fs.writeTextAtomic = async (path, text) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      await orig(path, text);
      active--;
    };
    const order: number[] = [];
    const jobs = Array.from({ length: 20 }, (_, i) =>
      store
        .updateProject(p.id, (x) => ({ ...x, deletedFrameIds: [...x.deletedFrameIds, `f${i}`] }))
        .then(() => order.push(i)),
    );
    await Promise.all(jobs);
    expect(maxActive).toBe(1);
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const ids = (fs.json(projectJsonPath(p.id)) as { deletedFrameIds: string[] }).deletedFrameIds;
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `f${i}`)); // no lost update
    expect(store.state.get().projects[p.id]!.deletedFrameIds).toEqual(ids);
  });

  it('mixed concurrent creates and updates all land', async () => {
    const { fs, store } = await loaded();
    const ps = await Promise.all([store.createProject('a'), store.createProject('b'), store.createProject('c')]);
    expect(new Set(ps.map((p) => p.id)).size).toBe(3);
    expect(store.state.get().index.projects.map((p) => p.name)).toEqual(['a', 'b', 'c']);
    expect((fs.json(INDEX_PATH) as { projects: unknown[] }).projects).toHaveLength(3);
  });

  it('a no-op mutation (same reference) writes nothing and does not notify', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    const log = fs.log.length;
    const cb = vi.fn();
    store.state.subscribe(cb);
    await store.updateProject(p.id, (x) => x);
    await store.updateIndex((i) => i);
    expect(fs.log.length).toBe(log);
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing reducer rejects that mutation only; the queue continues', async () => {
    const { store } = await loaded();
    const bad = store.mutate(() => {
      throw new Error('boom');
    });
    const good = store.createProject('ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toMatchObject({ name: 'ok' });
  });

  it('rename writes both files (the name lives in both)', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Old');
    await store.mutate((s) => {
      const r = renameProject(s.index, s.projects[p.id]!, 'New')!;
      return { result: null, index: r.index, projects: [r.project] };
    });
    expect((fs.json(INDEX_PATH) as { projects: { name: string }[] }).projects[0]!.name).toBe('New');
    expect((fs.json(projectJsonPath(p.id)) as { name: string }).name).toBe('New');
  });

  it('dropProjects removes from memory after the commit', async () => {
    const { store } = await loaded();
    const p = await store.createProject('Film');
    await store.mutate(() => ({ result: null, dropProjects: [p.id] }));
    expect(store.state.get().projects[p.id]).toBeUndefined();
  });
});

describe('failed writes', () => {
  it('NO_SPACE on a project write: memory and disk stay as before, the mutation rejects', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    const before = store.state.get();
    const diskBefore = fs.files.get(projectJsonPath(p.id));
    fs.failOn({ op: 'writeTextAtomic', path: projectJsonPath(p.id), error: noSpace() });
    await expect(store.updateProject(p.id, (x) => ({ ...x, fps: 12 }))).rejects.toMatchObject({ code: 'NO_SPACE' });
    expect(store.state.get()).toBe(before);
    expect(fs.files.get(projectJsonPath(p.id))).toBe(diskBefore);
    // the queue is not wedged
    fs.clearFailures();
    await expect(store.updateProject(p.id, (x) => ({ ...x, fps: 12 }))).resolves.toMatchObject({ fps: 12 });
  });

  it('second write of a two-file mutation fails: the first is restored', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Old');
    const idx = fs.files.get(INDEX_PATH);
    fs.failOn({ op: 'writeTextAtomic', path: projectJsonPath(p.id), error: noSpace() });
    await expect(
      store.mutate((s) => {
        const r = renameProject(s.index, s.projects[p.id]!, 'New')!;
        return { result: null, index: r.index, projects: [r.project] };
      }),
    ).rejects.toMatchObject({ code: 'NO_SPACE' });
    expect(fs.files.get(INDEX_PATH)).toBe(idx);
    expect(store.state.get().projects[p.id]!.name).toBe('Old');
    expect(store.state.get().index.projects[0]!.name).toBe('Old');
  });

  it('a failed write leaves the disk readable by a fresh load equal to memory', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    fs.failOn({ op: 'writeTextAtomic', error: new Error('EIO'), times: 1 });
    await expect(store.updateProject(p.id, (x) => ({ ...x, fps: 5 }))).rejects.toThrow('EIO');
    const again = await loaded(fs);
    expect(again.store.state.get().projects).toEqual(store.state.get().projects);
    expect(again.store.state.get().index).toEqual(store.state.get().index);
  });

  it('a failed merge after a capture result keeps the outstanding entry; a retry later succeeds', async () => {
    const { fs, store } = await loaded();
    const p = await store.createProject('Film');
    await store.updateProject(p.id, (x) => {
      const r = beginCapture(x, { reqId: 'req1', cameraId: 'cam', nowMs: 1 });
      if (!r.ok) throw new Error('bad');
      return r.project;
    });
    const merge = () =>
      store.updateProject(p.id, (x) => removeOutstanding(mergeFrame(x, info(p.id, 'F1', 1), 'cam').project, 'req1'));

    fs.failOn({ op: 'writeTextAtomic', path: projectJsonPath(p.id), error: noSpace(), times: 1 });
    await expect(merge()).rejects.toMatchObject({ code: 'NO_SPACE' });
    for (const proj of [store.state.get().projects[p.id]!, fs.json(projectJsonPath(p.id)) as typeof p]) {
      expect(proj.outstanding.map((o) => o.reqId)).toEqual(['req1']);
      expect(proj.frames).toEqual([]);
    }
    // the caller retries; mutations are idempotent upserts
    await merge();
    await merge();
    const done = store.state.get().projects[p.id]!;
    expect(done.outstanding).toEqual([]);
    expect(done.frames.map((f) => f.frameId)).toEqual(['F1']);
    expect(fs.json(projectJsonPath(p.id))).toEqual(done);
    expect(routeResult(store.state.get().index, p.id)).toBe('merge');
  });
});

describe('createProject flow and crash windows', () => {
  it('order: index entry, then projects/{id}/, then project.json', async () => {
    const { fs, store } = await loaded();
    const start = fs.log.length;
    const p = await store.createProject('Film', { rotation: 180 });
    expect(fs.log.slice(start)).toEqual([`write ${INDEX_PATH}`, `mkdir projects/${p.id}`, `write projects/${p.id}/project.json`]);
    expect(p.geometry.rotation).toBe(180);
    expect(fs.dirs.has(`projects/${p.id}`)).toBe(true);
  });

  it('blank name is refused without any write', async () => {
    const { fs, store } = await loaded();
    const log = fs.log.length;
    await expect(store.createProject('  ')).rejects.toThrow(/empty/);
    expect(fs.log.length).toBe(log);
  });

  it('failure at mkdir: index rolled back, memory unchanged', async () => {
    const { fs, store } = await loaded();
    const before = store.state.get();
    const idx = fs.files.get(INDEX_PATH);
    fs.failOn({ op: 'mkdir', error: noSpace() });
    await expect(store.createProject('Film')).rejects.toMatchObject({ code: 'NO_SPACE' });
    expect(store.state.get()).toBe(before);
    expect(fs.files.get(INDEX_PATH)).toBe(idx);
    expect([...fs.files.keys()].filter((k) => k.startsWith('projects/'))).toEqual([]);
  });

  it('failure at project.json: index and directory rolled back', async () => {
    const { fs, store } = await loaded();
    const idx = fs.files.get(INDEX_PATH);
    fs.failOn({ op: 'writeTextAtomic', path: /project\.json$/, error: noSpace() });
    await expect(store.createProject('Film')).rejects.toMatchObject({ code: 'NO_SPACE' });
    expect(fs.files.get(INDEX_PATH)).toBe(idx);
    expect([...fs.dirs].filter((d) => d.startsWith('projects/'))).toEqual([]);
    expect(store.state.get().index.projects).toEqual([]);
  });

  it('crash after the index write: index entry without directory (window 1), reported at load', async () => {
    const { fs, store } = await loaded();
    fs.crashAfter(1);
    await expect(store.createProject('Film')).rejects.toBeInstanceOf(CrashError);
    fs.restart();
    const entry = (fs.json(INDEX_PATH) as { projects: { id: string }[] }).projects[0]!;
    expect(fs.dirs.has(`projects/${entry.id}`)).toBe(false);
    const again = await loaded(fs);
    expect(again.store.state.get().index.projects).toHaveLength(1);
    expect(again.store.state.get().warnings).toEqual([expect.objectContaining({ kind: 'project_missing', id: entry.id })]);
  });

  it('crash after mkdir: index entry + empty directory, no project.json (window 1)', async () => {
    const { fs, store } = await loaded();
    fs.crashAfter(2);
    await expect(store.createProject('Film')).rejects.toBeInstanceOf(CrashError);
    fs.restart();
    const entry = (fs.json(INDEX_PATH) as { projects: { id: string }[] }).projects[0]!;
    expect(fs.dirs.has(`projects/${entry.id}`)).toBe(true);
    expect(fs.files.has(projectJsonPath(entry.id))).toBe(false);
    const again = await loaded(fs);
    expect(again.store.state.get().warnings[0]).toMatchObject({ kind: 'project_missing' });
  });

  it('failed rollback is reported as a warning', async () => {
    const { fs, store } = await loaded();
    // the index write succeeds, mkdir fails, and the rollback write of the index fails too
    const orig = fs.writeTextAtomic.bind(fs);
    let calls = 0;
    fs.failOn({ op: 'mkdir', error: noSpace() });
    fs.writeTextAtomic = async (p, t) => {
      if (p === INDEX_PATH && ++calls === 2) throw new Error('EIO');
      return orig(p, t);
    };
    await expect(store.createProject('Film')).rejects.toMatchObject({ code: 'NO_SPACE' });
    expect(store.state.get().warnings.map((w) => w.kind)).toContain('rollback_failed');
    expect(store.state.get().index.projects).toEqual([]);
  });
});
