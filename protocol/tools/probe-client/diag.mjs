// Adapter for the /diag routes (debug/probe builds only). The server side is written later, so
// every assumption about its JSON lives here and nowhere else.
//
// Assumed shapes:
//
//   POST /diag/probe/{name}        body: probe args object, {} when none (e.g. {"manualRestart":true})
//                                  → 200/202 {"runId":"<id>"}
//                                  → 409 when a probe is already running
//   GET  /diag/runs                → {"runs":[RunStatus, ...]}
//   GET  /diag/report/{runId}      → Report (may be polled while running; final when state is terminal)
//   POST /diag/continue            body: {"runId":"<id>","promptId":"<id>"}
//                                  → 200 {"ok":true}; 409 when that prompt is no longer pending
//   GET  /diag/files/{runId}/{name} → raw bytes; both segments match SAFE_NAME_RE
//   POST /diag/controls            body: e.g. {"previewQuality":"high"} → 200 (any JSON); 404 in release
//
//   RunStatus = {
//     "runId": "<id>", "name": "locks",
//     "state": "running" | "waiting" | "done" | "failed",   // "waiting" = blocked on a prompt
//     "step": "S2 capture 3/10",                            // optional, free-form progress text
//     "prompt": {"id": "<id>", "text": "Put the card into the frame"} | null,  // set while waiting
//     "error": "message"                                    // optional, when failed
//   }
//   Report = RunStatus fields + probe-specific data +
//     "files": ["report.json", "overlay-0.png", ...]       // or [{"name":"overlay-0.png","bytes":123}, ...]

import { getJson, postJson, request } from './http.mjs';

export const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const TERMINAL_STATES = new Set(['done', 'failed']);

export const PATHS = {
  start: (name) => `/diag/probe/${encodeURIComponent(name)}`,
  runs: '/diag/runs',
  report: (runId) => `/diag/report/${encodeURIComponent(runId)}`,
  continue: '/diag/continue',
  file: (runId, name) => `/diag/files/${encodeURIComponent(runId)}/${encodeURIComponent(name)}`,
  controls: '/diag/controls',
};

export function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw.prompt;
  return {
    runId: raw.runId,
    name: raw.name ?? null,
    state: raw.state ?? 'running',
    step: raw.step ?? null,
    prompt: p && p.id != null ? { id: String(p.id), text: p.text ?? '' } : null,
    error: raw.error ?? null,
  };
}

export function isTerminal(run) {
  return TERMINAL_STATES.has(run.state);
}

export function reportFileNames(report) {
  return (report?.files ?? []).map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean);
}

export async function startProbe(base, name, args = {}) {
  const res = await postJson(base, PATHS.start(name), args);
  if (typeof res.runId !== 'string' || !SAFE_NAME_RE.test(res.runId)) {
    throw new Error(`POST ${PATHS.start(name)}: expected {"runId": "<safe id>"}, got ${JSON.stringify(res)}`);
  }
  return res.runId;
}

/** The run from GET /diag/runs; falls back to the report when the list does not have it. */
export async function getRunStatus(base, runId) {
  const { runs = [] } = await getJson(base, PATHS.runs);
  const found = runs.find((r) => r?.runId === runId);
  return normalizeRun(found ?? (await getReport(base, runId)));
}

export function getReport(base, runId) {
  return getJson(base, PATHS.report(runId));
}

export function sendContinue(base, runId, promptId) {
  return postJson(base, PATHS.continue, { runId, promptId });
}

export async function downloadFile(base, runId, name) {
  const res = await request(base, PATHS.file(runId, name), { timeoutMs: 60_000 });
  return new Uint8Array(await res.arrayBuffer());
}

export function setControls(base, controls) {
  return postJson(base, PATHS.controls, controls);
}
