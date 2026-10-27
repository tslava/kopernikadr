// `camera` probe (PROTOCOL.md §3–§7): manual `GET /info`, remote-core `ControlClient` hello →
// session, preview pull loop at low/normal/high (fps, next→frame latency p50/p95), ping during a
// capture, and a capture round-trip. Also the session/capture helpers the download and reconnect
// probes share. Everything runs under the probe's own clientId and projectId, so the kid's frames
// are never listed or acked.
import { ControlClient, PROTOCOL_VERSION, ProtocolError, uuid } from '@kopernikadr/remote-core/protocol';
import { parsePreviewFrame } from '@kopernikadr/remote-core/preview-frame';
import { errorText, ProbeFailure, type Probe } from './runner';
import type { ProbeShared } from './shared';
import { mbPerS, round1, sleep, spread, throwIfAborted } from './util';

export const DEFAULT_PORT = 8765;
const CAPTURE_TIMEOUT_MS = 10_000; // PROTOCOL §8
const PREVIEW_STALL_MS = 3_000; // PROTOCOL §7 watchdog
const PING_EVERY_MS = 2_000; // PROTOCOL §4: keeps the 10 s session TTL alive
const QUALITIES = ['low', 'normal', 'high'] as const;
export type PreviewQuality = (typeof QUALITIES)[number];

export type WebSocketCtor = new (url: string) => WebSocket;

// --- address ---

export interface CameraTarget {
  host: string;
  port: number;
  source: 'nsd' | 'manual';
}

/** `host`, `host:port`, `[v6]:port`, with or without `http://`/`ws://` and a path; null if invalid. */
export function parseAddress(text: string): { host: string; port: number } | null {
  const s = text.trim().replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '');
  const m = /^\[([^\]\s]+)\](?::(\d+))?$/.exec(s) ?? /^([^:\s[\]]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { host: m[1], port } : null;
}

/** The camera to probe: the first one NSD found, else the manual address. */
export function resolveTarget(shared: ProbeShared): CameraTarget | null {
  const found = shared.nsdServices?.[0];
  if (found) return { host: found.host, port: found.port, source: 'nsd' };
  const manual = parseAddress(shared.manualAddress);
  return manual && { ...manual, source: 'manual' };
}

export function hostPort(t: { host: string; port: number }): string {
  return t.host.includes(':') ? `[${t.host.replace(/%/g, '%25')}]:${t.port}` : `${t.host}:${t.port}`;
}

export const NO_TARGET = 'no camera address: NSD found none and no address was entered';

// --- control session ---

/** `hello` data (PROTOCOL §6); only the fields the probes read are typed. */
export interface HelloData {
  cameraId: string;
  bootId: string;
  sessionId: string;
  name?: string;
  protocolVersion: number;
  sessionTtlMs?: number;
  capabilities?: { previewQualities?: string[] };
  controls?: { rotation?: number; previewQuality?: string };
}

export interface FrameInfo {
  frameId: string;
  seq: number;
  projectId: string;
  clientId: string;
  rotation: number;
  full: { w: number; h: number; bytes: number; sha256: string };
}

export interface SessionDeps {
  WebSocketImpl: WebSocketCtor;
  clientId: string;
  appVersion: string;
  platform: string;
  now: () => number;
  connectTimeoutMs?: number;
}

export interface ProbeSession {
  hello: HelloData;
  /** ms from socket open to the hello result. */
  helloMs: number;
  request<T = Record<string, unknown>>(op: string, args?: object, opts?: { reqId?: string; timeoutMs?: number }): Promise<T>;
  close(): void;
}

/** Resolves once `ws` is open; rejects on error/close/timeout. Listeners are attached at once. */
function waitOpen(ws: WebSocket, url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      if (err) {
        try {
          ws.close();
        } catch {
          // not open
        }
        reject(err);
      } else resolve();
    };
    const onOpen = () => done();
    const onError = () => done(new Error(`cannot connect to ${url}`));
    const onClose = (e: CloseEvent) => done(new Error(`${url} closed before open (${e.code})`));
    const timer = setTimeout(() => done(new Error(`${url}: no connection within ${timeoutMs} ms`)), timeoutMs);
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}

