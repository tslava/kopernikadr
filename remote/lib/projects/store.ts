/**
 * ProjectStore (ARCHITECTURE §5.4-5.5): persistence + ONE serialized async mutation queue over the
 * pure model/reducers.
 *
 * Every change of `index.json` / `project.json` goes through `mutate()`:
 *   queue slot -> reducer(current in-memory state) -> `writeTextAtomic` -> ONLY THEN update the
 *   in-memory state and notify subscribers -> resolve the caller's promise.
 * A failed write (NO_SPACE, any error) leaves memory untouched, restores files already written by
 * the same mutation (best effort) and rejects. Memory is the source of truth between mutations; it
 * is loaded once by `load()` and only this queue writes, so no read-modify-write races exist.
 *
 * Crash windows the Task 7 startup sweep must repair (disk state after a kill):
 *  1. createProject: index entry written, `projects/{id}/` not yet created or `project.json` not yet
 *     written -> index entry without directory/`project.json` ("re-add missing project dirs": the
 *     sweep recreates `project.json` from the index entry, empty frames). Surfaced at load as the
 *     `project_missing` warning.
 *  2. createProject: rolled back index after a failed dir/project.json step, but the rollback write
 *     itself failed -> same as 1 (and a `rollback_failed` warning).
 *  3. A rename (index + project.json written one after the other): index has the new name, project
 *     has the old one, or the reverse. Harmless; the sweep may copy the index name into project.json.
 *  4. Project expiry (done by the sweep/UI, not here): index commit (`deletedProjects`) before the
 *     directory removal -> a directory of a project in `deletedProjects` (sweep: remove it).
 *  5. Corrupt rename: `*.corrupt-<ts>` written, original not yet removed -> a corrupt original
 *     is found again at the next load and renamed again (idempotent, may leave two copies).
 *  6. Files in `frames/`, `tmp/` are not touched by this store at all (installs, downloads): the
 *     sweep promotes/deletes them per §5.8.
 */
import { CLIENT_ID_PATH, INDEX_PATH, projectDir, projectJsonPath, type FileAdapter } from './files';
import {
  droppedEditFields,
  ModelError,
  parseIndex,
  parseProject,
  type Project,
  type ProjectIndex,
  type Rotation,
} from './model';
import { createProject as createProjectReducer } from './reducers';
import { createStore, type Store } from '../state/store';

export type StoreWarningKind =
  | 'index_corrupt'
  | 'index_unknown_version'
  | 'project_corrupt'
  | 'project_edits_dropped'
  | 'project_unknown_version'
  | 'project_missing'
  | 'rollback_failed';

export interface StoreWarning {
  kind: StoreWarningKind;
  /** The project, for project-level warnings. */
  id?: string;
  path: string;
  /** Where the unreadable file was kept (`*.corrupt-<ts>`), for the `*_corrupt` kinds. */
  corruptPath?: string;
  detail: string;
}

export interface ProjectsState {
  ready: boolean;
  /** Unknown future `version` on disk: nothing is ever written; mutations reject. */
  readOnly: boolean;
  index: ProjectIndex;
  projects: Readonly<Record<string, Project>>;
  warnings: readonly StoreWarning[];
}

/** What a mutation function returns. A field that is the same reference as the current value is not written. */
export interface Mutation<T> {
  result: T;
  index?: ProjectIndex;
  projects?: Project[];
  /** Removed from memory after the commit (their directories are removed by the caller, later). */
  dropProjects?: string[];
}

export class ReadOnlyError extends Error {
  constructor() {
    super('ProjectStore is read-only (unsupported data version)');
    this.name = 'ReadOnlyError';
  }
}

export interface StoreOptions {
  now?: () => number;
  newId?: () => string;
  /**
   * Task 7 hook: called from `load()` when `index.json` was corrupt and has been renamed. The store
   * continues with a FRESH index (the old `clientId` kept if it could be salvaged) and no projects;
   * the rebuild from the `projects/` directory listing belongs here (use `store.mutate`).
   */
  onIndexCorrupt?: (w: StoreWarning, store: ProjectStore) => void | Promise<void>;
}

const emptyIndex = (clientId: string): ProjectIndex => ({
  version: 1,
  clientId,
  rememberedCamera: null,
  projects: [],
  deletedProjects: [],
  pendingProjectDeletes: [],
});

