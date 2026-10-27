// `ExportWriter` over the KopernikadrNative MP4 writer (ARCHITECTURE §5.1, §5.7): one temp file in
// `exports/`, positional writes as base64 over the Capacitor bridge, then close → publish, or abort.
import { KopernikadrNative, toBase64, type KopernikadrNativePlugin } from '../native';
import type { ExportWriter } from './mediabunnyExport';

/** One bridge call carries at most this many bytes (~1.4 MB of base64). */
export const NATIVE_WRITE_CHUNK = 1 << 20;

export type NativeVideoPlugin = Pick<
  KopernikadrNativePlugin,
  'videoOpen' | 'videoWriteAt' | 'videoClose' | 'videoPublish' | 'videoAbort'
>;

export interface NativeWriter extends ExportWriter {
  /** Set after `open`. */
  readonly handle: string | undefined;
  /** App-relative temp path, set after `open` (diagnostics). */
  readonly path: string | undefined;
}

export function createNativeWriter(
  { plugin = KopernikadrNative, chunkBytes = NATIVE_WRITE_CHUNK }: { plugin?: NativeVideoPlugin; chunkBytes?: number } = {},
): NativeWriter {
  if (!(Number.isInteger(chunkBytes) && chunkBytes > 0)) throw new RangeError(`bad chunkBytes: ${chunkBytes}`);
  let handle: string | undefined;
  let path: string | undefined;
  const need = () => {
    if (handle === undefined) throw new Error('native video writer is not open');
    return handle;
  };
  return {
    get handle() {
      return handle;
    },
    get path() {
      return path;
    },
    async open() {
      if (handle !== undefined) throw new Error('native video writer is already open');
      const r = await plugin.videoOpen();
      handle = r.handle;
      path = r.path;
    },
    async writeAt(position, bytes) {
      const h = need();
      // Sequential: each call is awaited, so native I/O speed is the backpressure.
      for (let off = 0; off < bytes.byteLength; off += chunkBytes) {
        const part = bytes.subarray(off, Math.min(off + chunkBytes, bytes.byteLength));
        await plugin.videoWriteAt({ handle: h, position: position + off, data: toBase64(part) });
      }
    },
    async close() {
      await plugin.videoClose({ handle: need() });
    },
    async publish(displayName) {
      const { uri } = await plugin.videoPublish({ handle: need(), displayName });
      return { uri };
    },
    async abort() {
      // Nothing to delete before a successful open; native abort is idempotent.
      if (handle !== undefined) await plugin.videoAbort({ handle });
    },
  };
}