/** BUSY gets a hint: the kid's remote-lite (another clientId) holds the camera. */
function helloError(e: unknown): Error {
  if (e instanceof ProtocolError && e.code === 'BUSY') {
    return new Error(`camera busy: another remote holds the session (close remote-lite), retry in ${e.retryAfterMs ?? '?'} ms`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** Opens `/ws/control`, sends hello with the probe clientId and keeps the session alive with pings. */
export async function openSession(target: { host: string; port: number }, deps: SessionDeps): Promise<ProbeSession> {
  const url = `ws://${hostPort(target)}/ws/control`;
  const timeoutMs = deps.connectTimeoutMs ?? 5_000;
  const ws = new deps.WebSocketImpl(url);
  ws.binaryType = 'arraybuffer';
  await waitOpen(ws, url, timeoutMs);
  const client = new ControlClient(ws, { timeoutMs: CAPTURE_TIMEOUT_MS });
  const t0 = deps.now();
  let hello: HelloData;
  try {
    hello = await client.request(
      'hello',
      { clientId: deps.clientId, protocolVersions: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION }, appVersion: deps.appVersion, platform: deps.platform },
      { timeoutMs },
    );
  } catch (e) {
    client.abort();
    throw helloError(e);
  }
  const helloMs = Math.round(deps.now() - t0);
  const pinger = setInterval(() => client.request('ping', {}, { timeoutMs: 5_000 }).catch(() => {}), PING_EVERY_MS);
  return {
    hello,
    helloMs,
    request: (op, args = {}, opts = {}) => client.request(op, args, opts),
    close() {
      clearInterval(pinger);
      client.abort();
    },
  };
}

export interface CaptureResult {
  frame: FrameInfo;
  roundTripMs: number;
  /** The result came from getOperation after a timeout (PROTOCOL §8). */
  viaGetOperation: boolean;
  /** CAMERA_NOT_READY answers before the capture was accepted. */
  notReadyRetries: number;
}

export interface CaptureOptions {
  now: () => number;
  signal?: AbortSignal;
  newReqId?: () => string;
  timeoutMs?: number;
  maxNotReady?: number;
}

/** `capture` with the PROTOCOL §8 timeout path; CAMERA_NOT_READY is retried with a fresh reqId. */
export async function captureFrame(
  session: ProbeSession,
  args: { projectId: string; rotation: number },
  { now, signal, newReqId = uuid, timeoutMs = CAPTURE_TIMEOUT_MS, maxNotReady = 10 }: CaptureOptions,
): Promise<CaptureResult> {
  for (let notReady = 0; ; notReady++) {
    throwIfAborted(signal);
    const reqId = newReqId();
    const t0 = now();
    try {
      const frame = await session.request<FrameInfo>('capture', args, { reqId, timeoutMs });
      return { frame, roundTripMs: Math.round(now() - t0), viaGetOperation: false, notReadyRetries: notReady };
    } catch (e) {
      if (e instanceof ProtocolError && e.code === 'TIMEOUT') {
        const frame = await resolveOperation(session, reqId, signal);
        return { frame, roundTripMs: Math.round(now() - t0), viaGetOperation: true, notReadyRetries: notReady };
      }
      if (e instanceof ProtocolError && e.code === 'CAMERA_NOT_READY' && notReady < maxNotReady) {
        await sleep(500, signal);
        continue;
      }
      throw e;
    }
  }
}

async function resolveOperation(session: ProbeSession, reqId: string, signal?: AbortSignal, maxPolls = 30): Promise<FrameInfo> {
  for (let i = 0; i < maxPolls; i++) {
    const op = await session.request<{ state: string; result?: FrameInfo; error?: { code?: string; message?: string } }>('getOperation', { reqId });
    if (op.state === 'done' && op.result) return op.result;
    if (op.state === 'failed') throw new ProtocolError('getOperation', op.error ?? {});
    if (op.state !== 'pending') throw new Error(`getOperation: state ${op.state}, no frame for reqId ${reqId}`);
    await sleep(1_000, signal);
  }
  throw new Error(`getOperation: still pending after ${maxPolls} polls`);
}

// --- preview ---

export interface PreviewStats {
  seconds: number;
  frames: number;
  fps: number;
  /** `next` sent → binary frame received. */
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  /** JPEG decode (createImageBitmap) per frame; null without a decoder. */
  decodeMs: { p50: number | null; p95: number | null; max: number | null } | null;
  jpegBytes: { min: number; avg: number; max: number } | null;
  /** Header `w×h` → frame count. */
  sizes: Record<string, number>;
  /** Watchdog/socket recoveries (no frame within 3 s, bad frame, socket closed). */
  stalls: number;
  stallLog: string[];
  mbPerS: number | null;
}

/** Queues one preview socket's binary messages so the pull loop can await them with a deadline. */
class BinaryInbox {
  #queue: ArrayBuffer[] = [];
  #waiter: (() => void) | null = null;
  closed: string | null = null;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') return;
      this.#queue.push(e.data as ArrayBuffer);
      this.#wake();
    });
    ws.addEventListener('close', (e) => {
      this.closed = `preview socket closed (${e.code})`;
      this.#wake();
    });
  }

  #wake() {
    const w = this.#waiter;
    this.#waiter = null;
    w?.();
  }

  async next(timeoutMs: number): Promise<ArrayBuffer> {
    if (!this.#queue.length && !this.closed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.#waiter = null;
          resolve();
        }, timeoutMs);
        this.#waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    const buf = this.#queue.shift();
    if (buf) return buf;
    throw new Error(this.closed ?? `no frame within ${timeoutMs} ms of next`);
  }

  close() {
    try {
      this.ws.close(1000);
    } catch {
      // already closed
    }
  }
}

