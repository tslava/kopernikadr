import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, projectFrames, expectedGalleryName, pickPage, expectedDurationS, newestGalleryRow } from './lib.mjs';

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
