/**
 * ProjectStore startup sweep (ARCHITECTURE §5.6 "Interrupted install", §5.8). Run ONCE after
 * `ProjectStore.load()` and BEFORE any download/install/capture starts (it empties `tmp/`).
 *
 * Rules, in order:
 *  1. `tmp/` is emptied.
 *  2. `pendingProjectDeletes` past their deadline -> `deletedProjects` (commit) -> directory removed.
 *     Directories of every project in `deletedProjects` are removed (crash window 4).
 *  3. `projects/{id}/` missing from the index and not tombstoned: its `project.json` is read and the
 *     project re-added to the index. This is also how a corrupt `index.json` is rebuilt from the
 *     directory listing (the store already restarted with an empty index and the salvaged clientId).
 *     Unreadable `project.json` -> warning, the directory is NEVER deleted (only a truly empty
 *     directory, with nothing to lose, is removed).
 *     (`StoreOptions.onIndexCorrupt` is deliberately not used: the hook runs INSIDE `load()`'s queue
 *     slot, so awaiting `store.mutate` from it would deadlock. The sweep does the rebuild.)
 *  4. Index entry without `project.json` (windows 1, 2, corrupt project.json) -> recreated from the
 *     index entry (empty frames). Index name wins over project.json name (window 3).
 *  5. Per project: hidden frames past their Undo deadline expire (tombstone commit, files go in 6);
 *     `pending` frames whose `frames/{id}.full.jpg` verifies (size + sha256) -> `local`; a file that
 *     does not verify is deleted and the frame stays `pending`; a `verify` that throws keeps the file.
 *  6. Files under `frames/` with no live frame entry are deleted if the frame is tombstoned
 *     (`deletedFrameIds`) or the file is a `play`/`thumb` cache. A `full` that is neither live nor
 *     tombstoned is KEPT with a warning (metadata loss: it may be the only copy). Unknown names are
 *     kept with a warning. Hidden (Undo window) frames are live, their files stay.
 *
 * Every state change goes through `store.mutate`; a file is removed only after the mutation that
 * made it garbage has committed. Read-only store (unknown future version): nothing is touched.
 * `verify` for the app: see `createWebVerify` (rare startup path, so a whole-file `fetch` is fine).
 */
import { projectDir, projectJsonPath, type FileAdapter } from './files';
import { DEFAULT_FPS, ModelError, parseProject, type FrameEntry, type Project } from './model';
import { expireFrames, expireProjects, setLocal } from './reducers';
import type { ProjectStore } from './store';

/** `path` is store-relative (`projects/{id}/frames/{frameId}.full.jpg`). Resolves true iff size and sha256 match. */
export type VerifyFn = (path: string, bytes: number, sha256: string) => Promise<boolean>;

export type SweepWarningKind =
  | 'orphan_dir_unreadable'
  | 'orphan_dir_mismatch'
  | 'project_recreated'
  | 'verify_failed'
  | 'full_kept_unreferenced'
  | 'unknown_file_kept'
  | 'sweep_step_failed';

export interface SweepWarning {
  kind: SweepWarningKind;
  id?: string;
  path?: string;
  detail: string;
}

export interface SweepReport {
  skipped?: 'read_only';
  tmpRemoved: string[];
  projectsExpired: string[];
  projectDirsRemoved: string[];
  projectsReadded: string[];
  projectsRecreated: string[];
  namesAligned: string[];
  framesExpired: { projectId: string; frameId: string }[];
  promoted: { projectId: string; frameId: string }[];
  /** Install files that did not match size/sha256 and were deleted (frame stays `pending`). */
  mismatched: { projectId: string; frameId: string }[];
  filesRemoved: string[];
  warnings: SweepWarning[];
}

export interface SweepOptions {
  verify: VerifyFn;
  now?: () => number;
}

const FRAME_FILE = /^(.+)\.(full|play|thumb)\.jpg$/;
const errMsg = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

/**
 * App `verify`: `fetchBytes(uri)` is `(u) => fetch(convertFileSrc(u)).then((r) => r.arrayBuffer())`,
 * hash via `crypto.subtle`. Loads the whole file (a few MB; startup only, rare).
 */
