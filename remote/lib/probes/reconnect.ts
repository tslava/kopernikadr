// `reconnect` probe (interactive): keeps a remote-core CameraConnection to the camera and asks the
// parent to (1) lock the phone screen and unlock it, (2) close the camera app and start it again.
// It measures the time from the parent's "unlocked/started" tap to the next session, and checks
// that a camera restart brings a new bootId (PROTOCOL §4.6).
import { CameraConnection } from '@kopernikadr/remote-core/connection';
import { hostPort, NO_TARGET, resolveTarget, type CameraTarget } from './camera';
import { ProbeFailure, ProbeSkip, type ProbeContext, type Probe, type PromptKey } from './runner';
import type { ProbeShared } from './shared';
import { sleep } from './util';

/** The part of CameraConnection the probe uses (tests may pass a fake). */
export interface ConnectionLike {
  readonly state: string;
  on(name: 'state', fn: (state: string) => void): () => void;
  on(name: 'session', fn: (hello: { bootId: string; sessionId: string }) => void): () => void;
  start(): void;
  stop(): void;
}

export interface ReconnectDeps {
  connect(target: CameraTarget): ConnectionLike;
  now: () => number;
  /** First connection. */
  initialTimeoutMs?: number;
  /** After the second tap: how long a drop may take to be noticed (ping timeout is 5 s). */
  offlineGraceMs?: number;
  /** After the second tap: how long to wait for the next session. */
  reconnectTimeoutMs?: number;
}

/** A CameraConnection to `target` (the app's real reconnect loop: 2 s ping, backoff 0.5→5 s). */
export function cameraConnection(opts: { clientId: string; appVersion: string; platform: string }) {
  return (target: CameraTarget): ConnectionLike =>
    new CameraConnection({ url: `ws://${hostPort(target)}/ws/control`, ...opts }) as ConnectionLike;
}

export interface ScenarioResult {
  skipped?: true;
  /** The connection went offline after the first prompt was shown. */
  wentOffline?: boolean;
  /** First non-online state, ms after the first prompt was shown. */
  offlineAfterMs?: number;
  reconnected?: boolean;
  /** Next session, ms after the second tap (0 if it was back before the tap). */
  timeToReconnectMs?: number;
  reconnectedBeforeTap?: boolean;
  bootChanged?: boolean;
  /** Connection state changes, ms after the first prompt was shown. */
  states?: { atMs: number; state: string }[];
  lastState?: string;
  error?: string;
}

const SCENARIOS: { key: 'screenLock' | 'cameraRestart'; first: PromptKey; second: PromptKey; needsNewBoot: boolean }[] = [
  { key: 'screenLock', first: 'lockScreen', second: 'unlockScreen', needsNewBoot: false },
  { key: 'cameraRestart', first: 'closeCamera', second: 'startCamera', needsNewBoot: true },
];

export function reconnectProbe(deps: ReconnectDeps): Probe<ProbeShared> {
  const { now } = deps;

  async function waitFor(cond: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const until = now() + timeoutMs;
    while (!cond()) {
      if (now() >= until) return false;
      await sleep(50, signal);
    }
    return true;
  }

  return {
    name: 'reconnect',
    async run(ctx: ProbeContext<ProbeShared>) {
      const target = resolveTarget(ctx.shared);
      if (!target) throw new ProbeFailure(NO_TARGET);

      const states: { at: number; state: string }[] = [];
      const sessions: { at: number; bootId: string; sessionId: string }[] = [];
      const conn = deps.connect(target);
      const offState = conn.on('state', (state) => states.push({ at: now(), state }));
      const offSession = conn.on('session', (h) => sessions.push({ at: now(), bootId: h.bootId, sessionId: h.sessionId }));
      const data: { target: CameraTarget; initial: { ms: number; bootId: string } | null } & Partial<Record<'screenLock' | 'cameraRestart', ScenarioResult>> = {
        target,
        initial: null,
      };

      try {
        const t0 = now();
        conn.start();
        if (!(await waitFor(() => sessions.length > 0, deps.initialTimeoutMs ?? 15_000, ctx.signal))) {
          throw new ProbeFailure(`no session within ${(deps.initialTimeoutMs ?? 15_000) / 1000} s (state ${conn.state})`, data);
        }
        data.initial = { ms: Math.round(sessions[0].at - t0), bootId: sessions[0].bootId };

        const problems: string[] = [];
        for (const sc of SCENARIOS) {
          const bootBefore = sessions.at(-1)!.bootId;
          // The parent locks the phone / closes the app while the first prompt is shown, i.e.
          // before tapping "Next": the drop is looked for from the moment the prompt appears.
          const tFirst = now();
          if ((await ctx.prompt(sc.first)) === 'skip') {
            data[sc.key] = { skipped: true };
            continue;
          }
          if ((await ctx.prompt(sc.second)) === 'skip') {
            data[sc.key] = { skipped: true };
            continue;
          }
          const tTap = now();
          const rel = (t: number) => Math.round(t - tFirst);
          const dropAfter = () => states.find((s) => s.at >= tFirst && s.state !== 'online');
          if (!dropAfter()) await waitFor(() => !!dropAfter(), deps.offlineGraceMs ?? 6_000, ctx.signal);
          const drop = dropAfter();
          const r: ScenarioResult = { wentOffline: !!drop };
          data[sc.key] = r;
          if (drop) {
            r.offlineAfterMs = rel(drop.at);
            const back = () => sessions.find((s) => s.at > drop.at);
            await waitFor(() => !!back(), deps.reconnectTimeoutMs ?? 60_000, ctx.signal);
            const b = back();
            r.reconnected = !!b;
            if (b) {
              r.timeToReconnectMs = Math.max(0, Math.round(b.at - tTap));
              r.reconnectedBeforeTap = b.at < tTap;
              r.bootChanged = b.bootId !== bootBefore;
            }
          } else {
            r.reconnected = conn.state === 'online';
            r.timeToReconnectMs = 0;
            r.bootChanged = false;
          }
          r.states = states.filter((s) => s.at >= tFirst).map((s) => ({ atMs: rel(s.at), state: s.state }));
          r.lastState = conn.state;

          if (!r.reconnected) r.error = `not reconnected (state ${conn.state})`;
          else if (sc.needsNewBoot && !r.bootChanged) r.error = r.wentOffline ? 'same bootId after a restart' : 'the connection never dropped: was the camera app closed?';
          if (r.error) problems.push(`${sc.key}: ${r.error}`);
        }

        if (SCENARIOS.every((sc) => data[sc.key]?.skipped)) throw new ProbeSkip('user', data);
        if (problems.length) throw new ProbeFailure(problems.join('; '), data);
        return data;
      } finally {
        offState();
        offSession();
        conn.stop();
      }
    },
  };
}
