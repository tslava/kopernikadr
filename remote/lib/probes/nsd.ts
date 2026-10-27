// `nsd` probe: browse `_kopernikadr._tcp` for a few seconds via discovery.ts (Task 7) and hand the
// cameras found to the camera probes. mDNS does not cross the emulator NAT, so there it fails with
// "no camera found" and the manual address is used instead.
import type { DiscoveryResult } from '../discovery';
import { ProbeFailure, ProbeSkip, type Probe } from './runner';
import type { ProbeShared } from './shared';

export interface NsdProbeDeps {
  /** discovery.discover bound to the native adapter; null in a plain browser. */
  discover: ((seconds: number) => Promise<DiscoveryResult>) | null;
  seconds?: number;
}

export function nsdProbe(deps: NsdProbeDeps): Probe<ProbeShared> {
  return {
    name: 'nsd',
    async run(ctx) {
      if (!deps.discover) throw new ProbeSkip('native-only');
      const r = await deps.discover(deps.seconds ?? 5);
      ctx.shared.nsdServices = r.services;
      const data = { ...r, count: r.services.length };
      const startError = r.errors.find((e) => e.stage === 'start');
      if (startError) throw new ProbeFailure(`discovery did not start: ${startError.message}`, data);
      if (!r.services.length) throw new ProbeFailure('no camera found', data);
      return data;
    },
  };
}
