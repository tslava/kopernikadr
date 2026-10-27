// TS facade of the in-app Capacitor plugin `KopernikadrNative` (Kotlin:
// android/app/src/main/java/pl/slava/kopernikadr/remote/native/, ARCHITECTURE §5.1, §5.7).
// All paths are relative to `filesDir/kopernikadr/` (`tmp/…`, `exports/…`, `probe/…`).
// Android only: on the web every call rejects with Capacitor's "not implemented".
import { registerPlugin } from '@capacitor/core';

/** `code` of a rejected call (Kotlin `NativeErrorCode`). */
export type NativeErrorCode =
  /** Not a safe path under `filesDir/kopernikadr/`, or the target is a directory. */
  | 'PATH_INVALID'
  /** Missing or malformed argument (bad type, negative size/position, bad sha256/base64/displayName). */
  | 'BAD_ARGUMENT'
  /** `installFile`: neither the tmp file nor a valid dest exists; `videoPublish`: the temp file is gone. */
  | 'NOT_FOUND'
  /** `installFile`: the tmp file's size or sha256 differs. */
  | 'CHECKSUM_MISMATCH'
  /** ENOSPC, or free space below the reserve (300 MB for `videoWriteAt` and `videoPublish`). */
  | 'NO_SPACE'
  /** Unknown video handle, or the wrong state (e.g. `videoPublish` on an open handle). */
  | 'BAD_HANDLE'
  /** The handle was closed or aborted (or its close failed). */
  | 'CLOSED'
  /** Any other I/O or provider failure. */
  | 'IO';

export const NATIVE_ERROR_CODES: readonly NativeErrorCode[] = [
  'PATH_INVALID',
  'BAD_ARGUMENT',
  'NOT_FOUND',
  'CHECKSUM_MISMATCH',
  'NO_SPACE',
  'BAD_HANDLE',
  'CLOSED',
  'IO',
];

export type InstallResult = 'INSTALLED' | 'ALREADY_INSTALLED';

export interface KopernikadrNativePlugin {
  /** tmp → fsync → rename over `path` → fsync dir; never deletes the target first. */
  writeTextAtomic(options: { path: string; text: string }): Promise<void>;

  /** Idempotent verified move of a downloaded file (`sha256`: 64 hex chars). */
  installFile(options: {
    tmp: string;
    dest: string;
    bytes: number;
    sha256: string;
  }): Promise<{ result: InstallResult }>;

  /** Free bytes on the filesystem of `path` (the app root if omitted). */
  freeBytes(options?: { path?: string }): Promise<{ bytes: number }>;

  /** Creates `exports/export-<handle>.mp4` for positional writes. */
  videoOpen(): Promise<{ handle: string; path: string }>;

  /** Writes base64 `data` at byte `position` (out of order and overlapping allowed). */
  videoWriteAt(options: { handle: string; position: number; data: string }): Promise<void>;

  /** fsync + close. Idempotent. */
  videoClose(options: { handle: string }): Promise<void>;

  /**
   * Copies a **closed** handle's file into the gallery (`Movies/Kopernikadr/`, name forced to
   * `kopernikadr-<displayName>.mp4`) and deletes the temp file. On failure the temp file stays
   * (retry, or `videoAbort`).
   */
  videoPublish(options: { handle: string; displayName: string }): Promise<{ uri: string }>;

  /** Opens a published gallery video (`content://` uri) in the system player. `NOT_FOUND`: no player. */
  videoView(options: { uri: string }): Promise<void>;

  /** Closes and deletes the temp file. Idempotent. */
  videoAbort(options: { handle: string }): Promise<void>;

  /** Startup sweep: every file in `exports/` without a live handle + our own pending gallery rows. */
  videoCleanupAbandoned(): Promise<{ deletedFiles: number; deletedRows: number }>;

  /** Debug builds only: inserts an empty pending gallery row (the emulator cleanup check). */
  __testInsertPending(options?: { displayName?: string }): Promise<{ uri: string }>;
}

export const KopernikadrNative = registerPlugin<KopernikadrNativePlugin>('KopernikadrNative');

/** The `NativeErrorCode` of a rejection from this plugin, or undefined for any other error. */
export function nativeErrorCode(err: unknown): NativeErrorCode | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (NATIVE_ERROR_CODES as readonly string[]).includes(code)
    ? (code as NativeErrorCode)
    : undefined;
}

// 0x8000 arguments per String.fromCharCode call stays far below engine argument limits.
const CHUNK = 0x8000;

/** Standard padded base64 of `bytes` (for `videoWriteAt`); safe for multi-MB arrays. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return btoa(parts.join(''));
}
