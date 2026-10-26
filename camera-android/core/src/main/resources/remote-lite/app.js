// Kopernikadr remote-lite: the browser remote served by the camera phone itself.
// UI glue only; the logic lives in lib/, tested with
//   cd camera-android/core/src/test/remote-lite && node --test
// Dev server with a fake camera: see protocol/tools/probe-client/fake-camera.mjs (--serve).

import { pickLang, makeTranslator } from './lib/i18n.js';
import { CameraConnection } from './lib/connection.js';
import { PreviewLoop } from './lib/preview.js';
import { uuid } from './lib/protocol.js';
import * as S from './lib/store.js';
import { fitRect, formatLabel } from './lib/video.js';
import { icon, batteryIcon, LOGO } from './lib/icons.js';
import { playShutter } from './lib/sound.js';
import { Player, exportVideo, downloadBlob } from './lib/media.js';

const lang = pickLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
const t = makeTranslator(lang);
document.documentElement.lang = lang;

const $ = (id) => document.getElementById(id);
const UNDO_MS = 5000;
const CAPTURE_TIMEOUT_MS = 10_000;
const KEY_CLIENT = 'kopernikadr.remoteLite.clientId';
const KEY_PREFS = 'kopernikadr.remoteLite.prefs';
const KEY_OUTSTANDING = 'kopernikadr.remoteLite.outstanding';

// ---------- storage ----------

const ls = (() => {
  try {
    const k = '__probe__';
    localStorage.setItem(k, k);
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
})();

function readJson(key, def) {
  try {
    return JSON.parse(ls.getItem(key)) ?? def;
  } catch {
    return def;
  }
}

const clientId = ls.getItem(KEY_CLIENT) || (() => { const id = uuid(); ls.setItem(KEY_CLIENT, id); return id; })();
const prefs = { onion: true, onionOpacity: 30, sound: true, ...readJson(KEY_PREFS, {}) };
const savePrefs = () => ls.setItem(KEY_PREFS, JSON.stringify(prefs));
let state = S.loadState(ls);
const save = () => S.saveState(ls, state);
const getOutstanding = () => readJson(KEY_OUTSTANDING, null);
const setOutstanding = (o) => (o ? ls.setItem(KEY_OUTSTANDING, JSON.stringify(o)) : ls.removeItem(KEY_OUTSTANDING));

// ---------- helpers ----------

const wsUrl = (path) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
const frameUrl = (frameId, variant) => `/frames/${encodeURIComponent(frameId)}/${variant}.jpg`;
const dateFmt = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const movieName = (ms) => dateFmt.format(new Date(ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Icon + label button content. */
function iconLabel(name, label) {
  return `${icon(name)}<span class="lbl">${esc(label)}</span>`;
}

function setButton(el, name, label, { aria = label } = {}) {
  el.innerHTML = iconLabel(name, label);
  el.setAttribute('aria-label', aria);
}

function setIconButton(el, name, label) {
  el.insertAdjacentHTML('afterbegin', icon(name));
  el.setAttribute('aria-label', label);
  el.title = label;
}

/** Long press: calls onLong after `ms`; onShort for a quick tap. Suppresses the click after a long press. */
function onLongPress(el, ms, { onLong, onShort, onStart, onCancel }) {
  let timer = null;
  let fired = false;
  let startXY = null;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      onCancel?.();
    }
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    fired = false;
    startXY = [e.clientX, e.clientY];
    onStart?.(e);
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      navigator.vibrate?.(30);
      onLong(e);
    }, ms);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && startXY && Math.hypot(e.clientX - startXY[0], e.clientY - startXY[1]) > 12) cancel();
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    el.addEventListener(ev, (e) => {
      const wasPending = Boolean(timer);
      cancel();
      if (ev === 'pointerup' && wasPending && !fired) onShort?.(e);
    });
  }
  el.addEventListener('click', (e) => {
    if (fired) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fired = false;
    }
  }, true);
}

// ---------- snackbar ----------

let snackTimer = null;
let snackAction = null;

function showSnack(text, { action, onAction, ms = action ? UNDO_MS : 3500, onExpire } = {}) {
  const prevExpire = snackAction?.onExpire;
  clearTimeout(snackTimer);
  if (prevExpire) prevExpire();
  const bar = $('snackbar');
  $('snack-text').textContent = text;
  const btn = $('snack-action');
  btn.hidden = !action;
  if (action) btn.innerHTML = iconLabel('undo', action);
  snackAction = { onAction, onExpire };
  bar.hidden = false;
  bar.classList.remove('show');
  void bar.offsetWidth;
  bar.classList.add('show');
  snackTimer = setTimeout(() => {
    bar.classList.remove('show');
    bar.hidden = true;
    const s = snackAction;
    snackAction = null;
    s?.onExpire?.();
  }, ms);
}

