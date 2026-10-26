// Unit tests for the pure remote-lite modules (the remote-core ones are tested in packages/remote-core).
// Run: cd camera-android/core/src/test/remote-lite && node --test   (Node >= 22.15, no dependencies;
// imports.test.mjs there needs `./gradlew-jbr :core:processResources` first)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { L, LIB_DIR, CORE_SRC_DIR } from './paths.mjs';

const store = await import(L('store.js'));
const { pickLang, makeTranslator, STRINGS } = await import(L('i18n.js'));
const video = await import(L('video.js'));

function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('store: create, list newest first, rename, fps clamp, save/load round trip', () => {
  const s = store.emptyState();
  const a = store.createProject(s, { id: 'a', now: 1000, name: 'A' });
  store.createProject(s, { id: 'b', now: 2000, name: 'B' });
  assert.deepEqual(store.listProjects(s).map((p) => p.id), ['b', 'a']);
  assert.equal(a.fps, 8);
  assert.equal(store.renameProject(a, '  Smok  '), 'Smok');
  assert.equal(store.renameProject(a, '   '), 'Smok', 'empty name is ignored');
  assert.equal(store.setFps(a, 30), 12);
  assert.equal(store.setFps(a, 1), 4);
  assert.equal(store.setFps(a, 'x'), 8);
  const st = memStorage();
  assert.ok(store.saveState(st, s));
  assert.deepEqual(store.loadState(st), s);
  assert.deepEqual(store.loadState(memStorage()), store.emptyState());
  st.setItem(store.STORAGE_KEY, '{broken');
  assert.deepEqual(store.loadState(st), store.emptyState());
});

test('store: insertFrame orders by seq, is idempotent, binds rotation/camera once', () => {
  const s = store.emptyState();
  const p = store.createProject(s, { id: 'p', now: 0, name: 'P' });
  assert.ok(store.insertFrame(p, { frameId: 'f3', seq: 3, rotation: 180, cameraId: 'cam' }));
  assert.ok(store.insertFrame(p, { frameId: 'f1', seq: 1, rotation: 0 }));
  assert.ok(store.insertFrame(p, { frameId: 'f2', seq: 2 }));
  assert.equal(store.insertFrame(p, { frameId: 'f2', seq: 2 }), false);
  assert.equal(store.insertFrame(p, { frameId: 'x' }), false, 'no seq');
  assert.deepEqual(p.frames.map((f) => f.frameId), ['f1', 'f2', 'f3']);
  assert.equal(p.rotation, 180);
  assert.equal(p.cameraId, 'cam');
  assert.equal(store.captureRotation(p, 0), 180);
  assert.equal(store.captureRotation(store.createProject(s, { id: 'e', now: 0, name: 'E' }), 0), 0);
});

test('store: hide/unhide keeps position; tombstoned frames are never re-added', () => {
  const s = store.emptyState();
  const p = store.createProject(s, { id: 'p', now: 0, name: 'P' });
  for (const n of [1, 2, 3]) store.insertFrame(p, { frameId: `f${n}`, seq: n });
  assert.ok(store.hideFrame(p, 'f2'));
  assert.equal(store.hideFrame(p, 'f2'), false);
  assert.deepEqual(store.visibleFrames(p).map((f) => f.frameId), ['f1', 'f3']);
  assert.equal(store.insertFrame(p, { frameId: 'f2', seq: 2 }), false);
  assert.ok(store.unhideFrame(p, 'f2'));
  assert.deepEqual(store.visibleFrames(p).map((f) => f.frameId), ['f1', 'f2', 'f3']);
  store.hideFrame(p, 'f3');
  assert.equal(store.lastVisibleFrame(p).frameId, 'f2');
});

test('store: mergeListedFrames fills gaps, recovers unknown projects, skips trashed ones', () => {
  const s = store.emptyState();
  const known = store.createProject(s, { id: 'known', now: 0, name: 'K' });
  store.insertFrame(known, { frameId: 'f1', seq: 1 });
  store.insertFrame(known, { frameId: 'f3', seq: 3 });
  store.hideFrame(known, 'f3');
  const gone = store.createProject(s, { id: 'gone', now: 0, name: 'G' });
  store.trashProject(s, 'gone', 10);
  const listed = [
    { frameId: 'f1', seq: 1, projectId: 'known' },
    { frameId: 'f2', seq: 2, projectId: 'known', rotation: 0 },
    { frameId: 'f3', seq: 3, projectId: 'known' },
    { frameId: 'g1', seq: 4, projectId: 'gone' },
    { frameId: 'u1', seq: 5, projectId: 'lost', capturedAt: '2026-10-26T15:04:05.123Z', rotation: 180 },
    { frameId: 'u2', seq: 6, projectId: 'lost' },
  ];
  const r = store.mergeListedFrames(s, listed, { now: 99, cameraId: 'cam', recoveredName: () => 'Odzyskany film' });
  assert.equal(r.added, 3);
  assert.deepEqual(r.recovered, ['lost']);
  assert.deepEqual(known.frames.map((f) => f.frameId), ['f1', 'f2', 'f3']);
  assert.deepEqual(store.visibleFrames(known).map((f) => f.frameId), ['f1', 'f2']);
  assert.equal(gone.frames.length, 0);
  const lost = store.findProject(s, 'lost');
  assert.equal(lost.recovered, true);
  assert.equal(lost.name, 'Odzyskany film');
  assert.equal(lost.createdAt, Date.parse('2026-10-26T15:04:05.123Z'));
  assert.equal(lost.rotation, 180);
  assert.equal(lost.cameraId, 'cam');
  assert.equal(store.mergeListedFrames(s, listed, { now: 99, recoveredName: () => 'x' }).added, 0, 'idempotent');
});

