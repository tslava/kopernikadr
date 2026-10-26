// One function per CLI command. Each logs human-readable lines via ctx.log and returns a JSON
// result (printed by client.mjs with --json).
//
// ctx = {target: parseTarget(...), clientId, projectId, log(line), warn(line), waitForEnter(text, signal)}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getJson, request, HttpError, isUnreachable, describeError } from './http.mjs';
import { ControlClient, ProtocolError, describeClose, openWebSocket } from './protocol.mjs';
import { parsePreviewFrame } from './preview-frame.mjs';
import * as diag from './diag.mjs';

const CAPTURE_TIMEOUT_MS = 10_000; // PROTOCOL §8
const PREVIEW_STALL_MS = 3_000; // PROTOCOL §7 watchdog

export async function info(ctx) {
  const data = await getJson(ctx.target.http, '/info');
  for (const [k, v] of Object.entries(data)) ctx.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return data;
}

async function connectControl(ctx) {
  const ctl = await ControlClient.connect(`${ctx.target.ws}/ws/control`, {
    onEvent: (name, data) => ctx.verbose && ctx.log(`evt ${name} ${JSON.stringify(data)}`),
    onClose: (c) => !c.byClient && ctx.warn(`control socket closed by the camera: ${describeClose(c.code, c.reason)}`),
    onPingError: (e) => ctx.warn(`ping failed: ${e.message}`),
  });
  try {
    await ctl.hello({ clientId: ctx.clientId });
  } catch (e) {
    ctl.close();
    throw e;
  }
  return ctl;
}

export async function hello(ctx) {
  const ctl = await connectControl(ctx);
  try {
    const s = ctl.session;
    ctx.log(`session ${s.sessionId} for client ${ctx.clientId}`);
    ctx.log(`camera ${s.name ?? '?'} (${s.cameraId}), boot ${s.bootId}, protocol v${s.protocolVersion}, ttl ${s.sessionTtlMs} ms`);
    if (s.controls) ctx.log(`controls: ${JSON.stringify(s.controls)}`);
    if (s.status) ctx.log(`status: ${JSON.stringify(s.status)}`);
    if (s.capabilities) ctx.log(`capabilities: ${JSON.stringify(s.capabilities)}`);
    return s;
  } finally {
    ctl.close();
  }
}

export async function capture(ctx, { projectId = ctx.projectId, rotation, reqId = randomUUID(), repeat = false } = {}) {
  const ctl = await connectControl(ctx);
  try {
    const args = { projectId, rotation: rotation ?? ctl.session.controls?.rotation ?? 0 };
    ctx.log(`capture reqId=${reqId} projectId=${args.projectId} rotation=${args.rotation}`);
    const first = await captureOnce(ctx, ctl, args, reqId);
    const result = { reqId, first };
    if (repeat) {
      ctx.log('repeat with the same reqId…');
      const second = await captureOnce(ctx, ctl, args, reqId);
      result.second = second;
      result.pass = second.frameId === first.frameId;
      ctx.log(result.pass
        ? `PASS: same frameId ${first.frameId}`
        : `FAIL: frameId ${first.frameId} vs ${second.frameId}`);
      if (!result.pass) process.exitCode = 1;
    }
    return result;
  } finally {
    ctl.close();
  }
}

async function captureOnce(ctx, ctl, args, reqId) {
  const t0 = performance.now();
  let frame;
  try {
    frame = await ctl.request('capture', args, { reqId, timeoutMs: CAPTURE_TIMEOUT_MS });
  } catch (e) {
    if (e.code !== 'TIMEOUT') throw e;
    ctx.warn(`no capture response in ${CAPTURE_TIMEOUT_MS} ms, resolving via getOperation`);
    frame = await resolveOperation(ctl, reqId);
  }
  const ms = Math.round(performance.now() - t0);
  const f = frame.full ?? {};
  ctx.log(`  frame ${frame.frameId} seq ${frame.seq} in ${ms} ms: full ${f.w}x${f.h} ${f.bytes} B sha256 ${f.sha256}`);
  return { ...frame, elapsedMs: ms };
}

