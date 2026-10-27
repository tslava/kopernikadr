import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, projectFrames, expectedGalleryName, pickPage } from './lib.mjs';

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