test('store: trash / restore / purge keeps the tombstone', () => {
  const s = store.emptyState();
  const p = store.createProject(s, { id: 'p', now: 0, name: 'P' });
  store.insertFrame(p, { frameId: 'f1', seq: 1 });
  assert.ok(store.trashProject(s, 'p', 100));
  assert.deepEqual(store.listProjects(s), []);
  assert.ok(store.restoreProject(s, 'p'));
  assert.equal(store.listProjects(s).length, 1);
  store.trashProject(s, 'p', 100);
  assert.equal(store.purgeTrashed(s, 4000), 0, 'still inside the undo window');
  assert.equal(store.purgeTrashed(s, 5100), 1);
  assert.equal(p.frames.length, 0);
  assert.equal(store.findProject(s, 'p').trashed, true);
});

test('i18n: language pick, plurals, params, every key in both languages', () => {
  assert.equal(pickLang(['ru-RU', 'en']), 'ru');
  assert.equal(pickLang(['en-US', 'pl-PL']), 'pl');
  assert.equal(pickLang(['en-US']), 'pl');
  assert.equal(pickLang('ru'), 'ru');
  assert.equal(pickLang(undefined), 'pl');
  const pl = makeTranslator('pl');
  const ru = makeTranslator('ru');
  assert.equal(pl('frames', { n: 1 }), '1 klatka');
  assert.equal(pl('frames', { n: 3 }), '3 klatki');
  assert.equal(pl('frames', { n: 5 }), '5 klatek');
  assert.equal(pl('frames', { n: 22 }), '22 klatki');
  assert.equal(ru('frames', { n: 1 }), '1 кадр');
  assert.equal(ru('frames', { n: 3 }), '3 кадра');
  assert.equal(ru('frames', { n: 11 }), '11 кадров');
  assert.equal(pl('saving', { i: 12, n: 80 }), 'Zapisuję… 12/80');
  assert.equal(pl('offline'), 'Kamera offline, łączę ponownie…');
  assert.equal(pl('busy'), 'Kamera jest używana przez inne urządzenie');
  assert.equal(pl('nope'), 'nope');
  assert.deepEqual(Object.keys(STRINGS.ru).sort(), Object.keys(STRINGS.pl).sort());
});

test('video: mime pick order, extension, file name, schedule, fit, ring', () => {
  assert.equal(video.pickMimeType(() => true), 'video/mp4;codecs=avc1.640028');
  assert.equal(video.pickMimeType((m) => m.startsWith('video/webm')), 'video/webm;codecs=vp9');
  assert.equal(video.pickMimeType((m) => m === 'video/webm'), 'video/webm');
  assert.equal(video.pickMimeType(() => { throw new Error('x'); }), '');
  assert.equal(video.extensionFor('video/mp4;codecs=avc1.640028'), 'mp4');
  assert.equal(video.extensionFor('video/webm'), 'webm');
  assert.equal(video.formatLabel('video/webm;codecs=vp9'), 'WEBM (vp9)');
  assert.equal(video.safeFileName('26 paź 2026, 15:04', 'mp4'), '26 paź 2026, 15 04.mp4');
  assert.ok(!video.safeFileName('../..', 'webm').startsWith('.'));
  assert.equal(video.safeFileName('', 'webm'), 'film.webm');
  const s = video.buildSchedule(['a', 'b', 'c'], 8);
  assert.deepEqual(s.steps.map((x) => [x.frameId, x.extra]), [['a', false], ['b', false], ['c', false], ['c', true]]);
  assert.equal(s.steps[0].holdMs, 125);
  assert.equal(s.totalMs, 500);
  assert.deepEqual(video.buildSchedule([], 8).steps, []);
  assert.deepEqual(video.fitRect(640, 480, 1440, 1080), { x: 0, y: 0, w: 1440, h: 1080 });
  assert.deepEqual(video.fitRect(1920, 1080, 1440, 1080), { x: 0, y: 135, w: 1440, h: 810 });
  assert.deepEqual(video.ringWindow(6, 8, 4), [6, 7, 0, 1]);
  assert.deepEqual(video.ringWindow(0, 3, 8), [0, 1, 2]);
  assert.deepEqual(video.ringWindow(0, 0, 8), []);
});

test('lib/ and remote-core share no file names (the build merges both into remote-lite/lib/)', () => {
  const lib = readdirSync(LIB_DIR).filter((n) => n.endsWith('.js'));
  const core = readdirSync(CORE_SRC_DIR).filter((n) => n.endsWith('.js'));
  assert.ok(core.includes('protocol.js') && core.includes('i18n-core.js'), 'remote-core src found');
  assert.deepEqual(lib.filter((n) => core.includes(n)), []);
});
