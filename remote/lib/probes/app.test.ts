import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProbes, probeIdentity, reportWriter } from './app';
import { PROBE_ORDER, PROBE_STORAGE, readStored, writeStored } from './shared';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probe app wiring', () => {
  it('builds every probe in PROBE_ORDER', () => {
    expect(buildProbes(false).map((p) => p.name)).toEqual([...PROBE_ORDER]);
    expect(buildProbes(true).map((p) => p.name)).toEqual([...PROBE_ORDER]);
  });

  it('the probe clientId/projectId persist in localStorage and differ from each other', () => {
    const s = memoryStorage();
    vi.stubGlobal('localStorage', s);
    const a = probeIdentity();
    const b = probeIdentity();
    expect(a).toEqual(b);
    expect(a.clientId).not.toBe(a.projectId);
    expect(s.m.get(PROBE_STORAGE.clientId)).toBe(a.clientId);
    expect(a.clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('without localStorage (it throws) the identity is still stable for the page load', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readStored('x')).toBeNull();
    expect(() => writeStored('x', 'y')).not.toThrow();
    expect(probeIdentity()).toEqual(probeIdentity());
  });

  it('no report writer in a browser', () => {
    expect(reportWriter(false)).toBeNull();
    expect(reportWriter(true)).not.toBeNull();
  });
});
