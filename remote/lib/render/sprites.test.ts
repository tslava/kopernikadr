import { beforeEach, describe, expect, it } from 'vitest';
import { bmp, asBitmap, type FakeBitmap } from '../play/play.testutil';
import { loadCatalog, parseCatalog, resetCatalogCache, spriteUrl } from './catalog';
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
    await expect(c.load('BAD', 128)).rejects.toThrow('boom');
    expect(f.calls).toHaveLength(2);
    expect(c.size).toBe(0);
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
