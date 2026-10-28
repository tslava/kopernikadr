import { describe, expect, it, vi } from 'vitest';
import { reopenFrom, runCut, type ReopenIO } from './cutSession';
import { FakeSegClient, SegError, SegSupersededError, type SegMaskResult, type SegStrokeArg } from './segClient';
import type { Img } from './stickerize';

const strokes: SegStrokeArg[] = [{ mode: 'add', points: [[0.5, 0.5]] }];
const ok: SegMaskResult = { mask: new Uint8Array(16), width: 4, height: 4, ms: 1, delegate: 'cpu' };
const photo: Img = { width: 2, height: 2, data: new Uint8ClampedArray(16) };

describe('runCut', () => {
  it('a run after the idle close reopens the session once and retries', async () => {
    let calls = 0;
    const seg = new FakeSegClient({
      run: () => {
        if (calls++ === 0) throw new SegError('NO_SESSION', 'gone');
        return ok;
      },
    });
    const reopen = vi.fn(async () => {
      await seg.open('tmp/again.png');
    });
    expect(await runCut(seg, strokes, reopen)).toBe(ok);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(seg.runs).toEqual([strokes, strokes]);
    expect(seg.opened).toEqual(['tmp/again.png']);
  });

  it('retries only once: a second NO_SESSION is the error', async () => {
    const seg = new FakeSegClient({ run: () => { throw new SegError('NO_SESSION', 'gone'); } });
    await expect(runCut(seg, strokes, async () => undefined)).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(seg.runs).toHaveLength(2);
  });

  it('other errors are not retried and do not reopen', async () => {
    const seg = new FakeSegClient({ run: () => { throw new SegError('SEG_FAILED', 'boom'); } });
    const reopen = vi.fn(async () => undefined);
    await expect(runCut(seg, strokes, reopen)).rejects.toMatchObject({ code: 'SEG_FAILED' });
    expect(reopen).not.toHaveBeenCalled();
    expect(seg.runs).toHaveLength(1);
  });

  it('a failing reopen rejects without a second run', async () => {
    const seg = new FakeSegClient({ run: () => { throw new SegError('NO_SESSION', 'gone'); } });
    await expect(runCut(seg, strokes, async () => { throw new SegError('MODEL_MISSING', 'x'); })).rejects.toMatchObject({ code: 'MODEL_MISSING' });
    expect(seg.runs).toHaveLength(1);
  });
});

describe('runCut with a newer run', () => {
  it('an obsolete run does not reopen and does not retry', async () => {
    const seg = new FakeSegClient({ run: () => { throw new SegError('NO_SESSION', 'gone'); } });
    const reopen = vi.fn(async () => undefined);
    await expect(runCut(seg, strokes, reopen, () => false)).rejects.toBeInstanceOf(SegSupersededError);
    expect(reopen).not.toHaveBeenCalled();
    expect(seg.runs).toHaveLength(1);
  });

  it('a run that became obsolete during the reopen does not retry', async () => {
    let current = true;
    const seg = new FakeSegClient({ run: () => { throw new SegError('NO_SESSION', 'gone'); } });
    const reopen = vi.fn(async () => { current = false; });
    await expect(runCut(seg, strokes, reopen, () => current)).rejects.toBeInstanceOf(SegSupersededError);
    expect(seg.runs).toHaveLength(1);
  });
});

describe('reopenFrom', () => {
  const io = (over: Partial<ReopenIO> = {}) => {
    const written: string[] = [];
    const removed: string[] = [];
    const base: ReopenIO = {
      encodePng: async () => new Uint8Array([1]),
      write: async (p) => { written.push(p); },
      remove: async (p) => { removed.push(p); },
      uuid: () => 'u1',
      ...over,
    };
    return { base, written, removed };
  };

  it('writes the kept photo as a PNG into tmp/ and opens it', async () => {
    const seg = new FakeSegClient();
    const { base, written, removed } = io();
    await reopenFrom(seg, () => photo, base)();
    expect(written).toEqual(['tmp/seg-src-u1.png']);
    expect(seg.opened).toEqual(['tmp/seg-src-u1.png']);
    expect(removed).toEqual([]);
  });

  it('removes the file when open fails (the native side deletes it only on success)', async () => {
    const seg = new FakeSegClient({ open: () => { throw new SegError('UNSUPPORTED', 'x'); } });
    const { base, removed } = io();
    await expect(reopenFrom(seg, () => photo, base)()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(removed).toEqual(['tmp/seg-src-u1.png']);
  });

  it('an obsolete reopen never opens (open would cancel the newest run) and drops its file', async () => {
    const seg = new FakeSegClient();
    const { base, removed } = io();
    await expect(reopenFrom(seg, () => photo, base)(() => false)).rejects.toBeInstanceOf(SegSupersededError);
    expect(seg.opened).toEqual([]);
    expect(removed).toEqual(['tmp/seg-src-u1.png']);
  });

  it('a failed PNG encode or write still removes the temporary file and never opens', async () => {
    for (const over of [
      { encodePng: async () => { throw new Error('encode'); } },
      { write: async () => { throw new Error('disk full'); } },
    ] as Partial<ReopenIO>[]) {
      const seg = new FakeSegClient();
      const { base, removed } = io(over);
      await expect(reopenFrom(seg, () => photo, base)()).rejects.toThrow();
      expect(seg.opened).toEqual([]);
      expect(removed).toEqual(['tmp/seg-src-u1.png']);
    }
  });

  it('a failing cleanup does not mask the original error', async () => {
    const seg = new FakeSegClient({ open: () => { throw new SegError('UNSUPPORTED', 'x'); } });
    const { base } = io({ remove: async () => { throw new Error('rm failed'); } });
    await expect(reopenFrom(seg, () => photo, base)()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('without a photo there is nothing to reopen', async () => {
    const { base, written } = io();
    await expect(reopenFrom(new FakeSegClient(), () => null, base)()).rejects.toMatchObject({ code: 'NO_SESSION' });
    expect(written).toEqual([]);
  });
});