export interface PreviewDeps {
  WebSocketImpl: WebSocketCtor;
  now: () => number;
  decode?: (jpeg: Uint8Array) => Promise<void>;
  stallMs?: number;
}

/** Pulls preview frames for `seconds` (send `next`, wait for one frame, repeat), like PreviewLoop. */
export async function measurePreview(url: string, seconds: number, deps: PreviewDeps, signal?: AbortSignal): Promise<PreviewStats> {
  const { now } = deps;
  const stallMs = deps.stallMs ?? PREVIEW_STALL_MS;
  const latency: number[] = [];
  const decode: number[] = [];
  const bytes: number[] = [];
  const sizes: Record<string, number> = {};
  const stallLog: string[] = [];

  const open = async () => {
    const ws = new deps.WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    const inbox = new BinaryInbox(ws);
    await waitOpen(ws, url.replace(/\?.*$/, ''), 5_000);
    return inbox;
  };

  const started = now();
  const deadline = started + seconds * 1000;
  let inbox = await open();
  try {
    while (now() < deadline && !signal?.aborted) {
      const t0 = now();
      try {
        if (inbox.closed) throw new Error(inbox.closed);
        inbox.ws.send('{"t":"next"}');
        const { header, jpeg } = parsePreviewFrame(await inbox.next(stallMs));
        latency.push(now() - t0);
        bytes.push(jpeg.length);
        const key = `${(header as { w?: number }).w}x${(header as { h?: number }).h}`;
        sizes[key] = (sizes[key] ?? 0) + 1;
        if (deps.decode) {
          const d0 = now();
          await deps.decode(jpeg);
          decode.push(now() - d0);
        }
      } catch (e) {
        stallLog.push(`${Math.round(now() - started)} ms: ${errorText(e)}`);
        inbox.close();
        if (now() >= deadline || signal?.aborted) break;
        inbox = await open();
      }
    }
  } finally {
    inbox.close();
  }

  const elapsed = (now() - started) / 1000;
  const total = bytes.reduce((a, b) => a + b, 0);
  return {
    seconds: round1(elapsed),
    frames: latency.length,
    fps: round1(elapsed > 0 ? latency.length / elapsed : 0),
    latencyMs: spread(latency),
    decodeMs: deps.decode ? spread(decode) : null,
    jpegBytes: bytes.length ? { min: Math.min(...bytes), avg: Math.round(total / bytes.length), max: Math.max(...bytes) } : null,
    sizes,
    stalls: stallLog.length,
    stallLog,
    mbPerS: mbPerS(total, elapsed * 1000),
  };
}

