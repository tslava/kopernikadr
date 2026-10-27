import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Backoff } from '@kopernikadr/remote-core/backoff';
import { CameraConnection } from '@kopernikadr/remote-core/connection';
import { hostPort, type CameraTarget } from './camera';
import { startFakeCamera, type FakeCamera } from './fakeCamera.testutil';
import { reconnectProbe, type ConnectionLike, type ReconnectDeps, type ScenarioResult } from './reconnect';
import { runProbes, type PromptKey } from './runner';

let cam: FakeCamera | null = null;
afterEach(async () => {
  await cam?.close();
  cam = null;
});

/** The real CameraConnection with a fast backoff (tests only); one probe clientId, as in the app. */
const PROBE_CLIENT = randomUUID();
const connect = (target: CameraTarget): ConnectionLike =>
  new CameraConnection({
    url: `ws://${hostPort(target)}/ws/control`,
    clientId: PROBE_CLIENT,
    backoff: new Backoff({ minMs: 50, maxMs: 200 }),
  }) as ConnectionLike;

const deps = (extra: Partial<ReconnectDeps> = {}): ReconnectDeps => ({
  connect,
  now: () => performance.now(),
  offlineGraceMs: 300,
  reconnectTimeoutMs: 3000,
  ...extra,
});

/** Prompt answers: an action per prompt (the "parent"), then "next" unless it returns "skip". */
function parent(actions: Partial<Record<PromptKey, () => Promise<unknown> | unknown>>) {
  const asked: PromptKey[] = [];
  return {
    asked,
    prompt: async (key: PromptKey) => {
      asked.push(key);
      const r = await actions[key]?.();
      return r === 'skip' ? ('skip' as const) : ('next' as const);
    },
  };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kick = () => fetch(`http://${cam!.host}/fake/kick`).then((r) => r.json());
const stopCamera = async () => {
  await cam!.close();
};
// Like the parent: lock/close first, notice it, then tap "Next" (the drop is seen before the tap).
const kickThenTap = async () => {
  await kick();
  await pause(300);
};
const stopThenTap = async () => {
  await stopCamera();
  await pause(300);
};
const startCamera = async (port: number) => {
  cam = await startFakeCamera({ port });
};

async function run(prompt: (k: PromptKey) => Promise<'next' | 'skip'>, d = deps(), manualAddress = `127.0.0.1:${cam!.port}`) {
  return (await runProbes([reconnectProbe(d)], { shared: { manualAddress }, prompt })).results[0];
}

type Data = { initial: { bootId: string } | null; screenLock?: ScenarioResult; cameraRestart?: ScenarioResult };

describe('reconnect probe (fake camera, real CameraConnection)', () => {
  it('screen lock (sockets dropped) and camera restart (new bootId) both reconnect', async () => {
    cam = await startFakeCamera();
    const port = cam.port;
    const p = parent({
      lockScreen: kickThenTap,
      closeCamera: stopThenTap,
      startCamera: () => startCamera(port),
    });
    const r = await run(p.prompt);
    expect(p.asked).toEqual(['lockScreen', 'unlockScreen', 'closeCamera', 'startCamera']);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const data = r.data as Data;
    expect(data.screenLock).toMatchObject({ wentOffline: true, reconnected: true, bootChanged: false });
    expect(data.cameraRestart).toMatchObject({ wentOffline: true, reconnected: true, bootChanged: true });
    expect(data.cameraRestart!.timeToReconnectMs).toBeGreaterThanOrEqual(0);
    expect(data.cameraRestart!.states!.map((s) => s.state)).toContain('offline');
  });

  it('a screen lock that never drops the connection counts as staying online', async () => {
    cam = await startFakeCamera();
    const port = cam.port;
    const r = await run(parent({ closeCamera: stopCamera, startCamera: () => startCamera(port) }).prompt);
    expect(r.ok).toBe(true);
    expect((r.data as Data).screenLock).toMatchObject({ wentOffline: false, reconnected: true, timeToReconnectMs: 0 });
  });

  it('fails when the "restarted" camera keeps its bootId (it was only kicked)', async () => {
    cam = await startFakeCamera();
    const r = await run(parent({ lockScreen: kick, closeCamera: kick }).prompt);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cameraRestart: same bootId after a restart');
  });

  it('fails when the camera does not come back in time', async () => {
    cam = await startFakeCamera();
    const port = cam.port;
    const r = await run(parent({ closeCamera: stopCamera }).prompt, deps({ reconnectTimeoutMs: 400 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^cameraRestart: not reconnected \(state offline\)/);
    expect((r.data as Data).cameraRestart).toMatchObject({ wentOffline: true, reconnected: false });
    await startCamera(port); // for afterEach
  });

  it('skipping one scenario keeps the other; skipping both skips the probe', async () => {
    cam = await startFakeCamera();
    const one = await run(parent({ lockScreen: kick, closeCamera: () => 'skip' }).prompt);
    expect(one.ok).toBe(true);
    expect((one.data as Data).cameraRestart).toEqual({ skipped: true });
    const both = await run(parent({ lockScreen: () => 'skip', unlockScreen: () => 'skip', closeCamera: () => 'skip' }).prompt);
    expect(both).toMatchObject({ ok: false, skipped: 'user' });
  });

  it('fails without a session at the start, and without an address', async () => {
    cam = await startFakeCamera();
    const port = cam.port;
    await cam.close();
    cam = null;
    const r = await run(parent({}).prompt, deps({ initialTimeoutMs: 300 }), `127.0.0.1:${port}`);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^no session within 0.3 s/) });
    const none = await run(parent({}).prompt, deps(), '');
    expect(none).toMatchObject({ ok: false, error: expect.stringMatching(/no camera address/) });
  });

  it('stops the connection at the end', async () => {
    let stopped = false;
    const fake: ConnectionLike = {
      state: 'online',
      on: ((name: string, fn: (x: unknown) => void) => {
        if (name === 'session') setTimeout(() => fn({ bootId: 'b', sessionId: 's' }), 10);
        return () => {};
      }) as ConnectionLike['on'],
      start() {},
      stop() {
        stopped = true;
      },
    };
    const r = await runProbes([reconnectProbe(deps({ connect: () => fake }))], { shared: { manualAddress: '10.0.2.2' }, prompt: async () => 'skip' });
    expect(r.results[0].skipped).toBe('user');
    expect(stopped).toBe(true);
  });
});
