// Boot (plan Task 12, "Startup sequence"). The native export sweep already ran at plugin load.
//   1. ProjectStore.load()
//   2. runStartupSweep
//   3. build capture + CameraClient (hooks: resolveOutstanding, then reconcile, on every session)
//   4. client.start()  (connect)
// Everything is injected, so tests run the real order with fakes. The result is the AppContext the
// UI reads (see ./app.ts for the real wiring and the React hook).
import { CameraClient, type CameraClientDeps, type SessionContext } from '../camera/client';
import type { NsdAdapter } from '../discovery';
import { createCapture, type Capture, type CaptureEnv } from '../capture/capture';
import type { FileAdapter } from '../projects/files';
import { runStartupSweep, type SweepReport, type VerifyFn } from '../projects/sweep';
import { ProjectStore } from '../projects/store';
import { createStore, type Store } from '../state/store';
import type { Transfer, TransferPause } from '../transfer/types';

/** The per-session reconcile hook (plan Task 11). Runs after `resolveOutstanding`. */
export type Reconcile = (ctx: SessionContext) => void | Promise<void>;

export interface AppContext {
  store: ProjectStore;
  client: CameraClient;
  capture: Capture;
  transfer: Transfer & Partial<TransferPause>;
  /** App-wide: an export is running (shooting is blocked, transfers are paused). Owned by the export controller. */
  exporting: Store<boolean>;
  sweep: SweepReport;
}

export interface TransferEnv {
  store: ProjectStore;
  /** `client.request`; rejects while offline. */
  request: (op: string, args: object, opts?: { timeoutMs?: number }) => Promise<any>;
  /** The connected camera's address, or null while not online. */
  target: () => { host: string; port: number } | null;
}

export interface BootDeps {
  fs: FileAdapter;
  verify: VerifyFn;
  nsd: NsdAdapter;
  /** Builds the transfer layer; `request`/`target` read the client lazily (it is created after capture). */
  createTransfer: (env: TransferEnv) => Transfer & Partial<TransferPause>;
  /** The per-session hook (after `resolveOutstanding`). It is responsible for `transfer.kick()`. */
  reconcile: Reconcile;
  /** Test seams: connection factory, search window, fetch, ... */
  clientDeps?: Partial<CameraClientDeps>;
  /** Defaults to `runStartupSweep` (a test seam for the order). */
  sweep?: typeof runStartupSweep;
  /** Defaults to `createCapture` (a test seam for the hook order). */
  createCapture?: (env: CaptureEnv) => Capture;
  appVersion?: string;
}

export async function boot(deps: BootDeps): Promise<AppContext> {
  const store = new ProjectStore(deps.fs);
  await store.load();
  const sweep = await (deps.sweep ?? runStartupSweep)(store, deps.fs, { verify: deps.verify });

  // CameraClient needs capture.resolveOutstanding, capture needs the client: tie the knot lazily.
  let client!: CameraClient;
  const transfer = deps.createTransfer({
    store,
    request: (op, args, opts) => client.request(op, args, opts),
    target: () => {
      const snap = client.snapshot;
      return snap.status === 'online' && snap.target ? { host: snap.target.host, port: snap.target.port } : null;
    },
  });
  const capture = (deps.createCapture ?? createCapture)({
    store,
    transfer,
    camera: {
      request: (...a) => client.request(...a),
      get snapshot() {
        return client.snapshot;
      },
    },
  });
  const { index } = store.state.get();
  client = new CameraClient({
    clientId: index.clientId,
    remembered: index.rememberedCamera,
    saveRememberedCamera: (cam) => void store.updateIndex((i) => ({ ...i, rememberedCamera: cam })),
    nsd: deps.nsd,
    appVersion: deps.appVersion,
    ...deps.clientDeps,
    resolveOutstanding: capture.resolveOutstanding,
    reconcile: deps.reconcile,
  });
  client.start();
  return { store, client, capture, transfer, exporting: createStore(false), sweep };
}
