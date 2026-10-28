#!/usr/bin/env node
// Photo-sticker E2E on a real tablet (plan "Photo stickers", Task 10), driven over Chrome DevTools Protocol.
// No dependencies, Node >= 22. See README.md. Works on ONE agent-created test movie (name starts with "Test")
// whose id is passed explicitly; it needs at least 1 frame. Never touches any other movie.
//
//   adb -s <serial> push toy.jpg /sdcard/Download/toy.jpg      # a portrait photo of a toy on a plain background
//   adb -s <serial> push alpha.png /sdcard/Download/alpha.png  # optional: a transparent PNG (skips the cut)
//   PID=$(adb -s <serial> shell pidof pl.slava.kopernikadr.remote.debug)
//   adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_$PID
//   node remote/e2e/stickers.cdp.mjs --devtools 9222 --adb "adb -s <serial>" --project <uuid> \
//     --photo /sdcard/Download/toy.jpg --toy 0.5,0.55 [--png /sdcard/Download/alpha.png]
//
// The system picker is replaced by the debug-only `__testImportImage`: the script redirects the
// plugin call `pickImage` to it (Capacitor.nativePromise wrapper in the page), so the "Z galerii" button is
// the real UI path. Prints PASS/FAIL per step and a JSON summary; exit code 1 on any FAIL.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { assertTestProject, movieStickerFile, myStickers, newStickerId, ownTileUnique, parseLibraryIndex, parseStickerArgs, pickPage, pointInRect, singleNewIndexId } from './lib.mjs';

const sh = promisify(exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UI strings (remote/lib/i18n/pl.ts)
const T = {
  tile: (n) => `Klatka ${n}`, emoji: '+ Emoji', make: 'Zrób naklejkę', gallery: 'Z galerii',
  erase: 'Usuń', undo: 'Cofnij', next: 'Dalej', komiks: 'Komiks', naklejka: 'Naklejka', save: 'Zapisz',
  thinking: 'Chwilka…', mine: 'Moje', mineDel: 'Usuń z „Moje”',
};

const args = (() => {
  try { return parseStickerArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\nusage: stickers.cdp.mjs --devtools <port> --project <uuid> --photo <device path> [--toy x,y] [--png <device path>] [--adb "adb -s <serial>"] [--package <pkg>]`); process.exit(2); }
})();

// ---- CDP (same shape as flow.cdp.mjs) --------------------------------------------------------------

let ws = null;
let nextId = 1;
const pending = new Map();

async function attach(timeoutMs = 30_000) {
  const t0 = Date.now();
  let last = 'no page';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const page = pickPage(await (await fetch(`http://127.0.0.1:${args.devtools}/json`)).json());
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws error')); });
        sock.onmessage = (e) => {
          const m = JSON.parse(e.data);
          const p = pending.get(m.id);
          if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
        };
        ws = sock;
        return;
      }
    } catch (e) { last = e.message; }
    await sleep(1000);
  }
  throw new Error(`cannot attach to the devtools page: ${last}`);
}

function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(desc, expr, timeoutMs, everyMs = 300) {
  const t0 = Date.now();
  let lastErr = '';
  for (;;) {
    try {
      const v = await ev(expr);
      if (v) return v;
    } catch (e) { lastErr = e.message; }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${Math.round(timeoutMs / 1000)}s) waiting for ${desc}${lastErr ? ` [${lastErr}]` : ''}`);
    await sleep(everyMs);
  }
}

const J = JSON.stringify;
const byLabel = (label) => `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${J(label)} && !b.disabled)`;
const byText = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith(${J(text)}) && !b.disabled)`;
const byTid = (id) => `document.querySelector('[data-testid=${id}]:not(:disabled)')`;
const click = async (desc, finder, timeoutMs = 10_000) => {
  await waitFor(desc, `!!(${finder})`, timeoutMs);
  await ev(`(${finder}).click(); true`);
};

/** A real touch (pointer events) on the viewport point. */
async function touch(points) {
  const [first, ...rest] = points;
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
  for (const p of rest) { await sleep(30); await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] }); }
  await sleep(30);
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// ---- device ------------------------------------------------------------------------------------

