import { beforeEach, describe, expect, it } from 'vitest';
import { bmp, asBitmap, type FakeBitmap } from '../play/play.testutil';
import { customStickerPath, loadCatalog, openmojiUrlOf, parseCatalog, projectSpriteUrlOf, resetCatalogCache, spriteUrl } from './catalog';
import { SpriteCache, bucketFor, type Rasterize, type SpriteBucket } from './sprites';

function fakeRaster(failing: string[] = []) {
  const calls: { url: string; size: number }[] = [];
  const made: FakeBitmap[] = [];
  const raster: Rasterize = async (url, size) => {
    calls.push({ url, size });
    if (failing.some((h) => url.endsWith(`${h}.svg`))) throw new Error('boom');
    const b = bmp(`${url}@${size}`);
    made.push(b);
    return asBitmap(b);
  };
  return { raster, calls, made };
}

describe('bucketFor', () => {
  it('picks the smallest bucket that fits, capped at 1024', () => {
    expect(bucketFor(1)).toBe(128);
    expect(bucketFor(128)).toBe(128);
    expect(bucketFor(129)).toBe(256);
    expect(bucketFor(300)).toBe(512);
    expect(bucketFor(1024)).toBe(1024);
    expect(bucketFor(1440)).toBe(1024);
  });
});

describe('SpriteCache', () => {
  it('rasterizes the sprite url at the bucket size and caches it', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster);
    expect(c.get('1F436', 256)).toBeUndefined();
    const a = await c.load('1F436', 256);
    expect(f.calls).toEqual([{ url: '/openmoji/1F436.svg', size: 256 }]);
    expect(c.get('1F436', 256)).toBe(a);
    expect(await c.load('1F436', 256)).toBe(a);
    expect(f.calls).toHaveLength(1);
    expect(c.get('1F436', 512)).toBeUndefined(); // buckets are separate entries
  });

  it('shares one rasterization between concurrent loads', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster);
    const [a, b] = await Promise.all([c.load('1F436', 128), c.load('1F436', 128)]);
    expect(a).toBe(b);
    expect(f.calls).toHaveLength(1);
  });

  it('evicts the least recently used by bytes and closes it', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster, 2 * 128 * 128 * 4); // room for two 128 sprites
    const a = await c.load('A', 128);
    await c.load('B', 128);
    c.get('A', 128); // A is now more recent than B
    await c.load('C', 128);
    expect(c.size).toBe(2);
    expect(c.bytes).toBe(2 * 128 * 128 * 4);
    expect(c.get('B', 128)).toBeUndefined();
    expect(c.get('A', 128)).toBe(a);
    const closed = f.made.filter((b) => b.closed).map((b) => b.id);
    expect(closed).toEqual(['/openmoji/B.svg@128']);
  });

  it('counts bytes by bucket and keeps a sprite larger than the cap', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster, 4 * 1024 * 1024); // exactly one 1024 sprite
    await c.load('A', 128);
    await c.load('B', 1024);
    expect(c.get('A', 128)).toBeUndefined();
    expect(c.bytes).toBe(1024 * 1024 * 4);
    const tiny = new SpriteCache(f.raster, 10);
    const only = await tiny.load('Z', 128);
    expect(tiny.get('Z', 128)).toBe(only);
    expect(only).toBeDefined();
  });

  it('does not cache a failed load; a retry rasterizes again', async () => {
    const f = fakeRaster(['BAD']);
    const c = new SpriteCache(f.raster);
    await expect(c.load('BAD', 128)).rejects.toThrow('boom');
    expect(c.hasFailed('BAD', 128)).toBe(true);
    await expect(c.load('BAD', 128)).rejects.toThrow('failed before'); // negative cache: no second fetch
    expect(f.calls).toHaveLength(1);
    expect(c.size).toBe(0);
    c.clear();
    expect(c.hasFailed('BAD', 128)).toBe(false);
  });

  it('a load that lands after clear() is closed, not inserted', async () => {
    const made: { closed: boolean; close(): void }[] = [];
    let land!: () => void;
    const gate = new Promise<void>((r) => (land = r));
    const c = new SpriteCache(async () => {
      await gate;
      const b = { closed: false, close() { this.closed = true; } };
      made.push(b);
      return b as unknown as ImageBitmap;
    });
    const loading = c.load('A', 128);
    c.clear();
    land();
    await expect(loading).rejects.toThrow('cleared');
    expect(made[0]!.closed).toBe(true);
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });

  it('clear closes everything', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster);
    await c.load('A', 128);
    await c.load('B', 128);
    c.clear();
    expect(f.made.every((b) => b.closed)).toBe(true);
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });
});

describe('SpriteCache.preload', () => {
  const B: SpriteBucket = 1024;

  it('holds every distinct sprite outside the LRU, beyond its byte cap', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster, 4 * 1024 * 1024); // LRU fits one 1024 sprite
    const set = await c.preload(['A', 'B', 'C', 'A'], B);
    expect(f.calls).toHaveLength(3);
    expect(c.size).toBe(0);
    for (const h of ['A', 'B', 'C']) expect(set.get(h)).toBeDefined();
    expect(f.made.some((b) => b.closed)).toBe(false);
    set.release();
    expect(f.made.every((b) => b.closed)).toBe(true);
    expect(set.get('A')).toBeUndefined();
  });

  it('fails naming the sprites that did not load and closes the rest', async () => {
    const f = fakeRaster(['B', 'D']);
    const c = new SpriteCache(f.raster);
    await expect(c.preload(['A', 'B', 'C', 'D'], B)).rejects.toThrow('sprites failed to load: B, D');
    expect(f.made.every((b) => b.closed)).toBe(true);
  });
});

