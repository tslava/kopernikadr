import { describe, expect, it } from 'vitest';
import { createStore } from '../state/store';
import { FakeFs } from '../projects/fakeFs.testutil';
import { EditHistory } from '../projects/history';
import type { FrameInfo } from '../projects/model';
import { mergeFrame, setLocal } from '../projects/reducers';
import { ProjectStore } from '../projects/store';
import { moveEntry } from '../projects/edit';
import { handlePoint } from '../render/stickerGeometry';
import { customEmoji } from '../stickers/pickerTabs';
import { pickSticker, reconcileSticker, StickerController, StickerCopyError, stickersOn, withLivePose } from './stickerController';

const info = (projectId: string, frameId: string, seq: number): FrameInfo => ({
  frameId, seq, projectId, clientId: 'c', rotation: 0, capturedAt: '2026-10-27T10:00:00.000Z',
  full: { w: 4, h: 3, bytes: 10, sha256: 'a'.repeat(64) },
});

const W = 400;
const H = 300;

async function setup(frames = 5, copySticker?: (id: string, pid: string) => Promise<void>) {
  let n = 0;
  const fs = new FakeFs();
  const store = new ProjectStore(fs, { now: () => 1_700_000_000_000, newId: () => 'p1' });
  await store.load();
  const p = await store.createProject('Film 1');
  await store.updateProject(p.id, (pr) => {
    pr = { ...pr, cameraId: 'cam' };
    for (let i = 1; i <= frames; i++) pr = setLocal(mergeFrame(pr, info(pr.id, `f${i}`, i), 'cam').project, `f${i}`);
    return pr;
  });
  const exporting = createStore(false);
  const history = new EditHistory();
  const c = new StickerController({ store, exporting, history, copySticker, newId: () => `s${++n}` });
  const project = () => store.state.get().projects.p1!;
  const sticker = (id = 's1') => project().stickers!.find((s) => s.id === id)!;
  return { c, store, exporting, history, project, sticker };
}

describe('StickerController', () => {
  it('add puts the sticker on the entry and every later one, and returns its id', async () => {
    const { c, sticker, history } = await setup();
    expect(await c.add('p1', 'f2', '1F436')).toBe('s1');
    expect(sticker().on).toEqual(['f2', 'f3', 'f4', 'f5']);
    expect(history.canUndo('p1')).toBe(true);
    expect(await c.add('p1', 'nope', '1F436')).toBeNull();
  });

  it('a body drag moves by the finger delta and commits once, on commit', async () => {
    const { c, project, sticker, history } = await setup();
    await c.add('p1', 'f2', '1F436');
    const before = project();
    const g = c.begin(sticker(), 'move', { x: 200, y: 150 }, W, H);
    expect(g.update({ x: 240, y: 135 })).toMatchObject({ x: 0.6, y: 0.45, size: 0.25, rot: 0 });
    g.update({ x: 280, y: 120 });
    expect(project()).toBe(before); // nothing written while the finger is down
    expect(await g.commit('p1')).toBe(true);
    expect(sticker()).toMatchObject({ x: 0.7, y: 0.4 });
    // one entry for the add, one for the drag
    await c.remove('p1', 's1');
    let steps = 0;
    while (history.pop('p1')) steps++;
    expect(steps).toBe(3);
  });

  it('a handle drag scales and rotates together', async () => {
    const { c, sticker } = await setup();
    await c.add('p1', 'f1', '1F436');
    const s = sticker();
    const h = handlePoint(s, W, H);
    const g = c.begin(s, 'handle', h, W, H);
    // straight right of the centre, twice as far: size doubles-ish, rot -45
    const pose = g.update({ x: s.x * W + 2 * (h.x - s.x * W), y: s.y * H });
    expect(pose.rot).toBeCloseTo(-45, 5);
    expect(pose.size).toBeGreaterThan(0.25);
    expect(pose.x).toBe(0.5);
    await g.commit('p1');
    expect(sticker().rot).toBeCloseTo(-45, 5);
    expect(sticker().size).toBeCloseTo(pose.size, 8);
  });

  it('a drag stays within the position clamp', async () => {
    const { c, sticker } = await setup();
    await c.add('p1', 'f1', '1F436');
    const g = c.begin(sticker(), 'move', { x: 0, y: 0 }, W, H);
    expect(g.update({ x: 5000, y: -5000 })).toMatchObject({ x: 1.25, y: -0.25 });
  });

  it('an unmoved gesture records no history', async () => {
    const { c, sticker, history } = await setup();
    await c.add('p1', 'f1', '1F436');
    history.pop('p1');
    const g = c.begin(sticker(), 'move', { x: 10, y: 10 }, W, H);
    g.update({ x: 10, y: 10 });
    expect(await g.commit('p1')).toBe(false);
    expect(history.canUndo('p1')).toBe(false);
  });

  it('a cancelled gesture writes nothing and restores the pose', async () => {
    const { c, project, sticker, history } = await setup();
    await c.add('p1', 'f1', '1F436');
    history.pop('p1');
    const before = project();
    const g = c.begin(sticker(), 'move', { x: 0, y: 0 }, W, H);
    g.update({ x: 100, y: 100 });
    expect(g.cancel()).toMatchObject({ x: 0.5, y: 0.5 });
    expect(await g.commit('p1')).toBe(false);
    expect(project()).toBe(before);
    expect(history.canUndo('p1')).toBe(false);
  });

  it('selection: picks the topmost sticker on the shown entry only', async () => {
    const { c, project } = await setup();
    await c.add('p1', 'f1', '1F436');
    await c.add('p1', 'f3', '1F431');
    const mid = { x: W / 2, y: H / 2 };
    expect(pickSticker(project(), 'f1', mid, W, H)?.id).toBe('s1');
    expect(pickSticker(project(), 'f3', mid, W, H)?.id).toBe('s2'); // on top
    expect(pickSticker(project(), 'f1', { x: 5, y: 5 }, W, H)).toBeNull();
    expect(pickSticker(project(), null, mid, W, H)).toBeNull();
    expect(stickersOn(project(), 'f1').map((s) => s.id)).toEqual(['s1']);
    expect(reconcileSticker('s2', project())).toBe('s2');
    expect(reconcileSticker('zzz', project())).toBeNull();
    expect(reconcileSticker(null, project())).toBeNull();
  });

  it('withLivePose overlays one sticker without touching the list', async () => {
    const { c, project } = await setup();
    await c.add('p1', 'f1', '1F436');
    const list = project().stickers!;
    const live = withLivePose(list, { id: 's1', pose: { x: 0.1, y: 0.2, size: 0.3, rot: 9 } });
    expect(live[0]).toMatchObject({ x: 0.1, rot: 9, emoji: '1F436' });
    expect(list[0]!.x).toBe(0.5);
    expect(withLivePose(list, null)).toBe(list);
  });

  it('range from / to use the tapped entry and keep the other end', async () => {
    const { c, sticker } = await setup();
    await c.add('p1', 'f1', '1F436'); // 1..5
    await c.rangeFrom('p1', 's1', 'f2');
    expect(sticker().on).toEqual(['f2', 'f3', 'f4', 'f5']);
    await c.rangeTo('p1', 's1', 'f4');
    expect(sticker().on).toEqual(['f2', 'f3', 'f4']);
    // from past the end: just that entry
    await c.rangeFrom('p1', 's1', 'f5');
    expect(sticker().on).toEqual(['f5']);
    // to before the start: just that entry
    await c.rangeTo('p1', 's1', 'f1');
    expect(sticker().on).toEqual(['f1']);
    expect(await c.rangeTo('p1', 's1', 'f1')).toBe(false);
  });

  it('a moved frame carries the sticker along', async () => {
    const { c, store, sticker } = await setup();
    await c.add('p1', 'f2', '1F436');
    await c.rangeTo('p1', 's1', 'f4'); // 2..4
    await store.updateProject('p1', (p) => moveEntry(p, 'f3', 1));
    expect(sticker().on.sort()).toEqual(['f2', 'f3', 'f4']);
  });

  it('delete and Cofnij share one history with the frame edits', async () => {
    const { c, project, history } = await setup();
    await c.add('p1', 'f1', '1F436');
    expect(await c.remove('p1', 's1')).toBe(true);
    expect(project().stickers).toEqual([]);
    expect(await c.remove('p1', 's1')).toBe(false);
    expect(history.canUndo('p1')).toBe(true);
  });

  it('does nothing while an export runs', async () => {
    const { c, exporting, project } = await setup();
    await c.add('p1', 'f1', '1F436');
    exporting.set(true);
    expect(await c.add('p1', 'f2', '1F431')).toBeNull();
    expect(await c.remove('p1', 's1')).toBe(false);
    expect(project().stickers).toHaveLength(1);
  });
});

