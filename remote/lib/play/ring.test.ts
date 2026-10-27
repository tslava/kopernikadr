import { describe, expect, it } from 'vitest';
import { createRing } from './ring';
import { asBitmap, bmp, flush, type FakeBitmap } from './play.testutil';

function setup() {
  const made: Record<string, FakeBitmap> = {};
  const ring = createRing({ load: async (k) => asBitmap((made[k] = bmp(k))) });
  return { ring, made };
}

describe('ring', () => {
  it('holds at most 8 and closes evicted bitmaps', async () => {
    const { ring, made } = setup();
    ring.want(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    await flush();
    expect(ring.size).toBe(8);
    expect(made.i).toBeUndefined();
    ring.want(['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    await flush();
    expect(made.a.closed && made.b.closed).toBe(true);
    expect(made.c.closed).toBe(false);
    expect(ring.get('a')).toBeUndefined();
    expect(ring.get('j')).toBeDefined();
    expect(ring.size).toBe(8);
  });

  it('release closes everything and a late decode is closed too', async () => {
    const late: { resolve?: (b: ImageBitmap) => void } = {};
    const ring = createRing({
      load: (k) => (k === 'slow' ? new Promise((r) => (late.resolve = r)) : Promise.resolve(asBitmap(bmp(k)))),
    });
    ring.want(['a', 'slow']);
    await flush();
    const a = ring.get('a') as unknown as FakeBitmap;
    ring.release();
    expect(a.closed).toBe(true);
    expect(ring.size).toBe(0);
    const l = bmp('slow');
    late.resolve!(asBitmap(l));
    await flush();
    expect(l.closed).toBe(true);
    expect(ring.get('slow')).toBeUndefined();
  });

  it('records failures until cleared', async () => {
    const ring = createRing({ load: async () => { throw new Error('x'); } });
    ring.want(['a']);
    await flush();
    expect(ring.failed('a')).toBe(true);
    ring.clearFailed();
    expect(ring.failed('a')).toBe(false);
  });
});
