import { describe, expect, it } from 'vitest';
import { ackEligible } from './eligibility';
import {
  droppedEditFields,
  isCustomSticker,
  ModelError,
  parseIndex,
  parseProject,
  type FrameInfo,
  type Project,
  type ProjectIndex,
} from './model';
import {
  beginCapture,
  clearUnavailable,
  createProject,
  expireFrames,
  expireProjects,
  hideFrame,
  hideProject,
  isGeometryFrozen,
  markUnavailable,
  mergeFrame,
  recoverProject,
  removeOutstanding,
  renameProject,
  routeResult,
  setFps,
  setLocal,
  setRotation,
  unhideFrame,
  unhideProject,
} from './reducers';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const CAM = 'cam-A';
const PID = '7a1f3c5e-8b2d-4f69-9c04-e6b8d2a4f1c3';

const emptyIndex = (): ProjectIndex => ({
  version: 1,
  clientId: 'c1',
  rememberedCamera: null,
  projects: [],
  deletedProjects: [],
  pendingProjectDeletes: [],
});

const info = (n: number, over: Partial<FrameInfo> = {}): FrameInfo => ({
  frameId: `F${String(n).padStart(3, '0')}`,
  seq: n,
  projectId: PID,
  clientId: 'c1',
  rotation: 0,
  capturedAt: '2026-10-26T15:04:05.123Z',
  full: { w: 3264, h: 2448, bytes: 1000 + n, sha256: `sha${n}` },
  derived: { play: { w: 1440, h: 1080 }, thumb: { w: 256, h: 192 } },
  ...over,
});

function newProject(): { index: ProjectIndex; project: Project } {
  return createProject(emptyIndex(), { id: PID, name: 'Film', nowMs: T0 });
}
function boundProject(): Project {
  const r = beginCapture(newProject().project, { reqId: 'r0', cameraId: CAM, nowMs: T0 });
  if (!r.ok) throw new Error('unreachable');
  return removeOutstanding(r.project, 'r0');
}
const merged = (p: Project, ...ns: number[]) => ns.reduce((acc, n) => mergeFrame(acc, info(n), CAM).project, p);

describe('create / rename / fps / rotation', () => {
  it('creates a project in both index and project', () => {
    const { index, project } = newProject();
    expect(index.projects).toEqual([{ id: PID, name: 'Film', createdAt: '2026-10-27T10:00:00.000Z' }]);
    expect(project).toMatchObject({ version: 1, fps: 8, cameraId: null, frames: [], outstanding: [], deletedFrameIds: [] });
    expect(project.geometry).toEqual({ aspect: '4:3', rotation: 0 });
  });
  it('refuses a reused id (also a tombstoned one)', () => {
    const { index } = newProject();
    expect(() => createProject(index, { id: PID, name: 'x', nowMs: T0 })).toThrow();
    expect(() => createProject({ ...emptyIndex(), deletedProjects: ['d'] }, { id: 'd', name: 'x', nowMs: T0 })).toThrow();
  });
  it('renames in both places, refuses blank, trims', () => {
    const { index, project } = newProject();
    const r = renameProject(index, project, '  Nowy  ')!;
    expect(r.index.projects[0]!.name).toBe('Nowy');
    expect(r.project.name).toBe('Nowy');
    expect(renameProject(index, project, '   ')).toBeNull();
  });
  it('fps accepts only 5/8/12', () => {
    const { project } = newProject();
    expect(setFps(project, 12).fps).toBe(12);
    expect(setFps(project, 7)).toBe(project);
  });
  it('rotation changes until frozen', () => {
    const { project } = newProject();
    expect(setRotation(project, 180).geometry.rotation).toBe(180);
    const r = beginCapture(project, { reqId: 'r1', cameraId: CAM, nowMs: T0 });
    if (!r.ok) throw new Error();
    expect(setRotation(r.project, 180)).toBe(r.project);
    expect(setRotation(merged(boundProject(), 1), 180).geometry.rotation).toBe(0);
  });
});

