// Test support: the Node fake camera from protocol/tools/probe-client (real HTTP + WebSocket on an
// ephemeral port), loaded through a computed URL so tsc doesn't type-check that plain JS file.
import { randomUUID } from 'node:crypto';
import type { SessionDeps } from './camera';

export interface FakeFrame {
  frameId: string;
  seq: number;
  clientId: string;
  projectId: string;
  full: { w: number; h: number; bytes: number; sha256: string };
}

export interface FakeCamera {
  host: string;
  port: number;
  fullBytes: Uint8Array;
  state: {
    frames: Map<string, FakeFrame>;
    acked: Set<string>;
    requests: string[];
    session: { sessionId: string; clientId: string } | null;
    ctl: { previewQuality: string; rotation: number };
  };
  close(): Promise<void>;
}

export interface FakeCameraOptions {
  port?: number;
  stallNexts?: number;
  captureDelayMs?: number;
  confirmDelayMs?: number;
  previewIntervalMs?: number;
  replaceSessions?: boolean;
  rotation?: number;
}

const FAKE_CAMERA = new URL('../../../protocol/tools/probe-client/fake-camera.mjs', import.meta.url).href;

export async function startFakeCamera(opts: FakeCameraOptions = {}): Promise<FakeCamera> {
  const mod = (await import(/* @vite-ignore */ FAKE_CAMERA)) as { startFakeCamera(o: FakeCameraOptions): Promise<FakeCamera> };
  return mod.startFakeCamera(opts);
}

/** Session deps for Node: global WebSocket, a fresh probe clientId. */
export function nodeSessionDeps(clientId: string = randomUUID()): SessionDeps {
  return { WebSocketImpl: WebSocket, clientId, appVersion: 'probe-test', platform: 'test', now: () => performance.now() };
}

/** A manual address for the fake camera. */
export const shared = (cam: { port: number }) => ({ manualAddress: `127.0.0.1:${cam.port}` });

/** Another client holding the camera's session (the kid's remote-lite) for BUSY tests. */
export async function holdSession(cam: { port: number }): Promise<() => void> {
  const ws = new WebSocket(`ws://127.0.0.1:${cam.port}/ws/control`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const answered = new Promise((resolve) => ws.addEventListener('message', resolve, { once: true }));
  ws.send(JSON.stringify({ v: 1, t: 'req', reqId: randomUUID(), op: 'hello', args: { clientId: randomUUID(), protocolVersions: { min: 1, max: 1 }, appVersion: 'kid', platform: 'web' } }));
  await answered;
  return () => ws.close();
}
