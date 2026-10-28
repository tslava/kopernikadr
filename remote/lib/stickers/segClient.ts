/**
 * Web side of one native segmenter session (`segOpen` / `segRun` / `segClose`, plan "Photo
 * stickers"). The native side is one slow single-thread worker, so:
 * - calls are serialized;
 * - a newer `run` supersedes a queued one (its promise rejects with [SegSupersededError]); a run that
 *   already started always finishes and resolves, the caller drops it when it is stale;
 * - rejections become a [SegError] with the native error code (`UNKNOWN` for anything else);
 * - `close` is idempotent and is what a dispose, cancel or save calls.
 * The mask is read as raw `width * height` uint8 bytes through the WebView file url of the session file.
 */
import { KopernikadrNative, nativeErrorCode, type NativeErrorCode, type SegStrokeArg } from '../native';
import { storeFileUrl } from './imageDecode';

export type { SegStrokeArg } from '../native';

export interface SegImage {
  /** Store-relative path of the exact image the mask refers to (`tmp/seg-<handle>.png`). */
  image: string;
  width: number;
  height: number;
  /** The image already has a cut-out (alpha < 250 somewhere): skip the segmenter and `close`. */
  hasAlpha: boolean;
}

export interface SegMaskResult {
  /** `width * height` bytes, confidence x 255. */
  mask: Uint8Array;
  width: number;
  height: number;
  ms: number;
  delegate: 'gpu' | 'cpu';
}

export interface SegClient {
  /** Decodes `path` (a picked or captured image in `tmp/`) and opens the session; closes a previous one first. */
  open(path: string, maxSide?: number): Promise<SegImage>;
  /** The whole stroke list every time (the native side keeps no stroke state). */
  run(strokes: SegStrokeArg[]): Promise<SegMaskResult>;
  /**
   * Starts the engine in the background (creating it and binding the picture is 4-8 s on a tablet): a
   * tiny dummy run in the picture centre whose result is discarded. It goes through the same queue,
   * so a real `run` made meanwhile waits for it and then reuses the warm engine. Never rejects.
   */
  warm(): Promise<void>;
  /**
   * Idempotent; never rejects. With `image` (the `SegImage.image` an `open` returned) it closes only the
   * session that open made: when another `open` has replaced it meanwhile, nothing happens.
   */
  close(image?: string): Promise<void>;
}

/** The warm-up stroke: one point in the middle of the picture. */
export const WARM_STROKE: SegStrokeArg = { mode: 'add', points: [[0.5, 0.5]] };

export class SegError extends Error {
  constructor(
    readonly code: NativeErrorCode | 'UNKNOWN',
    message: string,
  ) {
    super(message);
    this.name = 'SegError';
  }
}

/** A queued `run` replaced by a newer one before it started. Not a failure: ignore it. */
export class SegSupersededError extends Error {
  constructor() {
    super('segmentation superseded by a newer run');
    this.name = 'SegSupersededError';
  }
}

export interface SegDeps {
  native: {
    segOpen: typeof KopernikadrNative.segOpen;
    segRun: typeof KopernikadrNative.segRun;
    segClose: typeof KopernikadrNative.segClose;
  };
  /** Bytes of a store-relative file (`tmp/seg-<handle>.mask`); it is overwritten each run, so never cached. */
  readBytes(path: string): Promise<Uint8Array>;
}

let reads = 0;

