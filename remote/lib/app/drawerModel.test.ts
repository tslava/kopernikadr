import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { FrameInfo, Project, ProjectIndex } from '../projects/model';
import { beginCapture, createProject, markUnavailable, mergeFrame } from '../projects/reducers';
import {
  applyFps, applyPreviewQuality, applyRotation, compensationView, controlErrorKey, controlsPollMs, evLabel, formatBytes,
  lockView, readFreeBytes, rotationView, sendControl, unavailableCount, type Capabilities, type Controls,
} from './drawerModel';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../../protocol/fixtures/${n}.json`, import.meta.url), 'utf8'));
const hello = fx('hello.res').data;
const caps = hello.capabilities as Capabilities;
const baseControls = hello.controls as Controls;
const focusFailed = fx('controls.focusFailed.evt').data as Controls;

const PID = 'p1';
const CAM = 'cam-A';
const emptyIndex = (): ProjectIndex => ({ version: 1, clientId: 'c1', rememberedCamera: null, projects: [], deletedProjects: [], pendingProjectDeletes: [] });
const fresh = (): Project => createProject(emptyIndex(), { id: PID, name: 'Film', nowMs: 0 }).project;
const info = (n: number): FrameInfo => ({
  frameId: `F${n}`, seq: n, projectId: PID, clientId: 'c1', rotation: 0, capturedAt: '2026-10-26T15:04:05.123Z',
  full: { w: 3264, h: 2448, bytes: 1000 + n, sha256: `sha${n}` },
  derived: { play: { w: 1440, h: 1080 }, thumb: { w: 256, h: 192 } },
});
/** A project store double running the reducers over one project. */
const fakeStore = (p: Project) => {
  const s = { p, updateProject: async (_id: string, fn: (x: Project) => Project) => (s.p = fn(s.p)) };
  return s;
};

describe('lockView', () => {
  it('shows a confirmed lock as locked, an unconfirmed one as locking', () => {
    const c: Controls = { settling: true, exposure: { mode: 'locked', confirmed: false }, whiteBalance: { mode: 'locked', confirmed: true } };
    expect(lockView('exposure', c, caps).state).toBe('locking');
    expect(lockView('whiteBalance', c, caps).state).toBe('locked');
  });

  it('never says failed for focusOk:false while settling', () => {
    const settling: Controls = { ...focusFailed, settling: true };
    expect(lockView('focus', settling, caps).state).toBe('locking');
    expect(lockView('focus', settling, caps).state).not.toBe('failed');
  });

  it('says failed once settling ended (focusFailed fixture, and exposure mode failed)', () => {
    expect(focusFailed.settling).toBe(false);
    expect(lockView('focus', focusFailed, caps).state).toBe('failed');
    expect(lockView('exposure', { settling: false, exposure: { mode: 'failed', confirmed: false } }, caps).state).toBe('failed');
    expect(lockView('exposure', { settling: true, exposure: { mode: 'failed', confirmed: false } }, caps).state).toBe('locking');
  });

  it('handles fixed, unsupported and missing controls', () => {
    expect(lockView('focus', { focus: { mode: 'fixed', confirmed: true } }, caps)).toMatchObject({ state: 'fixed', canSet: false });
    expect(lockView('exposure', baseControls, { exposure: { lock: false } })).toMatchObject({ state: 'unsupported', canSet: false });
    expect(lockView('focus', null, caps).state).toBe('unknown');
    expect(lockView('exposure', baseControls, caps)).toMatchObject({ state: 'auto', current: 'auto', canSet: true });
  });
});

describe('compensationView', () => {
  it('is offered with the camera range when not frozen', () => {
    expect(compensationView(baseControls, caps)).toEqual({ min: -4, max: 4, steps: 0, label: '0.0 EV' });
  });

  it('is hidden when exposure is frozen or unsupported', () => {
    const frozen: Controls = { ...baseControls, exposure: { ...baseControls.exposure, mode: 'locked', compensationEnabled: false } };
    expect(compensationView(frozen, caps)).toBeNull();
    const off: Capabilities = { exposure: { compensation: { supported: false, minSteps: 0, maxSteps: 0 } } };
    expect(compensationView(baseControls, off)).toBeNull();
    expect(compensationView(null, caps)).toBeNull();
  });

  it('clamps steps and labels EV by stepEv', () => {
    const c: Controls = { exposure: { mode: 'auto', compensationEnabled: true, compensationSteps: 9 } };
    expect(compensationView(c, caps)?.steps).toBe(4);
    expect(evLabel(3, { num: 1, den: 2 })).toBe('+1.5 EV');
    expect(evLabel(-1, { num: 1, den: 3 })).toBe('-0.33 EV');
  });
});

describe('rotation', () => {
  it('is free for an empty project', () => {
    expect(rotationView(fresh(), caps)).toEqual({ options: [0, 180], current: 0, locked: false });
  });

  it('is locked once the first capture begins, and the reducer refuses it', async () => {
    const r = beginCapture(fresh(), { reqId: 'r1', cameraId: CAM, nowMs: 0 });
    if (!r.ok) throw new Error('unreachable');
    expect(rotationView(r.project, caps).locked).toBe(true);
    const store = fakeStore(r.project);
    await applyRotation(store, PID, 180);
    expect(store.p.geometry.rotation).toBe(0);
  });

  it('applies for an empty project', async () => {
    const store = fakeStore(fresh());
    await applyRotation(store, PID, 180);
    expect(store.p.geometry.rotation).toBe(180);
  });

  it('stays locked with a frame and nothing outstanding', () => {
    const r = beginCapture(fresh(), { reqId: 'r1', cameraId: CAM, nowMs: 0 });
    if (!r.ok) throw new Error('unreachable');
    const p = mergeFrame({ ...r.project, outstanding: [] }, info(1), CAM).project;
    expect(rotationView(p).locked).toBe(true);
  });
});

describe('setControl', () => {
  it('sends the flat shape and returns the Controls', async () => {
    const request = vi.fn(async () => baseControls);
    const r = await sendControl(request, { control: 'exposureCompensation', steps: -2 });
    expect(request).toHaveBeenCalledWith('setControl', { control: 'exposureCompensation', steps: -2 });
    expect(r).toEqual({ ok: true, controls: baseControls });
  });

  it('maps the error ladder to messages (fixture UNSUPPORTED_CONTROL)', async () => {
    const err = fx('setControl.err').error;
    const r = await sendControl(async () => { throw Object.assign(new Error(err.message), { code: err.code }); }, { control: 'focus', mode: 'locked' });
    expect(r).toEqual({ ok: false, code: 'UNSUPPORTED_CONTROL', messageKey: 'drawer.err.unsupported' });
    expect(controlErrorKey('INVALID_VALUE')).toBe('drawer.err.invalid');
    expect(controlErrorKey('INVALID_ARGS')).toBe('drawer.err.invalid');
    expect(controlErrorKey('CAPTURE_IN_PROGRESS')).toBe('drawer.err.busy');
    expect(controlErrorKey('CLOSED')).toBe('drawer.err.offline');
    expect(controlErrorKey('TIMEOUT')).toBe('drawer.err.offline');
    expect(controlErrorKey('WHATEVER')).toBe('drawer.err.generic');
  });
});

describe('fps and preview quality', () => {
  it('fps changes go through setFps and ignore values outside 5/8/12', async () => {
    const store = fakeStore(fresh());
    await applyFps(store, PID, 12);
    expect(store.p.fps).toBe(12);
    await applyFps(store, PID, 7);
    expect(store.p.fps).toBe(12);
  });

  it('quality changes tell the camera, and the preview follows only on success', async () => {
    const onQ = vi.fn();
    const ok = await applyPreviewQuality(async () => baseControls, 'high', onQ);
    expect(ok.ok).toBe(true);
    expect(onQ).toHaveBeenCalledWith('high');
    onQ.mockClear();
    const bad = await applyPreviewQuality(async () => { throw Object.assign(new Error('x'), { code: 'INVALID_VALUE' }); }, 'low', onQ);
    expect(bad).toMatchObject({ ok: false, messageKey: 'drawer.err.invalid' });
    expect(onQ).not.toHaveBeenCalled();
  });
});

describe('info and helpers', () => {
  it('counts unavailable frames', () => {
    const r = beginCapture(fresh(), { reqId: 'r1', cameraId: CAM, nowMs: 0 });
    if (!r.ok) throw new Error('unreachable');
    let p = mergeFrame(mergeFrame({ ...r.project, outstanding: [] }, info(1), CAM).project, info(2), CAM).project;
    expect(unavailableCount(p)).toBe(0);
    p = markUnavailable(p, 'F2', 'gave up', 0);
    expect(unavailableCount(p)).toBe(1);
  });

  it('formats storage and tolerates a missing/failing native call', async () => {
    expect(formatBytes(41_234_567_890, 'en')).toBe('41.2 GB');
    expect(formatBytes(500_000_000, 'en')).toBe('500 MB');
    expect(formatBytes(null)).toBeNull();
    expect(await readFreeBytes(async () => ({ bytes: 7 }))).toBe(7);
    expect(await readFreeBytes(null)).toBeNull();
    expect(await readFreeBytes(() => Promise.reject(new Error('x')))).toBeNull();
  });

  it('polls faster while settling', () => {
    expect(controlsPollMs({ settling: true })).toBeLessThan(controlsPollMs({ settling: false }));
  });
});
