// Regression gate for the shipped remote-lite: the merged output dir of
// `./gradlew-jbr :core:processResources` (remote-lite sources + packages/remote-core/src copied into
// remote-lite/lib/), i.e. exactly what the camera serves from the classpath and the APK contains.
//
// Needs the build first:  cd camera-android && ./gradlew-jbr :core:processResources
// Run:                    cd camera-android/core/src/test/remote-lite && node --test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { BUILT_REMOTE_LITE_DIR as BUILT, REMOTE_LITE_DIR, CORE_SRC_DIR, FAKE_CAMERA } from './paths.mjs';
import { specifiers } from '../../../../../packages/remote-core/test/specifiers.mjs';

const MISSING = `${BUILT} not found — build it first: cd camera-android && ./gradlew-jbr :core:processResources`;

before(() => {
  if (!existsSync(join(BUILT, 'index.html'))) throw new Error(MISSING);
});

/** Files under `dir`, as paths relative to it. */
function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p)];
  });
}

const modules = () => ['app.js', ...readdirSync(join(BUILT, 'lib')).filter((n) => n.endsWith('.js')).map((n) => `lib/${n}`)];

test('the build output is current: every source file is there, byte for byte', () => {
  const expected = [
    ...walk(REMOTE_LITE_DIR).map((rel) => [rel, join(REMOTE_LITE_DIR, rel)]),
    ...readdirSync(CORE_SRC_DIR).filter((n) => n.endsWith('.js')).map((n) => [`lib/${n}`, join(CORE_SRC_DIR, n)]),
  ];
  const stale = expected.filter(([rel, src]) => {
    const out = join(BUILT, rel);
    return !existsSync(out) || !readFileSync(out).equals(readFileSync(src));
  }).map(([rel]) => rel);
  assert.deepEqual(stale, [], `stale or missing in the build output — rerun :core:processResources`);
  assert.deepEqual(walk(BUILT).sort(), expected.map(([rel]) => rel).sort(), 'no extra files in the build output');
});

test('every import of app.js and lib/*.js is a relative ./x.js that exists in the merged dir', () => {
  const mods = modules();
  assert.ok(mods.includes('lib/protocol.js') && mods.includes('lib/media.js') && mods.includes('lib/i18n-core.js'), 'both roots merged');
  const problems = [];
  let count = 0;
  for (const mod of mods) {
    for (const spec of specifiers(readFileSync(join(BUILT, mod), 'utf8'))) {
      count++;
      if (!/^\.\.?\//.test(spec) || !spec.endsWith('.js')) {
        problems.push(`${mod}: "${spec}" is not a relative .js import (browsers load these unbundled)`);
        continue;
      }
      const target = resolve(dirname(join(BUILT, mod)), spec);
      if (!target.startsWith(BUILT) || !existsSync(target) || !statSync(target).isFile()) {
        problems.push(`${mod}: "${spec}" does not resolve in the merged dir`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(count >= 20, `found ${count} imports`);
});

test('index.html references (script, stylesheet, icons) exist in the merged dir', () => {
  const html = readFileSync(join(BUILT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)="([^"#?:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.includes('app.js'), 'the page loads app.js');
  for (const ref of refs) assert.ok(existsSync(join(BUILT, ref)), `index.html → ${ref}`);
});

test('fake camera serves the merged remote-lite page and modules from both roots', async () => {
  const { startFakeCamera, loadFakeImages } = await import(FAKE_CAMERA);
  const cam = await startFakeCamera({ images: loadFakeImages(), replaceSessions: true, rotation: 0, serveDir: BUILT });
  try {
    const html = await fetch(`http://${cam.host}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<script type="module" src="app\.js"><\/script>/);
    for (const path of ['/lib/store.js', '/lib/protocol.js', '/lib/i18n-core.js']) {
      const js = await fetch(`http://${cam.host}${path}`);
      assert.equal(js.status, 200, path);
      assert.match(js.headers.get('content-type'), /javascript/, path);
      await js.arrayBuffer();
    }
    assert.equal((await fetch(`http://${cam.host}/..%2f..%2fbuild.gradle.kts`)).status, 404);
  } finally {
    await cam.close();
  }
});
