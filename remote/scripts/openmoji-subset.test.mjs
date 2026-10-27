import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildSubset, validateList } from './openmoji-subset.mjs';

const cat = (id, hexcodes) => ({ id, name: { pl: `${id}-pl`, ru: `${id}-ru` }, hexcodes });

function fixture(svgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmoji-'));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir);
  for (const h of svgs) fs.writeFileSync(path.join(srcDir, `${h}.svg`), `<svg id="${h}"/>`);
  const licensePath = path.join(dir, 'LICENSE.txt');
  fs.writeFileSync(licensePath, 'CC BY-SA 4.0');
  return { srcDir, licensePath, outDir: path.join(dir, 'out') };
}

test('copies listed SVGs, writes catalog and license', () => {
  const f = fixture(['1F436', '1F431', '2600-FE0F', '1F600']);
  const list = { categories: [cat('animals', ['1F436', '1F431']), cat('nature', ['2600-FE0F'])] };
  const r = buildSubset({ list, ...f });
  assert.equal(r.count, 3);
  assert.deepEqual(fs.readdirSync(f.outDir).sort(), ['1F431.svg', '1F436.svg', '2600-FE0F.svg', 'LICENSE.txt', 'catalog.json']);
  assert.equal(fs.readFileSync(path.join(f.outDir, '1F436.svg'), 'utf8'), '<svg id="1F436"/>');
  assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSE.txt'), 'utf8'), 'CC BY-SA 4.0');
  const catalog = JSON.parse(fs.readFileSync(path.join(f.outDir, 'catalog.json'), 'utf8'));
  assert.deepEqual(catalog, {
    version: 1,
    categories: [
      { id: 'animals', name: { pl: 'animals-pl', ru: 'animals-ru' }, hexcodes: ['1F436', '1F431'] },
      { id: 'nature', name: { pl: 'nature-pl', ru: 'nature-ru' }, hexcodes: ['2600-FE0F'] },
    ],
  });
});

test('a missing hexcode fails loudly and names it', () => {
  const f = fixture(['1F436']);
  const list = { categories: [cat('animals', ['1F436', '1F431', '1F42D'])] };
  assert.throws(() => buildSubset({ list, ...f }), /missing.*1F431, 1F42D/);
});

test('output is deterministic and stale SVGs are removed', () => {
  const f = fixture(['1F436', '1F431']);
  const list = { categories: [cat('animals', ['1F436', '1F431'])] };
  buildSubset({ list, ...f });
  fs.writeFileSync(path.join(f.outDir, '1F999.svg'), 'stale');
  const first = fs.readFileSync(path.join(f.outDir, 'catalog.json'), 'utf8');
  buildSubset({ list, ...f });
  assert.equal(fs.readFileSync(path.join(f.outDir, 'catalog.json'), 'utf8'), first);
  assert.equal(fs.existsSync(path.join(f.outDir, '1F999.svg')), false);
});

test('validateList rejects bad lists', () => {
  assert.throws(() => validateList({}), /categories/);
  assert.throws(() => validateList({ categories: [cat('a', ['1f436'])] }), /bad hexcode/);
  assert.throws(() => validateList({ categories: [cat('a', ['1F436']), cat('b', ['1F436'])] }), /duplicate hexcode/);
  assert.throws(() => validateList({ categories: [cat('a', ['1F436']), cat('a', ['1F431'])] }), /duplicate category/);
  assert.throws(() => validateList({ categories: [{ id: 'a', name: { pl: 'x' }, hexcodes: ['1F436'] }] }), /name\.pl and name\.ru/);
  assert.throws(() => validateList({ categories: [cat('a', [])] }), /empty/);
});

test('the committed list is valid, kid-safe in size and every SVG is in public/openmoji', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const list = JSON.parse(fs.readFileSync(path.join(here, 'openmoji-list.json'), 'utf8'));
  validateList(list);
  assert.equal(list.categories.length, 8);
  const n = list.categories.reduce((s, c) => s + c.hexcodes.length, 0);
  assert.ok(n >= 150 && n <= 300, `about 200 emoji, got ${n}`);
  for (const c of list.categories) for (const h of c.hexcodes) assert.ok(fs.existsSync(path.join(here, '..', 'public', 'openmoji', `${h}.svg`)), h);
});