$('snack-action').addEventListener('click', () => {
  const s = snackAction;
  snackAction = null;
  clearTimeout(snackTimer);
  $('snackbar').hidden = true;
  s?.onAction?.();
});

// ---------- connection ----------

const conn = new CameraConnection({ url: wsUrl('/ws/control'), clientId, appVersion: 'remote-lite/1', platform: 'web' });
const preview = new PreviewLoop({
  urlFor: (sid) => wsUrl(`/ws/preview?session=${encodeURIComponent(sid)}`),
  onFrame: drawPreview,
  onError: (e) => console.debug('preview:', e.message),
});

conn.on('state', () => {
  preview.setSession(conn.online ? conn.session.sessionId : null);
  renderConn();
  renderCaptureControls();
});
conn.on('session', () => {
  preview.setSession(conn.session.sessionId);
  recover();
  ensureRotation();
});
conn.on('controls', () => renderDrawer());
conn.on('status', () => { renderBattery(); renderDrawer(); });

function connInfo() {
  switch (conn.state) {
    case 'online': return { cls: 'ok', ic: 'wifi', text: t('online') };
    case 'busy': return { cls: 'busy', ic: 'busy', text: t('busy') };
    case 'unsupported': return { cls: 'bad', ic: 'warn', text: t('unsupported') };
    case 'connecting': return { cls: 'wait', ic: 'wifi', text: t('connecting') };
    default: return { cls: 'bad', ic: 'wifiOff', text: t('offline') };
  }
}

function renderConn() {
  const info = connInfo();
  for (const el of [$('proj-conn'), $('cap-conn')]) {
    el.className = `chip conn-chip ${info.cls}`;
    el.innerHTML = `<span class="dot"></span>${icon(info.ic)}`;
    el.setAttribute('aria-label', info.text);
    el.title = info.text;
  }
  const banner = $('offline-banner');
  const show = conn.state !== 'online';
  banner.hidden = !show;
  $('stage').classList.toggle('offline', show);
  banner.classList.toggle('busy', conn.state === 'busy');
  renderStageMsg();
  if (show) {
    const ic = conn.state === 'busy' ? 'busy' : conn.state === 'unsupported' ? 'warn' : 'wifiOff';
    banner.innerHTML = `${icon(ic)}<span>${esc(info.text)}</span>${conn.state === 'busy' || conn.state === 'unsupported' ? '' : '<span class="dots"><i></i><i></i><i></i></span>'}`;
  }
}

