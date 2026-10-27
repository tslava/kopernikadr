/**
 * Download plumbing for Transfer A (ARCHITECTURE §5.6): the IO seam, the deadline + abort pattern
 * from the 0b `download` probe, and error classification. No state, no store.
 *
 * The native download (`@capacitor/file-transfer`) cannot be cancelled: on a deadline or a cancel the
 * caller stops waiting at once, and the tmp file is deleted only after the native call settles.
 * Every attempt uses its OWN tmp name, so a late write of an abandoned attempt never touches a new one.
 */
import { nativeErrorCode } from '../native';
import { raceAbort } from '../probes/util';

export const RESERVE_BYTES = 300 * 1024 * 1024;
export const CACHE_SLACK_BYTES = 1024 * 1024;
/** A 3264x2448 JPEG is 2-4 MB; far beyond any healthy Wi-Fi download of one. */
export const FULL_TIMEOUT_MS = 60_000;
export const CACHE_TIMEOUT_MS = 20_000;

/** Everything Transfer needs from the platform (tests pass a fake). Paths are `filesDir/kopernikadr/`-relative. */
export interface TransferIO {
  freeBytes(): Promise<number>;
  /** Creates the directory and its parents; no error when it exists. */
  mkdir(dir: string): Promise<void>;
  /** `FileTransfer.downloadFile`. Rejects with `DownloadError` (or anything: see `classify`). Not cancellable. */
  download(url: string, tmpPath: string): Promise<void>;
  /** `KopernikadrNative.installFile`: verifies size + sha256 natively (`CHECKSUM_MISMATCH`). */
  installFile(o: { tmp: string; dest: string; bytes: number; sha256: string }): Promise<unknown>;
  /** Atomic rename of a downloaded cache file over `dest` (no hash exists for `play`/`thumb`). */
  moveCache(tmpPath: string, dest: string): Promise<void>;
  /** Cache check: non-empty and decodes as an image. */
  validateJpeg(path: string): Promise<boolean>;
  /** Idempotent, best effort. */
  remove(path: string): Promise<void>;
}

export type DownloadErrorKind = 'http' | 'network' | 'timeout' | 'no_space' | 'cancelled';

export class DownloadError extends Error {
  constructor(
    readonly kind: DownloadErrorKind,
    message: string,
    readonly extra: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'DownloadError';
  }
  get status(): number | undefined {
    return this.extra.status;
  }
}

export type Variant = 'full' | 'play' | 'thumb';

export function frameUrl(target: { host: string; port: number }, frameId: string, variant: Variant): string {
  const h = target.host.includes(':') ? `[${target.host.replace(/%/g, '%25')}]` : target.host;
  return `http://${h}:${target.port}/frames/${encodeURIComponent(frameId)}/${variant}.jpg`;
}

const msg = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

export function isNoSpace(e: unknown): boolean {
  if (e instanceof DownloadError) return e.kind === 'no_space';
  if (nativeErrorCode(e) === 'NO_SPACE') return true;
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ENOSPC' || /ENOSPC|No space left|NO_SPACE/i.test(`${typeof code === 'string' ? code : ''} ${msg(e)}`);
}

export type Failure =
  | { kind: 'no_space' }
  | { kind: 'cancelled' }
  | { kind: 'http'; status: number; retryAfterMs?: number }
  | { kind: 'mismatch' }
  | { kind: 'missing' } // installFile NOT_FOUND: the tmp file vanished
  | { kind: 'network' } // includes timeout and every unknown error
  | { kind: 'other'; detail: string };

/** Maps any rejection of download/install to a retry class. */
export function classify(e: unknown): Failure {
  if (isNoSpace(e)) return { kind: 'no_space' };
  if (e instanceof DownloadError) {
    if (e.kind === 'cancelled') return { kind: 'cancelled' };
    if (e.kind === 'http') return { kind: 'http', status: e.status ?? 0, ...(e.extra.retryAfterMs !== undefined ? { retryAfterMs: e.extra.retryAfterMs } : {}) };
    return { kind: 'network' };
  }
  const code = nativeErrorCode(e);
  if (code === 'CHECKSUM_MISMATCH') return { kind: 'mismatch' };
  if (code === 'NOT_FOUND') return { kind: 'missing' };
  if (code !== undefined) return { kind: 'other', detail: code };
  return { kind: 'network' };
}

export function describeFailure(f: Failure): string {
  switch (f.kind) {
    case 'http':
      return `http ${f.status}`;
    case 'other':
      return f.detail;
    default:
      return f.kind;
  }
}

/**
 * `io.download` bounded by `timeoutMs` and `cancel`. Resolves when the file is complete in `tmp`.
 * Rejects with `DownloadError('cancelled')` / `('timeout')` (the file is then removed once the
 * native call settles) or with the download's own error (the file is removed at once).
 */
export async function downloadWithDeadline(
  io: Pick<TransferIO, 'download' | 'remove'>,
  url: string,
  tmp: string,
  opts: { cancel: AbortSignal; timeoutMs: number },
): Promise<void> {
  const signal = AbortSignal.any([opts.cancel, AbortSignal.timeout(opts.timeoutMs)]);
  const call = io.download(url, tmp);
  try {
    await raceAbort(call, signal);
  } catch (e) {
    if (signal.aborted) {
      void call
        .catch(() => {})
        .then(() => io.remove(tmp))
        .catch(() => {});
      throw new DownloadError(opts.cancel.aborted ? 'cancelled' : 'timeout', opts.cancel.aborted ? 'cancelled' : `no data within ${opts.timeoutMs} ms`);
    }
    await io.remove(tmp).catch(() => {});
    throw e;
  }
}
