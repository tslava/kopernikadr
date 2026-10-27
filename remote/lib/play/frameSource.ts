// Loads a project frame as an ImageBitmap for playback (and, later, export). UI-free: the URL
// mapping and the browser primitives are injected.

export type FrameKind = 'play' | 'full';
export type FrameUrl = (projectId: string, frameId: string, kind: FrameKind) => string;

export const PLAY_WIDTH = 1440;
export const PLAY_HEIGHT = 1080;

export interface FrameSourceOptions {
  /** The app uses `Capacitor.convertFileSrc(<file uri>)`. */
  frameUrl: FrameUrl;
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'blob'>>;
  createImageBitmap?: (blob: Blob, opts?: { resizeWidth: number; resizeHeight: number }) => Promise<ImageBitmap>;
  width?: number;
  height?: number;
}

export interface FrameSource {
  /** Local `play` (already 1440x1080) if it loads, else `full` resized to 1440x1080. The caller closes the bitmap. */
  load(projectId: string, frameId: string, signal?: AbortSignal): Promise<ImageBitmap>;
}

export function createFrameSource(o: FrameSourceOptions): FrameSource {
  const doFetch = o.fetch ?? ((url, init) => fetch(url, init));
  const decode = o.createImageBitmap ?? ((blob, opts) => createImageBitmap(blob, opts));
  const width = o.width ?? PLAY_WIDTH;
  const height = o.height ?? PLAY_HEIGHT;

  async function blobOf(url: string, signal?: AbortSignal): Promise<Blob> {
    const res = await doFetch(url, { signal });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res.blob();
  }

  return {
    async load(projectId, frameId, signal) {
      try {
        return await decode(await blobOf(o.frameUrl(projectId, frameId, 'play'), signal));
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      const blob = await blobOf(o.frameUrl(projectId, frameId, 'full'), signal);
      return decode(blob, { resizeWidth: width, resizeHeight: height });
    },
  };
}