function renderBattery() {
  const s = conn.status;
  const el = $('cap-battery');
  if (!s || s.batteryPct == null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `chip battery-chip${s.batteryPct <= 15 && !s.charging ? ' low' : ''}`;
  el.innerHTML = `${batteryIcon(s.batteryPct, s.charging)}<span>${s.batteryPct}%</span>`;
  const label = t('battery', { n: s.batteryPct }) + (s.charging ? `, ${t('charging')}` : '');
  el.setAttribute('aria-label', label);
  el.title = label;
}

/** Paged listFrames: frames captured by this client that we miss locally (e.g. a lost capture response). */
let recovering = false;
async function recover() {
  if (recovering) return;
  recovering = true;
  try {
    const all = [];
    let afterSeq = 0;
    for (let page = 0; page < 200; page++) {
      const r = await conn.request('listFrames', { afterSeq, limit: 500 });
      all.push(...(r.frames ?? []));
      if (!r.hasMore || !r.frames?.length) break;
      afterSeq = r.frames[r.frames.length - 1].seq;
    }
    const { added, recovered } = S.mergeListedFrames(state, all, {
      now: Date.now(), cameraId: conn.session?.cameraId, recoveredName: (ms) => `${t('recoveredMovie')} ${movieName(ms)}`,
    });
    const out = getOutstanding();
    let extra = 0;
    if (out) {
      const r = await resolveOperation(out.reqId);
      if (r.state === 'done') extra = acceptFrame(r.result) ? 1 : 0;
      if (['done', 'failed', 'unknown', 'unsupported'].includes(r.state)) setOutstanding(null);
    }
    if (added || recovered.length || extra) {
      save();
      renderAll();
      if (added + extra) showSnack(t('recoveredFrames', { n: added + extra }));
    }
  } catch (e) {
    console.debug('recover:', e.message);
  } finally {
    recovering = false;
  }
}

/**
 * Asks the camera what happened to a capture (PROTOCOL.md §6 getOperation). Never re-sends it.
 * @returns {Promise<{state: 'done'|'pending'|'failed'|'unknown'|'unsupported'|'unreachable', result?}>}
 */
async function resolveOperation(reqId) {
  for (let i = 0; i < 6; i++) {
    let r;
    try {
      r = await conn.request('getOperation', { reqId }, { timeoutMs: 4000 });
    } catch (e) {
      if (e.code === 'UNKNOWN_OP') return { state: 'unsupported' };
      return { state: 'unreachable' };
    }
    if (r.state !== 'pending') return r;
    await sleep(1000);
  }
  return { state: 'pending' };
}

/** Adds a frame from a capture result; returns true if it was new. */
function acceptFrame(info) {
  const { added } = S.mergeListedFrames(state, [info], {
    now: Date.now(), cameraId: conn.session?.cameraId, recoveredName: (ms) => `${t('recoveredMovie')} ${movieName(ms)}`,
  });
  return added > 0;
}

/** A project with frames is bound to its rotation: put the camera back to it when it differs. */
async function ensureRotation() {
  const p = currentProject();
  if (!p || route.screen !== 'capture' || !conn.online) return;
  const rot = S.captureRotation(p, conn.controls?.rotation);
  if (!p.frames.length || conn.controls?.rotation === rot) return;
  if (!(conn.capabilities?.rotations ?? []).includes(rot)) return;
  try {
    await conn.request('setControl', { control: 'rotation', degrees: rot });
  } catch (e) {
    console.debug('rotation:', e.message);
  }
}

// ---------- preview ----------

const previewCanvas = $('preview');
const previewCtx = previewCanvas.getContext('2d');

async function drawPreview(header, jpeg) {
  const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  try {
    const w = bmp.width;
    const h = Math.round((w * 3) / 4);
    if (previewCanvas.width !== w || previewCanvas.height !== h) {
      previewCanvas.width = w;
      previewCanvas.height = h;
    }
    if (bmp.height === h) previewCtx.drawImage(bmp, 0, 0);
    else {
      const r = fitRect(bmp.width, bmp.height, w, h);
      previewCtx.fillStyle = '#000';
      previewCtx.fillRect(0, 0, w, h);
      previewCtx.drawImage(bmp, r.x, r.y, r.w, r.h);
    }
  } finally {
    bmp.close();
  }
  if (!hasPreview) {
    hasPreview = true;
    renderStageMsg();
  }
}
let hasPreview = false;

function renderStageMsg() {
  const el = $('stage-msg');
  const show = !hasPreview && conn.online;
  el.hidden = !show;
  el.textContent = show ? t('waitingPreview') : '';
}

// ---------- routing ----------

const route = { screen: 'projects', projectId: null };
let navDepth = 0;

function parseHash() {
  const m = /^#\/p\/([^/]+)(\/play)?$/.exec(location.hash);
  if (!m) return { screen: 'projects', projectId: null };
  const p = S.findProject(state, decodeURIComponent(m[1]));
  if (!p || p.trashed) return { screen: 'projects', projectId: null };
  return { screen: m[2] ? 'playback' : 'capture', projectId: p.id };
}

function go(hash) {
  navDepth++;
  location.hash = hash;
}

function goBack(fallback) {
  if (navDepth > 0) {
    navDepth--;
    history.back();
  } else {
    location.replace(fallback);
  }
}

function currentProject() {
  return route.projectId ? S.findProject(state, route.projectId) : null;
}

function applyRoute() {
  const next = parseHash();
  const prev = route.screen;
  Object.assign(route, next);
  if (prev === 'playback' && next.screen !== 'playback') leavePlayback();
  $('screen-projects').hidden = next.screen !== 'projects';
  $('screen-capture').hidden = next.screen !== 'capture';
  $('screen-playback').hidden = next.screen !== 'playback';
  closeViewer();
  closeDrawer();
  if (next.screen === 'capture') {
    preview.start();
    renderCapture({ scroll: true });
    ensureRotation();
  } else {
    preview.stop();
  }
  if (next.screen === 'projects') renderProjects();
  if (next.screen === 'playback') enterPlayback();
  document.body.dataset.screen = next.screen;
}

window.addEventListener('hashchange', applyRoute);

function renderAll() {
  if (route.screen === 'projects') renderProjects();
  else if (route.screen === 'capture') renderCapture({ scroll: true });
}

// ---------- projects screen ----------

function renderProjects() {
  const grid = $('proj-grid');
  const items = S.listProjects(state);
  const cards = items.map((p) => {
    const v = S.visibleFrames(p);
    const thumb = v.length
      ? `<img src="${frameUrl(v[0].frameId, 'thumb')}" alt="" draggable="false" loading="lazy" onerror="this.remove()">`
      : '';
    return `<button class="card" type="button" data-id="${esc(p.id)}">
      <span class="card-thumb">${icon('film', 'ph')}${thumb}</span>
      <span class="card-meta"><span class="card-name">${esc(p.name)}</span>
      <span class="card-count">${icon('film')}${esc(t('frames', { n: v.length }))}</span></span>
    </button>`;
  });
  grid.innerHTML = `<button class="card new-card" type="button" id="btn-new">
      <span class="new-plus">${icon('plus')}</span><span class="new-label">${esc(t('newMovie'))}</span>
    </button>${cards.join('')}`;
  $('btn-new').addEventListener('click', () => {
    const now = Date.now();
    const p = S.createProject(state, { id: uuid(), now, name: movieName(now) });
    save();
    go(`#/p/${p.id}`);
  });
  for (const el of grid.querySelectorAll('.card[data-id]')) {
    el.addEventListener('click', () => go(`#/p/${el.dataset.id}`));
    onLongPress(el, 600, {
      onStart: () => el.classList.add('pressing'),
      onCancel: () => el.classList.remove('pressing'),
      onLong: () => { el.classList.remove('pressing'); openSheet(el.dataset.id); },
    });
  }
}

let sheetProjectId = null;
function openSheet(id) {
  const p = S.findProject(state, id);
  if (!p) return;
  sheetProjectId = id;
  $('sheet-name').value = p.name;
  $('sheet').hidden = false;
}
function closeSheet() {
  if (!sheetProjectId) return;
  const p = S.findProject(state, sheetProjectId);
  if (p) {
    S.renameProject(p, $('sheet-name').value);
    save();
  }
  sheetProjectId = null;
  $('sheet').hidden = true;
  $('sheet-name').blur();
  renderProjects();
}
$('sheet-done').addEventListener('click', closeSheet);
$('sheet-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') closeSheet(); });
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
$('sheet-delete').addEventListener('click', () => {
  const id = sheetProjectId;
  sheetProjectId = null;
  $('sheet').hidden = true;
  S.trashProject(state, id, Date.now());
  save();
  renderProjects();
  showSnack(t('movieDeleted'), {
    action: t('undo'),
    onAction: () => { S.restoreProject(state, id); save(); renderProjects(); },
    onExpire: () => { S.purgeTrashed(state, Date.now(), UNDO_MS); save(); },
  });
});