describe('StickerController: custom stickers (copy-on-place)', () => {
  const UUID = '0123abcd-0123-4abc-8abc-0123456789ab';
  const MY = `my:${UUID}`;

  it('copies the library sticker into the movie first, then places it', async () => {
    const calls: string[] = [];
    const { c, project, sticker } = await setup(5, async (id, pid) => void calls.push(`${pid}/${id}`));
    expect(await c.add('p1', 'f2', MY)).toBe('s1');
    expect(calls).toEqual([`p1/${UUID}`]);
    expect(sticker().emoji).toBe(MY);
    expect(project().stickers).toHaveLength(1);
  });

  it('a tile picked in "Moje" is placed by its library id (customEmoji)', async () => {
    const calls: string[] = [];
    const { c, sticker } = await setup(5, async (id, pid) => void calls.push(`${pid}/${id}`));
    expect(await c.add('p1', 'f2', customEmoji(UUID))).toBe('s1');
    expect(calls).toEqual([`p1/${UUID}`]);
    expect(sticker().emoji).toBe(MY);
  });

  it('a failed copy places nothing, writes nothing and throws StickerCopyError', async () => {
    const { c, project, history } = await setup(5, async () => {
      throw new Error('disk full');
    });
    const before = project();
    await expect(c.add('p1', 'f2', MY)).rejects.toBeInstanceOf(StickerCopyError);
    expect(project()).toBe(before);
    expect(history.canUndo('p1')).toBe(false);
  });

  it('without a copy dep a custom sticker cannot be placed; an OpenMoji one still can', async () => {
    const { c } = await setup();
    await expect(c.add('p1', 'f2', MY)).rejects.toBeInstanceOf(StickerCopyError);
    expect(await c.add('p1', 'f2', '1F436')).not.toBeNull();
  });

  it('does not copy while an export runs', async () => {
    const calls: string[] = [];
    const { c, exporting } = await setup(5, async (id) => void calls.push(id));
    exporting.set(true);
    expect(await c.add('p1', 'f2', MY)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('the movie keeps drawing after the library sticker is removed (the copy is what it references)', async () => {
    const files = new Map<string, string>([[`lib/${UUID}`, 'png']]);
    const { c, sticker } = await setup(5, async (id, pid) => void files.set(`projects/${pid}/stickers/${id}.webp`, files.get(`lib/${id}`)!));
    await c.add('p1', 'f2', MY);
    files.delete(`lib/${UUID}`); // library delete
    expect(files.has(`projects/p1/stickers/${UUID}.webp`)).toBe(true);
    expect(sticker().emoji).toBe(MY);
  });
});
