import { describe, expect, it } from 'vitest';
import { buildReport, reportFileName, saveReport, type ReportMeta, type ReportWriter } from './report';
import type { RunReport } from './runner';

const run: RunReport = {
  startedAt: '2026-10-27T07:50:00.000Z',
  durationMs: 61_234,
  cancelled: false,
  keepAwake: { held: true },
  results: [
    { name: 'env', ok: true, ms: 3, data: { isSecureContext: true } },
    { name: 'nsd', ok: false, ms: 5000, data: { services: [] }, error: 'no camera found' },
    { name: 'download', ok: false, ms: 900, data: null, skipped: 'native-only' },
  ],
};

const meta: ReportMeta = {
  appVersion: '0.1.0',
  platform: 'android',
  native: true,
  probeClientId: '6f0d8c7e-0000-4000-8000-000000000001',
  manualAddress: '10.0.2.2:8765',
};

const at = new Date('2026-10-27T07:52:01.123Z');

function fakeWriter(opts: { internal?: Error; external?: Error } = {}) {
  const files = new Map<string, string>();
  const writer: ReportWriter = {
    async writeInternal(path, text) {
      if (opts.internal) throw opts.internal;
      files.set(`internal:${path}`, text);
    },
    async writeExternal(path, text) {
      if (opts.external) throw opts.external;
      files.set(`external:${path}`, text);
      return `file:///storage/emulated/0/Android/data/pl.slava.kopernikadr.remote.debug/files/${path}`;
    },
  };
  return { writer, files };
}

describe('report', () => {
  it('file name: UTC, sortable, no colons', () => {
    expect(reportFileName(at)).toBe('remote-diag-20261027T075201Z.json');
  });

  it('builds the report: summary, meta, probes keyed by name in run order', () => {
    const r = buildReport(run, meta, at);
    expect(r).toMatchObject({
      kind: 'kopernikadr-remote-diag',
      schema: 1,
      createdAt: '2026-10-27T07:52:01.123Z',
      startedAt: '2026-10-27T07:50:00.000Z',
      durationMs: 61_234,
      cancelled: false,
      meta,
      keepAwake: { held: true },
      summary: { total: 3, passed: 1, failed: 1, skipped: 1 },
    });
    expect(Object.keys(r.probes)).toEqual(['env', 'nsd', 'download']);
    expect(r.probes.nsd.error).toBe('no camera found');
  });

  it('writes the same JSON to probe/<name> internally (atomic) and externally', async () => {
    const report = buildReport(run, meta, at);
    const { writer, files } = fakeWriter();
    const res = await saveReport(report, writer);
    const path = 'probe/remote-diag-20261027T075201Z.json';
    expect(res).toEqual({
      saved: true,
      name: 'remote-diag-20261027T075201Z.json',
      internal: { path, ok: true },
      external: { path, ok: true, uri: `file:///storage/emulated/0/Android/data/pl.slava.kopernikadr.remote.debug/files/${path}` },
    });
    expect([...files.keys()]).toEqual([`internal:${path}`, `external:${path}`]);
    const text = files.get(`internal:${path}`)!;
    expect(files.get(`external:${path}`)).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(report);
  });

  it('a failing internal write still makes the external copy, and vice versa', async () => {
    const report = buildReport(run, meta, at);
    const a = await saveReport(report, fakeWriter({ internal: Object.assign(new Error('disk full'), { code: 'NO_SPACE' }) }).writer);
    expect(a).toMatchObject({ saved: true, internal: { ok: false, error: 'NO_SPACE: disk full' }, external: { ok: true } });
    const b = await saveReport(report, fakeWriter({ external: new Error('denied') }).writer);
    expect(b).toMatchObject({ saved: true, internal: { ok: true }, external: { ok: false, error: 'denied' } });
    const c = await saveReport(report, fakeWriter({ internal: new Error('x'), external: new Error('y') }).writer);
    expect(c.saved).toBe(false);
  });

  it('in a browser nothing is written: native-only', async () => {
    const res = await saveReport(buildReport(run, meta, at), null);
    expect(res).toEqual({ saved: false, reason: 'native-only', name: 'remote-diag-20261027T075201Z.json' });
  });
});