const readProject = async () => JSON.parse((await sh(`${args.adb} shell run-as ${args.pkg} cat files/kopernikadr/projects/${args.project}/project.json`)).stdout);
const exists = async (rel) => (await sh(`${args.adb} shell "run-as ${args.pkg} ls ${rel} >/dev/null 2>&1 && echo yes || echo no"`)).stdout.trim() === 'yes';

/** Makes the "Z galerii" button import `path` through the debug hook instead of opening the system picker. */
async function redirectPicker(path) {
  const ok = await ev(`(() => {
    const cap = window.Capacitor;
    if (!cap || typeof cap.nativePromise !== 'function') return false;
    if (!cap.__origNativePromise) cap.__origNativePromise = cap.nativePromise.bind(cap);
    cap.nativePromise = (plugin, method, options) =>
      plugin === 'KopernikadrNative' && method === 'pickImage'
        ? cap.__origNativePromise(plugin, '__testImportImage', { path: ${J(path)} })
        : cap.__origNativePromise(plugin, method, options);
    return true;
  })()`);
  if (!ok) throw new Error('Capacitor.nativePromise is not available in the page: cannot redirect pickImage to __testImportImage');
}

const tile = (n) => `[...document.querySelectorAll('button.strip-tile')].find((b) => b.getAttribute('aria-label') === ${J(T.tile(n))})`;
const busy = `!!document.querySelector('.cut-msg.busy')`;
const stageRect = () => ev(`(() => { const r = document.querySelector('[data-testid=cut-stage] canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);

/** Frame 1 selected, picker open on the "Moje" tab, "Zrób naklejkę" tapped: the maker is open. */
async function openMaker() {
  await ev(`location.hash = ${J(`#/play/${args.project}`)}; true`);
  await waitFor('strip tile 1', `!!${tile(1)}`, 30_000);
  await ev(`${tile(1)}.click(); true`);
  await click('"+ Emoji"', `[...document.querySelectorAll('.edit-tools button')].find((b) => b.getAttribute('aria-label') === ${J(T.emoji)} && !b.disabled)`);
  await waitFor('picker', `!!document.querySelector('[role=dialog].picker')`, 15_000);
  await click('"Moje" tab', `document.querySelector('[role=tab][data-tab=mine]')`);
  await click('"Zrób naklejkę"', byTid('picker-make'));
  await waitFor('maker', `!!document.querySelector('[role=dialog][aria-label=${J(T.make)}]')`, 5_000);
}

const INDEX_REL = 'files/kopernikadr/stickers/index.json';
/** Ids in the persisted library index; throws (aborting the run) when the file exists but cannot be read or parsed. */
async function readLibraryIds() {
  if (!(await exists(INDEX_REL))) return [];
  return parseLibraryIndex((await sh(`${args.adb} shell run-as ${args.pkg} cat ${INDEX_REL}`)).stdout);
}

/** Snapshot of the persisted index BEFORE saving; the run must not start saving when it cannot be taken. */
const snapshotLibrary = readLibraryIds;

/** After saving: the one id the index gained, which must also be the new UI tile `uiId`. */
async function confirmNewSticker(beforeIds, uiId) {
  const id = singleNewIndexId(beforeIds, await readLibraryIds());
  if (id !== uiId) throw new Error(`the new tile ${uiId} is not the id the index gained (${id})`);
  return id;
}

/**
 * Deletes the run's own sticker `id` (confirmed by the index diff) from the open "Moje" tab. Verifies the
 * tile by its data-sticker attribute right before tapping; if it cannot be identified, deletes nothing and
 * returns a note so a human cleans up (the child's other stickers are never at risk).
 */
async function deleteOwnSticker(id) {
  const tiles = await mineIds().then((ids) => ids.map((i) => ({ id: i })));
  if (!ownTileUnique(tiles, id)) {
    ctx.leftovers.push(id);
    return `NOT deleted: no unique "Moje" tile for ${id}; remove the run's sticker by hand`;
  }
  const clicked = await ev(`(() => {
    const tiles = [...document.querySelectorAll('.mine-wrap')].filter((w) => w.querySelector('[data-sticker]')?.getAttribute('data-sticker') === ${J(id)});
    if (tiles.length !== 1) return false;
    const del = tiles[0].querySelector('[data-testid=mine-del]');
    if (!del) return false;
    del.click();
    return true;
  })()`);
  if (!clicked) {
    ctx.leftovers.push(id);
    return `NOT deleted: the delete button of ${id} was not found; remove the run's sticker by hand`;
  }
  await click('confirm', byTid('mine-del-confirm'), 5_000);
  await waitFor('tile gone', `!document.querySelector('[data-sticker=${J(id)}]')`, 10_000);
  return 'deleted';
}