$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
});

// ---------- capture screen ----------

let capturing = false;

function renderCapture({ scroll = false, popId = null } = {}) {
  const p = currentProject();
  if (!p) return;
  const v = S.visibleFrames(p);
  $('cap-counter').innerHTML = `${icon('film')}<b>${v.length}</b>`;
  $('cap-counter').setAttribute('aria-label', t('frames', { n: v.length }));
  $('cap-title').textContent = p.name;

  const strip = $('strip');
  if (!v.length) {
    strip.innerHTML = `<div class="strip-empty">${icon('camera')}<span>${esc(t('firstFrameHint'))}</span></div>`;
  } else {
    strip.innerHTML = v.map((f, i) => `<button class="thumb${f.frameId === popId ? ' pop' : ''}" type="button" data-id="${esc(f.frameId)}" aria-label="${esc(t('frameN', { n: i + 1 }))}">
      <img src="${frameUrl(f.frameId, 'thumb')}" alt="" draggable="false" loading="lazy"><span class="num">${i + 1}</span></button>`).join('');
  }
  if (scroll) requestAnimationFrame(() => strip.scrollTo({ left: strip.scrollWidth, behavior: popId ? 'smooth' : 'auto' }));

  const last = v[v.length - 1];
  const onion = $('onion');
  if (prefs.onion && last) {
    const src = frameUrl(last.frameId, 'play');
    if (onion.getAttribute('src') !== src) onion.src = src;
    onion.hidden = false;
  } else {
    onion.hidden = true;
  }
  onion.style.opacity = String(prefs.onionOpacity / 100);
  $('onion-toggle').setAttribute('aria-pressed', String(prefs.onion));
  $('onion-toggle').classList.toggle('on', prefs.onion);
  $('onion-opacity').value = String(prefs.onionOpacity);
  $('onion-opacity').disabled = !prefs.onion;
  renderCaptureControls();
  renderConn();
  renderBattery();
  renderStageMsg();
}

function renderCaptureControls() {
  const p = currentProject();
  const n = p ? S.visibleFrames(p).length : 0;
  const btn = $('btn-capture');
  btn.disabled = !conn.online || capturing;
  btn.classList.toggle('busy', capturing);
  $('btn-delete-last').disabled = n === 0;
  $('btn-watch').disabled = n === 0;
}

function flash() {
  const f = $('flash');
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
}

async function doCapture() {
  const p = currentProject();
  if (!p || capturing || !conn.online) return;
  capturing = true;
  renderCaptureControls();
  flash();
  if (prefs.sound) playShutter();
  const reqId = uuid();
  const rotation = S.captureRotation(p, conn.controls?.rotation);
  setOutstanding({ reqId, projectId: p.id, cameraId: conn.session?.cameraId ?? null, at: Date.now() });
  try {
    const info = await conn.request('capture', { projectId: p.id, rotation }, { reqId, timeoutMs: CAPTURE_TIMEOUT_MS });
    setOutstanding(null);
    if (acceptFrame(info)) save();
    if (route.screen === 'capture') renderCapture({ scroll: true, popId: info.frameId });
  } catch (e) {
    await captureFailed(e, reqId);
  } finally {
    capturing = false;
    renderCaptureControls();
  }
}

