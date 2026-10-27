// Live preview controller (plan Task 13, ARCHITECTURE §5.3): owns at most ONE remote-core PreviewLoop
// (which carries the 3 s watchdog: no frame within 3 s of a `next`, or a decode failure -> close and
// reopen the socket), draws frames to a canvas and closes every bitmap. The loop only runs while
// there is a valid session; it is restarted on app resume, a new session and a bootId change.
import { PreviewLoop } from '@kopernikadr/remote-core/preview';

export type PreviewQuality = 'low' | 'normal' | 'high';

/** The part of PreviewLoop the controller uses (tests pass a fake). */
export interface LoopLike {
  start(): void;
  stop(): void;
  setSession(sessionId: string | null): void;
  readonly running: boolean;
}

export interface LoopOptions {
  urlFor: (sessionId: string) => string;
  onFrame: (header: object, jpeg: Uint8Array) => Promise<void> | void;
  onError?: (e: Error) => void;
  watchdogMs: number;
}

export interface BitmapLike {
  width: number;
  height: number;
  close(): void;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): { drawImage(img: any, dx: number, dy: number): void } | null;
}

/** The part of CameraClient the controller follows. */
export interface ClientLike {
  onEvent(fn: (e: { type: string; hello?: { sessionId: string } }) => void): () => void;
  store: { get(): { status: string; hello: { sessionId: string } | null }; subscribe(l: () => void): () => void };
}

export interface PreviewControllerDeps {
  /** `/ws/preview?session=` URL of the current camera. */
  urlFor: (sessionId: string) => string;
  /** The canvas can be attached later (React ref). */
  canvas?: CanvasLike | null;
  createLoop?: (opts: LoopOptions) => LoopLike;
  createBitmap?: (jpeg: Uint8Array) => Promise<BitmapLike>;
  /** Preview quality, a parent setting; pushed to the camera with `applyQuality` on every (new) session and change. */
  quality?: PreviewQuality;
  applyQuality?: (q: PreviewQuality) => void | Promise<void>;
  watchdogMs?: number;
  onError?: (e: Error) => void;
  /** True after the first drawn frame of a session; false when the preview is lost / restarted / stopped. */
  onLive?: (live: boolean) => void;
}

export const WATCHDOG_MS = 3000;

const defaultBitmap = (jpeg: Uint8Array): Promise<BitmapLike> =>
  createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));

export class PreviewController {
  #d: PreviewControllerDeps;
  #loop: LoopLike | null = null;
  #canvas: CanvasLike | null;
  #session: string | null = null;
  #started = false;
  #quality: PreviewQuality;
  #live = false;
  #unsubs: Array<() => void> = [];

  constructor(deps: PreviewControllerDeps) {
    this.#d = deps;
    this.#canvas = deps.canvas ?? null;
    this.#quality = deps.quality ?? 'normal';
  }

  get quality(): PreviewQuality {
    return this.#quality;
  }
  get session(): string | null {
    return this.#session;
  }
  get live(): boolean {
    return this.#live;
  }
  /** The single loop (created lazily on first use, never replaced). */
  get loop(): LoopLike | null {
    return this.#loop;
  }

  setCanvas(canvas: CanvasLike | null): void {
    this.#canvas = canvas;
  }

  /** Follow a CameraClient: session -> set, bootIdChanged -> restart, leaving 'online' -> wait. */
  attach(client: ClientLike): () => void {
    const cur = client.store.get();
    if (cur.status === 'online' && cur.hello) this.setSession(cur.hello.sessionId);
    const offEvent = client.onEvent((e) => {
      if (e.type === 'session' && e.hello) this.setSession(e.hello.sessionId);
      else if (e.type === 'bootIdChanged') this.restart();
    });
    const offStore = client.store.subscribe(() => {
      if (client.store.get().status !== 'online') this.setSession(null);
    });
    const off = () => {
      offEvent();
      offStore();
    };
    this.#unsubs.push(off);
    return off;
  }

  start(): void {
    this.#started = true;
    this.#sync();
  }

  stop(): void {
    this.#started = false;
    this.#loop?.stop();
    this.#setLive(false);
  }

  /** A new valid session (after hello) or null (offline: wait). */
  setSession(sessionId: string | null): void {
    const changed = sessionId !== this.#session;
    this.#session = sessionId;
    if (!sessionId) {
      this.#loop?.setSession(null);
      this.#setLive(false);
      return;
    }
    if (changed) {
      this.#setLive(false);
      void this.#pushQuality();
    }
    this.#sync();
  }

  /** bootId change: drop the socket and open a fresh one for the same session. */
  restart(): void {
    const sid = this.#session;
    if (!this.#started || !sid || !this.#loop) return;
    this.#loop.setSession(null); // closes the socket, cancels the watchdog and reopen timers
    this.#setLive(false);
    this.#loop.setSession(sid);
    if (!this.#loop.running) this.#loop.start();
  }

  /** App resume (the sockets died in the background). */
  resume(): void {
    this.restart();
  }

  setQuality(q: PreviewQuality): void {
    if (q === this.#quality) return;
    this.#quality = q;
    void this.#pushQuality();
  }

  dispose(): void {
    for (const u of this.#unsubs.splice(0)) u();
    this.stop();
    this.#loop?.setSession(null);
  }

  // --- internals ---

  async #pushQuality(): Promise<void> {
    if (!this.#session || !this.#d.applyQuality) return;
    try {
      await this.#d.applyQuality(this.#quality);
    } catch (e) {
      this.#d.onError?.(e as Error);
    }
  }

  #sync(): void {
    if (!this.#started || !this.#session) return;
    const loop = this.#ensureLoop();
    loop.setSession(this.#session);
    if (!loop.running) loop.start();
  }

  #ensureLoop(): LoopLike {
    if (this.#loop) return this.#loop;
    const opts: LoopOptions = {
      urlFor: this.#d.urlFor,
      onFrame: (_h, jpeg) => this.#draw(jpeg),
      onError: (e) => this.#d.onError?.(e),
      watchdogMs: this.#d.watchdogMs ?? WATCHDOG_MS,
    };
    this.#loop = this.#d.createLoop
      ? this.#d.createLoop(opts)
      : (new PreviewLoop(opts) as unknown as LoopLike);
    return this.#loop;
  }

  async #draw(jpeg: Uint8Array): Promise<void> {
    const bmp = await (this.#d.createBitmap ?? defaultBitmap)(jpeg); // a decode failure throws: the loop drops and reopens
    try {
      const canvas = this.#canvas;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      this.#setLive(true);
    } finally {
      bmp.close();
    }
  }

  #setLive(v: boolean): void {
    if (v === this.#live) return;
    this.#live = v;
    this.#d.onLive?.(v);
  }
}
