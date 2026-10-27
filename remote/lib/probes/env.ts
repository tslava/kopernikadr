// `env` and `storage` probes: what the WebView offers (secure context, WebCrypto, WebCodecs, …)
// and the free space under the app's files dir. Globals are injected so tests use fakes.
import { ProbeFailure, ProbeSkip, type Probe } from './runner';

/** The parts of `globalThis` the env probe reads. */
export interface EnvGlobals {
  navigator?: {
    userAgent?: string;
    hardwareConcurrency?: number;
    deviceMemory?: number;
    languages?: readonly string[];
  };
  isSecureContext?: boolean;
  crypto?: { subtle?: unknown };
  screen?: { width?: number; height?: number };
  devicePixelRatio?: number;
  VideoEncoder?: unknown;
  VideoDecoder?: unknown;
  VideoFrame?: unknown;
  ImageDecoder?: unknown;
  createImageBitmap?: unknown;
  WebSocket?: unknown;
}

export interface EnvData {
  platform: string;
  native: boolean;
  userAgent: string | null;
  /** `Chrome/<version>` from the UA (the WebView version on Android). */
  webViewVersion: string | null;
  isSecureContext: boolean;
  cryptoSubtle: boolean;
  videoEncoder: boolean;
  videoDecoder: boolean;
  videoFrame: boolean;
  imageDecoder: boolean;
  createImageBitmap: boolean;
  webSocket: boolean;
  cores: number | null;
  deviceMemoryGb: number | null;
  screen: { w: number | null; h: number | null; dpr: number | null };
  languages: string[];
  /** Required features that are absent (the probe fails if any). */
  missing: string[];
}

const has = (v: unknown) => typeof v === 'function' || (typeof v === 'object' && v !== null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function webViewVersion(ua: string | undefined | null): string | null {
  return /\bChrome\/([\d.]+)/.exec(ua ?? '')?.[1] ?? null;
}

export function collectEnv(g: EnvGlobals, platform: string, native: boolean): EnvData {
  const nav = g.navigator ?? {};
  const data: Omit<EnvData, 'missing'> = {
    platform,
    native,
    userAgent: nav.userAgent ?? null,
    webViewVersion: webViewVersion(nav.userAgent),
    isSecureContext: g.isSecureContext === true,
    cryptoSubtle: has(g.crypto?.subtle),
    videoEncoder: has(g.VideoEncoder),
    videoDecoder: has(g.VideoDecoder),
    videoFrame: has(g.VideoFrame),
    imageDecoder: has(g.ImageDecoder),
    createImageBitmap: has(g.createImageBitmap),
    webSocket: has(g.WebSocket),
    cores: num(nav.hardwareConcurrency),
    deviceMemoryGb: num(nav.deviceMemory),
    screen: { w: num(g.screen?.width), h: num(g.screen?.height), dpr: num(g.devicePixelRatio) },
    languages: [...(nav.languages ?? [])],
  };
  // Needed by the app: sha256 checks (crypto.subtle), decode + export (VideoFrame, VideoEncoder).
  const required: [string, boolean][] = [
    ['isSecureContext', data.isSecureContext],
    ['crypto.subtle', data.cryptoSubtle],
    ['VideoFrame', data.videoFrame],
    ['VideoEncoder', data.videoEncoder],
    ['createImageBitmap', data.createImageBitmap],
    ['WebSocket', data.webSocket],
  ];
  return { ...data, missing: required.filter(([, ok]) => !ok).map(([name]) => name) };
}

export function envProbe<S>(deps: { globals: EnvGlobals; platform: string; native: boolean }): Probe<S> {
  return {
    name: 'env',
    async run() {
      const data = collectEnv(deps.globals, deps.platform, deps.native);
      if (data.missing.length) throw new ProbeFailure(`missing: ${data.missing.join(', ')}`, data);
      return data;
    },
  };
}

/** Free bytes under `filesDir` (KopernikadrNative.freeBytes); null `freeBytes` = not native. */
export function storageProbe<S>(deps: { freeBytes: (() => Promise<number>) | null }): Probe<S> {
  return {
    name: 'storage',
    async run() {
      if (!deps.freeBytes) throw new ProbeSkip('native-only');
      const bytes = await deps.freeBytes();
      return { freeBytes: bytes, freeGb: Math.round((bytes / 1e9) * 100) / 100 };
    },
  };
}