async function captureFailed(e, reqId) {
  if (e.code === 'TIMEOUT') {
    showSnack(t('captureChecking'));
    const r = await resolveOperation(reqId);
    if (r.state === 'done') {
      setOutstanding(null);
      if (acceptFrame(r.result)) save();
      if (route.screen === 'capture') renderCapture({ scroll: true, popId: r.result.frameId });
      showSnack(t('recoveredFrames', { n: 1 }));
      return;
    }
    if (r.state !== 'pending' && r.state !== 'unreachable') setOutstanding(null);
    showSnack(t('captureFailed'));
    return;
  }
  if (e.code === 'CLOSED') return; // offline banner is up; recover() resolves the outstanding capture
  if (!e.local) setOutstanding(null); // the camera answered: nothing was committed
  const msg = {
    CAMERA_NOT_READY: 'notReady', CAPTURE_IN_PROGRESS: 'notReady', STORAGE_LOW: 'storageLow', GEOMETRY_MISMATCH: 'geometry',
  }[e.code] ?? 'captureFailed';
  showSnack(t(msg));
  if (e.code === 'GEOMETRY_MISMATCH') ensureRotation();
}

function hideWithUndo(p, frameId) {
  if (!S.hideFrame(p, frameId)) return;
  save();
  renderCapture({ scroll: false });
  showSnack(t('frameDeleted'), {
    action: t('undo'),
    onAction: () => {
      S.unhideFrame(p, frameId);
      save();
      if (route.screen === 'capture') renderCapture({ scroll: false });
    },
  });
}

$('btn-capture').addEventListener('click', doCapture);
document.addEventListener('keydown', (e) => {
  if (route.screen === 'capture' && (e.code === 'Space' || e.code === 'Enter') && !e.repeat
      && !$('drawer').contains(document.activeElement) && $('viewer').hidden) {
    e.preventDefault();
    doCapture();
  }
});
$('btn-delete-last').addEventListener('click', () => {
  const p = currentProject();
  const last = p && S.lastVisibleFrame(p);
  if (last) hideWithUndo(p, last.frameId);
});
$('btn-watch').addEventListener('click', () => {
  const p = currentProject();
  if (p) go(`#/p/${p.id}/play`);
});
$('cap-back').addEventListener('click', () => goBack('#/'));
$('onion-toggle').addEventListener('click', () => {
  prefs.onion = !prefs.onion;
  savePrefs();
  renderCapture();
});
$('onion-opacity').addEventListener('input', (e) => {
  prefs.onionOpacity = Number(e.target.value);
  $('onion').style.opacity = String(prefs.onionOpacity / 100);
});
$('onion-opacity').addEventListener('change', savePrefs);
$('onion').addEventListener('error', () => { $('onion').hidden = true; });

$('strip').addEventListener('click', (e) => {
  const b = e.target.closest('.thumb');
  if (b) openViewer(b.dataset.id);
});

// ---------- frame viewer ----------

let viewerFrameId = null;
function openViewer(frameId) {
  const p = currentProject();
  if (!p) return;
  const idx = S.visibleFrames(p).findIndex((f) => f.frameId === frameId);
  if (idx < 0) return;
  viewerFrameId = frameId;
  $('viewer-img').src = frameUrl(frameId, 'play');
  $('viewer-label').textContent = t('frameN', { n: idx + 1 });
  $('viewer').hidden = false;
}
function closeViewer() {
  viewerFrameId = null;
  $('viewer').hidden = true;
  $('viewer-img').removeAttribute('src');
}
$('viewer-close').addEventListener('click', closeViewer);
$('viewer-delete').addEventListener('click', () => {
  const p = currentProject();
  const id = viewerFrameId;
  closeViewer();
  if (p && id) hideWithUndo(p, id);
});

// ---------- parent drawer ----------

const gear = $('cap-gear');
onLongPress(gear, 2000, {
  onStart: () => gear.classList.add('charging'),
  onCancel: () => gear.classList.remove('charging'),
  onShort: () => showSnack(t('holdGear')),
  onLong: () => { gear.classList.remove('charging'); openDrawer(); },
});
gear.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey) openDrawer(); });

let drawerOpen = false;
let sliderActive = false;
const pendingControls = new Set();

function openDrawer() {
  drawerOpen = true;
  renderDrawer();
  $('drawer').hidden = false;
  $('drawer-backdrop').hidden = false;
  requestAnimationFrame(() => $('drawer').classList.add('open'));
}
function closeDrawer() {
  drawerOpen = false;
  $('drawer').classList.remove('open');
  $('drawer').hidden = true;
  $('drawer-backdrop').hidden = true;
}
$('drawer-backdrop').addEventListener('click', closeDrawer);