const appDeps = (): SegDeps => ({
  native: KopernikadrNative,
  async readBytes(path) {
    const url = `${await storeFileUrl(path)}?r=${++reads}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`reading ${path}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
});

const toSegError = (e: unknown): SegError =>
  e instanceof SegError ? e : new SegError(nativeErrorCode(e) ?? 'UNKNOWN', e instanceof Error ? e.message : String(e));

export function createSegClient(deps: SegDeps = appDeps()): SegClient {
  let tail: Promise<unknown> = Promise.resolve();
  let handle: string | undefined;
  /** `SegImage.image` of the session `handle` belongs to. */
  let handleImage: string | undefined;
  /** The run waiting in the queue (not started yet), if any. */
  let queued: { superseded: boolean; cancel(): void } | undefined;

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => undefined);
    return p;
  };

  const closeNow = async (): Promise<void> => {
    const h = handle;
    handle = undefined;
    handleImage = undefined;
    if (h === undefined) return;
    try {
      await deps.native.segClose({ handle: h });
    } catch {
      // best effort: the native idle timeout and the tmp sweep clean up anyway
    }
  };

  return {
    open(path, maxSide) {
      queued?.cancel();
      return enqueue(async () => {
        await closeNow();
        try {
          const o = await deps.native.segOpen(maxSide === undefined ? { path } : { path, maxSide });
          handle = o.handle;
          handleImage = o.image;
          return { image: o.image, width: o.width, height: o.height, hasAlpha: o.hasAlpha };
        } catch (e) {
          throw toSegError(e);
        }
      });
    },

    run(strokes) {
      return new Promise<SegMaskResult>((resolve, reject) => {
        queued?.cancel();
        const job = {
          superseded: false,
          cancel() {
            job.superseded = true;
            reject(new SegSupersededError());
          },
        };
        queued = job;
        void enqueue(async () => {
          if (queued === job) queued = undefined;
          if (job.superseded) return;
          const h = handle;
          if (h === undefined) throw new SegError('NO_SESSION', 'no open segmenter session');
          try {
            const r = await deps.native.segRun({ handle: h, strokes });
            const mask = await deps.readBytes(r.mask);
            if (mask.length !== r.width * r.height) {
              throw new SegError('SEG_FAILED', `mask is ${mask.length} bytes, expected ${r.width * r.height}`);
            }
            resolve({ mask, width: r.width, height: r.height, ms: r.ms, delegate: r.delegate });
          } catch (e) {
            const err = toSegError(e);
            // the native session is gone (idle timeout, another app in front): nothing to close any more
            if (err.code === 'NO_SESSION' && handle === h) handle = undefined;
            throw err;
          }
        }).catch(reject);
      });
    },

    warm() {
      // not a `queued` run: it neither supersedes nor is superseded by the kid's strokes
      return enqueue(async () => {
        const h = handle;
        if (h === undefined) return;
        try {
          await deps.native.segRun({ handle: h, strokes: [WARM_STROKE] });
        } catch (e) {
          // the real run will meet the same failure (and report it); a gone session is dropped like in `run`
          if (toSegError(e).code === 'NO_SESSION' && handle === h) handle = undefined;
        }
      });
    },

    close(image) {
      if (image === undefined) {
        queued?.cancel();
        return enqueue(closeNow);
      }
      // only the session that produced `image`: decided when it is this close's turn in the queue
      return enqueue(async () => {
        if (handleImage === image) await closeNow();
      });
    },
  };
}

/** A scripted [SegClient] for UI tests: records the calls, answers from the given functions. */
export class FakeSegClient implements SegClient {
  readonly opened: string[] = [];
  readonly runs: SegStrokeArg[][] = [];
  closes = 0;
  /** The `image` argument of every `close` call (undefined = close whatever is open). */
  readonly closeArgs: (string | undefined)[] = [];
  warms = 0;

  constructor(
    private readonly script: {
      open?: (path: string) => SegImage | Promise<SegImage>;
      run?: (strokes: SegStrokeArg[]) => SegMaskResult | Promise<SegMaskResult>;
    } = {},
  ) {}

  async open(path: string): Promise<SegImage> {
    this.opened.push(path);
    return this.script.open ? this.script.open(path) : { image: 'tmp/seg-fake.png', width: 4, height: 4, hasAlpha: false };
  }

  async run(strokes: SegStrokeArg[]): Promise<SegMaskResult> {
    this.runs.push(strokes);
    return this.script.run
      ? this.script.run(strokes)
      : { mask: new Uint8Array(16), width: 4, height: 4, ms: 1, delegate: 'cpu' };
  }

  async warm(): Promise<void> {
    this.warms++;
  }

  async close(image?: string): Promise<void> {
    this.closes++;
    this.closeArgs.push(image);
  }
}
