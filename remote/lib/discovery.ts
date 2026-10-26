// NSD discovery for the probe (stage 0b): browse `_kopernikadr._tcp` for N seconds and list the
// cameras found. The native side is the in-app `KopernikadrNsd` Capacitor plugin
// (android/.../remote/nsd/NsdPlugin.kt), behind the NsdAdapter interface so tests use a fake.
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { parseService, NsdParseError, SERVICE_TYPE, type ParsedService, type RawService } from '@kopernikadr/remote-core/nsd';

export type { ParsedService, RawService };

/** A discovery problem: plugin start/stop, a failed resolve, a service that is not a camera. */
export interface DiscoveryError {
  stage: 'start' | 'stop' | 'discovery' | 'resolve' | 'parse';
  message: string;
  code?: string;
  /** Instance name of the service concerned, if any. */
  service?: string;
}

export type NsdEvent =
  | { type: 'found'; service: RawService }
  | { type: 'lost'; name: string }
  | ({ type: 'error' } & DiscoveryError);

/** The native NSD browser. `start` resolves once browsing runs; events arrive via `onEvent`. */
export interface NsdAdapter {
  start(serviceType: string, onEvent: (e: NsdEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscoveryResult {
  /** Cameras present at the end of the window, in the order first found. */
  services: ParsedService[];
  /** Milliseconds from the start of discovery to the first valid camera; null if none. */
  firstFoundMs: number | null;
  errors: DiscoveryError[];
  /** Length of the discovery window actually run (shorter if start failed). */
  durationMs: number;
}

export interface DiscoverOptions {
  seconds: number;
  adapter?: NsdAdapter;
  serviceType?: string;
  now?: () => number;
}

/** How long a hanging plugin `stop()` may delay the result. */
const STOP_TIMEOUT_MS = 2000;

const instanceKey = (name: unknown) => (typeof name === 'string' ? name.trim().replace(/\.+$/, '') : '');

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settles with `p`, or with 'timeout' after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | 'timeout'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    p.then(
      (value) => (clearTimeout(t), resolve({ ok: true, value })),
      (error) => (clearTimeout(t), resolve({ ok: false, error })),
    );
  });
}

/** Browses for `seconds`, then stops the plugin and returns the cameras found. */
export async function discover({ seconds, adapter = nativeNsdAdapter(), serviceType = SERVICE_TYPE, now = () => performance.now() }: DiscoverOptions): Promise<DiscoveryResult> {
  if (!(Number.isFinite(seconds) && seconds > 0)) throw new RangeError(`seconds must be > 0, got ${seconds}`);
  const windowMs = seconds * 1000;
  const found = new Map<string, ParsedService>();
  const errors: DiscoveryError[] = [];
  let firstFoundMs: number | null = null;
  let open = true;
  const t0 = now();

  const onEvent = (e: NsdEvent) => {
    if (!open) return;
    if (e.type === 'found') {
      try {
        const s = parseService(e.service);
        found.set(instanceKey(e.service.name) || s.cameraId, s);
        firstFoundMs ??= Math.round(now() - t0);
      } catch (err) {
        if (!(err instanceof NsdParseError)) throw err;
        errors.push({ stage: 'parse', code: err.code, message: err.message, service: instanceKey(e.service?.name) });
      }
    } else if (e.type === 'lost') {
      found.delete(instanceKey(e.name));
    } else {
      const { type: _type, ...error } = e;
      errors.push(error);
    }
  };

  const started = await within(adapter.start(serviceType, onEvent), windowMs);
  if (started === 'timeout') {
    errors.push({ stage: 'start', message: `start did not finish within ${seconds} s` });
  } else if (!started.ok) {
    errors.push({ stage: 'start', message: message(started.error) });
  } else {
    const left = windowMs - (now() - t0);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
  const durationMs = Math.round(now() - t0);
  open = false;

  const stopped = await within(adapter.stop(), STOP_TIMEOUT_MS);
  if (stopped === 'timeout') errors.push({ stage: 'stop', message: `stop did not finish within ${STOP_TIMEOUT_MS / 1000} s` });
  else if (!stopped.ok) errors.push({ stage: 'stop', message: message(stopped.error) });

  // One entry per camera: a camera re-registered under another instance name keeps the newest.
  const byCamera = new Map<string, ParsedService>();
  for (const s of found.values()) {
    byCamera.delete(s.cameraId);
    byCamera.set(s.cameraId, s);
  }
  return { services: [...byCamera.values()], firstFoundMs, errors, durationMs };
}

// --- native plugin (android/app/src/main/java/pl/slava/kopernikadr/remote/nsd/NsdPlugin.kt) ---

/** `serviceFound` payload: resolved host (preferred address), all addresses, port, TXT as UTF-8 text. */
export interface NativeService {
  name: string;
  type: string;
  host: string;
  addresses: string[];
  port: number;
  txt: Record<string, string>;
}

export interface NativeNsdError {
  stage: 'discovery' | 'resolve';
  code: string;
  message: string;
  name?: string;
}

export interface KopernikadrNsdPlugin {
  startDiscovery(options: { type: string }): Promise<void>;
  stopDiscovery(): Promise<void>;
  addListener(event: 'serviceFound', fn: (s: NativeService) => void): Promise<PluginListenerHandle>;
  addListener(event: 'serviceLost', fn: (s: { name: string; type: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'discoveryError', fn: (e: NativeNsdError) => void): Promise<PluginListenerHandle>;
  /** Debug builds only: registers a service on this device (emulator self-test). */
  __testRegister(options: { name: string; type: string; port: number; txt: Record<string, string> }): Promise<void>;
  __testUnregister(): Promise<void>;
}

let plugin: KopernikadrNsdPlugin | undefined;
export const KopernikadrNsd = (): KopernikadrNsdPlugin => (plugin ??= registerPlugin<KopernikadrNsdPlugin>('KopernikadrNsd'));

/** NsdAdapter over the in-app plugin. */
export function nativeNsdAdapter(nsd: KopernikadrNsdPlugin = KopernikadrNsd()): NsdAdapter {
  let handles: PluginListenerHandle[] = [];
  return {
    async start(type, onEvent) {
      handles = await Promise.all([
        nsd.addListener('serviceFound', (s) => onEvent({ type: 'found', service: s })),
        nsd.addListener('serviceLost', (s) => onEvent({ type: 'lost', name: s.name })),
        nsd.addListener('discoveryError', (e) =>
          onEvent({ type: 'error', stage: e.stage, code: e.code, message: e.message, ...(e.name ? { service: e.name } : {}) }),
        ),
      ]);
      await nsd.startDiscovery({ type });
    },
    async stop() {
      try {
        await nsd.stopDiscovery();
      } finally {
        const hs = handles;
        handles = [];
        await Promise.all(hs.map((h) => h.remove()));
      }
    },
  };
}
