// The app's TransferIO: Capacitor Filesystem + FileTransfer + KopernikadrNative. Device-only (no unit
// test); everything that decides anything lives in queue.ts / ack.ts / download.ts.
import { Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { KopernikadrNative } from '../native';
import { DownloadError, type TransferIO } from './download';

const inData = (path: string) => ({ directory: Directory.Data, path: `kopernikadr/${path}` });
const msg = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

/** FileTransfer rejects with `{code, message, httpStatus?}` (also under `data`). */
function toDownloadError(e: unknown): unknown {
  const o = e as { httpStatus?: unknown; data?: { httpStatus?: unknown } } | null;
  const status = o?.httpStatus ?? o?.data?.httpStatus;
  if (typeof status === 'number') return new DownloadError('http', msg(e), { status });
  return e;
}

export function createAppTransferIO(): TransferIO {
  return {
    async freeBytes() {
      return (await KopernikadrNative.freeBytes()).bytes;
    },
    async mkdir(dir) {
      try {
        await Filesystem.mkdir({ ...inData(dir), recursive: true });
      } catch (e) {
        if (!/already exists/i.test(msg(e))) throw e;
      }
    },
    async download(url, tmpPath) {
      const uri = (await Filesystem.getUri(inData(tmpPath))).uri;
      try {
        await FileTransfer.downloadFile({ url, path: uri });
      } catch (e) {
        throw toDownloadError(e);
      }
    },
    installFile: (o) => KopernikadrNative.installFile(o),
    async moveCache(tmpPath, dest) {
      await Filesystem.rename({ from: `kopernikadr/${tmpPath}`, to: `kopernikadr/${dest}`, directory: Directory.Data, toDirectory: Directory.Data });
    },
    async validateJpeg(path) {
      const uri = (await Filesystem.getUri(inData(path))).uri;
      const res = await fetch(Capacitor.convertFileSrc(uri));
      if (!res.ok) return false;
      const blob = await res.blob();
      if (blob.size === 0) return false;
      const bmp = await createImageBitmap(blob);
      bmp.close();
      return true;
    },
    async remove(path) {
      try {
        await Filesystem.deleteFile(inData(path));
      } catch (e) {
        if (!/does not exist|not exist|no such file|not found|ENOENT/i.test(msg(e))) throw e;
      }
    },
  };
}
