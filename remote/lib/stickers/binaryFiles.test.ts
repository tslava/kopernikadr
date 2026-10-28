import { describe, expect, it } from 'vitest';
import { FakeBinaryIO, FakeFs } from '../projects/fakeFs.testutil';
import { createBinaryFiles } from './binaryFiles';

const blob = (...b: number[]) => new Blob([new Uint8Array(b)]);

function setup() {
  const fs = new FakeFs();
  const io = new FakeBinaryIO(fs);
  return { fs, io, bin: createBinaryFiles(fs, io) };
}

const tmpLeft = (fs: FakeFs) => [...fs.binaries.keys()].filter((k) => k.startsWith('tmp/'));

describe('writeBinary', () => {
  it('goes through tmp and lands in place with size and sha256', async () => {
    const { fs, bin } = setup();
    const r = await bin.writeBinary('stickers/a.webp', blob(1, 2, 3));
    expect([...fs.binaries.get('stickers/a.webp')!]).toEqual([1, 2, 3]);
    expect(r.bytes).toBe(3);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tmpLeft(fs)).toEqual([]);
    expect(fs.log.some((l) => l.startsWith('writeBytes tmp/'))).toBe(true);
    expect(fs.log.some((l) => l.startsWith('install tmp/'))).toBe(true);
  });

  it('removes the tmp file when the install fails', async () => {
    const { fs, bin } = setup();
    fs.failOn({ op: 'installFile', times: 1 });
    await expect(bin.writeBinary('stickers/a.webp', blob(1))).rejects.toThrow(/injected/);
    expect(fs.binaries.size).toBe(0);
  });
});

describe('copyFile', () => {
  it('copies a file via tmp and keeps the source', async () => {
    const { fs, bin } = setup();
    fs.binaries.set('stickers/a.webp', new Uint8Array([9, 8, 7]));
    const r = await bin.copyFile('stickers/a.webp', 'projects/p/stickers/a.webp');
    expect([...fs.binaries.get('projects/p/stickers/a.webp')!]).toEqual([9, 8, 7]);
    expect([...fs.binaries.get('stickers/a.webp')!]).toEqual([9, 8, 7]);
    expect(r.bytes).toBe(3);
    expect(tmpLeft(fs)).toEqual([]);
  });

  it('is idempotent: a second copy succeeds and changes nothing', async () => {
    const { fs, bin } = setup();
    fs.binaries.set('stickers/a.webp', new Uint8Array([1, 2]));
    await bin.copyFile('stickers/a.webp', 'projects/p/stickers/a.webp');
    await bin.copyFile('stickers/a.webp', 'projects/p/stickers/a.webp');
    expect([...fs.binaries.get('projects/p/stickers/a.webp')!]).toEqual([1, 2]);
  });

  it('installFile reports ALREADY_INSTALLED when the tmp file is gone and dest is valid', async () => {
    const { fs, io } = setup();
    fs.binaries.set('d.png', new Uint8Array([5, 5]));
    const sha256 = await io.sha256(new Uint8Array([5, 5]));
    await expect(io.installFile({ tmp: 'tmp/x.bin', dest: 'd.png', bytes: 2, sha256 })).resolves.toBe('ALREADY_INSTALLED');
  });

  it('heals after a crash between the copy and the install', async () => {
    const { fs, bin } = setup();
    fs.binaries.set('stickers/a.webp', new Uint8Array([4, 4, 4]));
    fs.crashAfter(1); // the copy lands, then everything throws
    await expect(bin.copyFile('stickers/a.webp', 'projects/p/stickers/a.webp')).rejects.toThrow('simulated crash');
    expect(fs.binaries.has('projects/p/stickers/a.webp')).toBe(false);
    fs.restart();
    await bin.copyFile('stickers/a.webp', 'projects/p/stickers/a.webp');
    expect([...fs.binaries.get('projects/p/stickers/a.webp')!]).toEqual([4, 4, 4]);
  });

  it('fails when the source is missing', async () => {
    const { bin } = setup();
    await expect(bin.copyFile('stickers/none.webp', 'x/y.webp')).rejects.toThrow(/no such file/);
  });
});
