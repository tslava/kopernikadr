/** The app's sticker library (one per app run) and the WebView urls of its files. */
import { Capacitor } from '@capacitor/core';
import { createAppFileAdapter, type FileAdapter } from '../projects/files';
import { createAppBinaryFiles } from './binaryFiles';
import { StickerLibrary } from './library';

let app: { fs: FileAdapter; library: StickerLibrary } | undefined;

function boot() {
  if (!app) {
    const fs = createAppFileAdapter();
    app = { fs, library: new StickerLibrary({ fs, bin: createAppBinaryFiles(fs) }) };
  }
  return app;
}

export const appStickerLibrary = (): StickerLibrary => boot().library;

/** Best-effort delete of a store-relative file (the picked image in `tmp/`). */
export const removeStoreFile = (path: string): Promise<void> => boot().fs.remove(path).catch(() => undefined);

/** WebView url of a library sticker's 160 px thumbnail. */
export const thumbSrc = async (library: StickerLibrary, id: string): Promise<string> => Capacitor.convertFileSrc(await library.thumbUri(id));