function lockState(key) {
  const caps = conn.capabilities ?? {};
  const c = conn.controls?.[key];
  const supported = key === 'exposure' ? caps.exposure?.lock !== false && caps.exposure?.method !== null
    : key === 'whiteBalance' ? caps.whiteBalance?.lock !== false && caps.whiteBalance?.method !== null
      : !(caps.focus?.modes?.length === 1 && caps.focus.modes[0] === 'fixed') || c?.mode === 'fixed';
  if (!c) return { st: 'unknown', label: '—', ic: 'dash', canSet: false };
  if (!supported || c.mode === 'unsupported') return { st: 'unsupported', label: t('stUnsupported'), ic: 'dash', canSet: false };
  if (c.mode === 'fixed') return { st: 'fixed', label: t('stFixed'), ic: 'lock', canSet: false };
  // focus has no "failed" mode on the wire: a failed lock is locked + unconfirmed + focusOk:false
  const focusFailed = key === 'focus' && c.mode === 'locked' && !c.confirmed && c.focusOk === false;
  if (c.mode === 'failed' || focusFailed) return { st: 'failed', label: t('stFailed'), ic: 'warn', canSet: true };
  if (c.mode === 'locked') return c.confirmed ? { st: 'locked', label: t('stLocked'), ic: 'lock', canSet: true }
    : { st: 'locking', label: t('stLocking'), ic: 'unlock', canSet: true };
  return { st: 'auto', label: t('stAuto'), ic: 'unlock', canSet: true };
}

function seg(name, options, current, { disabled = false } = {}) {
  return `<div class="seg" role="group" data-ctl="${name}">${options.map((o) => `<button type="button" data-v="${esc(o.v)}"
    class="${String(o.v) === String(current) ? 'sel' : ''}${pendingControls.has(name) ? ' pending' : ''}" ${disabled ? 'disabled' : ''}
    aria-pressed="${String(o.v) === String(current)}">${o.ic ? icon(o.ic) : ''}<span>${esc(o.label)}</span></button>`).join('')}</div>`;
}

function evLabel(steps, stepEv) {
  const ev = (steps * (stepEv?.num ?? 1)) / (stepEv?.den ?? 2);
  const s = ev.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return `${ev > 0 ? '+' : ''}${s} EV`;
}

function renderDrawer() {
  if (!drawerOpen || sliderActive) return;
  const d = $('drawer');
  const c = conn.controls;
  const caps = conn.capabilities ?? {};
  const st = conn.status;
  const p = currentProject();
  const projectEmpty = !p || S.visibleFrames(p).length === 0;
  const lockRow = (key, label) => {
    const s = lockState(key);
    const mode = c?.[key]?.mode === 'locked' ? 'locked' : c?.[key]?.mode === 'auto' ? 'auto' : null;
    return `<section class="row">
      <div class="row-head"><h3>${esc(label)}</h3><span class="state st-${s.st}">${icon(s.ic)}${esc(s.label)}</span></div>
      ${s.canSet && conn.online ? seg(key, [{ v: 'auto', label: t('auto'), ic: 'unlock' }, { v: 'locked', label: t('lock'), ic: 'lock' }], mode) : ''}
    </section>`;
  };
  const comp = caps.exposure?.compensation;
  const compOn = Boolean(comp?.supported && c?.exposure?.compensationEnabled && conn.online);
  const steps = c?.exposure?.compensationSteps ?? 0;
  const rotations = caps.rotations?.length ? caps.rotations : [0, 180];
  const qualities = caps.previewQualities?.length ? caps.previewQualities : ['low', 'normal', 'high'];
  const qLabel = { low: t('qLow'), normal: t('qNormal'), high: t('qHigh') };
  const hot = st && !['none', 'light', 'unknown', undefined].includes(st.thermal);
  const gb = (b) => (b / 1e9).toLocaleString(lang, { maximumFractionDigits: 1 });

  d.innerHTML = `
    <header class="drawer-head"><h2 id="drawer-title">${icon('gear')}${esc(t('parentTitle'))}</h2>
      <button class="icon-btn" type="button" id="drawer-close" aria-label="${esc(t('close'))}">${icon('close')}</button></header>
    ${hot ? `<div class="warn-box">${icon('warn')}${esc(t('hot'))}</div>` : ''}
    <div class="drawer-body">
      ${lockRow('exposure', t('exposure'))}
      <section class="row">
        <div class="row-head"><h3>${esc(t('compensation'))}</h3><span class="state" id="comp-label">${compOn || comp?.supported ? esc(evLabel(steps, comp?.stepEv)) : esc(t('stUnsupported'))}</span></div>
        ${comp?.supported ? `<input type="range" id="comp" min="${comp.minSteps}" max="${comp.maxSteps}" step="1" value="${steps}" ${compOn ? '' : 'disabled'}>
        ${compOn ? '' : `<p class="hint">${esc(t('compensationOff'))}</p>`}` : ''}
      </section>
      ${lockRow('whiteBalance', t('whiteBalance'))}
      ${lockRow('focus', t('focus'))}
      <section class="row">
        <div class="row-head"><h3>${icon('rotate')}${esc(t('rotation'))}</h3></div>
        ${seg('rotation', rotations.map((r) => ({ v: r, label: `${r}°` })), c?.rotation, { disabled: !projectEmpty || !conn.online })}
        ${projectEmpty ? '' : `<p class="hint">${esc(t('rotationOnlyEmpty'))}</p>`}
      </section>
      <section class="row">
        <div class="row-head"><h3>${esc(t('previewQuality'))}</h3></div>
        ${seg('previewQuality', qualities.map((q) => ({ v: q, label: qLabel[q] ?? q })), c?.previewQuality, { disabled: !conn.online })}
      </section>
      <section class="row">
        <div class="row-head"><h3>${icon(prefs.sound ? 'soundOn' : 'soundOff')}${esc(t('shutterSound'))}</h3></div>
        ${seg('sound', [{ v: 'on', label: t('on'), ic: 'soundOn' }, { v: 'off', label: t('off'), ic: 'soundOff' }], prefs.sound ? 'on' : 'off')}
      </section>
      <section class="row info">
        <div class="row-head"><h3>${esc(t('camera'))}</h3><span class="state">${esc(conn.session?.name ?? '—')}</span></div>
        ${st ? `<p>${batteryIcon(st.batteryPct, st.charging)} ${st.batteryPct ?? '—'}%${st.charging ? ` · ${esc(t('charging'))}` : ''}</p>
        <p>${esc(t('freeSpace'))}: ${gb(st.freeBytes ?? 0)} GB</p>` : ''}
        <p class="mono">${esc(location.host)} · ${esc(clientId.slice(0, 8))}</p>
      </section>
    </div>`;

  $('drawer-close').addEventListener('click', closeDrawer);
  for (const group of d.querySelectorAll('.seg')) {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.disabled) return;
      onSeg(group.dataset.ctl, b.dataset.v, b);
    });
  }
  const slider = $('comp');
  if (slider) {
    slider.addEventListener('pointerdown', () => { sliderActive = true; });
    slider.addEventListener('input', () => { $('comp-label').textContent = evLabel(Number(slider.value), comp?.stepEv); });
    slider.addEventListener('change', async () => {
      sliderActive = false;
      await setControl('exposureCompensation', { control: 'exposureCompensation', steps: Number(slider.value) });
    });
    slider.addEventListener('pointerup', () => { setTimeout(() => { sliderActive = false; }, 50); });
  }
}

