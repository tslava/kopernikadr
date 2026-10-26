// Loading frame pictures over HTTP: per-request timeout, bounded retries with backoff, and a
// fallback from `play` to `full`. Right after shooting, the camera is still generating the `play`
// variants in the background, so a first request may be slow or fail; a later one succeeds.
// No DOM here: fetch, decode and the clock are injected, so `node --test` drives every path.

/** Export: every frame must really load, or the export is aborted. */
export const EXPORT_POLICY = Object.freeze({ attempts: 4, fullAttempts: 2, timeoutMs: 20_000, backoffMs: [500, 1500, 3000, 5000] });
/** Playback and onion skin: retry briefly, then give up quietly (the next pass tries again). */
export const VIEW_POLICY = Object.freeze({ attempts: 3, fullAttempts: 1, timeoutMs: 10_000, backoffMs: [400, 1000, 2500] });

export const realClock = {
  now: () => (globalThis.performance ?? Date).now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t),
};

export function abortError() {
  return Object.assign(new Error('cancelled'), { name: 'AbortError' });
}

/** A frame that could not be loaded even after all retries and the `full` fallback. */
export class FrameLoadError extends Error {
  constructor(frameId, cause, tries) {
    super(`frame ${frameId}: ${cause?.message ?? 'load failed'} (after ${tries} tries)`);
    this.name = 'FrameLoadError';
    this.code = 'FRAME_LOAD_FAILED';
    this.frameId = frameId;
    this.tries = tries;
    this.cause = cause;
  }
}

/** Delay before retry number `n` (0-based). */
export function retryDelay(policy, n) {
  const b = policy.backoffMs;
  return b.length ? b[Math.min(n, b.length - 1)] : 0;
}

/** Resolves after `ms`, or rejects with AbortError when `signal` aborts. */
export function sleep(ms, { clock = realClock, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clock.clearTimeout(timer); reject(abortError()); };
    const timer = clock.setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** URL of attempt `k` of a variant: retries get a query so no cached failure is reused. */
export function attemptUrl(urlFor, frameId, variant, k) {
  const u = urlFor(frameId, variant);
  return k > 0 ? `${u}${u.includes('?') ? '&' : '?'}retry=${k}` : u;
}

/** One GET with a timeout covering the headers and the body. Resolves a non-empty Blob. */
async function getOnce(url, { fetchImpl, clock, timeoutMs, signal }) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort);
  let timedOut = false;
  const timer = clock.setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const blob = await res.blob();
    if (!blob?.size) throw new Error('empty body');
    return blob;
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw Object.assign(new Error(`no answer within ${timeoutMs} ms`), { timeout: true });
    throw e;
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Loads one frame: `play` up to `policy.attempts` times, then `full` up to `policy.fullAttempts`
 * times (a 404 on `play` goes to `full` at once). Each attempt is fetch + decode with a timeout.
 * @param {string} frameId
 * @param {{urlFor: (id: string, variant: string) => string, fetchImpl?: Function,
 *          decode?: (blob: Blob, variant: 'play'|'full') => Promise<any>, clock?: object, policy?: object,
 *          signal?: AbortSignal, prefer?: 'play'|'full', onRetry?: (info: object) => void}} o
 * @returns {Promise<{value: any, variant: 'play'|'full', tries: number}>} value = decode(blob) (or the Blob)
 * @throws {FrameLoadError} after the last attempt; AbortError when `signal` aborts
 */
export async function loadFrame(frameId, { urlFor, fetchImpl = globalThis.fetch, decode = null, clock = realClock,
  policy = EXPORT_POLICY, signal, prefer = 'play', onRetry } = {}) {
  const plan = prefer === 'full' ? [['full', policy.fullAttempts]] : [['play', policy.attempts], ['full', policy.fullAttempts]];
  let tries = 0;
  let lastError = null;
  let waitBefore = false;
  for (const [variant, max] of plan) {
    for (let k = 0; k < max; k++) {
      if (signal?.aborted) throw abortError();
      if (waitBefore) await sleep(retryDelay(policy, tries - 1), { clock, signal });
      tries++;
      try {
        const blob = await getOnce(attemptUrl(urlFor, frameId, variant, k), { fetchImpl, clock, timeoutMs: policy.timeoutMs, signal });
        const value = decode ? await decode(blob, variant) : blob;
        if (signal?.aborted) {
          value?.close?.();
          throw abortError();
        }
        return { value, variant, tries };
      } catch (e) {
        if (e?.name === 'AbortError' && signal?.aborted) throw e;
        lastError = e;
        onRetry?.({ frameId, variant, tries, error: e });
        waitBefore = e?.status !== 404;
        if (e?.status === 404) break; // no such variant: retrying the same URL will not help
      }
    }
  }
  throw new FrameLoadError(frameId, lastError, tries);
}

/**
 * Retry plan for an <img> showing a frame: attempt `n` (0 = the first load) → the URL to load and
 * the delay before it, or null when the image should give up.
 */
export function imageAttempt(urlFor, frameId, n, policy = VIEW_POLICY) {
  if (n < policy.attempts) return { url: attemptUrl(urlFor, frameId, 'play', n), delayMs: n ? retryDelay(policy, n - 1) : 0 };
  const k = n - policy.attempts;
  if (k < policy.fullAttempts) return { url: attemptUrl(urlFor, frameId, 'full', k), delayMs: retryDelay(policy, n - 1) };
  return null;
}
