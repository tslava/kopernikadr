/**
 * Binary files for the sticker library (plan "Photo stickers"). The `FileAdapter` is text-only and
 * images never pass through `Filesystem.readFile/writeFile` (ARCHITECTURE §5.4). The sticker PNGs
 * are the documented exception, like `videoWriteAt`: they are small (<= ~1 MB), so one base64 write
 * to `tmp/` is fine. They never land in place directly: `tmp/<uuid>.bin` -> size + sha256 ->
 * native `installFile` (atomic, verified rename). `installFile` is idempotent, so a copy that is
 * repeated after a crash heals itself (`ALREADY_INSTALLED` is success). `tmp/` is emptied by the
 * startup sweep, so a leftover tmp file after a crash costs nothing.
 */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { KopernikadrNative, type InstallResult } from '../native';
import { ROOT, type FileAdapter } from '../projects/files';

export interface Installed {
  bytes: number;
  sha256: string;
}

export interface BinaryFiles {
  /** Encodes `blob` into `dest` (store-relative) atomically; resolves with its size and sha256. */
  writeBinary(dest: string, blob: Blob): Promise<Installed>;
  /** Copies the store-relative file `src` to `dest` atomically; idempotent. */
  copyFile(src: string, dest: string): Promise<Installed>;
}

/** The raw platform calls, injected so the logic is testable without Capacitor. */
export interface BinaryIO {
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  /** `Filesystem.copy` inside the store. */
  copy(from: string, to: string): Promise<void>;
  installFile(o: { tmp: string; dest: string; bytes: number; sha256: string }): Promise<InstallResult>;
  sha256(bytes: Uint8Array): Promise<string>;
  uuid(): string;
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export function createBinaryFiles(fs: FileAdapter, io: BinaryIO): BinaryFiles {
  async function install(tmp: string, dest: string, bytes: Uint8Array): Promise<Installed> {
    const info: Installed = { bytes: bytes.length, sha256: await io.sha256(bytes) };
    try {
      const dir = dirOf(dest);
      if (dir) await fs.mkdir(dir);
      await io.installFile({ tmp, dest, ...info });
      return info;
    } catch (e) {
      await fs.remove(tmp).catch(() => undefined);
      throw e;
    }
  }
  return {
    async writeBinary(dest, blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const tmp = `tmp/${io.uuid()}.bin`;
      await io.writeBytes(tmp, bytes);
      return install(tmp, dest, bytes);
    },
    async copyFile(src, dest) {
      const tmp = `tmp/${io.uuid()}.bin`;
      await io.copy(src, tmp);
      let bytes: Uint8Array;
      try {
        bytes = await io.readBytes(tmp);
      } catch (e) {
        await fs.remove(tmp).catch(() => undefined);
        throw e;
      }
      return install(tmp, dest, bytes);
    },
  };
}

const inData = (path: string) => ({ directory: Directory.Data, path: `${ROOT}/${path}` });

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The app implementation: `Filesystem` for tmp + copy, `KopernikadrNative.installFile` for the move. */
export function createAppBinaryIO(): BinaryIO {
  return {
    async writeBytes(path, bytes) {
      await Filesystem.writeFile({ ...inData(path), data: toBase64(bytes), recursive: true });
    },
    async readBytes(path) {
      const r = await Filesystem.readFile(inData(path));
      return typeof r.data === 'string' ? fromBase64(r.data) : new Uint8Array(await r.data.arrayBuffer());
    },
    async copy(from, to) {
      await Filesystem.copy({
        from: `${ROOT}/${from}`,
        to: `${ROOT}/${to}`,
        directory: Directory.Data,
        toDirectory: Directory.Data,
      });
    },
    installFile: async (o) => (await KopernikadrNative.installFile(o)).result,
    sha256: sha256Hex,
    uuid: () => crypto.randomUUID(),
  };
}

export const createAppBinaryFiles = (fs: FileAdapter): BinaryFiles => createBinaryFiles(fs, createAppBinaryIO());
