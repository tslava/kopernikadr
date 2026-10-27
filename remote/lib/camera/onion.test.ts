import { describe, expect, it } from 'vitest';
import type { FrameEntry } from '../projects/model';
import { lastLocalFrame, onionOpacityValue, selectOnionSource, type FrameUrl } from './onion';

const fr = (seq: number, state: FrameEntry['state'] = 'local', hiddenUntil: string | null = null): FrameEntry => ({
  frameId: `F${seq}`, seq, bytes: 1, sha256: 'x', state, hiddenUntil,
});
const urls = (have: string[]): FrameUrl => (p, f, k) => (have.includes(`${f}/${k}`) ? `file://${p}/${f}/${k}` : null);

describe('onion source selection', () => {
  it('no frames / only pending -> none', () => {
    expect(selectOnionSource('p', [], urls([]))).toBeNull();
    expect(selectOnionSource('p', [fr(1, 'pending')], urls(['F1/play']))).toBeNull();
  });
  it('prefers play of the last local frame', () => {
    const s = selectOnionSource('p', [fr(1), fr(2), fr(3, 'pending')], urls(['F2/play', 'F2/thumb', 'F1/play']));
    expect(s).toEqual({ kind: 'play', frameId: 'F2', url: 'file://p/F2/play' });
  });
  it('falls back to thumb, then none', () => {
    expect(selectOnionSource('p', [fr(2)], urls(['F2/thumb']))?.kind).toBe('thumb');
    expect(selectOnionSource('p', [fr(2)], urls(['F1/play']))).toBeNull();
  });
  it('skips frames hidden by a pending undo', () => {
    const now = Date.parse('2026-01-01T00:00:10Z');
    const frames = [fr(1), fr(2, 'local', '2026-01-01T00:00:15Z')];
    expect(lastLocalFrame(frames, now)?.frameId).toBe('F1');
    expect(lastLocalFrame(frames, Date.parse('2026-01-01T00:00:20Z'))?.frameId).toBe('F2');
  });
  it('clamps opacity', () => {
    expect(onionOpacityValue(30)).toBe(0.3);
    expect(onionOpacityValue(0)).toBe(0.1);
    expect(onionOpacityValue(200)).toBe(0.8);
    expect(onionOpacityValue(NaN)).toBe(0.3);
  });
});
