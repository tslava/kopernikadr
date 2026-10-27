// `videoFrame` probe: the `full` the download probe installed → `fetch(convertFileSrc)` →
// `createImageBitmap` → `new VideoFrame` → close; then the same at the export size (1440×1080
// resize in createImageBitmap, as the export pipeline decodes it).
import { ProbeFailure, ProbeSkip, type Probe } from './runner';
import type { ProbeShared } from './shared';

export const EXPORT_SIZE = { w: 1440, h: 1080 } as const;

export interface BitmapLike {
  width: number;
  height: number;
  close(): void;
}

export interface VideoFrameLike {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  format: string | null;
  close(): void;
}

export interface VideoFrameDeps {
  native: boolean;
  /** `fetch(Capacitor.convertFileSrc(uri)).then(r => r.blob())`. */
  readBlob(uri: string): Promise<Blob>;
  createImageBitmap(blob: Blob, opts?: { resizeWidth?: number; resizeHeight?: number }): Promise<BitmapLike>;
  /** The `VideoFrame` constructor (undefined if WebCodecs is missing). */
  VideoFrame: (new (image: BitmapLike, init: { timestamp: number }) => VideoFrameLike) | undefined;
  now: () => number;
}

interface Decoded {
  bitmap: { w: number; h: number };
  frame: { codedWidth: number; codedHeight: number; displayWidth: number; displayHeight: number; format: string | null };
  decodeMs: number;
  frameMs: number;
}

export function videoFrameProbe(deps: VideoFrameDeps): Probe<ProbeShared> {
  const { now } = deps;

  async function decode(blob: Blob, resize?: { resizeWidth: number; resizeHeight: number }): Promise<Decoded> {
    const Ctor = deps.VideoFrame;
    if (!Ctor) throw new Error('VideoFrame is not available');
    const t0 = now();
    const bitmap = await deps.createImageBitmap(blob, resize);
    try {
      const decodeMs = Math.round(now() - t0);
      const t1 = now();
      const vf = new Ctor(bitmap, { timestamp: 0 });
      try {
        return {
          bitmap: { w: bitmap.width, h: bitmap.height },
          frame: { codedWidth: vf.codedWidth, codedHeight: vf.codedHeight, displayWidth: vf.displayWidth, displayHeight: vf.displayHeight, format: vf.format },
          decodeMs,
          frameMs: Math.round(now() - t1),
        };
      } finally {
        vf.close();
      }
    } finally {
      bitmap.close();
    }
  }

  return {
    name: 'videoFrame',
    async run(ctx) {
      const file = ctx.shared.downloaded;
      if (!file) throw new ProbeSkip(deps.native ? 'no-input' : 'native-only');
      const t0 = now();
      const blob = await deps.readBlob(file.uri);
      const data: { frameId: string; blobBytes: number; readMs: number; full?: Decoded; exportSize?: Decoded } = {
        frameId: file.frameId,
        blobBytes: blob.size,
        readMs: Math.round(now() - t0),
      };
      if (blob.size !== file.bytes) throw new ProbeFailure(`read ${blob.size} bytes, expected ${file.bytes}`, data);

      data.full = await decode(blob);
      const { w, h } = data.full.bitmap;
      if (!(w > 0 && h > 0) || data.full.frame.displayWidth !== w || data.full.frame.displayHeight !== h) {
        throw new ProbeFailure(`VideoFrame ${data.full.frame.displayWidth}×${data.full.frame.displayHeight} ≠ bitmap ${w}×${h}`, data);
      }
      data.exportSize = await decode(blob, { resizeWidth: EXPORT_SIZE.w, resizeHeight: EXPORT_SIZE.h });
      const f = data.exportSize.frame;
      if (f.displayWidth !== EXPORT_SIZE.w || f.displayHeight !== EXPORT_SIZE.h) {
        throw new ProbeFailure(`resized VideoFrame ${f.displayWidth}×${f.displayHeight} ≠ ${EXPORT_SIZE.w}×${EXPORT_SIZE.h}`, data);
      }
      return data;
    },
  };
}
