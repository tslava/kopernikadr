import { describe, expect, it, vi } from 'vitest';
import { createFrameSource } from './frameSource';

const ok = (name: string) => ({ ok: true, status: 200, blob: async () => ({ name }) as unknown as Blob });
const bad = { ok: false, status: 404, blob: async () => ({}) as Blob };
const frameUrl = (p: string, f: string, k: string) => `app://${p}/${f}.${k}`;

describe('frameSource', () => {
  it('uses the local play, decoded as is', async () => {
    const fetch = vi.fn(async (_u: string) => ok('play'));
    const decode = vi.fn(async (_b: Blob, _o?: unknown) => 'bmp' as unknown as ImageBitmap);
    const s = createFrameSource({ frameUrl, fetch, createImageBitmap: decode });
    expect(await s.load('p', 'f1')).toBe('bmp');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('app://p/f1.play');
    expect(decode).toHaveBeenCalledWith({ name: 'play' });
  });

  it('falls back to full resized to 1440x1080 when play is missing', async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith('.play') ? bad : ok('full')));
    const decode = vi.fn(async (_b: Blob, _o?: unknown) => 'bmp' as unknown as ImageBitmap);
    const s = createFrameSource({ frameUrl, fetch, createImageBitmap: decode });
    await s.load('p', 'f1');
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['app://p/f1.play', 'app://p/f1.full']);
    expect(decode).toHaveBeenCalledWith({ name: 'full' }, { resizeWidth: 1440, resizeHeight: 1080 });
  });

  it('falls back to full when play does not decode', async () => {
    const decode = vi.fn(async (_b: Blob, o?: unknown) => {
      if (!o) throw new Error('corrupt');
      return 'bmp' as unknown as ImageBitmap;
    });
    const s = createFrameSource({ frameUrl, fetch: async () => ok('x'), createImageBitmap: decode });
    expect(await s.load('p', 'f1')).toBe('bmp');
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('rejects when both fail, and does not fall back after an abort', async () => {
    const s = createFrameSource({ frameUrl, fetch: async () => bad, createImageBitmap: async () => ({}) as ImageBitmap });
    await expect(s.load('p', 'f1')).rejects.toThrow(/HTTP 404/);
    const fetch = vi.fn(async (_u: string): Promise<never> => {
      throw new Error('aborted');
    });
    const ac = new AbortController();
    ac.abort();
    await expect(createFrameSource({ frameUrl, fetch }).load('p', 'f1', ac.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
