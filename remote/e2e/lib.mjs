// Pure helpers of flow.cdp.mjs (unit-tested in lib.test.mjs; no I/O here).

export function parseArgs(argv) {
  const out = { devtools: null, camera: 'http://127.0.0.1:8765', adbRestart: null, reforward: null, cameraFromApp: '10.0.2.2:8765' };
  const keys = { '--devtools': 'devtools', '--camera': 'camera', '--adb-restart': 'adbRestart', '--reforward': 'reforward', '--camera-from-app': 'cameraFromApp' };
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
