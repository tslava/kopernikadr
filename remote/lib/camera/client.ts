// CameraClient (plan Task 8): target selection + status + per-session hooks on top of remote-core's
// CameraConnection, which owns the ONE reconnect loop (token, backoff, BUSY, 4001). This layer never
// reconnects by itself; it only creates/stops a connection when the *target* changes.
import { CameraConnection } from '@kopernikadr/remote-core/connection';
import { SERVICE_TYPE, parseService } from '@kopernikadr/remote-core/nsd';
import type { ParsedService } from '@kopernikadr/remote-core/nsd';
import { createStore, type Store } from '../state/store';
import type { NsdAdapter } from '../discovery';
import { hostPort, selectTarget, targetKey, verifyManual, type ManualResult, type RememberedCamera, type Target } from './discover';

export type CameraStatus = 'searching' | 'connecting' | 'online' | 'offline' | 'busy' | 'replaced' | 'wrong-camera';

/** `hello` data (PROTOCOL §6); the fields the remote reads. */
export interface HelloData {
  cameraId: string;
  bootId: string;
  sessionId: string;
  name?: string;
  protocolVersion?: number;
  capabilities?: Record<string, unknown>;
  controls?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The part of CameraConnection the client uses (tests pass a fake). */
export interface ConnectionLike {
  state: string;
  session: unknown;
  on(name: 'state' | 'session', fn: (...args: any[]) => void): () => unknown;
  start(): void;
  stop(): void;
  reconnectNow(): void;
  takeOver(): void;
  request(op: string, args?: object, opts?: { reqId?: string; timeoutMs?: number }): Promise<any>;
}

export interface SessionContext {
  hello: HelloData;
  bootId: string;
  /** The bootId differs from the previous session's (camera restarted). */
  bootIdChanged: boolean;
  request: CameraClient['request'];
}

export interface CameraClientDeps {
  clientId: string;
  /** The active project's camera, or null. */
  requiredCameraId?: string | null;
  remembered?: RememberedCamera | null;
  /** Persists `rememberedCamera` (the ProjectStore's job); errors are swallowed. */
  saveRememberedCamera: (cam: RememberedCamera) => void | Promise<void>;
  /** Run on EVERY new session, in this order. Errors do not break the loop. */
  resolveOutstanding: (ctx: SessionContext) => void | Promise<void>;
  reconcile: (ctx: SessionContext) => void | Promise<void>;
  nsd: NsdAdapter;
  createConnection?: (url: string, clientId: string) => ConnectionLike;
  fetch?: typeof fetch;
  /** How long discovery runs before "the single camera found" is accepted / the connect screen is shown. */
  searchWindowMs?: number;
  appVersion?: string;
  platform?: string;
}

export type ClientEvent =
  | { type: 'session'; hello: HelloData }
  | { type: 'bootIdChanged'; from: string; to: string }
  | { type: 'hookError'; hook: 'resolveOutstanding' | 'reconcile'; error: unknown }
  | { type: 'remembered'; camera: RememberedCamera };

export interface ClientSnapshot {
  status: CameraStatus;
  /** Nothing selectable after the search window: show the connect screen. */
  needsConnect: boolean;
  found: ParsedService[];
  target: Target | null;
  hello: HelloData | null;
  retryAfterMs?: number;
  /** The camera speaks no common protocol version (status stays 'offline'). */
  unsupported: boolean;
  /** The per-session hooks are running (capture should wait). */
  reconciling: boolean;
}

const instanceKey = (n: string) => n.trim().replace(/\.+$/, '');

export class CameraClient {
  readonly store: Store<ClientSnapshot>;
  #d: CameraClientDeps;
  #conn: ConnectionLike | null = null;
  #unsubs: Array<() => unknown> = [];
  #required: string | null;
  #remembered: RememberedCamera | null;
  #manual: Target | null = null;
  #found = new Map<string, ParsedService>(); // by instance name
  #settled = false;
  #settleTimer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #wrongKey: string | null = null;
  #lastBootId: string | null = null;
  #gen = 0;
  #hooks: Promise<void> = Promise.resolve();
  #listeners = new Set<(e: ClientEvent) => void>();