const mineIds = () => ev(`[...document.querySelectorAll('.picker-grid.mine [data-sticker]')].map((e) => e.getAttribute('data-sticker'))`).catch(() => []);

/** Ids of the "Moje" tiles now, recorded before saving so only the sticker made by the run is ever touched. */
const recordMineIds = mineIds;

/** Waits until the maker has closed (saving finished) and a tile that was not there before shows; returns its id. */
async function waitNewMineTile(beforeIds) {
  const t0 = Date.now();
  for (;;) {
    const makerOpen = await ev(`!!document.querySelector('[role=dialog][aria-label=${J(T.make)}]')`);
    if (!makerOpen) {
      const id = newStickerId(beforeIds, await mineIds());
      if (id) return id;
    }
    if (Date.now() - t0 > 30_000) throw new Error('timeout: no new "Moje" tile after the maker closed');
    await sleep(300);
  }
}

// ---- steps ------------------------------------------------------------------------------------

const ctx = { uuid: null, timings: {}, leftovers: [] };
const steps = [];

steps.push(['0 safety: the movie is a "Test..." one with frames', async () => {
  const p = await readProject();
  assertTestProject(p, args.project);
  if (!p.frames?.length) throw new Error('the test movie has no frames');
  return `"${p.name}", ${p.frames.length} frames, ${myStickers(p).length} custom stickers already`;
}]);

steps.push(['1 JPEG toy: gallery import -> cut -> tap -> run', async () => {
  await openMaker();
  await redirectPicker(args.photo);
  await click('"Z galerii"', byTid('maker-gallery'));
  await waitFor('cut step', `!!document.querySelector('[data-testid=cut-stage]')`, 30_000);
  const r = await stageRect();
  const p = pointInRect(r, args.toy.x, args.toy.y);
  const t0 = Date.now();
  await touch([p]);
  await waitFor('run started', `${busy} || !document.querySelector('[data-testid=cut-next]')?.disabled`, 5_000, 100);
  await waitFor('run finished ("Chwilka…" gone, Dalej enabled)', `!${busy} && !!${byTid('cut-next')}`, 30_000, 200);
  ctx.timings.firstRunMs = Date.now() - t0;
  return `first run ${ctx.timings.firstRunMs} ms`;
}]);

steps.push(['2 erase stroke, Cofnij, Dalej', async () => {
  await click('brush "Usuń"', `document.querySelector('[data-brush=erase]')`);
  const r = await stageRect();
  const a = pointInRect(r, Math.max(0, args.toy.x - 0.03), args.toy.y);
  const b = pointInRect(r, Math.min(1, args.toy.x + 0.03), args.toy.y);
  const t0 = Date.now();
  await touch([a, pointInRect(r, args.toy.x, args.toy.y), b]);
  await waitFor('erase run finished', `${byTid('cut-undo')} && !${busy} && !!${byTid('cut-next')}`, 30_000, 200);
  ctx.timings.eraseRunMs = Date.now() - t0;
  await click('Cofnij', byTid('cut-undo'));
  await waitFor('undo run finished', `!${busy} && !!${byTid('cut-next')}`, 30_000, 200);
  await click('Dalej', byTid('cut-next'));
  await waitFor('style step', `!!document.querySelector('[data-style]')`, 15_000);
  return `later run ${ctx.timings.eraseRunMs} ms`;
}]);

