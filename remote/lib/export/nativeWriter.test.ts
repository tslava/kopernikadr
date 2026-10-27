import { describe, expect, it, vi } from 'vitest';
import { createNativeWriter, NATIVE_WRITE_CHUNK, type NativeVideoPlugin } from './nativeWriter';

function fakePlugin() {
  const calls: unknown[][] = [];
  const plugin = {
    videoOpen: vi.fn(async () => (calls.push(['open']), { handle: 'h1', path: 'exports/export-h1.mp4' })),
    videoWriteAt: vi.fn(async (o: { handle: string; position: number; data: string }) => {
      calls.push(['writeAt', o.handle, o.position, Buffer.from(o.data, 'base64')]);
    }),
    videoClose: vi.fn(async (o: { handle: string }) => void calls.push(['close', o.handle])),
    videoPublish: vi.fn(async (o: { handle: string; displayName: string }) => {
      calls.push(['publish', o.handle, o.displayName]);
      return { uri: 'content://media/external/video/media/7' };
    }),
    videoAbort: vi.fn(async (o: { handle: string }) => void calls.push(['abort', o.handle])),
  } satisfies NativeVideoPlugin;
  return { plugin, calls };
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

describe('createNativeWriter', () => {
  it('opens, writes base64 at positions, closes and publishes with the handle', async () => {
    const { plugin, calls } = fakePlugin();
    const w = createNativeWriter({ plugin });
    expect(w.handle).toBeUndefined();
    await w.open();
    expect(w.handle).toBe('h1');
    expect(w.path).toBe('exports/export-h1.mp4');
    const data = bytes(100);
    await w.writeAt(4096, data);
    await w.close();
    expect(await w.publish('film')).toEqual({ uri: 'content://media/external/video/media/7' });
    expect(calls).toEqual([
      ['open'],
      ['writeAt', 'h1', 4096, Buffer.from(data)],
      ['close', 'h1'],
      ['publish', 'h1', 'film'],
    ]);
  });

  it('splits a large write into ≤chunkBytes calls with advancing positions', async () => {
    const { plugin, calls } = fakePlugin();
    const w = createNativeWriter({ plugin, chunkBytes: 1000 });
    await w.open();
    const data = bytes(2500, 7);
    await w.writeAt(10, data);
    const writes = calls.filter((c) => c[0] === 'writeAt') as [string, string, number, Buffer][];
    expect(writes.map((c) => [c[2], c[3].length])).toEqual([
      [10, 1000],
      [1010, 1000],
      [2010, 500],
    ]);
    expect(Buffer.concat(writes.map((c) => c[3]))).toEqual(Buffer.from(data));
  });

  it('defaults to 1 MiB chunks', async () => {
    const { plugin } = fakePlugin();
    const w = createNativeWriter({ plugin });
    await w.open();
    await w.writeAt(0, new Uint8Array(NATIVE_WRITE_CHUNK + 1));
    expect(plugin.videoWriteAt).toHaveBeenCalledTimes(2);
    expect(NATIVE_WRITE_CHUNK).toBe(1 << 20);
  });

  it('respects subarray offsets of the input', async () => {
    const { plugin, calls } = fakePlugin();
    const w = createNativeWriter({ plugin });
    await w.open();
    const whole = bytes(50);
    await w.writeAt(0, whole.subarray(10, 20));
    expect(calls[1][3]).toEqual(Buffer.from(whole.subarray(10, 20)));
  });

  it('awaits each chunk before sending the next', async () => {
    const { plugin } = fakePlugin();
    let inFlight = 0;
    let maxInFlight = 0;
    plugin.videoWriteAt.mockImplementation(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    const w = createNativeWriter({ plugin, chunkBytes: 10 });
    await w.open();
    await w.writeAt(0, bytes(55));
    expect(plugin.videoWriteAt).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(1);
  });

  it('propagates a native rejection (e.g. NO_SPACE) and stops writing', async () => {
    const { plugin } = fakePlugin();
    plugin.videoWriteAt.mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'NO_SPACE' }));
    const w = createNativeWriter({ plugin, chunkBytes: 10 });
    await w.open();
    await expect(w.writeAt(0, bytes(30))).rejects.toMatchObject({ code: 'NO_SPACE' });
    expect(plugin.videoWriteAt).toHaveBeenCalledTimes(1);
  });

  it('abort before open is a no-op; after open it aborts the handle', async () => {
    const { plugin, calls } = fakePlugin();
    const w = createNativeWriter({ plugin });
    await w.abort();
    expect(plugin.videoAbort).not.toHaveBeenCalled();
    await w.open();
    await w.abort();
    await w.abort();
    expect(calls.filter((c) => c[0] === 'abort')).toEqual([
      ['abort', 'h1'],
      ['abort', 'h1'],
    ]);
  });

  it('rejects use before open and a second open', async () => {
    const { plugin } = fakePlugin();
    const w = createNativeWriter({ plugin });
    await expect(w.writeAt(0, bytes(1))).rejects.toThrow(/not open/);
    await expect(w.close()).rejects.toThrow(/not open/);
    await expect(w.publish('x')).rejects.toThrow(/not open/);
    await w.open();
    await expect(w.open()).rejects.toThrow(/already open/);
  });

  it('rejects a bad chunk size', () => {
    expect(() => createNativeWriter({ chunkBytes: 0 })).toThrow(RangeError);
  });
});