describe('beginCapture', () => {
  it('adds outstanding, binds the camera and freezes the rotation in ONE state change', () => {
    const p0 = setRotation(newProject().project, 180);
    const r = beginCapture(p0, { reqId: 'r1', cameraId: CAM, nowMs: T0 });
    expect(r).toMatchObject({ ok: true, rotation: 180 });
    if (!r.ok) throw new Error();
    expect(r.project.cameraId).toBe(CAM);
    expect(r.project.outstanding).toEqual([{ reqId: 'r1', cameraId: CAM, sentAt: '2026-10-27T10:00:00.000Z' }]);
    expect(p0.cameraId).toBeNull(); // input untouched
  });
  it('refuses another camera, keeps the bound one', () => {
    const r = beginCapture(boundProject(), { reqId: 'r2', cameraId: 'cam-B', nowMs: T0 });
    expect(r).toEqual({ ok: false, reason: 'camera_mismatch' });
  });
  it('the same reqId twice is a no-op', () => {
    const a = beginCapture(newProject().project, { reqId: 'r1', cameraId: CAM, nowMs: T0 });
    if (!a.ok) throw new Error();
    const b = beginCapture(a.project, { reqId: 'r1', cameraId: CAM, nowMs: T0 + 5000 });
    if (!b.ok) throw new Error();
    expect(b.project).toBe(a.project);
  });
  it('geometry freeze: first capture lost, UI rotation changes, result arrives -> original rotation holds', () => {
    const start = newProject().project;
    const a = beginCapture(start, { reqId: 'r1', cameraId: CAM, nowMs: T0 });
    if (!a.ok) throw new Error();
    expect(a.rotation).toBe(0);
    // the parent flips the rotation in the UI while r1 is still outstanding: ignored
    const flipped = setRotation(a.project, 180);
    expect(flipped.geometry.rotation).toBe(0);
    // the result arrives (a 0-rotation frame)
    const done = mergeFrame(removeOutstanding(flipped, 'r1'), info(1), CAM).project;
    expect(done.geometry.rotation).toBe(0);
    // a next capture still goes out with the frozen rotation
    const b = beginCapture(done, { reqId: 'r2', cameraId: CAM, nowMs: T0 });
    expect(b).toMatchObject({ ok: true, rotation: 0 });
  });
  it('the project is frozen even when the outstanding capture later fails, if a frame exists', () => {
    const p = merged(boundProject(), 1);
    expect(setRotation(p, 180).geometry.rotation).toBe(0);
  });
});

describe('mergeFrame: monotonic merge table (§5.5)', () => {
  it('absent -> inserted as pending', () => {
    const r = mergeFrame(boundProject(), info(1), CAM);
    expect(r.status).toBe('inserted');
    expect(r.project.frames).toEqual([
      { frameId: 'F001', seq: 1, bytes: 1001, sha256: 'sha1', state: 'pending', hiddenUntil: null },
    ]);
  });
  it('present pending -> unchanged', () => {
    const p = merged(boundProject(), 1);
    const r = mergeFrame(p, info(1), CAM);
    expect(r.status).toBe('exists');
    expect(r.project).toBe(p);
  });
  it('present local -> stays local (never back to pending)', () => {
    const p = setLocal(merged(boundProject(), 1), 'F001');
    const r = mergeFrame(p, info(1), CAM);
    expect(r.project).toBe(p);
    expect(r.project.frames[0]!.state).toBe('local');
  });
  it('present hidden -> keeps hiddenUntil and position', () => {
    let p = merged(boundProject(), 1, 2, 3);
    p = hideFrame(p, 'F002', T0);
    const r = mergeFrame(p, info(2), CAM);
    expect(r.project).toBe(p);
    expect(r.project.frames.map((f) => f.frameId)).toEqual(['F001', 'F002', 'F003']);
    expect(r.project.frames[1]!.hiddenUntil).toBe('2026-10-27T10:00:05.000Z');
  });
  it('present with different bytes/sha in the new FrameInfo -> existing entry untouched', () => {
    const p = merged(boundProject(), 1);
    const r = mergeFrame(p, info(1, { full: { w: 1, h: 1, bytes: 9, sha256: 'other' } }), CAM);
    expect(r.project).toBe(p);
  });
  it('tombstoned -> not inserted', () => {
    const p = { ...boundProject(), deletedFrameIds: ['F001'] };
    const r = mergeFrame(p, info(1), CAM);
    expect(r.status).toBe('tombstoned');
    expect(r.project).toBe(p);
  });
  it('orders by seq whatever the arrival order, keyed by frameId', () => {
    const p = merged(boundProject(), 5, 2, 9, 2, 7);
    expect(p.frames.map((f) => f.seq)).toEqual([2, 5, 7, 9]);
  });
  it('removing the outstanding never touches frames', () => {
    const a = beginCapture(boundProject(), { reqId: 'r1', cameraId: CAM, nowMs: T0 });
    if (!a.ok) throw new Error();
    const p = setLocal(merged(a.project, 1), 'F001');
    const q = removeOutstanding(p, 'r1');
    expect(q.frames).toBe(p.frames);
    expect(q.outstanding).toEqual([]);
    expect(removeOutstanding(q, 'r1')).toBe(q);
  });
});