steps.push(['3 Komiks, Zapisz, "Moje" tile, place, project.json + copy', async () => {
  await click('Komiks', `document.querySelector('[data-style=komiks]')`);
  await waitFor('Komiks selected', `document.querySelector('[data-style=komiks]').getAttribute('aria-checked') === 'true'`, 5_000);
  const before = await recordMineIds();
  const indexBefore = await snapshotLibrary();
  const t0 = Date.now();
  await click('Zapisz', byTid('maker-save'));
  ctx.uuid = await waitNewMineTile(before);
  await confirmNewSticker(indexBefore, ctx.uuid);
  ctx.timings.saveMs = Date.now() - t0;
  await ev(`document.querySelector('.picker-grid.mine [data-sticker=${J(ctx.uuid)}]').click(); true`);
  await waitFor('picker closed', `!document.querySelector('[role=dialog].picker')`, 10_000);
  let p;
  const t1 = Date.now();
  for (;;) {
    p = await readProject();
    if (myStickers(p).some((s) => s.uuid === ctx.uuid)) break;
    if (Date.now() - t1 > 15_000) throw new Error(`project.json has no my:${ctx.uuid} sticker: ${J(p.stickers)}`);
    await sleep(500);
  }
  if (!(await exists(movieStickerFile(args.project, ctx.uuid)))) throw new Error(`movie copy ${movieStickerFile(args.project, ctx.uuid)} is missing`);
  return `save ${ctx.timings.saveMs} ms; my:${ctx.uuid} placed, movie copy exists`;
}]);

steps.push(['4 delete from "Moje", the movie copy stays', async () => {
  await click('"+ Emoji"', `[...document.querySelectorAll('.edit-tools button')].find((b) => b.getAttribute('aria-label') === ${J(T.emoji)} && !b.disabled)`);
  await waitFor('picker', `!!document.querySelector('[role=dialog].picker')`, 15_000);
  await click('"Moje" tab', `document.querySelector('[role=tab][data-tab=mine]')`);
  await waitFor('tile', `!!document.querySelector('.mine-wrap [data-sticker=${J(ctx.uuid)}]')`, 10_000);
  const note = await deleteOwnSticker(ctx.uuid);
  if (note !== 'deleted') throw new Error(note);
  await ev(`${byLabel('Zamknij')}?.click(); true`).catch(() => {});
  if (await exists(`files/kopernikadr/stickers/${ctx.uuid}.webp`)) throw new Error('library file still exists');
  if (!(await exists(movieStickerFile(args.project, ctx.uuid)))) throw new Error('the movie copy vanished with the library item');
  const p = await readProject();
  if (!myStickers(p).some((s) => s.uuid === ctx.uuid)) throw new Error('the sticker left project.json');
  return 'library files gone, movie copy and project.json entry intact';
}]);

steps.push(['5 transparent PNG skips the cut', async () => {
  if (!args.png) return 'skipped (no --png)';
  await ev(`(() => { const d = document.querySelector('[role=dialog].picker'); const c = d && [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Zamknij'); c?.click(); return true; })()`);
  await openMaker();
  await redirectPicker(args.png);
  await click('"Z galerii"', byTid('maker-gallery'));
  await waitFor('style step directly (no cut stage)', `!!document.querySelector('[data-style]') && !document.querySelector('[data-testid=cut-stage]')`, 30_000);
  const before = await recordMineIds();
  const indexBefore = await snapshotLibrary();
  await click('Zapisz', byTid('maker-save'));
  // cleanup: only the sticker made by this run, proven by the index diff and the tile's id
  const id = await waitNewMineTile(before);
  await confirmNewSticker(indexBefore, id);
  const note = await deleteOwnSticker(id);
  return `PNG went alpha -> style, saved; cleanup: ${note}`;
}]);

// ---- run ---------------------------------------------------------------------------------------

const results = [];
await attach();
for (const [name, fn] of steps) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`PASS ${name}: ${detail}`);
  } catch (e) {
    results.push({ step: name, ok: false, detail: e.message, ms: Date.now() - t0 });
    console.log(`FAIL ${name}: ${e.message}`);
    break; // later steps depend on the earlier ones
  }
}
ws?.close();
if (ctx.leftovers.length) console.log(`LEFTOVER stickers made by this run, remove by hand from "Moje": ${ctx.leftovers.join(', ')}`);
console.log(J({ project: args.project, timings: ctx.timings, results }, null, 2));
process.exit(results.some((r) => !r.ok) || results.length < steps.length ? 1 : 0);
