// Probe runner (stage 0b): runs the diagnostics probes one after another with injected adapters,
// so the logic is tested without a device. A failing probe never stops the run; keep-awake is held
// for the whole run so the tablet doesn't sleep during the long ones (preview, export).

/** One probe's outcome as it lands in the report. `skipped` = neither a pass nor a failure. */
export interface ProbeResult {
  name: string;
  ok: boolean;
  ms: number;
  data: unknown;
  error?: string;
  /** Why the probe did not really run: `native-only`, `cancelled`, `user`, `no-input`, … */
  skipped?: string;
}

/** The interactive steps a probe can ask the parent to do (Diagnostics shows the text). */
export type PromptKey = 'lockScreen' | 'unlockScreen' | 'closeCamera' | 'startCamera';
export type PromptAnswer = 'next' | 'skip';
export type PromptFn = (key: PromptKey) => Promise<PromptAnswer>;

export interface ProbeContext<S> {
  /** Aborted when the parent taps Stop; long waits should end early. */
  signal: AbortSignal;
  /** State handed from one probe to the next (camera address, downloaded file, …). */
  shared: S;
  /** Results of the probes that already ran in this run. */
  results: readonly ProbeResult[];
  prompt: PromptFn;
}

export interface Probe<S> {
  name: string;
  /** Resolves with the result data; throws to fail (ProbeFailure keeps partial data) or skip (ProbeSkip). */
  run(ctx: ProbeContext<S>): Promise<unknown>;
}

/** A failure that still carries what was measured before it. */
export class ProbeFailure extends Error {
  constructor(
    message: string,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = 'ProbeFailure';
  }
}

/** The probe could not run here (e.g. `native-only` in a plain browser); `data` is optional. */
export class ProbeSkip extends Error {
  constructor(
    readonly reason: string,
    readonly data: unknown = null,
  ) {
    super(`skipped: ${reason}`);
    this.name = 'ProbeSkip';
  }
}

/** Keeps the screen on (`@capacitor-community/keep-awake` in the app). */
export interface KeepAwakeAdapter {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export type ProbeUpdate = { name: string; state: 'running' } | { name: string; state: 'done'; result: ProbeResult };

export interface RunOptions<S> {
  shared: S;
  keepAwake?: KeepAwakeAdapter;
  signal?: AbortSignal;
  prompt?: PromptFn;
  onUpdate?: (u: ProbeUpdate) => void;
  now?: () => number;
  wallClock?: () => Date;
}

export interface RunReport {
  startedAt: string;
  durationMs: number;
  cancelled: boolean;
  keepAwake: { held: boolean; error?: string; releaseError?: string };
  results: ProbeResult[];
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

// Error names whose message already says everything.
const PLAIN = new Set(['Error', 'ProbeFailure', 'ProbeSkip', 'ProtocolError']);

/** A one-line description of anything thrown (keeps a Capacitor/native `code`). */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) {
    const msg = (e as { message?: unknown } | null)?.message;
    return typeof msg === 'string' ? msg : String(e);
  }
  let text = PLAIN.has(e.name) ? e.message : `${e.name}: ${e.message}`;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && code && !text.includes(code)) text = `${code}: ${text}`;
  return text;
}

export function summarize(results: readonly ProbeResult[]): Summary {
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  return { total: results.length, passed, failed: results.length - passed - skipped, skipped };
}

/** Runs `probes` sequentially. Never throws for a probe's failure. */
export async function runProbes<S>(probes: readonly Probe<S>[], opts: RunOptions<S>): Promise<RunReport> {
  const now = opts.now ?? (() => performance.now());
  const signal = opts.signal ?? new AbortController().signal;
  const prompt: PromptFn = opts.prompt ?? (async () => 'skip');
  const startedAt = (opts.wallClock ?? (() => new Date()))().toISOString();
  const t0 = now();
  const results: ProbeResult[] = [];

  const keepAwake: RunReport['keepAwake'] = { held: false };
  if (opts.keepAwake) {
    try {
      await opts.keepAwake.acquire();
      keepAwake.held = true;
    } catch (e) {
      keepAwake.error = errorText(e);
    }
  } else {
    keepAwake.error = 'no keep-awake adapter';
  }

  try {
    for (const probe of probes) {
      let result: ProbeResult;
      if (signal.aborted) {
        result = { name: probe.name, ok: false, ms: 0, data: null, skipped: 'cancelled' };
      } else {
        opts.onUpdate?.({ name: probe.name, state: 'running' });
        result = await runOne(probe, { signal, shared: opts.shared, results: [...results], prompt }, now);
      }
      results.push(result);
      opts.onUpdate?.({ name: probe.name, state: 'done', result });
    }
  } finally {
    if (opts.keepAwake) {
      try {
        await opts.keepAwake.release();
      } catch (e) {
        keepAwake.releaseError = errorText(e);
      }
    }
  }

  return { startedAt, durationMs: Math.round(now() - t0), cancelled: signal.aborted, keepAwake, results };
}

async function runOne<S>(probe: Probe<S>, ctx: ProbeContext<S>, now: () => number): Promise<ProbeResult> {
  const t = now();
  const ms = () => Math.round(now() - t);
  try {
    const data = await probe.run(ctx);
    return { name: probe.name, ok: true, ms: ms(), data: data ?? null };
  } catch (e) {
    const elapsed = ms();
    if (e instanceof ProbeSkip) return { name: probe.name, ok: false, ms: elapsed, data: e.data, skipped: e.reason };
    const data = e instanceof ProbeFailure ? e.data : null;
    if (ctx.signal.aborted) return { name: probe.name, ok: false, ms: elapsed, data, skipped: 'cancelled', error: errorText(e) };
    return { name: probe.name, ok: false, ms: elapsed, data, error: errorText(e) };
  }
}
