/**
 * Decodes a picked image in the WebView: an `<img>` (EXIF orientation applied by the browser) drawn
 * to a canvas at most `maxSide` on the long side. The url comes from the file-URL helper
 * (`resolveFrameBaseUri` + `convertFileSrc`, like the frames).
 */
import { Capacitor } from '@capacitor/core';
import { resolveFrameBaseUri } from '../app/frames';
import { MAX_STICKER_PX, type Img } from './stickerize';

/** Any pixel that is not (nearly) opaque: a PNG/WebP with a cut-out already (no segmenter needed). */
export function hasTransparency(img: Img, maxAlpha = 250): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < maxAlpha) return true;
  return false;
}

/** Store-relative `tmp/...` path -> a URL the WebView can load. */
export async function storeFileUrl(path: string): Promise<string> {
  const base = (await resolveFrameBaseUri()).replace(/\/+$/, '');
  return Capacitor.convertFileSrc(`${base}/${path}`);
}

/** The picture as PNG bytes (to hand it to the native side again). */
export async function encodePng(img: Img): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('encodePng: no 2d context');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

export async function decodeImage(url: string, maxSide: number = MAX_STICKER_PX): Promise<Img> {
  const el = new Image();
  el.src = url;
  await el.decode();
  const scale = Math.min(1, maxSide / Math.max(el.naturalWidth, el.naturalHeight));
  const width = Math.max(1, Math.round(el.naturalWidth * scale));
  const height = Math.max(1, Math.round(el.naturalHeight * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('decodeImage: no 2d context');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(el, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { width, height, data };
}