async function resolveOperation(ctl, reqId, maxWaitMs = 30_000) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const op = await ctl.request('getOperation', { reqId });
    if (op.state === 'done') return op.result;
    if (op.state === 'failed') throw new ProtocolError('getOperation', op.error);
    if (op.state !== 'pending') throw new Error(`getOperation: state ${op.state}, no frame for reqId ${reqId}`);
    if (Date.now() > deadline) throw new Error(`getOperation: still pending after ${maxWaitMs} ms`);
    await sleep(1_000);
  }
}

export async function preview(ctx, { seconds = 10, quality, stallMs = PREVIEW_STALL_MS } = {}) {
  if (quality) await setPreviewQuality(ctx, quality);

  const frames = [];
  const recoveries = [];
  const deadline = Date.now() + seconds * 1000;
  let ctl = null;
  let inbox = null;

  const open = async () => {
    ctl = await connectControl(ctx);
    const ws = await openWebSocket(`${ctx.target.ws}/ws/preview?session=${encodeURIComponent(ctl.session.sessionId)}`);
    inbox = new Inbox(ws);
  };
  const closeAll = () => {
    inbox?.close();
    ctl?.close();
    inbox = ctl = null;
  };
  const reopen = async () => {
    closeAll();
    while (Date.now() < deadline) {
      try {
        return await open();
      } catch (e) {
        ctx.warn(`reconnect failed: ${describeError(e)}`);
        closeAll();
        await sleep(1_000);
      }
    }
  };

  await open();
  const started = performance.now();
  try {
    while (Date.now() < deadline && inbox) {
      const t0 = performance.now();
      let parsed;
      try {
        inbox.send(JSON.stringify({ t: 'next' }));
        parsed = parsePreviewFrame(await inbox.nextBinary(stallMs));
      } catch (e) {
        recoveries.push({ atMs: Math.round(performance.now() - started), reason: e.message });
        ctx.warn(`preview: ${e.message}; re-hello and reopen`);
        await reopen();
        continue;
      }
      const { w, h, seq } = parsed.header;
      frames.push({ latencyMs: performance.now() - t0, bytes: parsed.jpeg.length, w, h, seq });
    }
  } finally {
    closeAll();
  }

  const stats = previewStats(frames, (performance.now() - started) / 1000, recoveries);
  printPreviewStats(ctx, stats);
  return stats;
}

async function setPreviewQuality(ctx, quality) {
  try {
    await diag.setControls(ctx.target.http, { previewQuality: quality });
    ctx.log(`previewQuality set to ${quality}`);
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e;
    ctx.warn('POST /diag/controls → 404 (not a debug/probe build?); continuing with the current quality');
  }
}

/** Queues messages of one WebSocket so a pull loop can await them with a deadline. */
class Inbox {
  #ws;
  #queue = [];
  #waiter = null;
  #closed = null;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (e) => this.#push({ data: e.data }));
    ws.addEventListener('close', (e) => {
      this.#closed = `preview socket closed: ${describeClose(e.code, e.reason)}`;
      this.#push({ closed: this.#closed });
    });
  }

  send(text) {
    if (this.#closed) throw new Error(this.#closed);
    this.#ws.send(text);
  }

  close() {
    try { this.#ws.close(1000); } catch { /* already closed */ }
  }

  /** Resolves with the next binary message; text messages are skipped. */
  async nextBinary(timeoutMs) {
    const until = performance.now() + timeoutMs;
    for (;;) {
      const item = await this.#next(until - performance.now()).catch(() => {
        throw new Error(`no frame within ${timeoutMs} ms of next`);
      });
      if (item.closed) throw new Error(item.closed);
      if (typeof item.data !== 'string') return item.data;
    }
  }

  #next(timeoutMs) {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#closed) return Promise.resolve({ closed: this.#closed });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error('timeout'));
      }, Math.max(0, timeoutMs));
      this.#waiter = (item) => { clearTimeout(timer); resolve(item); };
    });
  }

  #push(item) {
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w(item);
    } else {
      this.#queue.push(item);
    }
  }
}

