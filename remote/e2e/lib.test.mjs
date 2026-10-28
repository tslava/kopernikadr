import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, projectFrames, expectedGalleryName, pickPage, expectedDurationS, newestGalleryRow, parseStickerArgs, assertTestProject, myStickers, pointInRect, containRect, movieStickerFile, newStickerId, parseLibraryIndex, singleNewIndexId, ownTileUnique } from './lib.mjs';

test('parseArgs', () => {
  const a = parseArgs(['--devtools', '9222', '--adb-restart', 'adb x', '--camera', 'http://h:1/']);
  assert.deepEqual([a.devtools, a.camera, a.adbRestart, a.reforward], ['9222', 'http://h:1', 'adb x', null]);
  assert.throws(() => parseArgs(['--adb-restart', 'x']));
  assert.throws(() => parseArgs(['--devtools', 'x', '--adb-restart', 'x']));
  assert.throws(() => parseArgs(['--devtools', '1', '--adb-restart']));
});

test('projectFrames', () => {
  const s = { frames: [{ projectId: 'a', acked: true }, { projectId: 'a', acked: false }, { projectId: 'b', acked: true }] };
  assert.deepEqual(projectFrames(s, 'a'), { total: 2, acked: 1 });
  assert.deepEqual(projectFrames({}, 'a'), { total: 0, acked: 0 });
});

test('expectedGalleryName', () => {
  assert.equal(expectedGalleryName('Film 3', new Date(2026, 9, 27)), 'kopernikadr-Film_3-2026-10-27.mp4');
});

test('pickPage', () => {
  assert.equal(pickPage([{ type: 'service_worker', webSocketDebuggerUrl: 'x' }]), null);
  const list = [
    { type: 'page', url: 'https://a', webSocketDebuggerUrl: 'w1' },
    { type: 'page', url: 'http://localhost/', webSocketDebuggerUrl: 'w2' },
  ];
  assert.equal(pickPage(list).webSocketDebuggerUrl, 'w2');
});

test('expectedDurationS', () => {
  assert.equal(expectedDurationS([{ hold: 1 }, { hold: 4 }, { hold: 3, off: true }, { hold: 1 }], 8), 6 / 8);
  assert.equal(expectedDurationS([], 8), 0);
  assert.equal(expectedDurationS([{ hold: 2, off: true }], 4), 0);
});

test('newestGalleryRow', () => {
  const out = [
    'Row: 0 _id=10, _display_name=kopernikadr-Film_3-2026-10-27.mp4, _data=/storage/emulated/0/Movies/a.mp4, duration=1000',
    'Row: 1 _id=12, _display_name=kopernikadr-Film_3-2026-10-27 (1).mp4, _data=/storage/emulated/0/Movies/b.mp4, duration=2000',
    'Row: 2 _id=13, _display_name=other.mp4, _data=/x, duration=5',
  ].join('\n');
  assert.deepEqual(newestGalleryRow(out, 'kopernikadr-Film_3-'), { id: 12, name: 'kopernikadr-Film_3-2026-10-27 (1).mp4', data: '/storage/emulated/0/Movies/b.mp4', durationMs: 2000 });
  assert.equal(newestGalleryRow(out, 'nope'), null);
});

test('parseArgs adb options', () => {
  const a = parseArgs(['--devtools', '1', '--adb-restart', 'x', '--adb', 'adb -s e', '--package', 'p']);
  assert.deepEqual([a.adb, a.pkg], ['adb -s e', 'p']);
});

const PID = '2e949ac9-32fc-4128-9e5f-c8116396f7fa';

test('parseStickerArgs', () => {
  const a = parseStickerArgs(['--devtools', '9222', '--project', PID, '--photo', '/sdcard/Download/toy.jpg', '--toy', '0.4,0.6']);
  assert.deepEqual(a.toy, { x: 0.4, y: 0.6 });
  assert.equal(a.png, null);
  assert.throws(() => parseStickerArgs(['--devtools', '9222', '--photo', '/x']), /--project/);
  assert.throws(() => parseStickerArgs(['--devtools', '9222', '--project', 'Film 3', '--photo', '/x']), /--project/);
  assert.throws(() => parseStickerArgs(['--devtools', '9222', '--project', PID, '--photo', 'x']), /--photo/);
  assert.throws(() => parseStickerArgs(['--devtools', '9222', '--project', PID, '--photo', '/x', '--toy', '2,0']), /--toy/);
});