// --- the probe ---

export interface CameraProbeDeps extends SessionDeps {
  fetch: typeof fetch;
  projectId: string;
  /** Per quality (the plan: 10 s). */
  previewSeconds?: number;
  /** Wait after `setControl previewQuality` before measuring (rebind on the phone). */
  qualitySettleMs?: number;
  decode?: (jpeg: Uint8Array) => Promise<void>;
  /** Preview watchdog (PROTOCOL §7: 3 s). */
  stallMs?: number;
  newReqId?: () => string;
  /** Ping interval while a capture is in flight. */
  capturePingEveryMs?: number;
}

export interface CameraData {
  target: CameraTarget;
  info: { ms: number; cameraId: string; name?: string; bootId: string; protocolVersions: { min: number; max: number } } | null;
  hello: {
    ms: number;
    cameraId: string;
    bootId: string;
    sessionId: string;
    name?: string;
    protocolVersion: number;
    sessionTtlMs?: number;
    rotation: number;
    previewQuality?: string;
  } | null;
  preview: Partial<Record<PreviewQuality, PreviewStats>>;
  captureWithPing: (Omit<CaptureResult, 'frame'> & {
    frameId: string;
    seq: number;
    fullBytes: number;
    pings: number;
    pingsAnsweredDuringCapture: number;
    pingRttMs: { p50: number | null; p95: number | null; max: number | null };
    pingErrors: string[];
  }) | null;
  capture: (Omit<CaptureResult, 'frame'> & { frameId: string; seq: number; full: FrameInfo['full'] }) | null;
  errors: { step: string; error: string }[];
}

