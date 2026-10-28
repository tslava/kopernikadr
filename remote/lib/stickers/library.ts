/**
 * The sticker library on the tablet (plan "Photo stickers"): `stickers/index.json`
 * (`{v: 1, items: [{id, created, bytes, sha256}]}`, newest first), `stickers/<uuid>.webp` (the
 * sticker, <= 1024 px square) and `stickers/<uuid>.thumb.webp` (160 px, for the "Moje" tiles).
 * `add` writes both WebPs first and the index last, so a crash in between leaves an orphan WebP that
 * nothing lists (harmless). `list` hides rows whose WebP is gone. Removing a sticker never touches a
 * movie: placing a sticker copies the WebP into the movie folder.
 */
import type { FileAdapter } from '../projects/files';
import type { BinaryFiles } from './binaryFiles';

export const STICKERS_DIR = 'stickers';
export const INDEX = `${STICKERS_DIR}/index.json`;
export const STICKER_LIMIT = 200;
export const LIBRARY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LibraryItem {
  id: string;
  /** ms since epoch. */
  created: number;
  bytes: number;
  sha256: string;
}

export class StickerLibraryFullError extends Error {
  constructor() {
    super(`sticker library is full (${STICKER_LIMIT})`);
    this.name = 'StickerLibraryFullError';
  }
}

export interface StickerLibraryDeps {
  fs: FileAdapter;
  bin: BinaryFiles;
  randomUUID?: () => string;
  now?: () => number;
  warn?: (msg: string, err?: unknown) => void;
}

export const stickerPath = (id: string): string => `${STICKERS_DIR}/${id}.webp`;
export const thumbPath = (id: string): string => `${STICKERS_DIR}/${id}.thumb.webp`;

function parseIndex(text: string): LibraryItem[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const o = raw as { v?: unknown; items?: unknown } | null;
  if (!o || o.v !== 1 || !Array.isArray(o.items)) return null;
  const out: LibraryItem[] = [];
  for (const r of o.items as Partial<LibraryItem>[]) {
    if (!r || typeof r.id !== 'string' || !LIBRARY_ID_RE.test(r.id)) continue;
    out.push({
      id: r.id,
      created: Number.isFinite(r.created) ? (r.created as number) : 0,
      bytes: Number.isFinite(r.bytes) ? (r.bytes as number) : 0,
      sha256: typeof r.sha256 === 'string' ? r.sha256 : '',
    });
  }
  return out;
}

/** Store-relative path of a library sticker's copy inside a movie. */
export const movieStickerPath = (projectId: string, id: string): string => `projects/${projectId}/stickers/${id}.webp`;

/**
 * `copySticker` for the `StickerController`: library `stickers/<id>.webp` -> `projects/{pid}/stickers/<id>.webp`
 * (tmp + installFile, idempotent: a repeat after a crash heals itself). Only a valid uuid builds a path.
 */
export function createStickerCopier(bin: BinaryFiles): (id: string, projectId: string) => Promise<void> {
  return async (id, projectId) => {
    if (!LIBRARY_ID_RE.test(id)) throw new Error(`bad sticker id: ${id}`);
    await bin.copyFile(stickerPath(id), movieStickerPath(projectId, id));
  };
}

export class StickerLibrary {
  private readonly fs: FileAdapter;
  private readonly bin: BinaryFiles;
  private readonly uuid: () => string;
  private readonly now: () => number;
  private readonly warn: (msg: string, err?: unknown) => void;
  /** Serializes add/remove: each is a read-modify-write of the index. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: StickerLibraryDeps) {
    this.fs = deps.fs;
    this.bin = deps.bin;
    this.uuid = deps.randomUUID ?? (() => crypto.randomUUID());
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((m, e) => console.warn(m, e));
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Index rows as stored. A missing index is an empty library. An unreadable one (I/O error) THROWS:
   * treating it as empty would let the next write replace a valid index and orphan every sticker. A
   * readable but corrupt index is an empty list; before a mutation (`keepCorrupt`) the bad text is
   * kept as `index.json.corrupt-<ts>` (the project store's convention) so nothing is lost silently.
   */
  private async readRows(keepCorrupt: boolean): Promise<LibraryItem[]> {
    const text = await this.fs.readText(INDEX);
    if (text === null) return [];
    const rows = parseIndex(text);
    if (rows) return rows;
    this.warn('sticker index corrupt, starting empty');
    if (keepCorrupt) await this.fs.writeTextAtomic(`${INDEX}.corrupt-${this.now()}`, text);
    return [];
  }

  private async visible(rows: LibraryItem[]): Promise<LibraryItem[]> {
    if (rows.length === 0) return rows;
    const present = new Set(await this.fs.list(STICKERS_DIR));
    return rows.filter((r) => present.has(`${r.id}.webp`));
  }

  /** Newest first; rows whose WebP is missing are hidden. Rejects when the index cannot be read. */
  async list(): Promise<LibraryItem[]> {
    return this.visible(await this.readRows(false));
  }

  /** Stores a new sticker (+ thumbnail) and returns its id. Throws `StickerLibraryFullError` at 200. */
  add(webp: Blob, thumb: Blob): Promise<string> {
    return this.serial(async () => {
      const rows = await this.visible(await this.readRows(true));
      if (rows.length >= STICKER_LIMIT) throw new StickerLibraryFullError();
      const id = this.uuid();
      await this.fs.mkdir(STICKERS_DIR);
      try {
        const info = await this.bin.writeBinary(stickerPath(id), webp);
        await this.bin.writeBinary(thumbPath(id), thumb);
        const item: LibraryItem = { id, created: this.now(), bytes: info.bytes, sha256: info.sha256 };
        await this.fs.writeTextAtomic(INDEX, JSON.stringify({ v: 1, items: [item, ...rows] }));
      } catch (e) {
        await this.fs.remove(stickerPath(id)).catch(() => undefined);
        await this.fs.remove(thumbPath(id)).catch(() => undefined);
        throw e;
      }
      return id;
    });
  }

  /** Deletes only the library copy; movies keep their own. Idempotent. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (!LIBRARY_ID_RE.test(id)) return;
      const rows = await this.readRows(true);
      if (rows.some((r) => r.id === id)) {
        await this.fs.writeTextAtomic(INDEX, JSON.stringify({ v: 1, items: rows.filter((r) => r.id !== id) }));
      }
      await this.fs.remove(stickerPath(id));
      await this.fs.remove(thumbPath(id));
    });
  }

  /** Native file URI of the sticker WebP (feed it to `convertFileSrc`). */
  fileUri(id: string): Promise<string> {
    if (!LIBRARY_ID_RE.test(id)) return Promise.reject(new Error(`bad sticker id: ${id}`));
    return this.fs.uri(stickerPath(id));
  }

  thumbUri(id: string): Promise<string> {
    if (!LIBRARY_ID_RE.test(id)) return Promise.reject(new Error(`bad sticker id: ${id}`));
    return this.fs.uri(thumbPath(id));
  }
}
