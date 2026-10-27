// App lifecycle (plan Task 19): what happens when the app goes to the background and comes back.
//
//   pause   : preview loops stop; transfers pause (foreground only) unless an export runs (it owns
//             its own pause); keep-awake is released unless an export runs. The camera connection is
//             left alone: the OS kills the socket, the client notices and goes offline by itself.
//   resume  : client.resume() (ONE loop, reconnects now; never a second connection), previews
//             restart, transfer.resume() + kick(). Outstanding captures resolve through the normal
//             per-session hook (resolveOutstanding) when the new session arrives.
//   export  : background does not cancel it. If Android kills the app the startup sweep cleans up.
//   probes  : Diagnostics runs its own sessions; `yieldToProbes()` stops the app's client meanwhile.
//
// Everything is injected, so tests run it with fakes. No UI here.
import type { Store } from '../state/store';

export interface KeepAwakeAdapter {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export type KeepAwakeKind = 'view' | 'export';

/**
 * Ref-counted keep-awake, the single owner of the screen lock. Holders: capture views ('view') and
 * running exports ('export'). The screen is held when an export holds it, or a view holds it while
 * the app is in the foreground.
 */
export class KeepAwakeManager {
  #a: KeepAwakeAdapter;
  #counts: Record<KeepAwakeKind, number> = { view: 0, export: 0 };
  #background = false;
  #held = false;

  constructor(adapter: KeepAwakeAdapter) {
    this.#a = adapter;
  }

  get held(): boolean {
    return this.#held;
  }
  count(kind: KeepAwakeKind): number {
    return this.#counts[kind];
  }

  /** Returns an idempotent release function. */
  hold(kind: KeepAwakeKind = 'view'): () => void {
    this.#counts[kind]++;
    this.#apply();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#counts[kind]--;
      this.#apply();
    };
  }

  setBackground(background: boolean): void {
    this.#background = background;
    this.#apply();
  }

  #apply(): void {
    const want = this.#counts.export > 0 || (this.#counts.view > 0 && !this.#background);
    if (want === this.#held) return;
    this.#held = want;
    void (want ? this.#a.acquire() : this.#a.release()).catch(() => {});
  }
}

export interface PreviewLike {
  start(): void;
  stop(): void;
}

export interface LifecycleDeps {
  client: { start(): void; stop(): void; resume(): void };
  transfer: { pause?: () => Promise<void>; resume?: () => void; kick?: () => void };
  /** App-wide export flag (owned by the export controller). */
  exporting: Store<boolean>;
  keepAwake: KeepAwakeAdapter;
}

export interface Lifecycle {
  keepAwake: KeepAwakeManager;
  readonly background: boolean;
  /** Capacitor `appStateChange.isActive`. Idempotent for repeated states. */
  setActive(active: boolean): void;
  /** The capture view registers its preview controller: stopped on pause, restarted on resume. */
  registerPreview(p: PreviewLike): () => void;
  /** Diagnostics: the app's client yields while probes use their own sessions. Returns the release. */
  yieldToProbes(): () => void;
  dispose(): void;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const keepAwake = new KeepAwakeManager(deps.keepAwake);
  const previews = new Set<PreviewLike>();
  let background = false;
  let probing = 0;
  // our own transfer pause (not the export's)
  let paused = false;

  // An export holds the screen for its whole run.
  let exportHold: (() => void) | null = null;
  const syncExport = () => {
    if (deps.exporting.get()) exportHold ??= keepAwake.hold('export');
    else {
      exportHold?.();
      exportHold = null;
    }
  };
  const idle = () => background || probing > 0;

  const pauseTransfer = () => {
    if (paused || deps.exporting.get() || !deps.transfer.pause) return;
    paused = true;
    void deps.transfer.pause().catch(() => {});
  };
  const resumeTransfer = () => {
    if (!paused) return;
    paused = false;
    if (deps.exporting.get()) return; // the export's pause is in force; it resumes the queue itself
    deps.transfer.resume?.();
    deps.transfer.kick?.();
  };

  const offExport = deps.exporting.subscribe(() => {
    syncExport();
    // The export ended while we are in the background / probing: its resume() un-paused the queue.
    if (!deps.exporting.get() && idle()) {
      paused = false;
      pauseTransfer();
    }
  });
  syncExport();

  return {
    keepAwake,
    get background() {
      return background;
    },
    setActive(active) {
      if (active === !background) return;
      background = !active;
      keepAwake.setBackground(background);
      if (background) {
        for (const p of previews) p.stop();
        pauseTransfer();
      } else if (probing === 0) {
        deps.client.resume();
        for (const p of previews) p.start();
        resumeTransfer();
      }
    },
    registerPreview(p) {
      previews.add(p);
      return () => void previews.delete(p);
    },
    yieldToProbes() {
      probing++;
      if (probing === 1) {
        deps.client.stop();
        for (const p of previews) p.stop();
        pauseTransfer();
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        probing--;
        if (probing > 0) return;
        deps.client.start();
        if (!background) {
          for (const p of previews) p.start();
          resumeTransfer();
        }
      };
    },
    dispose() {
      offExport();
      exportHold?.();
      exportHold = null;
    },
  };
}
