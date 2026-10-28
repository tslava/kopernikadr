// Pure helpers of flow.cdp.mjs (unit-tested in lib.test.mjs; no I/O here).

export function parseArgs(argv) {
  const out = { devtools: null, camera: 'http://127.0.0.1:8765', adbRestart: null, reforward: null, cameraFromApp: '10.0.2.2:8765', adb: 'adb', pkg: 'pl.slava.kopernikadr.remote.debug' };
  const keys = { '--devtools': 'devtools', '--camera': 'camera', '--adb-restart': 'adbRestart', '--reforward': 'reforward', '--camera-from-app': 'cameraFromApp', '--adb': 'adb', '--package': 'pkg' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = keys[argv[i]];
    if (!k || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    out[k] = argv[i + 1];
  }
  if (!out.devtools || !/^\d+$/.test(out.devtools)) throw new Error('--devtools <port> is required');
  if (!out.adbRestart) throw new Error('--adb-restart "<cmd>" is required');
  out.camera = out.camera.replace(/\/+$/, '');
  return out;
}

/** Frames of one project on the fake camera, from its /fake/state. */
export function projectFrames(state, projectId) {
  const frames = (state.frames ?? []).filter((f) => f.projectId === projectId);
  return { total: frames.length, acked: frames.filter((f) => f.acked).length };
}

const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Gallery file name for a default movie name ("Film 3" -> kopernikadr-Film_3-<date>.mp4). Names with other characters are not handled. */
export function expectedGalleryName(movieName, date) {
  return `kopernikadr-${movieName.trim().replace(/\s+/g, '_')}-${isoDate(date)}.mp4`;
}

/** Pick the app's page from the DevTools /json list (the WebView page, not a worker/iframe). */
export function pickPage(list) {
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  return pages.find((t) => /localhost|capacitor/i.test(t.url ?? '')) ?? pages[0] ?? null;
}

/** Seconds the movie lasts: every entry that is not switched off shows for `hold` ticks of 1/fps. */
export function expectedDurationS(items, fps) {
  return items.filter((e) => !e.off).reduce((sum, e) => sum + e.hold, 0) / fps;
}

/** Newest MediaStore row (highest _id) whose display name starts with `prefix`, from `content query` output (`Row: 0 _id=1, _display_name=x, ...`). */
export function newestGalleryRow(output, prefix) {
  const rows = output.split('\n').map((l) => {
    const m = /_id=(\d+)/.exec(l);
    const n = /_display_name=(.*?)(?:, \w+=|$)/.exec(l);
    const d = /_data=(.*?)(?:, \w+=|$)/.exec(l);
    const dur = /duration=(\d+)/.exec(l);
    return m && n ? { id: Number(m[1]), name: n[1], data: d ? d[1] : null, durationMs: dur ? Number(dur[1]) : null } : null;
  }).filter((r) => r && r.name.startsWith(prefix));
  return rows.sort((a, b) => b.id - a.id)[0] ?? null;
}

// ---- stickers.cdp.mjs ----

/** Args of stickers.cdp.mjs. `--project` (an agent-created test movie) is mandatory: the script never picks a movie itself. */
export function parseStickerArgs(argv) {
  const out = { devtools: null, project: null, photo: null, png: null, toy: null, adb: 'adb', pkg: 'pl.slava.kopernikadr.remote.debug' };
  const keys = { '--devtools': 'devtools', '--project': 'project', '--photo': 'photo', '--png': 'png', '--toy': 'toy', '--adb': 'adb', '--package': 'pkg' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = keys[argv[i]];
    if (!k || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    out[k] = argv[i + 1];
  }
  if (!out.devtools || !/^\d+$/.test(out.devtools)) throw new Error('--devtools <port> is required');
  if (!out.project || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(out.project)) throw new Error('--project <uuid of a test movie> is required');
  if (!out.photo || !out.photo.startsWith('/')) throw new Error('--photo <absolute device path of the toy photo (JPEG)> is required');
  if (out.png && !out.png.startsWith('/')) throw new Error('--png must be an absolute device path');
  const toy = (out.toy ?? '0.5,0.5').split(',').map(Number);
  if (toy.length !== 2 || toy.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) throw new Error('--toy must be "x,y" normalized 0..1');
  out.toy = { x: toy[0], y: toy[1] };
  return out;
}

/** Safety gate: only a movie named "Test..." and with exactly the id passed on the command line may be driven. */
export function assertTestProject(project, id) {
  if (!project || project.id !== id) throw new Error(`project.json id ${project?.id} is not the requested ${id}`);
  if (typeof project.name !== 'string' || !project.name.startsWith('Test')) throw new Error(`refusing to run: movie "${project.name}" is not named "Test..."`);
}

/** The `my:<uuid>` stickers of a project.json, with the uuid. */
export function myStickers(project) {
  return (project.stickers ?? []).filter((s) => typeof s.emoji === 'string' && s.emoji.startsWith('my:')).map((s) => ({ ...s, uuid: s.emoji.slice(3) }));
}

/** Viewport point of a normalized (0..1) position inside a DOMRect-like {left, top, width, height}. */
export function pointInRect(rect, nx, ny) {
  return { x: rect.left + rect.width * nx, y: rect.top + rect.height * ny };
}

/**
 * The rectangle an image of natW x natH occupies inside `box` under `object-fit: contain`
 * (centered, scaled to fit, the rest is letterboxing).
 */
export function containRect(box, natW, natH) {
  if (!(natW > 0) || !(natH > 0)) return { left: box.left, top: box.top, width: box.width, height: box.height };
  const k = Math.min(box.width / natW, box.height / natH);
  const width = natW * k;
  const height = natH * k;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** Path of a movie's copy of a library sticker, relative to the app's data dir (for `run-as`). */
export const movieStickerFile = (projectId, uuid) => `files/kopernikadr/projects/${projectId}/stickers/${uuid}.webp`;

/**
 * The one library sticker id that is in `nowIds` but not in `beforeIds` (ids as listed in the "Moje"
 * grid). `null` while there is none yet; throws when several appeared (something else is adding), so a
 * cleanup never deletes a sticker that was not made by the run.
 */
export function newStickerId(beforeIds, nowIds) {
  const known = new Set(beforeIds);
  const fresh = [...new Set(nowIds)].filter((id) => !known.has(id));
  if (fresh.length > 1) throw new Error(`more than one new sticker appeared: ${fresh.join(', ')}`);
  return fresh[0] ?? null;
}

/**
 * Ids in the persisted library index (`stickers/index.json`, `{ v: 1, items: [{ id, ... }] }`). `text === null`
 * means the file does not exist yet (an empty library). Anything unreadable throws: the run must abort
 * rather than guess which stickers are the child's.
 */
export function parseLibraryIndex(text) {
  if (text === null) return [];
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`stickers/index.json is not valid JSON: ${e.message}`); }
  if (!doc || !Array.isArray(doc.items)) throw new Error('stickers/index.json has no items array');
  const ids = doc.items.map((it) => it?.id);
  if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('stickers/index.json has an item without a string id');
  return ids;
}

/** The exactly-one id that is in the index after saving but was not before; throws on zero or several. */
export function singleNewIndexId(beforeIds, afterIds) {
  const known = new Set(beforeIds);
  const fresh = [...new Set(afterIds)].filter((id) => !known.has(id));
  if (fresh.length !== 1) throw new Error(`expected exactly one new sticker in index.json, got ${fresh.length}${fresh.length ? `: ${fresh.join(', ')}` : ''}`);
  return fresh[0];
}

/**
 * Whether the tile about to be tapped is the run's own sticker: `tiles` are the "Moje" tiles as
 * `{ id }` (their data-sticker attribute), `expectedId` the id the index diff produced. True only for
 * exactly one tile with exactly that id; never decided by position.
 */
export function ownTileUnique(tiles, expectedId) {
  if (typeof expectedId !== 'string' || !expectedId) return false;
  return tiles.filter((t) => t.id === expectedId).length === 1;
}
