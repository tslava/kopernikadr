import { describe, expect, it, vi } from 'vitest';
import { FakeBinaryIO, FakeFs } from '../projects/fakeFs.testutil';
import { createBinaryFiles } from './binaryFiles';
import { createStickerCopier, INDEX, STICKER_LIMIT, StickerLibrary, StickerLibraryFullError } from './library';

const blob = (...b: number[]) => new Blob([new Uint8Array(b)]);
const uid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ids = async (lib: StickerLibrary) => (await lib.list()).map((i) => i.id);

function setup() {
  const fs = new FakeFs();
  const bin = createBinaryFiles(fs, new FakeBinaryIO(fs));
  let n = 0;
  let t = 1000;
  const warn = vi.fn();
  const lib = new StickerLibrary({ fs, bin, randomUUID: () => uid(++n), now: () => ++t, warn });
  return { fs, lib, warn };
}

describe('StickerLibrary', () => {
  it('starts empty', async () => {
    expect(await setup().lib.list()).toEqual([]);
  });

  it('adds a sticker and its thumbnail, and lists it', async () => {
    const { fs, lib } = setup();
    const id = await lib.add(blob(1, 2, 3), blob(4));
    expect(id).toBe(uid(1));
    expect(fs.binaries.has(`stickers/${id}.webp`)).toBe(true);
    expect(fs.binaries.has(`stickers/${id}.thumb.webp`)).toBe(true);
    const items = await lib.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, bytes: 3 });
    expect(items[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((fs.json(INDEX) as { v: number }).v).toBe(1);
  });

  it('lists newest first', async () => {
    const { lib } = setup();
    const a = await lib.add(blob(1), blob(1));
    const b = await lib.add(blob(2), blob(2));
    const c = await lib.add(blob(3), blob(3));
    expect(await ids(lib)).toEqual([c, b, a]);
  });

  it('removes only that sticker (files and row); idempotent', async () => {
    const { fs, lib } = setup();
    const a = await lib.add(blob(1), blob(1));
    const b = await lib.add(blob(2), blob(2));
    await lib.remove(a);
    await lib.remove(a);
    expect(await ids(lib)).toEqual([b]);
    expect(fs.binaries.has(`stickers/${a}.webp`)).toBe(false);
    expect(fs.binaries.has(`stickers/${a}.thumb.webp`)).toBe(false);
    expect(fs.binaries.has(`stickers/${b}.webp`)).toBe(true);
  });

  it('rejects a malformed id', async () => {
    const { lib } = setup();
    await lib.add(blob(1), blob(1));
    await lib.remove('../x');
    expect(await lib.list()).toHaveLength(1);
    await expect(lib.fileUri('../x')).rejects.toThrow(/bad sticker id/);
    await expect(lib.thumbUri('x')).rejects.toThrow(/bad sticker id/);
  });

  it('gives file and thumbnail uris', async () => {
    const { lib } = setup();
    const id = await lib.add(blob(1), blob(1));
    expect(await lib.fileUri(id)).toBe(`file:///data/kopernikadr/stickers/${id}.webp`);
    expect(await lib.thumbUri(id)).toBe(`file:///data/kopernikadr/stickers/${id}.thumb.webp`);
  });

  it('refuses the 201st sticker and keeps the library intact', async () => {
    const { fs, lib } = setup();
    const rows = Array.from({ length: STICKER_LIMIT }, (_, i) => ({ id: uid(i + 1000), created: i, bytes: 1, sha256: '' }));
    for (const r of rows) fs.binaries.set(`stickers/${r.id}.webp`, new Uint8Array([1]));
    fs.files.set(INDEX, JSON.stringify({ v: 1, items: rows }));
    await expect(lib.add(blob(1), blob(1))).rejects.toBeInstanceOf(StickerLibraryFullError);
    expect(await lib.list()).toHaveLength(STICKER_LIMIT);
    await lib.remove(rows[0]!.id);
    await expect(lib.add(blob(1), blob(1))).resolves.toBeTruthy();
  });

  it('a failed index write cleans up its PNGs and leaves the library as it was', async () => {
    const { fs, lib } = setup();
    const a = await lib.add(blob(1), blob(1));
    fs.failOn({ op: 'writeTextAtomic', path: INDEX, times: 1 });
    await expect(lib.add(blob(2), blob(2))).rejects.toThrow(/injected/);
    expect(await ids(lib)).toEqual([a]);
    expect([...fs.binaries.keys()].filter((k) => k.startsWith('stickers/'))).toHaveLength(2);
  });

  it('a hard crash after the PNGs, before the index: the orphan is ignored', async () => {
    const { fs, lib } = setup();
    const a = await lib.add(blob(1), blob(1));
    fs.crashAfter(4); // PNG: tmp write + install, thumb: tmp write + install; the index write crashes
    await expect(lib.add(blob(2), blob(2))).rejects.toThrow('simulated crash');
    fs.restart();
    // the orphans may or may not be cleaned (the crash also kills the cleanup), the index never lists them
    expect(await ids(lib)).toEqual([a]);
    const c = await lib.add(blob(3), blob(3));
    expect(await ids(lib)).toEqual([c, a]);
  });

  it('hides a row whose WebP is missing', async () => {
    const { fs, lib } = setup();
    const a = await lib.add(blob(1), blob(1));
    const b = await lib.add(blob(2), blob(2));
    fs.binaries.delete(`stickers/${a}.webp`);
    expect(await ids(lib)).toEqual([b]);
  });

  it('a corrupt index lists empty; the next add keeps a corrupt copy and the files stay', async () => {
    const { fs, lib, warn } = setup();
    const a = await lib.add(blob(1), blob(1));
    fs.files.set(INDEX, '{not json');
    expect(await lib.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect([...fs.files.keys()].filter((k) => k.startsWith(`${INDEX}.corrupt-`))).toEqual([]); // reading alone writes nothing
    const b = await lib.add(blob(2), blob(2));
    expect(await ids(lib)).toEqual([b]);
    const kept = [...fs.files.entries()].filter(([k]) => k.startsWith(`${INDEX}.corrupt-`));
    expect(kept).toHaveLength(1);
    expect(kept[0]![1]).toBe('{not json');
    expect(fs.binaries.has(`stickers/${a}.webp`)).toBe(true);
  });

  it('an unreadable index (I/O error) is an error, never an empty library: add and remove leave it untouched', async () => {
    const { fs, lib } = setup();
    const a = await lib.add(blob(1), blob(1));
    const before = fs.files.get(INDEX);
    fs.failOn({ op: 'readText', path: INDEX, times: 3 });
    await expect(lib.list()).rejects.toThrow(/injected/);
    await expect(lib.add(blob(2), blob(2))).rejects.toThrow(/injected/);
    await expect(lib.remove(a)).rejects.toThrow(/injected/);
    expect(fs.files.get(INDEX)).toBe(before);
    expect(fs.binaries.has(`stickers/${a}.webp`)).toBe(true);
    expect([...fs.binaries.keys()].filter((k) => k.startsWith('stickers/'))).toHaveLength(2); // no orphan from the failed add
    fs.clearFailures();
    expect(await ids(lib)).toEqual([a]);
  });

  it('a failed corrupt-copy blocks the mutation (the bad index is not overwritten)', async () => {
    const { fs, lib } = setup();
    fs.files.set(INDEX, '{not json');
    fs.failOn({ op: 'writeTextAtomic', path: /index\.json\.corrupt-/, times: 1 });
    await expect(lib.add(blob(1), blob(1))).rejects.toThrow(/injected/);
    expect(fs.files.get(INDEX)).toBe('{not json');
  });

  it('drops index rows with a bad id', async () => {
    const { fs, lib } = setup();
    const a = await lib.add(blob(1), blob(1));
    const idx = fs.json(INDEX) as { items: object[] };
    idx.items.push({ id: '../evil', created: 1, bytes: 1, sha256: '' });
    fs.files.set(INDEX, JSON.stringify(idx));
    expect(await ids(lib)).toEqual([a]);
  });

  it('serializes concurrent adds', async () => {
    const { lib } = setup();
    const added = await Promise.all([lib.add(blob(1), blob(1)), lib.add(blob(2), blob(2)), lib.add(blob(3), blob(3))]);
    expect(new Set(await ids(lib))).toEqual(new Set(added));
  });
});

describe('createStickerCopier', () => {
  it('copies the library PNG into the movie, idempotently, leaving the library copy', async () => {
    const fs = new FakeFs();
    const bin = createBinaryFiles(fs, new FakeBinaryIO(fs));
    const lib = new StickerLibrary({ fs, bin });
    const id = await lib.add(blob(7, 8, 9), blob(1));
    const copy = createStickerCopier(bin);
    await copy(id, 'P1');
    await copy(id, 'P1');
    expect([...fs.binaries.get(`projects/P1/stickers/${id}.webp`)!]).toEqual([7, 8, 9]);
    await lib.remove(id);
    expect(fs.binaries.has(`projects/P1/stickers/${id}.webp`)).toBe(true);
  });

  it('refuses a bad id and fails when the library file is gone', async () => {
    const fs = new FakeFs();
    const copy = createStickerCopier(createBinaryFiles(fs, new FakeBinaryIO(fs)));
    await expect(copy('../x', 'P1')).rejects.toThrow(/bad sticker id/);
    await expect(copy('0123abcd-0123-4abc-8abc-0123456789ab', 'P1')).rejects.toThrow();
  });
});