describe('duplicate results: capture result + reconcile', () => {
  it('the frame ends up once, and local survives the reconcile re-merge', () => {
    let p = boundProject();
    const a = beginCapture(p, { reqId: 'r1', cameraId: CAM, nowMs: T0 });
    if (!a.ok) throw new Error();
    p = a.project;
    // 1. the capture result
    p = mergeFrame(removeOutstanding(p, 'r1'), info(1), CAM).project;
    p = setLocal(p, 'F001');
    // 2. reconcile lists the same frame (ack not yet processed by the phone)
    const again = mergeFrame(p, info(1), CAM);
    expect(again.status).toBe('exists');
    expect(again.project.frames).toHaveLength(1);
    expect(again.project.frames[0]!.state).toBe('local');
    // 3. in the other order: reconcile first, then the result
    let q = mergeFrame(boundProject(), info(1), CAM).project;
    q = mergeFrame(q, info(1), CAM).project;
    expect(q.frames).toHaveLength(1);
  });
  it('a result for an expired (tombstoned) frame does not resurrect it', () => {
    let p = setLocal(merged(boundProject(), 1), 'F001');
    p = expireFrames(hideFrame(p, 'F001', T0), T0 + 5000).project;
    expect(p.frames).toEqual([]);
    expect(mergeFrame(p, info(1), CAM).project.frames).toEqual([]);
  });
});

describe('mergeFrame: camera and project guards', () => {
  it('refused when the frame camera differs from project.cameraId', () => {
    const p = boundProject();
    const r = mergeFrame(p, info(1), 'cam-B');
    expect(r.status).toBe('wrong_camera');
    expect(r.project).toBe(p);
  });
  it('refused for an unbound project', () => {
    expect(mergeFrame(newProject().project, info(1), CAM).status).toBe('wrong_camera');
  });
  it('refused for another projectId', () => {
    expect(mergeFrame(boundProject(), info(1, { projectId: 'zzz' }), CAM).status).toBe('wrong_project');
  });
});

describe('routeResult: deleted projects', () => {
  it('deleted project -> not merged; live -> merge; unknown -> recover path', () => {
    const { index } = newProject();
    expect(routeResult(index, PID)).toBe('merge');
    expect(routeResult({ ...index, deletedProjects: ['gone'] }, 'gone')).toBe('deleted_project');
    expect(routeResult(index, 'nope')).toBe('unknown_project');
  });
  it('a project in the Undo window still merges', () => {
    const { index } = newProject();
    expect(routeResult(hideProject(index, PID, T0), PID)).toBe('merge');
  });
});

describe('setLocal / unavailable', () => {
  it('pending -> local, idempotent, absent is ignored', () => {
    const p = merged(boundProject(), 1);
    const l = setLocal(p, 'F001');
    expect(l.frames[0]!.state).toBe('local');
    expect(setLocal(l, 'F001')).toBe(l);
    expect(setLocal(l, 'nope')).toBe(l);
  });
  it('mark/clear unavailable on a pending frame; local frames are not marked', () => {
    const p = merged(boundProject(), 1, 2);
    const m = markUnavailable(p, 'F001', 'download_failed', T0);
    expect(m.frames[0]!.unavailable).toEqual({ reason: 'download_failed', since: '2026-10-27T10:00:00.000Z' });
    expect(markUnavailable(m, 'F001', 'other', T0 + 1)).toBe(m);
    expect(clearUnavailable(m, 'F001').frames[0]).not.toHaveProperty('unavailable');
    const l = setLocal(p, 'F002');
    expect(markUnavailable(l, 'F002', 'x', T0)).toBe(l);
  });
  it('unavailable never makes a frame eligible, and does not block a local one', () => {
    const { index } = newProject();
    const p = markUnavailable(merged(boundProject(), 1), 'F001', 'x', T0);
    expect(ackEligible({ frameId: 'F001', projectId: PID }, p, index)).toBe(false);
  });
});