const serialize = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export class ProjectStore {
  readonly state: Store<ProjectsState>;
  private tail: Promise<unknown> = Promise.resolve();
  /** Serialized content of every file this store knows to be on disk. */
  private disk = new Map<string, string>();
  /**
   * project.json text whose `cut`/`stickers` the lenient parse dropped, by path. A copy is kept as
   * `<path>.corrupt-<ts>` right before the next write of that file, so an edit is never lost silently.
   */
  private lossy = new Map<string, string>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly fs: FileAdapter,
    private readonly opts: StoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.state = createStore<ProjectsState>({
      ready: false,
      readOnly: false,
      index: emptyIndex(''),
      projects: {},
      warnings: [],
    });
  }

  // --- queue ------------------------------------------------------------------------------

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The one way to change persisted state. `fn` is a pure function of the current state; it runs
   * when its turn comes, so it always sees every earlier mutation. Resolves with `fn`'s `result`
   * after the writes completed and memory was updated; rejects (state unchanged) if `fn` throws
   * or a write fails.
   */
  mutate<T>(fn: (s: ProjectsState) => Mutation<T>): Promise<T> {
    return this.enqueue(() => this.run(fn, []));
  }

  /** Create a project: index entry first, then `projects/{id}/` and `project.json` (see crash windows). */
  createProject(name: string, args: { rotation?: Rotation } = {}): Promise<Project> {
    return this.enqueue(() =>
      this.run((s) => {
        const n = name.trim();
        if (n === '') throw new Error('project name is empty');
        const created = createProjectReducer(s.index, {
          id: this.newId(),
          name: n,
          nowMs: this.now(),
          ...(args.rotation !== undefined ? { rotation: args.rotation } : {}),
        });
        return { result: created.project, index: created.index, projects: [created.project] };
      }, ['create']),
    );
  }

  /** `fn` returns the same reference for "no change". Rejects for an unknown project. */
  updateProject(id: string, fn: (p: Project) => Project): Promise<Project> {
    return this.mutate((s) => {
      const p = s.projects[id];
      if (!p) throw new Error(`unknown project: ${id}`);
      const next = fn(p);
      return { result: next, projects: [next] };
    });
  }

  updateIndex(fn: (i: ProjectIndex) => ProjectIndex): Promise<ProjectIndex> {
    return this.mutate((s) => {
      const next = fn(s.index);
      return { result: next, index: next };
    });
  }

  /** Resolves when everything queued so far has finished. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  private async run<T>(fn: (s: ProjectsState) => Mutation<T>, flags: ['create'] | []): Promise<T> {
    const cur = this.state.get();
    if (!cur.ready) throw new Error('ProjectStore is not loaded');
    if (cur.readOnly) throw new ReadOnlyError();
    const m = fn(cur);

    // what to write, index first
    const writes: { path: string; value: unknown }[] = [];
    if (m.index && m.index !== cur.index) writes.push({ path: INDEX_PATH, value: m.index });
    const projects = (m.projects ?? []).filter((p) => cur.projects[p.id] !== p);
    for (const p of projects) writes.push({ path: projectJsonPath(p.id), value: p });
    if (writes.length === 0 && !(m.dropProjects?.length)) return m.result;

    const newDirs = flags[0] === 'create' ? projects.map((p) => projectDir(p.id)) : [];
    const written: { path: string; prev: string | undefined }[] = [];
    let mkdirDone = newDirs.length === 0;
    try {
      for (const w of writes) {
        // the project directory is created between the index entry and its project.json
        if (w.path !== INDEX_PATH && !mkdirDone) {
          for (const d of newDirs) await this.fs.mkdir(d);
          mkdirDone = true;
        }
        const text = serialize(w.value);
        await this.keepLossyOriginal(w.path);
        await this.fs.writeTextAtomic(w.path, text);
        written.push({ path: w.path, prev: this.disk.get(w.path) });
        this.disk.set(w.path, text);
      }
    } catch (err) {
      await this.rollback(written, newDirs);
      throw err;
    }

    const next: ProjectsState = { ...cur, index: m.index ?? cur.index };
    const map = { ...cur.projects };
    for (const p of projects) map[p.id] = p;
    for (const id of m.dropProjects ?? []) delete map[id];
    next.projects = map;
    this.state.set(next);
    return m.result;
  }

  private async rollback(written: { path: string; prev: string | undefined }[], newDirs: string[]): Promise<void> {
    const failed: StoreWarning[] = [];
    for (const w of [...written].reverse()) {
      try {
        if (w.prev !== undefined) await this.fs.writeTextAtomic(w.path, w.prev);
        else await this.fs.remove(w.path);
        if (w.prev !== undefined) this.disk.set(w.path, w.prev);
        else this.disk.delete(w.path);
      } catch (e) {
        failed.push({ kind: 'rollback_failed', path: w.path, detail: String((e as Error)?.message ?? e) });
      }
    }
    for (const d of newDirs) {
      try {
        await this.fs.remove(d, { recursive: true });
      } catch {
        /* an empty orphan directory is swept by Task 7 */
      }
    }
    if (failed.length > 0) this.addWarnings(failed);
  }

  private addWarnings(w: StoreWarning[]): void {
    this.state.update((s) => ({ ...s, warnings: [...s.warnings, ...w] }));
  }

  // --- load ------------------------------------------------------------------------------

  /**
   * Reads `index.json` and every listed `project.json` into memory. Never throws for bad DATA
   * (it becomes a warning); throws only for I/O errors, or when a fresh index cannot be written.
   */
  load(): Promise<void> {
    return this.enqueue(async () => {
      const warnings: StoreWarning[] = [];
      let readOnly = false;
      let index: ProjectIndex;

      // the clientId is also kept in its own file (written once): the phone's unacked frames carry it
      let idFile: string | null = null;
      try {
        const t = (await this.fs.readText(CLIENT_ID_PATH))?.trim();
        idFile = t ? t : null;
      } catch {
        /* unreadable: treated as absent */
      }
      const raw = await this.fs.readText(INDEX_PATH);
      if (raw === null) {
        index = emptyIndex(idFile ?? this.newId());
        await this.write(INDEX_PATH, index);
      } else {
        try {
          index = parseIndex(JSON.parse(raw));
          this.disk.set(INDEX_PATH, raw);
        } catch (e) {
          if (e instanceof ModelError && e.code === 'unknown_version') {
            readOnly = true;
            index = emptyIndex(this.newId());
            warnings.push({ kind: 'index_unknown_version', path: INDEX_PATH, detail: e.message });
          } else {
            const w = await this.keepCorrupt(INDEX_PATH, raw, 'index_corrupt', e);
            warnings.push(w);
            index = emptyIndex(salvageClientId(raw) ?? idFile ?? this.newId());
            await this.write(INDEX_PATH, index);
          }
        }
      }

      if (idFile === null && !readOnly) {
        try {
          await this.fs.writeTextAtomic(CLIENT_ID_PATH, index.clientId);
        } catch {
          /* best effort: index.json still has it */
        }
      }

      const projects: Record<string, Project> = {};
      for (const entry of index.projects) {
        const path = projectJsonPath(entry.id);
        const text = await this.fs.readText(path);
        if (text === null) {
          warnings.push({ kind: 'project_missing', id: entry.id, path, detail: 'no project.json' });
          continue;
        }
        try {
          const json: unknown = JSON.parse(text);
          const parsed = parseProject(json);
          projects[entry.id] = parsed;
          this.disk.set(path, text);
          const dropped = droppedEditFields(json, parsed);
          if (dropped.length > 0) {
            this.lossy.set(path, text);
            const detail = `unreadable ${dropped.join(', ')} ignored; the original is kept as ${path}.corrupt-<ts> before the next write`;
            console.warn(`project ${entry.id}: ${detail}`);
            warnings.push({ kind: 'project_edits_dropped', id: entry.id, path, detail });
          }
        } catch (e) {
          if (e instanceof ModelError && e.code === 'unknown_version') {
            readOnly = true;
            warnings.push({ kind: 'project_unknown_version', id: entry.id, path, detail: e.message });
          } else if (readOnly) {
            // never rename/rewrite anything in read-only mode
            warnings.push({ kind: 'project_corrupt', id: entry.id, path, detail: String((e as Error)?.message ?? e) });
          } else {
            warnings.push({ ...(await this.keepCorrupt(path, text, 'project_corrupt', e)), id: entry.id });
          }
        }
      }

      this.state.set({ ready: true, readOnly, index, projects, warnings });
      const corrupt = warnings.find((w) => w.kind === 'index_corrupt');
      if (corrupt && this.opts.onIndexCorrupt) await this.opts.onIndexCorrupt(corrupt, this);
    });
  }

  private async write(path: string, value: unknown): Promise<void> {
    const text = serialize(value);
    await this.fs.writeTextAtomic(path, text);
    this.disk.set(path, text);
  }

  /** Before the first write over a project.json whose edit fields were dropped at load: keep the original. */
  private async keepLossyOriginal(path: string): Promise<void> {
    const text = this.lossy.get(path);
    if (text === undefined) return;
    await this.fs.writeTextAtomic(`${path}.corrupt-${this.now()}`, text);
    this.lossy.delete(path);
  }

  /** Keep the unreadable file as `<path>.corrupt-<ts>` (copy, then remove the original). */
  private async keepCorrupt(path: string, text: string, kind: StoreWarningKind, err: unknown): Promise<StoreWarning> {
    const corruptPath = `${path}.corrupt-${this.now()}`;
    await this.fs.writeTextAtomic(corruptPath, text);
    await this.fs.remove(path);
    return { kind, path, corruptPath, detail: String((err as Error)?.message ?? err) };
  }
}

function salvageClientId(raw: string): string | undefined {
  try {
    const v = JSON.parse(raw) as { clientId?: unknown } | null;
    return typeof v?.clientId === 'string' && v.clientId !== '' ? v.clientId : undefined;
  } catch {
    return undefined;
  }
}
