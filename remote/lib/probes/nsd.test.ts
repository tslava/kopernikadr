import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from '../discovery';
import { discover, type NsdAdapter } from '../discovery';
import { nsdProbe } from './nsd';
import { runProbes } from './runner';
import type { ProbeShared } from './shared';

const camera = { cameraId: 'cam-1', name: 'Kopernikadr Kamera', protocolVersions: { min: 1, max: 1 }, host: '192.168.1.34', port: 8765 };

async function run(discoverFn: ((s: number) => Promise<DiscoveryResult>) | null, seconds?: number) {
  const shared: ProbeShared = { manualAddress: '' };
  const r = await runProbes([nsdProbe({ discover: discoverFn, seconds })], { shared });
  return { result: r.results[0], shared };
}

describe('nsd probe', () => {
  it('passes with the cameras found and shares them with the next probes', async () => {
    let asked = 0;
    const { result, shared } = await run(async (s) => {
      asked = s;
      return { services: [camera], firstFoundMs: 420, errors: [], durationMs: 3000 };
    }, 3);
    expect(asked).toBe(3);
    expect(result).toMatchObject({ ok: true, data: { count: 1, firstFoundMs: 420, services: [camera] } });
    expect(shared.nsdServices).toEqual([camera]);
  });

  it('defaults to a 5 s window', async () => {
    let asked = 0;
    await run(async (s) => {
      asked = s;
      return { services: [camera], firstFoundMs: 1, errors: [], durationMs: 5000 };
    });
    expect(asked).toBe(5);
  });

  it('fails with "no camera found" (keeping the latency data and errors)', async () => {
    const errors = [{ stage: 'parse' as const, code: 'NO_ID', message: 'TXT id is missing', service: 'x' }];
    const { result, shared } = await run(async () => ({ services: [], firstFoundMs: null, errors, durationMs: 5000 }));
    expect(result).toMatchObject({ ok: false, error: 'no camera found', data: { count: 0, errors } });
    expect(shared.nsdServices).toEqual([]);
  });

  it('fails when discovery could not start, even through the real discover()', async () => {
    const adapter: NsdAdapter = { start: () => Promise.reject(new Error('NSD unavailable')), stop: async () => {} };
    const { result } = await run((seconds) => discover({ seconds, adapter }), 0.05);
    expect(result).toMatchObject({ ok: false, error: 'discovery did not start: NSD unavailable' });
  });

  it('is skipped as native-only in a browser', async () => {
    const { result } = await run(null);
    expect(result).toMatchObject({ ok: false, skipped: 'native-only' });
  });
});