describe('frame hide / unhide / expire (§5.8)', () => {
  it('hide sets the deadline, unhide clears it and keeps state/position', () => {
    let p = setLocal(merged(boundProject(), 1, 2), 'F001');
    p = hideFrame(p, 'F001', T0);
    expect(p.frames[0]).toMatchObject({ state: 'local', hiddenUntil: '2026-10-27T10:00:05.000Z' });
    expect(hideFrame(p, 'F001', T0 + 1000)).toBe(p); // deadline not extended
    const u = unhideFrame(p, 'F001');
    expect(u.frames[0]).toMatchObject({ state: 'local', hiddenUntil: null });
    expect(u.frames.map((f) => f.frameId)).toEqual(['F001', 'F002']);
  });
  it('expire only past the deadline: tombstone + remove, reports ids to unlink', () => {
    const p = hideFrame(merged(boundProject(), 1, 2), 'F001', T0);
    const early = expireFrames(p, T0 + 4999);
    expect(early.expired).toEqual([]);
    expect(early.project).toBe(p);
    const late = expireFrames(p, T0 + 5000);
    expect(late.expired).toEqual(['F001']);
    expect(late.project.deletedFrameIds).toEqual(['F001']);
    expect(late.project.frames.map((f) => f.frameId)).toEqual(['F002']);
  });
  it('expiry removes the cut entries of the expired frames (duplicates too)', () => {
    const base = merged(boundProject(), 1, 2, 3);
    const p = hideFrame(
      {
        ...base,
        cut: [
          { id: 'F001', frameId: 'F001', hold: 2 },
          { id: 'D1', frameId: 'F002', hold: 1 },
          { id: 'F002', frameId: 'F002', hold: 1 },
          { id: 'F003', frameId: 'F003', hold: 1 },
        ],
      },
      'F002',
      T0,
    );
    const r = expireFrames(p, T0 + 5000).project;
    expect(r.cut!.map((e) => e.id)).toEqual(['F001', 'F003']);
    expect(r.cut![0]!.hold).toBe(2);
  });
  it('expiry prunes the stickers on, and drops a sticker left with nothing', () => {
    const st = (id: string, on: string[]) => ({ id, emoji: '1F436', x: 0.5, y: 0.5, size: 0.2, rot: 0, on });
    const base = merged(boundProject(), 1, 2);
    const p = hideFrame({ ...base, stickers: [st('S1', ['F002']), st('S2', ['F001', 'F002']), st('S3', ['F001'])] }, 'F002', T0);
    const r = expireFrames(p, T0 + 5000).project;
    expect(r.stickers!.map((s) => [s.id, s.on])).toEqual([['S2', ['F001']], ['S3', ['F001']]]);
    expect(r.stickers![1]).toBe(p.stickers![2]); // untouched stickers keep their reference
    expect(r.deletedFrameIds).toEqual(['F002']); // the tombstone is unchanged
  });
  it('a project without edits expires exactly as before (no cut/stickers appear)', () => {
    const r = expireFrames(hideFrame(merged(boundProject(), 1, 2), 'F001', T0), T0 + 5000).project;
    expect('cut' in r).toBe(false);
    expect('stickers' in r).toBe(false);
  });
});

describe('project hide / unhide / expire', () => {
  it('hide -> pendingProjectDeletes, still in projects; unhide restores', () => {
    const { index } = newProject();
    const h = hideProject(index, PID, T0);
    expect(h.pendingProjectDeletes).toEqual([{ id: PID, deadline: '2026-10-27T10:00:05.000Z' }]);
    expect(h.projects).toHaveLength(1);
    expect(hideProject(h, PID, T0 + 1000)).toBe(h);
    expect(hideProject(index, 'nope', T0)).toBe(index);
    expect(unhideProject(h, PID).pendingProjectDeletes).toEqual([]);
  });
  it('unhide is refused once the deadline has passed (restart inside/after the window)', () => {
    const h = hideProject(newProject().index, PID, T0);
    expect(unhideProject(h, PID, T0 + 4999).pendingProjectDeletes).toEqual([]);
    expect(unhideProject(h, PID, T0 + 5000)).toBe(h);
    expect(unhideProject(h, PID, T0 + 60_000)).toBe(h);
  });
  it('expire -> deletedProjects, removed from projects, idempotent, only past the deadline', () => {
    const h = hideProject(newProject().index, PID, T0);
    expect(expireProjects(h, T0 + 4999)).toEqual({ index: h, expired: [] });
    const e = expireProjects(h, T0 + 5000);
    expect(e.expired).toEqual([PID]);
    expect(e.index).toMatchObject({ projects: [], pendingProjectDeletes: [], deletedProjects: [PID] });
    expect(expireProjects(e.index, T0 + 9000).expired).toEqual([]);
  });
});