async function onSeg(name, value, btn) {
  if (name === 'sound') {
    prefs.sound = value === 'on';
    savePrefs();
    if (prefs.sound) playShutter();
    renderDrawer();
    return;
  }
  btn.classList.add('pending');
  if (name === 'rotation') {
    const degrees = Number(value);
    const ok = await setControl('rotation', { control: 'rotation', degrees });
    const p = currentProject();
    if (ok && p && p.frames.length && !S.visibleFrames(p).length) {
      p.rotation = degrees; // all frames hidden: the project may change its orientation
      save();
    }
  } else if (name === 'previewQuality') {
    await setControl(name, { control: 'previewQuality', value });
  } else {
    await setControl(name, { control: name, mode: value });
  }
}

async function setControl(name, args) {
  pendingControls.add(name);
  try {
    const c = await conn.request('setControl', args);
    conn.controls = c;
    return true;
  } catch (e) {
    showSnack(t(e.code === 'UNSUPPORTED_CONTROL' ? 'stUnsupported' : 'controlFailed'));
    return false;
  } finally {
    pendingControls.delete(name);
    renderDrawer();
  }
}

// ---------- playback + export ----------

const player = new Player({
  canvas: $('play-canvas'),
  urlFor: frameUrl,
  ringSize: 8,
  onIndex: (i, n) => { $('play-counter').textContent = `${i + 1} / ${n}`; },
});
let exportAbort = null;

function enterPlayback() {
  const p = currentProject();
  if (!p) return;
  const ids = S.visibleFrames(p).map((f) => f.frameId);
  $('play-empty').hidden = ids.length > 0;
  $('play-empty').textContent = t('noFramesToWatch');
  $('play-fps').value = String(p.fps);
  renderFps(p.fps);
  $('play-save').disabled = ids.length === 0;
  player.setFrames(ids);
  player.setFps(p.fps);
  const ctx = $('play-canvas').getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, $('play-canvas').width, $('play-canvas').height);
  player.play();
  renderPlayToggle();
}

function leavePlayback() {
  player.stop();
  exportAbort?.abort();
}

function renderPlayToggle() {
  setButton($('play-toggle'), player.playing ? 'pause' : 'play', player.playing ? t('pause') : t('play'));
}

function renderFps(fps) {
  $('play-fps-label').textContent = t('fps', { n: fps });
}

