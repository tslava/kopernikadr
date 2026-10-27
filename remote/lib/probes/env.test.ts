import { describe, expect, it } from 'vitest';
import { collectEnv, envProbe, storageProbe, webViewVersion, type EnvGlobals } from './env';
import { runProbes } from './runner';

const TABLET_UA =
  'Mozilla/5.0 (Linux; Android 12; TB328FU Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.7390.12 Safari/537.36';

const fn = () => {};

const tablet: EnvGlobals = {
  navigator: { userAgent: TABLET_UA, hardwareConcurrency: 8, deviceMemory: 4, languages: ['pl-PL', 'en-US'] },
  isSecureContext: true,
  crypto: { subtle: {} },
  screen: { width: 1920, height: 1200 },
  devicePixelRatio: 1.5,
  VideoEncoder: fn,
  VideoDecoder: fn,
  VideoFrame: fn,
  ImageDecoder: fn,
  createImageBitmap: fn,
  WebSocket: fn,
};

const run = (probe: ReturnType<typeof envProbe<object>>) => runProbes([probe], { shared: {} }).then((r) => r.results[0]);

describe('env probe', () => {
  it('reads the WebView version from the UA', () => {
    expect(webViewVersion(TABLET_UA)).toBe('155.0.7390.12');
    expect(webViewVersion('Mozilla/5.0 (X11) Gecko/20100101 Firefox/140.0')).toBeNull();
    expect(webViewVersion(undefined)).toBeNull();
  });

  it('collects everything from a capable WebView and passes', async () => {
    const r = await run(envProbe({ globals: tablet, platform: 'android', native: true }));
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      platform: 'android',
      native: true,
      userAgent: TABLET_UA,
      webViewVersion: '155.0.7390.12',
      isSecureContext: true,
      cryptoSubtle: true,
      videoEncoder: true,
      videoDecoder: true,
      videoFrame: true,
      imageDecoder: true,
      createImageBitmap: true,
      webSocket: true,
      cores: 8,
      deviceMemoryGb: 4,
      screen: { w: 1920, h: 1200, dpr: 1.5 },
      languages: ['pl-PL', 'en-US'],
      missing: [],
    });
  });

  it('fails and lists what is missing (insecure context, no WebCodecs), keeping the data', async () => {
    const old: EnvGlobals = { ...tablet, isSecureContext: false, crypto: {}, VideoEncoder: undefined, VideoFrame: undefined };
    const r = await run(envProbe({ globals: old, platform: 'android', native: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing: isSecureContext, crypto.subtle, VideoFrame, VideoEncoder');
    expect((r.data as { videoDecoder: boolean }).videoDecoder).toBe(true);
  });

  it('copes with an empty global object', () => {
    const d = collectEnv({}, 'web', false);
    expect(d.userAgent).toBeNull();
    expect(d.cores).toBeNull();
    expect(d.screen).toEqual({ w: null, h: null, dpr: null });
    expect(d.missing).toHaveLength(6);
  });
});

describe('storage probe', () => {
  it('reports free bytes from the native plugin', async () => {
    const r = await runProbes([storageProbe({ freeBytes: async () => 12_345_678_901 })], { shared: {} });
    expect(r.results[0]).toMatchObject({ ok: true, data: { freeBytes: 12_345_678_901, freeGb: 12.35 } });
  });

  it('is skipped as native-only in a browser', async () => {
    const r = await runProbes([storageProbe({ freeBytes: null })], { shared: {} });
    expect(r.results[0]).toMatchObject({ ok: false, skipped: 'native-only' });
  });

  it('fails when the plugin rejects', async () => {
    const err = Object.assign(new Error('statfs failed'), { code: 'IO' });
    const r = await runProbes([storageProbe({ freeBytes: () => Promise.reject(err) })], { shared: {} });
    expect(r.results[0]).toMatchObject({ ok: false, error: 'IO: statfs failed' });
  });
});