async function getInfo(target: CameraTarget, deps: CameraProbeDeps, signal: AbortSignal): Promise<NonNullable<CameraData['info']>> {
  const t0 = deps.now();
  const res = await deps.fetch(`http://${hostPort(target)}/info`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
  if (!res.ok) throw new Error(`GET /info: HTTP ${res.status}`);
  const body = (await res.json()) as { cameraId?: string; name?: string; bootId?: string; protocolVersions?: { min: number; max: number } };
  const ms = Math.round(deps.now() - t0);
  const pv = body.protocolVersions;
  if (!body.cameraId || !body.bootId || !pv) throw new Error(`GET /info: unexpected body ${JSON.stringify(body)}`);
  if (PROTOCOL_VERSION < pv.min || PROTOCOL_VERSION > pv.max) throw new Error(`GET /info: protocol ${pv.min}-${pv.max} does not cover ${PROTOCOL_VERSION}`);
  return { ms, cameraId: body.cameraId, name: body.name, bootId: body.bootId, protocolVersions: pv };
}

/** One capture with pings sent every `everyMs` while it is in flight (PROTOCOL §4.5). */
async function captureWithPings(session: ProbeSession, args: { projectId: string; rotation: number }, deps: CameraProbeDeps, signal: AbortSignal) {
  let inFlight = true;
  const rtts: number[] = [];
  const pingErrors: string[] = [];
  let answeredDuring = 0;
  const capture = captureFrame(session, args, { now: deps.now, signal, newReqId: deps.newReqId }).finally(() => {
    inFlight = false;
  });
  const pings = (async () => {
    while (inFlight) {
      const p0 = deps.now();
      try {
        await session.request('ping', {}, { timeoutMs: 5_000 });
        rtts.push(deps.now() - p0);
        if (inFlight) answeredDuring++;
      } catch (e) {
        pingErrors.push(errorText(e));
      }
      if (inFlight) await sleep(deps.capturePingEveryMs ?? 100).catch(() => {});
    }
  })();
  const [{ frame, ...rest }] = await Promise.all([capture, pings]);
  return {
    frame,
    stats: {
      ...rest,
      frameId: frame.frameId,
      seq: frame.seq,
      fullBytes: frame.full.bytes,
      pings: rtts.length + pingErrors.length,
      pingsAnsweredDuringCapture: answeredDuring,
      pingRttMs: spread(rtts),
      pingErrors,
    },
  };
}

export function cameraProbe(deps: CameraProbeDeps): Probe<ProbeShared> {
  return {
    name: 'camera',
    async run(ctx) {
      const target = resolveTarget(ctx.shared);
      if (!target) throw new ProbeFailure(NO_TARGET);
      const data: CameraData = { target, info: null, hello: null, preview: {}, captureWithPing: null, capture: null, errors: [] };
      const failed = (step: string, e: unknown) => data.errors.push({ step, error: errorText(e) });
      const finish = () => {
        if (data.errors.length) throw new ProbeFailure(data.errors.map((e) => `${e.step}: ${e.error}`).join('; '), data);
        return data;
      };

      try {
        data.info = await getInfo(target, deps, ctx.signal);
      } catch (e) {
        failed('info', e); // a CORS problem only breaks fetch; the sockets may still work
      }

      let session: ProbeSession;
      try {
        session = await openSession(target, deps);
      } catch (e) {
        failed('hello', e);
        return finish();
      }
      const h = session.hello;
      const rotation = h.controls?.rotation ?? 0;
      data.hello = {
        ms: session.helloMs,
        cameraId: h.cameraId,
        bootId: h.bootId,
        sessionId: h.sessionId,
        name: h.name,
        protocolVersion: h.protocolVersion,
        sessionTtlMs: h.sessionTtlMs,
        rotation,
        previewQuality: h.controls?.previewQuality,
      };
      if (data.info && data.info.cameraId !== h.cameraId) failed('info', `cameraId ${data.info.cameraId} ≠ hello ${h.cameraId}`);

      try {
        const offered = h.capabilities?.previewQualities ?? [...QUALITIES];
        const original = h.controls?.previewQuality;
        let current = original;
        const previewUrl = `ws://${hostPort(target)}/ws/preview?session=${encodeURIComponent(h.sessionId)}`;
        for (const q of QUALITIES.filter((x) => offered.includes(x))) {
          throwIfAborted(ctx.signal);
          try {
            if (current !== q) {
              await session.request('setControl', { control: 'previewQuality', value: q });
              current = q;
              await sleep(deps.qualitySettleMs ?? 1_000, ctx.signal);
            }
            const stats = await measurePreview(previewUrl, deps.previewSeconds ?? 10, deps, ctx.signal);
            data.preview[q] = stats;
            if (!stats.frames) failed(`preview.${q}`, 'no frames');
          } catch (e) {
            failed(`preview.${q}`, e);
          }
        }
        if (original && current !== original) {
          await session.request('setControl', { control: 'previewQuality', value: original }).catch((e) => failed('preview.restore', e));
        }

        throwIfAborted(ctx.signal);
        const captured = (ctx.shared.capturedFrameIds ??= []);
        const args = { projectId: deps.projectId, rotation };
        try {
          const r = await captureWithPings(session, args, deps, ctx.signal);
          captured.push(r.frame.frameId);
          data.captureWithPing = r.stats;
          if (r.stats.pingErrors.length) failed('captureWithPing', `ping failed during a capture: ${r.stats.pingErrors[0]}`);
        } catch (e) {
          failed('captureWithPing', e);
        }

        throwIfAborted(ctx.signal);
        try {
          const { frame, ...rest } = await captureFrame(session, args, { now: deps.now, signal: ctx.signal, newReqId: deps.newReqId });
          captured.push(frame.frameId);
          data.capture = { ...rest, frameId: frame.frameId, seq: frame.seq, full: frame.full };
        } catch (e) {
          failed('capture', e);
        }
      } finally {
        session.close();
      }
      return finish();
    },
  };
}