$('play-toggle').addEventListener('click', () => {
  if (player.playing) player.pause();
  else player.play();
  renderPlayToggle();
});
$('play-fps').addEventListener('input', (e) => {
  const p = currentProject();
  if (!p) return;
  const fps = S.setFps(p, e.target.value);
  player.setFps(fps);
  renderFps(fps);
});
$('play-fps').addEventListener('change', save);
$('play-back').addEventListener('click', () => goBack(`#/p/${route.projectId}`));
$('play-save').addEventListener('click', startExport);

function exportUI({ mode, text, sub = '', progress = null }) {
  $('export-panel').hidden = false;
  $('export-icon').innerHTML = icon(mode === 'done' ? 'check' : mode === 'error' ? 'warn' : 'save');
  $('export-icon').className = `export-icon ${mode}`;
  $('export-text').textContent = text;
  $('export-sub').textContent = sub;
  $('export-progress').hidden = progress == null;
  if (progress != null) $('export-bar').style.width = `${Math.round(progress * 100)}%`;
  const action = $('export-action');
  setButton(action, mode === 'running' ? 'close' : 'check', mode === 'running' ? t('cancel') : t('close'));
  action.className = `big-btn${mode === 'done' ? ' primary' : ''}`;
}

async function startExport() {
  const p = currentProject();
  if (!p || exportAbort) return;
  const ids = S.visibleFrames(p).map((f) => f.frameId);
  if (!ids.length) return;
  const wasPlaying = player.playing;
  player.pause();
  renderPlayToggle();
  exportAbort = new AbortController();
  exportUI({ mode: 'running', text: t('saving', { i: 0, n: ids.length }), progress: 0 });
  try {
    const r = await exportVideo({
      frameIds: ids, fps: p.fps, name: p.name, urlFor: frameUrl, signal: exportAbort.signal,
      onProgress: (i, n) => exportUI({ mode: 'running', text: t('saving', { i, n }), progress: i / n }),
    });
    downloadBlob(r.blob, r.fileName);
    window.__lastExport = { mime: r.mime, size: r.blob.size, fileName: r.fileName, url: URL.createObjectURL(r.blob) };
    exportUI({ mode: 'done', text: t('saved'), sub: `${t('savedFormat', { f: formatLabel(r.mime) })} · ${r.fileName}` });
  } catch (e) {
    if (e.name === 'AbortError') {
      $('export-panel').hidden = true;
    } else {
      console.error('export:', e);
      exportUI({ mode: 'error', text: t(e.code === 'UNSUPPORTED' ? 'saveUnsupported' : 'saveFailed') });
    }
  } finally {
    exportAbort = null;
    if (wasPlaying && route.screen === 'playback') {
      player.play();
      renderPlayToggle();
    }
  }
}

$('export-action').addEventListener('click', () => {
  if (exportAbort) exportAbort.abort();
  else $('export-panel').hidden = true;
});

// ---------- static texts + init ----------

function initTexts() {
  document.title = t('appTitle');
  $('logo').innerHTML = LOGO;
  $('proj-title').textContent = t('myMovies');
  setIconButton($('btn-fullscreen'), 'fullscreen', t('fullscreen'));
  setIconButton($('cap-back'), 'back', t('back'));
  setIconButton($('play-back'), 'back', t('back'));
  setIconButton(gear, 'gear', t('parentTitle'));
  setButton($('onion-toggle'), 'ghost', t('onion'));
  $('onion-opacity').setAttribute('aria-label', t('onionOpacity'));
  $('btn-capture').querySelector('.cap-icon').innerHTML = icon('camera');
  $('btn-capture').querySelector('.cap-label').textContent = t('capture');
  $('btn-capture').setAttribute('aria-label', t('capture'));
  setButton($('btn-delete-last'), 'trash', t('deleteLast'));
  setButton($('btn-watch'), 'watch', t('watch'));
  setButton($('viewer-delete'), 'trash', t('delete'));
  setButton($('viewer-close'), 'close', t('close'));
  setButton($('sheet-delete'), 'trash', t('deleteMovie'));
  setButton($('sheet-done'), 'check', t('done'));
  $('sheet-label').textContent = t('movieName');
  $('ic-turtle').innerHTML = icon('turtle');
  $('ic-turtle').title = t('slower');
  $('ic-hare').innerHTML = icon('hare');
  $('ic-hare').title = t('faster');
  $('play-fps').setAttribute('aria-label', t('fps', { n: '' }).trim());
  setButton($('play-save'), 'save', t('saveVideo'));
}

document.addEventListener('contextmenu', (e) => {
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) preview.stop();
  else {
    if (route.screen === 'capture') preview.start();
    if (!conn.online) conn.reconnectNow();
  }
});

S.purgeTrashed(state, Date.now(), UNDO_MS);
save();
initTexts();
renderConn();
applyRoute();
conn.start();

// for debugging from the console / DevTools
window.kopernikadr = { conn, preview, player, get state() { return state; }, prefs };