describe('catalog', () => {
  const good = {
    version: 1,
    categories: [
      { id: 'animals', name: { pl: 'Zwierzęta', ru: 'Животные' }, hexcodes: ['1F436', '1F431'] },
      { id: 'food', name: { pl: 'Jedzenie', ru: 'Еда' }, hexcodes: ['1F34E'] },
    ],
  };

  beforeEach(() => resetCatalogCache());

  it('parses a valid catalog', () => {
    expect(parseCatalog(good).categories.map((c) => c.id)).toEqual(['animals', 'food']);
    expect(spriteUrl('1F436')).toBe('/openmoji/1F436.svg');
  });

  it('rejects malformed catalogs', () => {
    const bad = (mut: (c: typeof good) => unknown) => () => parseCatalog(mut(structuredClone(good)));
    expect(() => parseCatalog(null)).toThrow('bad shape');
    expect(bad((c) => ({ ...c, version: 2 }))).toThrow('bad shape');
    expect(bad((c) => ({ ...c, categories: [] }))).toThrow('bad shape');
    expect(bad((c) => ({ ...c, categories: [{ ...c.categories[0], name: { pl: 'x' } }] }))).toThrow('pl and ru');
    expect(bad((c) => ({ ...c, categories: [{ ...c.categories[0], hexcodes: [] }] }))).toThrow('empty');
    expect(bad((c) => ({ ...c, categories: [c.categories[0], c.categories[0]] }))).toThrow('duplicate category');
    expect(bad((c) => ({ ...c, categories: [c.categories[0], { ...c.categories[1], hexcodes: ['1F436'] }] }))).toThrow('duplicate hexcode');
  });

  it('loads once, and retries after a failure', async () => {
    let n = 0;
    const urls: string[] = [];
    const ok = async (url: string) => (urls.push(url), n++, good);
    const a = await loadCatalog(ok);
    expect(await loadCatalog(ok)).toBe(a);
    expect(n).toBe(1);
    expect(urls).toEqual(['/openmoji/catalog.json']);

    resetCatalogCache();
    await expect(loadCatalog(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect((await loadCatalog(ok)).categories).toHaveLength(2);
  });

  it('the committed catalog parses and every sprite file exists', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const dir = new URL('../../public/openmoji/', import.meta.url);
    const cat = parseCatalog(JSON.parse(readFileSync(new URL('catalog.json', dir), 'utf8')));
    expect(cat.categories).toHaveLength(8);
    for (const c of cat.categories) for (const h of c.hexcodes) expect(existsSync(new URL(`${h}.svg`, dir)), h).toBe(true);
  });
});

describe('sprite urls (urlOf)', () => {
  const ID = 'my:0123abcd-0123-4abc-8abc-0123456789ab';
  const urlOf = projectSpriteUrlOf('P1', 'file:///data/kopernikadr/', (u) => `conv:${u}`);

  it('a hexcode gives the OpenMoji svg, a custom id the movie copy, an invalid id nothing', () => {
    expect(urlOf('1F436')).toBe('/openmoji/1F436.svg');
    expect(urlOf(ID)).toBe('conv:file:///data/kopernikadr/projects/P1/stickers/0123abcd-0123-4abc-8abc-0123456789ab.webp');
    expect(urlOf('my:../../etc')).toBeNull();
    expect(urlOf('my:')).toBeNull();
    expect(customStickerPath('P1', '1F436')).toBeNull();
    expect(openmojiUrlOf(ID)).toBeNull();
    expect(openmojiUrlOf('1F436')).toBe('/openmoji/1F436.svg');
  });

  it('SpriteCache loads a custom sticker from the per-project url', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster, undefined, urlOf);
    await c.load(ID, 256);
    await c.load('1F436', 256);
    expect(f.calls.map((x) => x.url)).toEqual([urlOf(ID), '/openmoji/1F436.svg']);
  });

  it('an invalid custom id is an unknown sprite: load fails (and is remembered), nothing is rasterized', async () => {
    const f = fakeRaster();
    const c = new SpriteCache(f.raster, undefined, urlOf);
    await expect(c.load('my:bad', 128)).rejects.toThrow('unknown sprite');
    expect(c.hasFailed('my:bad', 128)).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('playback: a missing movie copy fails once, is remembered, and draws nothing', async () => {
    const c = new SpriteCache(async () => {
      throw new Error('gone');
    }, undefined, urlOf);
    await expect(c.load(ID, 256)).rejects.toThrow('gone');
    expect(c.hasFailed(ID, 256)).toBe(true);
    expect(c.get(ID, 256)).toBeUndefined();
  });

  it('preload names the custom sticker that is missing', async () => {
    const f = fakeRaster([ID.slice(3)]); // its .webp url fails
    const failing: Rasterize = async (url, size) => {
      if (url.includes(ID.slice(3))) throw new Error('gone');
      return f.raster(url, size);
    };
    const c = new SpriteCache(failing, undefined, urlOf);
    const err = await c.preload(['1F436', ID], 1024).catch((e: unknown) => e as Error & { failed: string[] });
    expect((err as Error).message).toContain(ID);
    expect((err as { failed: string[] }).failed).toEqual([ID]);
    expect(f.made.every((b) => b.closed)).toBe(true);
  });
});