export function previewStats(frames, elapsedS, recoveries = []) {
  const lat = frames.map((f) => f.latencyMs).sort((a, b) => a - b);
  const bytes = frames.map((f) => f.bytes);
  const sizes = {};
  for (const f of frames) sizes[`${f.w}x${f.h}`] = (sizes[`${f.w}x${f.h}`] ?? 0) + 1;
  const round = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    seconds: round(elapsedS),
    frames: frames.length,
    fps: round(elapsedS > 0 ? frames.length / elapsedS : 0),
    latencyMs: { p50: round(percentile(lat, 50)), p95: round(percentile(lat, 95)), max: round(lat.at(-1)) },
    jpegBytes: frames.length
      ? { min: Math.min(...bytes), avg: Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length), max: Math.max(...bytes) }
      : null,
    sizes,
    recoveries: recoveries.length,
    recoveryLog: recoveries,
  };
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function printPreviewStats(ctx, s) {
  ctx.log(`preview ${s.seconds} s: ${s.frames} frames, ${s.fps} fps`);
  ctx.log(`latency ms (next → frame): p50 ${s.latencyMs.p50} p95 ${s.latencyMs.p95} max ${s.latencyMs.max}`);
  if (s.jpegBytes) ctx.log(`jpeg bytes: min ${s.jpegBytes.min} avg ${s.jpegBytes.avg} max ${s.jpegBytes.max}`);
  ctx.log(`sizes: ${Object.entries(s.sizes).map(([k, n]) => `${k} (${n})`).join(', ') || '-'}`);
  ctx.log(`recoveries: ${s.recoveries}`);
}

export async function download(ctx, frameId, { variant = 'full', sha256, out } = {}) {
  const path = `/frames/${encodeURIComponent(frameId)}/${variant}.jpg`;
  const t0 = performance.now();
  const res = await request(ctx.target.http, path, { timeoutMs: 60_000 });
  const contentLength = res.headers.get('content-length');
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ms = performance.now() - t0;
  const digest = createHash('sha256').update(bytes).digest('hex');

  const result = {
    url: ctx.target.http + path,
    bytes: bytes.length,
    contentLength: contentLength == null ? null : Number(contentLength),
    contentLengthOk: contentLength != null && Number(contentLength) === bytes.length,
    sha256: digest,
    sha256Ok: sha256 ? sha256.toLowerCase() === digest : null,
    jpegSoi: bytes[0] === 0xff && bytes[1] === 0xd8,
    elapsedMs: Math.round(ms),
    mbPerS: Math.round((bytes.length / 1e6 / (ms / 1000)) * 10) / 10,
    savedTo: null,
  };
  if (out) {
    await writeFile(out, bytes);
    result.savedTo = out;
  }

  ctx.log(`${variant}.jpg: ${result.bytes} B in ${result.elapsedMs} ms (${result.mbPerS} MB/s)`);
  ctx.log(`Content-Length: ${contentLength ?? 'missing'} → ${result.contentLengthOk ? 'OK' : 'MISMATCH'}`);
  ctx.log(`sha256: ${digest}${sha256 ? (result.sha256Ok ? ' → OK' : ` → MISMATCH (expected ${sha256})`) : ''}`);
  if (!result.jpegSoi) ctx.warn('body does not start with FF D8 (not a JPEG?)');
  if (out) ctx.log(`saved to ${out}`);
  if (!result.contentLengthOk || result.sha256Ok === false) process.exitCode = 1;
  return result;
}

/**
 * Starts a probe, answers its prompts from the terminal (or notices they were answered on the
 * phone), survives the server being away (screen locked) for up to `maxDownMs`, then saves the
 * report and its files to `<outRoot>/<YYYY-MM-DD>/<runId>/`.
 */