describe('recoverProject', () => {
  const fmt = (ms: number) => `27.10.${new Date(ms).getUTCFullYear()}`;
  it('creates "Odzyskany <date>" bound to the current camera, rotation from FrameInfo, frame pending', () => {
    const r = recoverProject(emptyIndex(), info(7, { rotation: 180 }), { cameraId: CAM, nowMs: T0, formatDate: fmt });
    if (!r.ok) throw new Error(r.reason);
    expect(r.project).toMatchObject({ id: PID, name: 'Odzyskany 27.10.2026', cameraId: CAM });
    expect(r.project.geometry.rotation).toBe(180);
    expect(r.project.frames.map((f) => [f.frameId, f.state])).toEqual([['F007', 'pending']]);
    expect(r.index.projects).toEqual([{ id: PID, name: 'Odzyskany 27.10.2026', createdAt: '2026-10-27T10:00:00.000Z' }]);
  });
  it('refused for tombstoned, pending-delete, existing projects and a bad rotation', () => {
    const args = { cameraId: CAM, nowMs: T0, formatDate: fmt };
    const base = emptyIndex();
    expect(recoverProject({ ...base, deletedProjects: [PID] }, info(1), args)).toEqual({ ok: false, reason: 'tombstoned' });
    expect(recoverProject({ ...base, pendingProjectDeletes: [{ id: PID, deadline: 'x' }] }, info(1), args)).toEqual({ ok: false, reason: 'pending_delete' });
    expect(recoverProject(newProject().index, info(1), args)).toEqual({ ok: false, reason: 'exists' });
    expect(recoverProject(base, info(1, { rotation: 90 }), args)).toEqual({ ok: false, reason: 'bad_rotation' });
  });
});

describe('ackEligible: the table', () => {
  const ref = (id = 'F001', projectId = PID) => ({ frameId: id, projectId });
  const idx = (over: Partial<ProjectIndex> = {}): ProjectIndex => ({ ...newProject().index, ...over });

  it('pending frame -> NO', () => {
    expect(ackEligible(ref(), merged(boundProject(), 1), idx())).toBe(false);
  });
  it('local frame -> yes', () => {
    expect(ackEligible(ref(), setLocal(merged(boundProject(), 1), 'F001'), idx())).toBe(true);
  });
  it('local + hidden (Undo window) -> yes: files exist', () => {
    const p = hideFrame(setLocal(merged(boundProject(), 1), 'F001'), 'F001', T0);
    expect(ackEligible(ref(), p, idx())).toBe(true);
  });
  it('pending + hidden -> NO', () => {
    expect(ackEligible(ref(), hideFrame(merged(boundProject(), 1), 'F001', T0), idx())).toBe(false);
  });
  it('tombstoned frame (deletedFrameIds) -> yes, even if not in frames', () => {
    const p = { ...boundProject(), deletedFrameIds: ['F009'] };
    expect(ackEligible(ref('F009'), p, idx())).toBe(true);
  });
  it('expired frame -> yes', () => {
    const p = expireFrames(hideFrame(merged(boundProject(), 1), 'F001', T0), T0 + 5000).project;
    expect(ackEligible(ref(), p, idx())).toBe(true);
  });
  it('frame unknown to a live project -> NO', () => {
    expect(ackEligible(ref('F404'), boundProject(), idx())).toBe(false);
  });
  it('unknown project (no tombstone) -> NO', () => {
    expect(ackEligible(ref(), null, idx())).toBe(false);
    expect(ackEligible(ref('F001', 'other'), boundProject(), idx())).toBe(false);
  });
  it('project in deletedProjects -> yes, with or without a project object', () => {
    const i = idx({ deletedProjects: ['gone'] });
    expect(ackEligible(ref('F1', 'gone'), null, i)).toBe(true);
  });
  it('project in pendingProjectDeletes (Undo window) -> NO, for local and tombstoned frames too', () => {
    const p = { ...setLocal(merged(boundProject(), 1), 'F001'), deletedFrameIds: ['F009'] };
    const i = hideProject(idx(), PID, T0);
    expect(ackEligible(ref('F001'), p, i)).toBe(false);
    expect(ackEligible(ref('F009'), p, i)).toBe(false);
    expect(ackEligible(ref('F777'), null, i)).toBe(false);
  });
  it('after Undo the frames are eligible again; after expiry the project is eligible by tombstone', () => {
    const p = setLocal(merged(boundProject(), 1), 'F001');
    const hidden = hideProject(idx(), PID, T0);
    expect(ackEligible(ref(), p, unhideProject(hidden, PID))).toBe(true);
    const expired = expireProjects(hidden, T0 + 5000).index;
    expect(ackEligible(ref('F777'), null, expired)).toBe(true);
    expect(ackEligible(ref(), p, expired)).toBe(true);
  });
});

