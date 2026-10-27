import { describe, expect, it } from 'vitest';
import { failure, REASON_KEY, type CaptureReason } from '../capture/outstanding';
import type { FrameEntry, Project } from '../projects/model';
import { frameCount, hasOutstandingFor, onionSourceFor, pendingCount, shutterState, toastKey } from './captureModel';

const ok = { online: true, reconciling: false, outstanding: false, exporting: false, pressing: false };
const frame = (seq: number, over: Partial<FrameEntry> = {}): FrameEntry => ({
  frameId: `f${seq}`, seq, bytes: 1, sha256: 'x', state: 'local', hiddenUntil: null, ...over,
});

describe('shutterState', () => {
  it('is enabled only when nothing blocks it', () => {
    expect(shutterState(ok)).toEqual({ enabled: true, blocked: null });
  });
  it.each([
    [{ online: false }, 'offline'],
    [{ reconciling: true }, 'reconciling'],
    [{ outstanding: true }, 'outstanding'],
    [{ exporting: true }, 'exporting'],
    [{ pressing: true }, 'pressing'],
  ] as const)('%j -> disabled (%s)', (over, why) => {
    expect(shutterState({ ...ok, ...over })).toEqual({ enabled: false, blocked: why });
  });
  it('offline wins over everything', () => {
    expect(shutterState({ online: false, reconciling: true, outstanding: true, exporting: true, pressing: true }).blocked).toBe('offline');
  });
});

describe('hasOutstandingFor', () => {
  const projects = { a: { outstanding: [] }, b: { outstanding: [{ reqId: 'r', cameraId: 'cam1', sentAt: 't' }] } };
  it('limit 1 per camera across projects', () => {
    expect(hasOutstandingFor(projects, 'cam1')).toBe(true);
    expect(hasOutstandingFor(projects, 'cam2')).toBe(false);
    expect(hasOutstandingFor(projects, null)).toBe(false);
  });
});

describe('toastKey', () => {
  it('maps every failure reason to its message key', () => {
    for (const r of Object.keys(REASON_KEY) as CaptureReason[]) expect(toastKey(failure(r))).toBe(REASON_KEY[r]);
  });
  it('shows nothing for a frame', () => {
    expect(toastKey({ ok: true, frameId: 'f', projectId: 'p', merge: 'inserted' })).toBeNull();
  });
});

describe('counter / placeholders', () => {
  const now = Date.parse('2026-01-01T00:00:10Z');
  const p: Pick<Project, 'id' | 'frames' | 'outstanding'> = {
    id: 'p',
    frames: [frame(1), frame(2, { state: 'pending' }), frame(3, { hiddenUntil: '2026-01-01T00:00:15Z' }), frame(4, { hiddenUntil: '2026-01-01T00:00:05Z' })],
    outstanding: [{ reqId: 'r', cameraId: 'c', sentAt: 't' }],
  };
  it('counts visible frames (hidden by a pending undo excluded)', () => expect(frameCount(p, now)).toBe(3));
  it('counts outstanding + downloading as placeholders', () => expect(pendingCount(p, now)).toBe(2));
});

describe('onionSourceFor', () => {
  const now = Date.parse('2026-01-01T00:00:10Z');
  const url = (_p: string, f: string, k: string) => `u/${f}.${k}`;
  it('is the last local frame (play)', () => {
    const p = { id: 'p', frames: [frame(1), frame(2), frame(3, { state: 'pending' })] };
    expect(onionSourceFor(p, url, now)).toEqual({ kind: 'play', frameId: 'f2', url: 'u/f2.play' });
  });
  it('falls back to thumb when play is absent', () => {
    const p = { id: 'p', frames: [frame(1)] };
    expect(onionSourceFor(p, (_a, f, k) => (k === 'play' ? null : `u/${f}.${k}`), now)).toEqual({ kind: 'thumb', frameId: 'f1', url: 'u/f1.thumb' });
  });
  it('is null with no frames, no project or no url resolver', () => {
    expect(onionSourceFor({ id: 'p', frames: [] }, url, now)).toBeNull();
    expect(onionSourceFor(null, url, now)).toBeNull();
    expect(onionSourceFor({ id: 'p', frames: [frame(1)] }, null, now)).toBeNull();
  });
});