test('assertTestProject', () => {
  assertTestProject({ id: PID, name: 'Test sticky' }, PID);
  assert.throws(() => assertTestProject({ id: PID, name: 'Film 2' }, PID), /not named/);
  assert.throws(() => assertTestProject({ id: 'other', name: 'Test x' }, PID), /not the requested/);
  assert.throws(() => assertTestProject(null, PID));
});

test('myStickers, pointInRect, movieStickerFile', () => {
  const u = '11111111-2222-3333-4444-555555555555';
  const s = myStickers({ stickers: [{ emoji: '1F436' }, { emoji: `my:${u}` }] });
  assert.equal(s.length, 1);
  assert.equal(s[0].uuid, u);
  assert.deepEqual(myStickers({}), []);
  assert.deepEqual(pointInRect({ left: 10, top: 20, width: 100, height: 50 }, 0.5, 0.2), { x: 60, y: 30 });
  assert.equal(movieStickerFile(PID, u), `files/kopernikadr/projects/${PID}/stickers/${u}.webp`);
});

test('newStickerId finds only the sticker made by the run', () => {
  assert.equal(newStickerId(['a', 'b'], ['a', 'b']), null); // the old tiles behind a still-saving maker
  assert.equal(newStickerId([], []), null);
  assert.equal(newStickerId(['a', 'b'], ['c', 'a', 'b']), 'c');
  assert.equal(newStickerId([], ['c']), 'c');
  assert.throws(() => newStickerId(['a'], ['x', 'y', 'a']), /more than one/);
});

test('parseLibraryIndex: absent file is empty, garbage aborts', () => {
  assert.deepEqual(parseLibraryIndex(null), []);
  assert.deepEqual(parseLibraryIndex(JSON.stringify({ v: 1, items: [{ id: 'a' }, { id: 'b' }] })), ['a', 'b']);
  assert.throws(() => parseLibraryIndex(''));
  assert.throws(() => parseLibraryIndex('{oops'));
  assert.throws(() => parseLibraryIndex('{"v":1}'));
  assert.throws(() => parseLibraryIndex('{"items":[{"id":1}]}'));
  assert.throws(() => parseLibraryIndex('{"items":[null]}'));
});

test('singleNewIndexId: exactly one new id', () => {
  assert.equal(singleNewIndexId(['a'], ['n', 'a']), 'n');
  assert.equal(singleNewIndexId([], ['n']), 'n');
  assert.throws(() => singleNewIndexId(['a'], ['a']));
  assert.throws(() => singleNewIndexId(['a'], ['a', 'x', 'y']));
  assert.throws(() => singleNewIndexId(['a', 'b'], ['a']));
});

test('ownTileUnique: only an exact, single id match is deletable', () => {
  assert.equal(ownTileUnique([{ id: 'x' }, { id: 'n' }], 'n'), true);
  assert.equal(ownTileUnique([{ id: 'x' }], 'n'), false);
  assert.equal(ownTileUnique([{ id: 'n' }, { id: 'n' }], 'n'), false);
  assert.equal(ownTileUnique([{ id: 'n1' }], 'n'), false);
  assert.equal(ownTileUnique([{ id: 'n' }], null), false);
  assert.equal(ownTileUnique([], ''), false);
});

test('containRect letterboxes portrait and landscape images', () => {
  const box = { left: 10, top: 20, width: 200, height: 100 };
  assert.deepEqual(containRect(box, 100, 200), { left: 85, top: 20, width: 50, height: 100 });
  assert.deepEqual(containRect(box, 400, 100), { left: 10, top: 45, width: 200, height: 50 });
  assert.deepEqual(containRect(box, 0, 0), box);
});
