// remote-core is loaded unbundled by browsers (remote-lite gets a copy of src/*.js in its lib/),
// so its modules may import only each other by a relative `./x.js` path: no bare specifiers
// (`foo`, `@scope/foo`), no `node:` built-ins, no subdirectories, no `../`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_DIR } from './support.mjs';
import { specifiers } from './specifiers.mjs';

const RELATIVE_SIBLING = /^\.\/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.js$/;

const sources = () => readdirSync(SRC_DIR).filter((n) => n.endsWith('.js')).sort();

test('specifier scan finds every import form (self-check)', () => {
  const code = [
    "import { a } from './a.js';",
    "import * as b from 'b-pkg';",
    "export { c } from \"node:fs\";",
    "import './side.js';",
    'const d = await import(`@scope/d`);',
    "// import { x } from 'commented-out';",
  ].join('\n');
  assert.deepEqual(specifiers(code).sort(), ['./a.js', './side.js', '@scope/d', 'b-pkg', 'node:fs']);
});

test('src/ holds only flat .js modules', () => {
  const entries = readdirSync(SRC_DIR, { withFileTypes: true });
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.ok(e.isFile() && e.name.endsWith('.js'), `unexpected entry in src/: ${e.name}`);
  }
});

test('remote-core modules import only sibling ./x.js files that exist', () => {
  for (const name of sources()) {
    const code = readFileSync(join(SRC_DIR, name), 'utf8');
    for (const spec of specifiers(code)) {
      assert.match(spec, RELATIVE_SIBLING, `${name}: "${spec}" is not a relative ./x.js import`);
      assert.ok(existsSync(join(SRC_DIR, spec)), `${name}: "${spec}" does not exist in src/`);
    }
    assert.doesNotMatch(code, /\brequire\s*\(/, `${name}: CommonJS require()`);
    assert.doesNotMatch(code, /\bprocess\.|\bBuffer\b/, `${name}: Node-only globals`);
  }
});

test('the package exports every module as @kopernikadr/remote-core/<name>', async () => {
  for (const name of sources()) {
    const sub = name.replace(/\.js$/, '');
    const mod = await import(`@kopernikadr/remote-core/${sub}`);
    const direct = await import(new URL(`../src/${name}`, import.meta.url).href);
    assert.equal(mod, direct, `${sub} resolves to src/${name}`);
  }
});
