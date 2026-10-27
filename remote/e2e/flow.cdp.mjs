#!/usr/bin/env node
// Emulator E2E flow of the native remote (plan Task 20), driven over Chrome DevTools Protocol.
// No dependencies, Node >= 22 (global fetch + WebSocket). See README.md.
//
//   node remote/e2e/flow.cdp.mjs --devtools 9222 --camera http://127.0.0.1:8765 \
//     --adb-restart "adb -s emulator-5554 shell 'am force-stop pl.slava.kopernikadr.remote; am start -n pl.slava.kopernikadr.remote/.MainActivity'" \
//     --reforward "<cmd that re-runs adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>>"
//
// Prints PASS/FAIL per step and a JSON summary; exit code 1 on any FAIL.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { expectedGalleryName, parseArgs, pickPage, projectFrames } from './lib.mjs';

const sh = promisify(exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UI strings (remote/lib/i18n/pl.ts)
const T = {
  newMovie: 'Nowy film', shutter: 'Zrób zdjęcie', play: 'Oglądaj film', backToMovies: 'Wróć do filmów',
  del: 'Usuń film', delConfirm: 'Usuń', exportBtn: 'Zapisz film w galerii', exportDone: 'Zapisano w galerii',
  exportGo: ['Zapisz', 'Zapisz bez nich'], undoPrefix: 'Cofnij', playEmpty: 'Nie ma jeszcze klatek do obejrzenia.',
};
const UNDO_WINDOW_MS = 5000; // remote/lib/projects/model.ts

const args = (() => {
  try { return parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\nusage: flow.cdp.mjs --devtools <port> --adb-restart "<cmd>" [--reforward "<cmd>"] [--camera http://127.0.0.1:8765] [--camera-from-app 10.0.2.2:8765]`); process.exit(2); }
})();

// ---- CDP ---------------------------------------------------------------------------------------

let ws = null;
let nextId = 1;
const pending = new Map();

async function attach(timeoutMs = 90_000) {
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
        sock.onclose = () => { for (const p of pending.values()) p.rej(new Error('devtools socket closed')); pending.clear(); };
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

/** Evaluates `expr` in the page (promises awaited), returns the value. */
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** Polls the page expression until it is truthy; evaluation errors (reload, navigation) count as "not yet". */
async function waitFor(desc, expr, timeoutMs, everyMs = 400) {
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
const btn = (label) => `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${J(label)})`;
const shutterReady = `(() => { const b = document.querySelector('button.shutter'); return !!b && !b.disabled; })()`;
const counter = `(() => { const e = document.querySelector('[data-testid=frame-count]'); return e ? Number(e.textContent) : -1; })()`;
const routeIs = (prefix) => `location.hash.startsWith(${J(prefix)})`;
const goto = (hash) => ev(`location.hash = ${J(hash)}; true`);

async function fake(path) {
  const res = await fetch(`${args.camera}${path}`);
  if (!res.ok) throw new Error(`fake camera ${path}: HTTP ${res.status}`);
  return res.json();
}

// ---- steps -------------------------------------------------------------------------------------

const ctx = { projectId: null, movieName: null, galleryDate: null };
const steps = [];

steps.push(['1 create a movie', async () => {
  await goto('#/projects');
  await waitFor('projects view with an enabled "new movie" card', `(() => { const b = document.querySelector('button.card.new'); return !!b && !b.disabled; })()`, 30_000);
  await ev(`document.querySelector('button.card.new').click(); true`);
  await waitFor('capture view', routeIs('#/capture/'), 15_000);
  ctx.projectId = await ev(`decodeURIComponent(location.hash.split('/')[2])`);
  ctx.movieName = await waitFor('movie title', `document.querySelector('main.capture h1')?.textContent`, 10_000);
  return `project ${ctx.projectId} "${ctx.movieName}"`;
}]);

steps.push(['2 connect', async () => {
  try {
    await waitFor('shutter enabled (already online)', shutterReady, 10_000);
    return 'already online';
  } catch { /* connect manually below */ }
  await goto('#/connect');
  await waitFor('connect view', `!!document.querySelector('[data-testid=connect-address]')`, 10_000);
  await ev(`(() => {
    const i = document.querySelector('[data-testid=connect-address]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${J(args.cameraFromApp)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor('connect button enabled', `(() => { const b = document.querySelector('form.manual button[type=submit]'); return !!b && !b.disabled; })()`, 5_000);
  await ev(`document.querySelector('form.manual button[type=submit]').click(); true`);
  // ConnectScreen goes back by itself once online; fall back to the route by hand.
  await waitFor('camera online (left the connect view)', `!location.hash.startsWith('#/connect')`, 30_000);
  await goto(`#/capture/${ctx.projectId}`);
  await waitFor('shutter enabled', shutterReady, 30_000);
  return `connected manually to ${args.cameraFromApp}`;
}]);

steps.push(['3 shoot 10 frames', async () => {
  for (let i = 1; i <= 10; i++) {
    await waitFor(`shutter enabled before frame ${i}`, shutterReady, 30_000);
    await ev(`document.querySelector('button.shutter').click(); true`);
    await waitFor(`counter ${i}`, `${counter} === ${i}`, 30_000);
  }
  await waitFor('shutter enabled after frame 10', shutterReady, 30_000);
  return 'counter shows 10';
}]);

steps.push(['4 kill the app mid-transfer, relaunch, all 10 local + acked', async () => {
  const before = projectFrames(await fake('/fake/state'), ctx.projectId);
  await sh(args.adbRestart);
  ws?.close();
  await sleep(1500);
  if (args.reforward) await sh(args.reforward);
  await attach();
  await goto(`#/capture/${ctx.projectId}`);
  await waitFor('capture view of the movie after relaunch', `${routeIs('#/capture/')} && ${counter} >= 0`, 60_000);
  await waitFor('counter 10 after relaunch', `${counter} === 10`, 60_000);
  // Acked on the camera implies the full variant was downloaded, verified and persisted (ack-after-local).
  const t0 = Date.now();
  let f;
  for (;;) {
    f = projectFrames(await fake('/fake/state'), ctx.projectId);
    if (f.total === 10 && f.acked === 10) break;
    if (Date.now() - t0 > 60_000) throw new Error(`within 60s only ${f.acked}/${f.total} frames acked on the camera`);
    await sleep(1000);
  }
  const c = await ev(counter);
  if (c !== 10) throw new Error(`counter is ${c}, expected 10`);
  return `10/10 acked, counter 10 (acked before kill: ${before.acked}/${before.total})`;
}]);

steps.push(['5 dropped capture response resolves', async () => {
  await waitFor('shutter enabled', shutterReady, 60_000);
  await fake('/fake/drop-capture');
  await ev(`document.querySelector('button.shutter').click(); true`);
  await waitFor('counter 11', `${counter} === 11`, 20_000);
  return 'counter 11 within 20s';
}]);

steps.push(['6 play view shows frames', async () => {
  await ev(`${btn(T.play)}.click(); true`);
  await waitFor('play view', routeIs('#/play/'), 10_000);
  await waitFor('canvas', `!!document.querySelector('canvas.play-canvas')`, 5_000);
  await waitFor('playable frames (play button enabled, no empty note)',
    `(() => { const p = [...document.querySelectorAll('.play-controls button')].find((b) => /Odtwórz|Pauza/.test(b.getAttribute('aria-label') ?? '')); return !!p && !p.disabled && !document.body.textContent.includes(${J(T.playEmpty)}); })()`, 30_000);
  return 'play view open, playable frames';
}]);

steps.push(['7 export to the gallery', async () => {
  ctx.galleryDate = await ev(`(() => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; })()`);
  await waitFor('export button enabled', `(() => { const b = ${btn(T.exportBtn)}; return !!b && !b.disabled; })()`, 10_000);
  await ev(`${btn(T.exportBtn)}.click(); true`);
  const t0 = Date.now();
  for (;;) {
    const s = await ev(`(() => {
      const d = document.querySelector('[role=dialog]'); if (!d) return { none: true };
      return { text: d.textContent, alert: d.querySelector('[role=alert]')?.textContent ?? null,
               go: [...d.querySelectorAll('button.primary')].map((b) => b.textContent) };
    })()`);
    if (s.alert) throw new Error(`export failed: ${s.alert}`);
    if (s.text?.includes(T.exportDone)) break;
    if (s.go?.some((x) => T.exportGo.includes(x))) {
      await ev(`[...document.querySelectorAll('[role=dialog] button.primary')].find((b) => ${J(T.exportGo)}.includes(b.textContent))?.click(); true`);
    }
    if (Date.now() - t0 > 120_000) throw new Error('timeout (120s) waiting for "Zapisano w galerii"');
    await sleep(500);
  }
  const [y, m, d] = ctx.galleryDate;
  const name = expectedGalleryName(ctx.movieName, new Date(y, m - 1, d));
  await ev(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Zamknij')?.click(); true`);
  return `expected gallery file (MediaStore display name): ${name}`;
}]);

const card = () => `document.querySelector(${J(`[data-testid=movie-card][data-project-id="${ctx.projectId}"]`)})`;
const deleteBtn = () => `${card()}?.querySelector(${J(`button[aria-label="${T.del}"]`)})`;
const confirmBtn = `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === ${J(T.delConfirm)})`;
const undoBtn = `[...document.querySelectorAll('.undo-toast button')].find((b) => b.textContent.startsWith(${J(T.undoPrefix)}))`;

steps.push(['8 delete + Undo keeps the movie', async () => {
  await goto('#/projects');
  await waitFor('movie card', `!!${card()}`, 15_000);
  await ev(`${deleteBtn()}.click(); true`);
  await waitFor('delete confirmation', `!!${confirmBtn}`, 3_000);
  await ev(`${confirmBtn}.click(); true`);
  await waitFor('Undo toast', `!!${undoBtn}`, 5_000);
  await waitFor('card hidden during the Undo window', `!${card()}`, 3_000);
  await ev(`${undoBtn}.click(); true`);
  await waitFor('card listed again after Undo', `!!${card()}`, 5_000);
  await sleep(UNDO_WINDOW_MS + 1500); // the cancelled deletion must not fire later
  await waitFor('card still listed', `!!${card()}`, 2_000);
  return 'listed again, survived past the window';
}]);

steps.push(['9 delete past the Undo window: gone + all frames acked', async () => {
  await ev(`${deleteBtn()}.click(); true`);
  await waitFor('delete confirmation', `!!${confirmBtn}`, 3_000);
  await ev(`${confirmBtn}.click(); true`);
  await waitFor('Undo toast', `!!${undoBtn}`, 5_000);
  await sleep(UNDO_WINDOW_MS + 1500);
  await waitFor('card gone', `!${card()}`, 10_000);
  const t0 = Date.now();
  let f;
  for (;;) {
    f = projectFrames(await fake('/fake/state'), ctx.projectId);
    if (f.total >= 11 && f.acked === f.total) break;
    if (Date.now() - t0 > 60_000) throw new Error(`within 60s only ${f.acked}/${f.total} frames acked on the camera`);
    await sleep(1000);
  }
  return `gone, ${f.acked}/${f.total} frames acked on the camera`;
}]);

// ---- run ---------------------------------------------------------------------------------------

const results = [];
let broken = null;
await attach();
for (const [name, fn] of steps) {
  let r;
  if (broken && /^[2-9]/.test(name)) r = { name, status: 'FAIL', reason: `skipped: ${broken} failed` };
  else {
    const t0 = Date.now();
    try { r = { name, status: 'PASS', reason: await fn(), ms: Date.now() - t0 }; } catch (e) { r = { name, status: 'FAIL', reason: e.message, ms: Date.now() - t0 }; }
    if (r.status === 'FAIL' && name.startsWith('1 ')) broken = 'step 1';
  }
  results.push(r);
  console.log(`${r.status} ${r.name}: ${r.reason}`);
}
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(JSON.stringify({ ok: failed === 0, failed, projectId: ctx.projectId, movieName: ctx.movieName,
  expectedGalleryName: ctx.galleryDate ? expectedGalleryName(ctx.movieName, new Date(ctx.galleryDate[0], ctx.galleryDate[1] - 1, ctx.galleryDate[2])) : null, steps: results }, null, 2));
ws?.close();
process.exit(failed ? 1 : 0);