describe('validation: index.json / project.json v1', () => {
  const goodIndex = () => ({
    version: 1,
    clientId: 'c1',
    rememberedCamera: { cameraId: 'cam-A', host: '192.168.1.20', port: 8765 },
    projects: [{ id: PID, name: 'Film', createdAt: '2026-10-27T10:00:00.000Z' }],
    deletedProjects: ['d1'],
    pendingProjectDeletes: [{ id: 'p1', deadline: '2026-10-27T10:00:05.000Z' }],
  });
  const goodProject = () => ({
    version: 1,
    id: PID,
    name: 'Film',
    createdAt: '2026-10-27T10:00:00.000Z',
    fps: 8,
    geometry: { aspect: '4:3', rotation: 0 },
    cameraId: 'cam-A',
    frames: [
      { frameId: 'F1', seq: 1, bytes: 10, sha256: 'x', state: 'pending', hiddenUntil: null },
      { frameId: 'F2', seq: 2, bytes: 10, sha256: 'y', state: 'local', hiddenUntil: '2026-10-27T10:00:05.000Z', unavailable: { reason: 'r', since: 's' } },
    ],
    deletedFrameIds: ['F0'],
    outstanding: [{ reqId: 'r', cameraId: 'cam-A', sentAt: 's' }],
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ModelError);
      return `${(e as ModelError).code} ${(e as ModelError).path}`;
    }
    return 'no error';
  };

  it('accepts valid documents, round-trips through JSON', () => {
    expect(parseIndex(JSON.parse(JSON.stringify(goodIndex())))).toEqual(goodIndex());
    expect(parseProject(JSON.parse(JSON.stringify(goodProject())))).toEqual(goodProject());
    expect(parseIndex({ ...goodIndex(), rememberedCamera: null }).rememberedCamera).toBeNull();
  });
  it('accepts what the reducers produce', () => {
    const { index, project } = newProject();
    expect(parseIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
    const p = markUnavailable(merged(boundProject(), 1), 'F001', 'x', T0);
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
  });
  describe('cut and stickers', () => {
    const sticker = { id: 's1', emoji: '1F436', x: 0.5, y: 0.5, size: 0.3, rot: 15, on: ['F1', 'F2'] };
    it('absent -> undefined', () => {
      const p = parseProject(goodProject());
      expect(p.cut).toBeUndefined();
      expect(p.stickers).toBeUndefined();
      expect('cut' in p).toBe(false);
      expect('stickers' in p).toBe(false);
    });
    it('a valid round-trip', () => {
      const raw = { ...goodProject(), cut: [{ id: 'F1', frameId: 'F1', hold: 2 }, { id: 'U1', frameId: 'F1', hold: 1, off: true }], stickers: [sticker] };
      const p = parseProject(JSON.parse(JSON.stringify(raw)));
      expect(p.cut).toEqual(raw.cut);
      expect(p.stickers).toEqual(raw.stickers);
      expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    });
    it('a malformed entry is dropped, the rest survives', () => {
      const raw = {
        ...goodProject(),
        cut: [{ id: 'F1', frameId: 'F1', hold: 1 }, { id: '', frameId: 'F1', hold: 1 }, { id: 'a', hold: 1 }, { id: 'b', frameId: 'F2', hold: 'x' }, 7, null, { id: 'F2', frameId: 'F2', hold: 3, off: 'yes' }],
        stickers: [sticker, { ...sticker, id: 's2', emoji: 5 }, { ...sticker, id: 's3', on: 'F1' }, 'x'],
      };
      const p = parseProject(raw);
      expect(p.cut).toEqual([{ id: 'F1', frameId: 'F1', hold: 1 }, { id: 'F2', frameId: 'F2', hold: 3 }]);
      expect(p.stickers).toEqual([sticker]);
    });
    it('custom stickers: a valid my:<uuid> is kept, a malformed one is dropped and reported', () => {
      const ok = 'my:0123abcd-0123-4abc-8abc-0123456789ab';
      const raw = {
        ...goodProject(),
        stickers: [
          { ...sticker, id: 'c1', emoji: ok },
          { ...sticker, id: 'c2', emoji: 'my:../../x' },
          { ...sticker, id: 'c3', emoji: 'my:0123ABCD-0123-4abc-8abc-0123456789ab' },
          { ...sticker, id: 'c4', emoji: 'my:' },
        ],
      };
      const p = parseProject(raw);
      expect(p.stickers?.map((s) => s.emoji)).toEqual([ok]);
      expect(droppedEditFields(raw, p)).toEqual(['stickers']);
    });
    it('isCustomSticker / MY_STICKER_RE accept only my:<lowercase uuid>', () => {
      expect(isCustomSticker('my:0123abcd-0123-4abc-8abc-0123456789ab')).toBe(true);
      expect(isCustomSticker('1F436')).toBe(false);
      expect(isCustomSticker('my:0123abcd-0123-4abc-8abc-0123456789ab/../x')).toBe(false);
      expect(isCustomSticker('xmy:0123abcd-0123-4abc-8abc-0123456789ab')).toBe(false);
    });
    it('a malformed field -> undefined, the project stays readable', () => {
      const p = parseProject({ ...goodProject(), cut: 'nope', stickers: { a: 1 } });
      expect(p.cut).toBeUndefined();
      expect(p.stickers).toBeUndefined();
      expect(p.frames).toHaveLength(2);
    });
    it('clamps hold, size and position; non-string `on` members are dropped', () => {
      const p = parseProject({
        ...goodProject(),
        cut: [{ id: 'a', frameId: 'F1', hold: 99 }, { id: 'b', frameId: 'F1', hold: -3 }, { id: 'c', frameId: 'F1', hold: 2.6 }],
        stickers: [{ ...sticker, x: 9, y: -9, size: 5, on: ['F1', 3, ''] }, { ...sticker, id: 's2', size: 0 }],
      });
      expect(p.cut?.map((c) => c.hold)).toEqual([8, 1, 3]);
      expect(p.stickers?.[0]).toMatchObject({ x: 1.25, y: -0.25, size: 1, on: ['F1'] });
      expect(p.stickers?.[1].size).toBe(0.05);
    });
    it('droppedEditFields reports what the lenient parse lost, not clamps or absence', () => {
      const lossy = (raw: Record<string, unknown>) => droppedEditFields(raw, parseProject(raw));
      expect(lossy(goodProject())).toEqual([]);
      expect(lossy({ ...goodProject(), cut: 'nope' })).toEqual(['cut']);
      expect(lossy({ ...goodProject(), cut: null, stickers: { a: 1 } })).toEqual(['cut', 'stickers']);
      expect(lossy({ ...goodProject(), cut: [{ id: 'F1', frameId: 'F1', hold: 1 }, 7] })).toEqual(['cut']);
      expect(lossy({ ...goodProject(), stickers: [sticker, { ...sticker, id: 's2', emoji: 5 }] })).toEqual(['stickers']);
      expect(lossy({ ...goodProject(), cut: [{ id: 'a', frameId: 'F1', hold: 99 }], stickers: [{ ...sticker, size: 9 }] })).toEqual([]);
    });
    it('unknown keys on kept entries survive the parse', () => {
      const p = parseProject({
        ...goodProject(),
        cut: [{ id: 'a', frameId: 'F1', hold: 1, off: false, future: { x: 1 } }],
        stickers: [{ ...sticker, flip: true }],
      });
      expect(p.cut).toEqual([{ id: 'a', frameId: 'F1', hold: 1, future: { x: 1 } }]);
      expect(p.stickers?.[0]).toMatchObject({ ...sticker, flip: true });
    });
    it('a later duplicate id is dropped', () => {
      const p = parseProject({
        ...goodProject(),
        cut: [{ id: 'a', frameId: 'F1', hold: 1 }, { id: 'a', frameId: 'F2', hold: 4 }],
        stickers: [sticker, { ...sticker, x: 0.1 }],
      });
      expect(p.cut).toEqual([{ id: 'a', frameId: 'F1', hold: 1 }]);
      expect(p.stickers).toEqual([sticker]);
    });
  });
  it('unknown version -> unknown_version (future 2, 0, and a non-number is bad_type)', () => {
    expect(code(() => parseIndex({ ...goodIndex(), version: 2 }))).toBe('unknown_version index.version');
    expect(code(() => parseProject({ ...goodProject(), version: 0 }))).toBe('unknown_version project.version');
    expect(code(() => parseProject({ ...goodProject(), version: '1' }))).toBe('bad_type project.version');
  });
  it('missing fields -> missing_field with a path', () => {
    for (const k of ['version', 'clientId', 'rememberedCamera', 'projects', 'deletedProjects', 'pendingProjectDeletes']) {
      const d: Record<string, unknown> = goodIndex();
      delete d[k];
      expect(code(() => parseIndex(d))).toBe(`missing_field index.${k}`);
    }
    for (const k of ['id', 'createdAt', 'geometry', 'cameraId', 'frames', 'deletedFrameIds', 'outstanding']) {
      const d: Record<string, unknown> = goodProject();
      delete d[k];
      expect(code(() => parseProject(d))).toBe(`missing_field project.${k}`);
    }
    const f = goodProject();
    delete (f.frames[0] as Record<string, unknown>).sha256;
    expect(code(() => parseProject(f))).toBe('missing_field project.frames[0].sha256');
  });
  it('bad types -> bad_type / not_object', () => {
    expect(code(() => parseIndex(null))).toBe('not_object index');
    expect(code(() => parseIndex([]))).toBe('not_object index');
    expect(code(() => parseIndex({ ...goodIndex(), projects: {} }))).toBe('bad_type index.projects');
    expect(code(() => parseIndex({ ...goodIndex(), deletedProjects: [1] }))).toBe('bad_type index.deletedProjects[0]');
    expect(code(() => parseIndex({ ...goodIndex(), clientId: 5 }))).toBe('bad_type index.clientId');
    expect(code(() => parseProject({ ...goodProject(), geometry: { aspect: '4:3', rotation: 90 } }))).toBe('bad_type project.geometry.rotation');
    expect(code(() => parseProject({ ...goodProject(), geometry: { aspect: '16:9', rotation: 0 } }))).toBe('bad_type project.geometry.aspect');
    expect(code(() => parseProject({ ...goodProject(), cameraId: 3 }))).toBe('bad_type project.cameraId');
    const f = goodProject();
    (f.frames[0] as Record<string, unknown>).state = 'done';
    expect(code(() => parseProject(f))).toBe('bad_type project.frames[0].state');
    const g = goodProject();
    (g.frames[1] as Record<string, unknown>).seq = 1.5;
    expect(code(() => parseProject(g))).toBe('bad_type project.frames[1].seq');
  });
});

