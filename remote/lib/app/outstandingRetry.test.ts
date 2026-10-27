import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSnapshot, SessionContext } from '../camera/client';
import { createStore } from '../state/store';
import { createOutstandingRetry, OUTSTANDING_RETRY_MS } from './outstandingRetry';

const snap = (over: Partial<ClientSnapshot> = {}): ClientSnapshot =>
  ({
    status: 'online', needsConnect: false, found: [], target: null, unsupported: false, reconciling: false,
    hello: { cameraId: 'cam', bootId: 'b1' },
    ...over,
  }) as ClientSnapshot;
const withOut = (cameraId: string | null) => ({
  projects: { p: { outstanding: cameraId ? [{ reqId: 'r', cameraId, sentAt: 's' }] : [] } },
});

describe('outstanding retry', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  function rig(client = snap(), projects = withOut('cam')) {
    const cs = createStore(client);
    const ps = createStore(projects);
    const resolve = vi.fn(async (_ctx: SessionContext) => {});
    const retry = createOutstandingRetry({ client: { store: cs, request: vi.fn() }, projects: ps, resolve });
    return { cs, ps, resolve, retry };
  }

  it('retries every 5 s while online, settled and an entry of this camera exists', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(OUTSTANDING_RETRY_MS - 1);
    expect(r.resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.resolve.mock.calls[0]![0]).toMatchObject({ bootId: 'b1', bootIdChanged: false });
    await vi.advanceTimersByTimeAsync(OUTSTANDING_RETRY_MS);
    expect(r.resolve).toHaveBeenCalledTimes(2);
    r.retry.dispose();
  });

  it('stops when the entry resolves, when offline or reconciling, and on dispose', async () => {
    const r = rig();
    r.ps.set(withOut(null));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.resolve).not.toHaveBeenCalled();

    r.ps.set(withOut('cam'));
    r.cs.set(snap({ status: 'offline' }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.resolve).not.toHaveBeenCalled();

    r.cs.set(snap({ reconciling: true }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.resolve).not.toHaveBeenCalled();

    r.cs.set(snap());
    await vi.advanceTimersByTimeAsync(OUTSTANDING_RETRY_MS);
    expect(r.resolve).toHaveBeenCalledTimes(1);
    r.retry.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it('ignores an entry of another camera and does not overlap slow attempts', async () => {
    const other = rig(snap(), withOut('other'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(other.resolve).not.toHaveBeenCalled();
    other.retry.dispose();

    const cs = createStore(snap());
    let release!: () => void;
    const resolve = vi.fn(() => new Promise<void>((res) => void (release = res)));
    const retry = createOutstandingRetry({ client: { store: cs, request: vi.fn() }, projects: createStore(withOut('cam')), resolve });
    await vi.advanceTimersByTimeAsync(OUTSTANDING_RETRY_MS * 3);
    expect(resolve).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(OUTSTANDING_RETRY_MS);
    expect(resolve).toHaveBeenCalledTimes(2);
    retry.dispose();
  });
});
