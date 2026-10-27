import { describe, expect, it } from 'vitest';
import { clearQuarantine, isClearAnswer, isPlainName, newClearQuestion, listQuarantine, thumbEntries, type QuarantineEntry, type QuarantineFs } from './quarantine';

/** In-memory quarantine directory; the fs only ever sees plain names, so `outside` must stay untouched. */
function fakeDir(entries: QuarantineEntry[], failOn: string[] = []) {
  const files = new Map(entries.map((e) => [e.name, e]));
  const outside = new Set(['index.json', 'projects/a/project.json']);
  const removed: string[] = [];
  const fs: QuarantineFs = {
    async list() { return [...files.values()]; },
    async remove(name) {
      if (failOn.includes(name)) throw new Error(`boom ${name}`);
      files.delete(name);
      removed.push(name);
    },
    async uri(name) { return `file:///q/${name}`; },
  };
  return { fs, files, outside, removed, names: () => [...files.keys()] };
}
const e = (name: string, size: number, mtime: number): QuarantineEntry => ({ name, size, mtime });

describe('quarantine', () => {
  it('lists files with count and size, newest first', async () => {
    const d = fakeDir([e('a-F1-100.full.jpg', 4000, 100), e('b-F2-300.full.jpg', 6000, 300), e('c-F3-200.full.jpg', 1000, 200)]);
    const s = await listQuarantine(d.fs);
    expect(s.count).toBe(3);
    expect(s.bytes).toBe(11000);
    expect(s.entries.map((x) => x.name)).toEqual(['b-F2-300.full.jpg', 'c-F3-200.full.jpg', 'a-F1-100.full.jpg']);
  });

  it('a missing directory is empty', async () => {
    const d = fakeDir([]);
    expect(await listQuarantine(d.fs)).toEqual({ count: 0, bytes: 0, entries: [] });
    expect(await clearQuarantine(d.fs, d.names())).toEqual({ removed: 0, failed: [] });
  });

  it('thumbnails: newest 12 jpg files only', async () => {
    const many = Array.from({ length: 15 }, (_, i) => e(`p-F${i}-${i}.full.jpg`, 10, i));
    const s = await listQuarantine(fakeDir([...many, e('notes.txt', 1, 999)]).fs);
    const t = thumbEntries(s);
    expect(t).toHaveLength(12);
    expect(t[0]!.name).toBe('p-F14-14.full.jpg');
    expect(t.every((x) => x.name.endsWith('.jpg'))).toBe(true);
  });

  it('clear removes the files in the directory and nothing else', async () => {
    const d = fakeDir([e('a.full.jpg', 1, 1), e('b.full.jpg', 1, 2)]);
    const r = await clearQuarantine(d.fs, d.names());
    expect(r).toEqual({ removed: 2, failed: [] });
    expect(d.files.size).toBe(0);
    expect(d.removed.every((n) => !n.includes('/'))).toBe(true);
    expect(d.outside.size).toBe(2);
  });

  it('path guard: a name that could leave the directory is skipped', async () => {
    expect(isPlainName('a-F1-1.full.jpg')).toBe(true);
    for (const bad of ['', '.', '..', '../index.json', 'a/b.jpg', 'a\\b.jpg']) expect(isPlainName(bad)).toBe(false);
    const d = fakeDir([e('../index.json', 1, 1), e('sub/x.jpg', 1, 2), e('ok.full.jpg', 1, 3)]);
    expect((await listQuarantine(d.fs)).entries.map((x) => x.name)).toEqual(['ok.full.jpg']);
    expect(await clearQuarantine(d.fs, d.names())).toEqual({ removed: 1, failed: [] });
    expect(d.removed).toEqual(['ok.full.jpg']);
  });

  it('a partial failure is reported and the rest is still removed', async () => {
    const d = fakeDir([e('a.full.jpg', 1, 1), e('b.full.jpg', 1, 2), e('c.full.jpg', 1, 3)], ['b.full.jpg']);
    const r = await clearQuarantine(d.fs, d.names());
    expect(r.removed).toBe(2);
    expect(r.failed).toEqual([{ name: 'b.full.jpg', error: 'boom b.full.jpg' }]);
    expect([...d.files.keys()]).toEqual(['b.full.jpg']);
  });

  it('clear removes only what the parent saw: a file quarantined meanwhile stays', async () => {
    const d = fakeDir([e('a.full.jpg', 1, 1), e('b.full.jpg', 1, 2)]);
    const seen = d.names();
    d.files.set('late.full.jpg', e('late.full.jpg', 1, 3));
    expect(await clearQuarantine(d.fs, seen)).toEqual({ removed: 2, failed: [] });
    expect([...d.files.keys()]).toEqual(['late.full.jpg']);
  });

  it('a name with dots inside is a plain name and can be cleared', async () => {
    expect(isPlainName('a..b.jpg')).toBe(true);
  });

  it('the clear question: product of two factors in 12..29, only the exact digits pass', () => {
    for (const r of [0, 0.5, 0.999999]) {
      const q = newClearQuestion(() => r);
      expect(q.a).toBeGreaterThanOrEqual(12);
      expect(q.a).toBeLessThanOrEqual(29);
      expect(q.b).toBeGreaterThanOrEqual(12);
      expect(q.b).toBeLessThanOrEqual(29);
      expect(q.answer).toBe(q.a * q.b);
    }
    const q = { a: 23, b: 17, answer: 391 };
    expect(isClearAnswer(q, '391')).toBe(true);
    expect(isClearAnswer(q, ' 391 ')).toBe(true);
    for (const bad of ['', '390', '39', '3910', '391x', '0x187', '391.0', '-391']) expect(isClearAnswer(q, bad)).toBe(false);
  });
});
