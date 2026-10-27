// A ring of decoded bitmaps kept ahead of the play head. Memory is bounded by `capacity`
// (default 8, ARCHITECTURE §5.7); an evicted or released bitmap is closed.

export const RING_SIZE = 8;

type Entry =
  | { state: 'loading'; abort: AbortController }
  | { state: 'ready'; bitmap: ImageBitmap }
  | { state: 'failed' };

export interface RingOptions {
  load: (key: string, signal: AbortSignal) => Promise<ImageBitmap>;
  capacity?: number;
}

export interface Ring {
  /** The keys wanted now, in play order. Only the first `capacity` are kept; everything else is evicted (closed). */
  want(keys: readonly string[]): void;
  get(key: string): ImageBitmap | undefined;
  failed(key: string): boolean;
  clearFailed(): void;
  /** Closes every bitmap and aborts loads in flight. The ring stays usable (`want` reloads). */
  release(): void;
  readonly size: number;
}

export function createRing(o: RingOptions): Ring {
  const capacity = o.capacity ?? RING_SIZE;
  const entries = new Map<string, Entry>();

  function drop(key: string): void {
    const e = entries.get(key);
    if (!e) return;
    entries.delete(key);
    if (e.state === 'ready') e.bitmap.close();
    else if (e.state === 'loading') e.abort.abort();
  }

  function start(key: string): void {
    const abort = new AbortController();
    const entry: Entry = { state: 'loading', abort };
    entries.set(key, entry);
    o.load(key, abort.signal).then(
      (bitmap) => {
        if (entries.get(key) !== entry) {
          bitmap.close(); // evicted or released while decoding
          return;
        }
        entries.set(key, { state: 'ready', bitmap });
      },
      () => {
        if (entries.get(key) === entry) entries.set(key, { state: 'failed' });
      },
    );
  }

  return {
    want(keys) {
      const wanted = new Set(keys.slice(0, capacity));
      for (const key of [...entries.keys()]) if (!wanted.has(key)) drop(key);
      for (const key of wanted) if (!entries.has(key)) start(key);
    },
    get(key) {
      const e = entries.get(key);
      return e?.state === 'ready' ? e.bitmap : undefined;
    },
    failed: (key) => entries.get(key)?.state === 'failed',
    clearFailed() {
      for (const [k, e] of entries) if (e.state === 'failed') entries.delete(k);
    },
    release() {
      for (const key of [...entries.keys()]) drop(key);
    },
    get size() {
      return entries.size;
    },
  };
}
