// Small helpers shared by the probes: waiting, stats, hashing.

/** Resolves after `ms`, or rejects at once when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  return e;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Nearest-rank percentile of an ascending array (null if empty). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** One decimal. */
export const round1 = (x: number) => Math.round(x * 10) / 10;

/** p50/p95/max of a sample, rounded to 0.1. */
export function spread(values: readonly number[]): { p50: number | null; p95: number | null; max: number | null } {
  const s = [...values].sort((a, b) => a - b);
  const r = (x: number | null) => (x == null ? null : round1(x));
  return { p50: r(percentile(s, 50)), p95: r(percentile(s, 95)), max: r(s.at(-1) ?? null) };
}

/** Lowercase hex SHA-256 via WebCrypto (`crypto.subtle` exists in secure contexts and in Node). */
export async function sha256Hex(bytes: Uint8Array, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** MB/s (10^6 bytes) with one decimal; null for a zero duration. */
export function mbPerS(bytes: number, ms: number): number | null {
  return ms > 0 ? round1(bytes / 1e6 / (ms / 1000)) : null;
}
