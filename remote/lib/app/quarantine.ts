/**
 * The tablet's quarantine (`kopernikadr/quarantine/`): where the sweep moves an install file that did not verify
 * (`{project}-{frameId}-{time}.full.jpg`, see projects/sweep.ts). It is never cleaned automatically; a parent looks
 * at it and clears it on purpose. Flat directory, no per-project folders.
 */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { ROOT } from '../projects/files';

export const QUARANTINE_DIR = 'quarantine';
export const THUMB_LIMIT = 12;

export interface QuarantineEntry {
  name: string;
  size: number;
  /** Modified time, ms since epoch. */
  mtime: number;
}

/** The directory `kopernikadr/quarantine/`, nothing else is reachable through it. */
export interface QuarantineFs {
  /** Regular files directly in the directory; `[]` when it does not exist. */
  list(): Promise<QuarantineEntry[]>;
  /** One file of the directory by plain name; idempotent. */
  remove(name: string): Promise<void>;
  /** Native file URI of one file (for `convertFileSrc`). */
  uri(name: string): Promise<string>;
}

export interface QuarantineSummary {
  count: number;
  bytes: number;
  /** Newest first. */
  entries: QuarantineEntry[];
}

export interface ClearResult {
  removed: number;
  failed: Array<{ name: string; error: string }>;
}

const errMsg = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

/** A plain file name: no separators, no dot-dot, so it can only point inside the quarantine directory. */
export const isPlainName = (name: string): boolean =>
  name !== '' && name !== '.' && !name.includes('..') && !/[\\/\0]/.test(name);

export async function listQuarantine(fs: QuarantineFs): Promise<QuarantineSummary> {
  const entries = (await fs.list())
    .filter((e) => isPlainName(e.name))
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return { count: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), entries };
}

/** The newest `limit` jpg files: the ones worth a thumbnail. */
export const thumbEntries = (s: QuarantineSummary, limit = THUMB_LIMIT): QuarantineEntry[] =>
  s.entries.filter((e) => /\.jpe?g$/i.test(e.name)).slice(0, limit);

/**
 * Removes what the directory holds right now. A failure on one file does not stop the others; the caller shows
 * `failed`. Names come from a fresh listing and must be plain, so nothing outside the directory is touched.
 */
export async function clearQuarantine(fs: QuarantineFs): Promise<ClearResult> {
  const result: ClearResult = { removed: 0, failed: [] };
  for (const e of (await fs.list()).filter((x) => isPlainName(x.name))) {
    try {
      await fs.remove(e.name);
      result.removed++;
    } catch (err) {
      result.failed.push({ name: e.name, error: errMsg(err) });
    }
  }
  return result;
}

const at = (name?: string) => ({ directory: Directory.Data, path: name === undefined ? `${ROOT}/${QUARANTINE_DIR}` : `${ROOT}/${QUARANTINE_DIR}/${name}` });
const isMissing = (e: unknown): boolean => /does not exist|not exist|no such file|not found|ENOENT/i.test(errMsg(e));

/** The app implementation over Capacitor Filesystem (Directory.Data). */
export function createAppQuarantineFs(): QuarantineFs {
  return {
    async list() {
      try {
        const r = await Filesystem.readdir(at());
        return r.files.filter((f) => f.type === 'file').map((f) => ({ name: f.name, size: f.size, mtime: f.mtime ?? 0 }));
      } catch (e) {
        if (isMissing(e)) return [];
        throw e;
      }
    },
    async remove(name) {
      if (!isPlainName(name)) throw new Error(`refusing to remove ${name}`);
      try {
        await Filesystem.deleteFile(at(name));
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    },
    uri: async (name) => (await Filesystem.getUri(at(name))).uri,
  };
}