  constructor(deps: CameraClientDeps) {
    this.#d = deps;
    this.#required = deps.requiredCameraId ?? null;
    this.#remembered = deps.remembered ?? null;
    this.store = createStore<ClientSnapshot>({
      status: 'searching', needsConnect: false, found: [], target: null, hello: null, unsupported: false, reconciling: false,
    });
  }

  get snapshot(): ClientSnapshot {
    return this.store.get();
  }
  /** The current session's `hello`, or null while not online. */
  get session(): HelloData | null {
    return this.snapshot.status === 'online' ? this.snapshot.hello : null;
  }
  onEvent(fn: (e: ClientEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** Passthrough to the live connection; rejects (CLOSED) while not online. */
  request = (op: string, args: object = {}, opts: { reqId?: string; timeoutMs?: number } = {}): Promise<any> => {
    if (!this.#conn || this.snapshot.status !== 'online') return Promise.reject(Object.assign(new Error('not connected'), { code: 'CLOSED' }));
    return this.#conn.request(op, args, opts);
  };

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#settled = false;
    this.#settleTimer = setTimeout(() => {
      this.#settled = true;
      this.#reselect();
    }, this.#d.searchWindowMs ?? 4000);
    this.#d.nsd
      .start(SERVICE_TYPE, (e) => {
        if (!this.#running) return;
        if (e.type === 'found') {
          try {
            const s = parseService(e.service);
            this.#found.set(instanceKey(e.service.name ?? s.cameraId), s);
          } catch {
            return; // not a usable camera
          }
        } else if (e.type === 'lost') this.#found.delete(instanceKey(e.name));
        else return;
        this.#reselect();
      })
      .catch(() => {
        // discovery unavailable: remembered camera and manual entry still work
      });
    this.#reselect();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#settleTimer);
    this.#dropConnection();
    this.#gen++;
    void this.#d.nsd.stop().catch(() => {});
  }

  /** App resume: the connection drops its socket and reconnects now (no second loop). */
  resume(): void {
    if (!this.#running) return;
    this.#wrongKey = null;
    if (this.#conn) this.#conn.reconnectNow();
    else this.#reselect();
  }

  /** After status 'replaced': take the session back. */
  takeOver(): void {
    if (this.snapshot.status === 'replaced') this.#conn?.takeOver();
  }

  /** The active project changed (or got bound): select again for the new camera. */
  setRequiredCameraId(id: string | null): void {
    if (id === this.#required) return;
    this.#required = id;
    this.#manual = null;
    this.#wrongKey = null;
    this.#lastBootId = null;
    this.#dropConnection();
    this.#gen++;
    this.#patch({ hello: null, target: null, status: 'searching', needsConnect: false, reconciling: false });
    if (this.#running) this.#reselect();
  }

  /** Validates `host:port` with GET /info; on success connects to it. */
  async connectManual(text: string): Promise<ManualResult> {
    const r = await verifyManual(text, { requiredCameraId: this.#required, fetch: this.#d.fetch });
    if (r.ok && this.#running) {
      this.#manual = r.target;
      this.#wrongKey = null;
      this.#dropConnection();
      this.#reselect();
    }
    return r;
  }

  // --- internals ---

  #patch(p: Partial<ClientSnapshot>): void {
    this.store.update((s) => ({ ...s, ...p }));
  }
  #emit(e: ClientEvent): void {
    for (const fn of this.#listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  #reselect(): void {
    if (!this.#running) return;
    const found = [...this.#found.values()];
    this.#patch({ found });
    let sel = selectTarget({ requiredCameraId: this.#required, remembered: this.#remembered, found, settled: this.#settled });
    if (this.#manual) {
      const m = this.#manual;
      const hit = found.find((s) => s.cameraId === m.cameraId);
      sel = { kind: 'target', target: hit && !this.#conn ? { ...m, host: hit.host, port: hit.port } : m };
    }
    if (sel.kind !== 'target') {
      if (!this.#conn && this.snapshot.status !== 'wrong-camera') this.#patch({ status: 'searching', needsConnect: sel.kind === 'connect' });
      return;
    }
    const t = sel.target;
    if (this.#conn) {
      // Switch only if we hold no session and the address changed (the camera got a new IP).
      const cur = this.snapshot.target;
      if (!cur || targetKey(cur) === targetKey(t) || this.snapshot.status === 'online' || this.snapshot.status === 'busy') return;
    } else if (this.#wrongKey === targetKey(t)) return;
    this.#connect(t);
  }

  #connect(t: Target): void {
    this.#dropConnection();
    const url = `ws://${hostPort(t)}/ws/control`;
    const make =
      this.#d.createConnection ??
      ((u: string, clientId: string) =>
        new CameraConnection({ url: u, clientId, appVersion: this.#d.appVersion ?? 'remote-native', platform: this.#d.platform ?? 'android' }) as ConnectionLike);
    const conn = make(url, this.#d.clientId);
    this.#conn = conn;
    this.#patch({ target: t, status: 'connecting', needsConnect: false, hello: null, retryAfterMs: undefined, unsupported: false });
    this.#unsubs = [
      conn.on('state', (state: string, detail?: { retryAfterMs?: number }) => {
        if (conn !== this.#conn) return;
        if (state === 'online') return; // 'session' follows; the camera check comes first
        this.#gen++; // the previous session's hooks are stale
        const unsupported = state === 'unsupported';
        this.#patch({
          status: unsupported ? 'offline' : (state as CameraStatus),
          unsupported,
          retryAfterMs: state === 'busy' ? detail?.retryAfterMs : undefined,
          reconciling: false,
        });
      }),
      conn.on('session', (hello: HelloData) => {
        if (conn === this.#conn) this.#onSession(t, hello);
      }),
    ];
    conn.start();
  }

  #dropConnection(): void {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    const c = this.#conn;
    this.#conn = null;
    c?.stop();
  }

  #onSession(t: Target, hello: HelloData): void {
    if (this.#required && hello.cameraId !== this.#required) {
      this.#wrongKey = targetKey(t);
      this.#dropConnection();
      this.#gen++;
      this.#patch({ status: 'wrong-camera', hello, reconciling: false });
      this.#reselect(); // maybe NSD already sees the right camera elsewhere
      return;
    }
    const gen = ++this.#gen;
    const prev = this.#lastBootId;
    const bootIdChanged = prev !== null && prev !== hello.bootId;
    this.#lastBootId = hello.bootId;
    this.#patch({ status: 'online', hello, retryAfterMs: undefined, unsupported: false, reconciling: true, target: { ...t, cameraId: hello.cameraId } });
    this.#emit({ type: 'session', hello });
    if (bootIdChanged) this.#emit({ type: 'bootIdChanged', from: prev!, to: hello.bootId });
    this.#remember(t, hello.cameraId);
    const ctx: SessionContext = { hello, bootId: hello.bootId, bootIdChanged, request: this.request };
    this.#hooks = this.#hooks.then(async () => {
      for (const hook of ['resolveOutstanding', 'reconcile'] as const) {
        if (gen !== this.#gen) return; // a newer session (or a drop) took over; its chain runs the hooks
        try {
          await this.#d[hook](ctx);
        } catch (error) {
          this.#emit({ type: 'hookError', hook, error });
        }
      }
      if (gen === this.#gen) this.#patch({ reconciling: false });
    });
  }

  #remember(t: Target, cameraId: string): void {
    const r = this.#remembered;
    if (r && r.cameraId === cameraId && r.host === t.host && r.port === t.port) return;
    const cam = { cameraId, host: t.host, port: t.port };
    this.#remembered = cam;
    this.#emit({ type: 'remembered', camera: cam });
    try {
      Promise.resolve(this.#d.saveRememberedCamera(cam)).catch(() => {});
    } catch {
      // saving is best effort
    }
  }
}