describe('review fixes: reducers/model', () => {
  it('setLocal clears a stale unavailable flag', () => {
    const p = markUnavailable(merged(boundProject(), 1), 'F001', 'http 404', T0);
    expect(p.frames[0]!.unavailable).toBeDefined();
    const l = setLocal(p, 'F001');
    expect(l.frames[0]!.state).toBe('local');
    expect(l.frames[0]!.unavailable).toBeUndefined();
  });

  it('beginCapture persists geometryFrozen; it survives dropping the outstanding entry', () => {
    const b = beginCapture(newProject().project, { reqId: 'r1', cameraId: CAM, nowMs: T0 });
    if (!b.ok) throw new Error('x');
    expect(b.project.geometryFrozen).toBe(true);
    const dropped = removeOutstanding(b.project, 'r1');
    expect(dropped.outstanding).toEqual([]);
    expect(isGeometryFrozen(dropped)).toBe(true);
    expect(setRotation(dropped, 180)).toBe(dropped);
    expect(parseProject(JSON.parse(JSON.stringify(dropped))).geometryFrozen).toBe(true);
    expect(isGeometryFrozen(newProject().project)).toBe(false);
    expect('geometryFrozen' in parseProject(JSON.parse(JSON.stringify(newProject().project)))).toBe(false);
  });

  it('parseProject is lenient for non-critical fields (fps, name) and strict for ids/frames/state', () => {
    const raw = JSON.parse(JSON.stringify(newProject().project));
    expect(parseProject({ ...raw, fps: 7 }).fps).toBe(8);
    expect(parseProject({ ...raw, fps: 'fast' }).fps).toBe(8);
    const { fps: _f, ...noFps } = raw;
    expect(parseProject(noFps).fps).toBe(8);
    expect(parseProject({ ...raw, name: 5 }).name).toBe('');
    expect(() => parseProject({ ...raw, id: '' })).toThrow(ModelError);
    expect(() => parseProject({ ...raw, frames: [{ frameId: 'a', seq: 1, bytes: 1, sha256: 'x', state: 'weird', hiddenUntil: null }] })).toThrow(ModelError);
  });
});
