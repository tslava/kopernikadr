/**
 * File access for the ProjectStore (ARCHITECTURE §5.4-5.5). All paths are relative to
 * `filesDir/kopernikadr/` (`index.json`, `projects/{id}/project.json`, ...), no leading slash.
 * Images never go through here (they are downloaded and moved natively); only small JSON text.
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { KopernikadrNative } from '../native';

export interface FileAdapter {
  /** UTF-8 text, or `null` when the file does not exist. */
  readText(path: string): Promise<string | null>;
  /** tmp -> fsync -> rename over `path`: after a crash either the old or the new content. */
  writeTextAtomic(path: string, text: string): Promise<void>;
  /** Entry names (not paths) directly in `dir`; `[]` when `dir` does not exist. */
  list(dir: string): Promise<string[]>;
  /** Creates `dir` and its parents; no error when it exists. */
  mkdir(dir: string): Promise<void>;
  /** Idempotent (a missing path is fine). `recursive` is required for a directory. */
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Native file URI of `path` (for downloads and `convertFileSrc`). */
  uri(path: string): Promise<string>;
}

export const ROOT = 'kopernikadr';
export const INDEX_PATH = 'index.json';
export const projectDir = (id: string): string => `projects/${id}`;
export const projectJsonPath = (id: string): string => `${projectDir(id)}/project.json`;

const inData = (path: string) => ({ directory: Directory.Data, path: `${ROOT}/${path}` });
const msg = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);
const isMissing = (e: unknown): boolean => /does not exist|not exist|no such file|not found|ENOENT/i.test(msg(e));
const isExisting = (e: unknown): boolean => /already exists/i.test(msg(e));

/** The app implementation: `KopernikadrNative` for atomic writes, `Filesystem` for the rest. */
export function createAppFileAdapter(): FileAdapter {
  return {
    async readText(path) {
      try {
        const r = await Filesystem.readFile({ ...inData(path), encoding: Encoding.UTF8 });
        return typeof r.data === 'string' ? r.data : await r.data.text();
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    writeTextAtomic: (path, text) => KopernikadrNative.writeTextAtomic({ path: path, text }),
    async list(dir) {
      try {
        return (await Filesystem.readdir(inData(dir))).files.map((f) => f.name);
      } catch (e) {
        if (isMissing(e)) return [];
        throw e;
      }
    },
    async mkdir(dir) {
      try {
        await Filesystem.mkdir({ ...inData(dir), recursive: true });
      } catch (e) {
        if (!isExisting(e)) throw e;
      }
    },
    async remove(path, opts) {
      try {
        if (opts?.recursive) await Filesystem.rmdir({ ...inData(path), recursive: true });
        else await Filesystem.deleteFile(inData(path));
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    },
    uri: async (path) => (await Filesystem.getUri(inData(path))).uri,
  };
}
