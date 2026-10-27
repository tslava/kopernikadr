// Dev script: copies the curated OpenMoji subset (openmoji-list.json) from the `openmoji` package
// into remote/public/openmoji/ (SVGs + catalog.json + LICENSE.txt). The output is committed, so the
// app build does not need the package. Run: `npm run openmoji` from remote/.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HEX = /^[0-9A-F]{4,6}(-[0-9A-F]{4,6})*$/;

/** Validates the curated list and returns it as-is. Throws on the first problem. */
export function validateList(list) {
  if (!list || !Array.isArray(list.categories) || list.categories.length === 0) throw new Error('list: categories missing');
  const ids = new Set();
  const seen = new Set();
  for (const c of list.categories) {
    if (typeof c.id !== 'string' || !c.id) throw new Error('list: category without id');
    if (ids.has(c.id)) throw new Error(`list: duplicate category ${c.id}`);
    ids.add(c.id);
    if (typeof c.name?.pl !== 'string' || typeof c.name?.ru !== 'string' || !c.name.pl || !c.name.ru) throw new Error(`list: category ${c.id} needs name.pl and name.ru`);
    if (!Array.isArray(c.hexcodes) || c.hexcodes.length === 0) throw new Error(`list: category ${c.id} is empty`);
    for (const h of c.hexcodes) {
      if (typeof h !== 'string' || !HEX.test(h)) throw new Error(`list: bad hexcode ${JSON.stringify(h)} in ${c.id}`);
      if (seen.has(h)) throw new Error(`list: duplicate hexcode ${h}`);
      seen.add(h);
    }
  }
  return list;
}

/**
 * Copies `<srcDir>/<hex>.svg` for every listed hexcode into `outDir`, writes catalog.json and
 * LICENSE.txt. Stale .svg files in `outDir` are removed first. Output depends only on the inputs.
 * @returns {{ count: number, bytes: number }}
 */
export function buildSubset({ list, srcDir, licensePath, outDir }) {
  validateList(list);
  const hexcodes = list.categories.flatMap((c) => c.hexcodes);
  const missing = hexcodes.filter((h) => !fs.existsSync(path.join(srcDir, `${h}.svg`)));
  if (missing.length > 0) throw new Error(`missing in OpenMoji color set: ${missing.join(', ')}`);
  if (!fs.existsSync(licensePath)) throw new Error(`license not found: ${licensePath}`);

  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.svg')) fs.rmSync(path.join(outDir, f));
  let bytes = 0;
  for (const h of hexcodes) {
    const svg = fs.readFileSync(path.join(srcDir, `${h}.svg`));
    bytes += svg.length;
    fs.writeFileSync(path.join(outDir, `${h}.svg`), svg);
  }
  const catalog = {
    version: 1,
    categories: list.categories.map((c) => ({ id: c.id, name: { pl: c.name.pl, ru: c.name.ru }, hexcodes: [...c.hexcodes] })),
  };
  fs.writeFileSync(path.join(outDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  fs.copyFileSync(licensePath, path.join(outDir, 'LICENSE.txt'));
  return { count: hexcodes.length, bytes };
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgDir = path.dirname(createRequire(import.meta.url).resolve('openmoji/package.json'));
  const list = JSON.parse(fs.readFileSync(path.join(here, 'openmoji-list.json'), 'utf8'));
  const { count, bytes } = buildSubset({
    list,
    srcDir: path.join(pkgDir, 'color', 'svg'),
    licensePath: path.join(pkgDir, 'LICENSE.txt'),
    outDir: path.join(here, '..', 'public', 'openmoji'),
  });
  console.log(`openmoji: ${count} SVGs, ${(bytes / 1024).toFixed(0)} KiB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`openmoji: ${e.message}`);
    process.exit(1);
  }
}