export async function probe(ctx, name, { args = {}, outRoot, pollMs = 1_000, maxDownMs = 5 * 60_000, maxBackoffMs = 10_000 } = {}) {
  const base = ctx.target.http;
  const runId = await diag.startProbe(base, name, args);
  ctx.log(`probe ${name} started: run ${runId}`);

  const down = { since: null, backoff: pollMs };
  const reachable = async (fn) => {
    for (;;) {
      try {
        const r = await fn();
        if (down.since) ctx.log(`server is back after ${Math.round((Date.now() - down.since) / 1000)} s`);
        down.since = null;
        down.backoff = pollMs;
        return r;
      } catch (e) {
        if (!isUnreachable(e)) throw e;
        if (!down.since) {
          down.since = Date.now();
          ctx.warn(`server unreachable (${describeError(e)}); phone screen locked? retrying for up to ${Math.round(maxDownMs / 1000)} s`);
        } else if (Date.now() - down.since > maxDownMs) {
          throw new Error(`server unreachable for over ${Math.round(maxDownMs / 1000)} s: ${describeError(e)}`);
        }
        await sleep(down.backoff);
        down.backoff = Math.min(down.backoff * 2, maxBackoffMs);
      }
    }
  };

  const answered = new Set();
  let lastStep = null;
  let run;
  for (;;) {
    run = await reachable(() => diag.getRunStatus(base, runId));
    const step = run.step ?? run.state;
    if (step !== lastStep) ctx.log(`  ${step}`);
    lastStep = step;
    if (diag.isTerminal(run)) break;
    if (run.prompt && !answered.has(run.prompt.id)) {
      answered.add(run.prompt.id);
      await answerPrompt(ctx, run, reachable, pollMs);
      continue;
    }
    await sleep(pollMs);
  }

  const report = await reachable(() => diag.getReport(base, runId));
  const dir = join(outRoot, localDate(), runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const saved = ['report.json'];
  for (const file of diag.reportFileNames(report)) {
    if (file === 'report.json') continue;
    if (!diag.SAFE_NAME_RE.test(file)) {
      ctx.warn(`skipping unsafe file name ${JSON.stringify(file)}`);
      continue;
    }
    const bytes = await reachable(() => diag.downloadFile(base, runId, file));
    await writeFile(join(dir, file), bytes);
    saved.push(file);
  }

  ctx.log(`run ${runId} ${run.state}${run.error ? `: ${run.error}` : ''}`);
  ctx.log(`saved ${saved.length} file(s) to ${dir}`);
  if (run.state === 'failed') process.exitCode = 1;
  return { runId, name, state: run.state, error: run.error, dir, files: saved };
}

async function answerPrompt(ctx, run, reachable, pollMs) {
  const { runId } = run;
  const prompt = run.prompt;
  ctx.log('');
  ctx.log(`>>> ${prompt.text}`);

  // Whichever comes first: Enter here, or the prompt going away (Continue tapped on the phone).
  const ac = new AbortController();
  const enter = ctx.waitForEnter('Press Enter to continue (or tap Continue on the phone)… ', ac.signal)
    .then(() => 'enter', () => 'aborted');
  const gone = (async () => {
    while (!ac.signal.aborted) {
      await sleep(pollMs);
      const s = await diag.getRunStatus(ctx.target.http, runId).catch(() => null);
      if (s && s.prompt?.id !== prompt.id) return 'gone';
    }
    return 'aborted';
  })();
  const winner = await Promise.race([enter, gone]);
  ac.abort();

  if (winner === 'gone') {
    ctx.log('prompt answered on the phone');
    return;
  }
  try {
    await reachable(() => diag.sendContinue(ctx.target.http, runId, prompt.id));
    ctx.log('continue sent');
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) ctx.log('prompt was already answered');
    else throw e;
  }
}

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