export function createWebVerify(
  fs: Pick<FileAdapter, 'uri'>,
  fetchBytes: (uri: string) => Promise<ArrayBuffer>,
): VerifyFn {
  return async (path, bytes, sha256) => {
    const buf = await fetchBytes(await fs.uri(path));
    if (buf.byteLength !== bytes) return false;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    return hex === sha256.toLowerCase();
  };
}

export async function runStartupSweep(store: ProjectStore, fs: FileAdapter, opts: SweepOptions): Promise<SweepReport> {
  const now = opts.now ?? Date.now;
  const r: SweepReport = {
    tmpRemoved: [],
    projectsExpired: [],
    projectDirsRemoved: [],
    projectsReadded: [],
    projectsRecreated: [],
    namesAligned: [],
    framesExpired: [],
    promoted: [],
    mismatched: [],
    filesRemoved: [],
    warnings: [],
  };
  if (store.state.get().readOnly) {
    r.skipped = 'read_only';
    return r;
  }
  // a failing step must not stop the others (and never deletes anything it was unsure about)
  const step = async (name: string, id: string | undefined, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      r.warnings.push({ kind: 'sweep_step_failed', ...(id ? { id } : {}), detail: `${name}: ${errMsg(e)}` });
    }
  };

  async function snapshot(id: string): Promise<Project> {
    return store.mutate((s) => {
      const p = s.projects[id];
      if (!p) throw new Error(`project vanished: ${id}`);
      return { result: p };
    });
  }

  async function sweepProject(id: string): Promise<void> {
    // name: the index is written first by a rename, so it is the newer one
    const aligned = await store.mutate((s) => {
      const p = s.projects[id];
      const e = s.index.projects.find((x) => x.id === id);
      if (!p || !e || p.name === e.name) return { result: false };
      return { result: true, projects: [{ ...p, name: e.name }] };
    });
    if (aligned) r.namesAligned.push(id);

    // frames past their Undo deadline
    const expiredIds = await store.mutate((s) => {
      const p = s.projects[id];
      if (!p) return { result: [] as string[] };
      const e = expireFrames(p, now());
      return { result: e.expired, projects: [e.project] };
    });
    for (const frameId of expiredIds) r.framesExpired.push({ projectId: id, frameId });

    // interrupted installs
    const framesDir = `${projectDir(id)}/frames`;
    const present = new Set(await fs.list(framesDir));
    const pending = (await snapshot(id)).frames.filter((f) => f.state === 'pending' && present.has(`${f.frameId}.full.jpg`));
    const ok: FrameEntry[] = [];
    for (const f of pending) {
      const path = `${framesDir}/${f.frameId}.full.jpg`;
      let good: boolean;
      try {
        good = await opts.verify(path, f.bytes, f.sha256);
      } catch (e) {
        r.warnings.push({ kind: 'verify_failed', id, path, detail: `${errMsg(e)}; file kept` });
        continue;
      }
      if (good) ok.push(f);
      else {
        await fs.remove(path);
        r.mismatched.push({ projectId: id, frameId: f.frameId });
      }
    }
    if (ok.length > 0) {
      const done = await store.mutate((s) => {
        let p = s.projects[id];
        const promoted: string[] = [];
        if (!p) return { result: promoted };
        for (const f of ok) {
          const cur = p.frames.find((x) => x.frameId === f.frameId);
          if (!cur || cur.state !== 'pending' || cur.sha256 !== f.sha256 || cur.bytes !== f.bytes) continue;
          p = setLocal(p, f.frameId);
          promoted.push(f.frameId);
        }
        return { result: promoted, projects: [p] };
      });
      for (const frameId of done) r.promoted.push({ projectId: id, frameId });
    }

    // garbage: list FIRST, then snapshot (an entry always exists before its file does)
    const files = await fs.list(framesDir);
    const proj = await snapshot(id);
    const live = new Set(proj.frames.map((f) => f.frameId));
    const dead = new Set(proj.deletedFrameIds);
    for (const name of files) {
      const path = `${framesDir}/${name}`;
      const m = FRAME_FILE.exec(name);
      if (!m) {
        r.warnings.push({ kind: 'unknown_file_kept', id, path, detail: 'unexpected name in frames/' });
        continue;
      }
      const frameId = m[1]!;
      const kind = m[2]!;
      if (live.has(frameId)) continue;
      if (dead.has(frameId) || kind !== 'full') {
        await fs.remove(path);
        r.filesRemoved.push(path);
      } else {
        r.warnings.push({ kind: 'full_kept_unreferenced', id, path, detail: 'no frame entry and not tombstoned; kept' });
      }
    }
  }

  await step('tmp', undefined, async () => {
    for (const name of await fs.list('tmp')) {
      await fs.remove(`tmp/${name}`, { recursive: true });
      r.tmpRemoved.push(name);
    }
  });

  await step('expire-projects', undefined, async () => {
    const expired = await store.mutate((s) => {
      const e = expireProjects(s.index, now());
      return { result: e.expired, index: e.index, dropProjects: e.expired };
    });
    r.projectsExpired.push(...expired);
  });

  await step('tombstoned-dirs', undefined, async () => {
    const dead = new Set(store.state.get().index.deletedProjects);
    for (const name of await fs.list('projects')) {
      if (!dead.has(name)) continue;
      await fs.remove(projectDir(name), { recursive: true });
      r.projectDirsRemoved.push(name);
    }
  });

  await step('readd-dirs', undefined, async () => {
    const found: Project[] = [];
    for (const name of await fs.list('projects')) {
      const idx = store.state.get().index;
      if (idx.projects.some((p) => p.id === name) || idx.deletedProjects.includes(name)) continue;
      if (idx.pendingProjectDeletes.some((p) => p.id === name)) continue;
      const path = projectJsonPath(name);
      const text = await fs.readText(path);
      if (text === null) {
        if ((await fs.list(projectDir(name))).length === 0) {
          await fs.remove(projectDir(name), { recursive: true }); // empty: nothing to lose
          r.projectDirsRemoved.push(name);
        } else {
          r.warnings.push({ kind: 'orphan_dir_unreadable', id: name, path, detail: 'no project.json; directory kept' });
        }
        continue;
      }
      let p: Project;
      try {
        p = parseProject(JSON.parse(text));
      } catch (e) {
        const why = e instanceof ModelError && e.code === 'unknown_version' ? 'unknown version' : errMsg(e);
        r.warnings.push({ kind: 'orphan_dir_unreadable', id: name, path, detail: `${why}; directory kept` });
        continue;
      }
      if (p.id !== name) {
        r.warnings.push({ kind: 'orphan_dir_mismatch', id: name, path, detail: `project.json id is ${p.id}; directory kept` });
        continue;
      }
      found.push(p);
    }
    found.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    for (const p of found) {
      const added = await store.mutate((s) => {
        if (s.index.projects.some((e) => e.id === p.id) || s.index.deletedProjects.includes(p.id)) return { result: false };
        return {
          result: true,
          index: { ...s.index, projects: [...s.index.projects, { id: p.id, name: p.name, createdAt: p.createdAt }] },
          projects: [p],
        };
      });
      if (added) r.projectsReadded.push(p.id);
    }
  });

  await step('recreate-project-json', undefined, async () => {
    const s = store.state.get();
    const missing = s.index.projects.filter((e) => !s.projects[e.id] && !s.index.deletedProjects.includes(e.id));
    for (const e of missing) {
      await fs.mkdir(projectDir(e.id));
      const made = await store.mutate((cur) => {
        const entry = cur.index.projects.find((x) => x.id === e.id);
        if (!entry || cur.projects[e.id]) return { result: false };
        const p: Project = {
          version: 1,
          id: entry.id,
          name: entry.name,
          createdAt: entry.createdAt,
          fps: DEFAULT_FPS,
          geometry: { aspect: '4:3', rotation: 0 },
          cameraId: null,
          frames: [],
          deletedFrameIds: [],
          outstanding: [],
        };
        return { result: true, projects: [p] };
      });
      if (made) {
        r.projectsRecreated.push(e.id);
        r.warnings.push({
          kind: 'project_recreated',
          id: e.id,
          path: projectJsonPath(e.id),
          detail: 'project.json rebuilt from the index entry (no frames); frame files are kept',
        });
      }
    }
  });

  for (const id of Object.keys(store.state.get().projects)) {
    await step('project', id, () => sweepProject(id));
  }

  return r;
}
