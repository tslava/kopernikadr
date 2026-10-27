import { describe, expect, it } from 'vitest';
import { createStore } from '../state/store';
import { createFrameUrls, framePath } from './frames';

const state = (frames: { frameId: string; state: 'pending' | 'local' }[]) =>
  ({ state: createStore({ projects: { p: { frames } } }) }) as any;

describe('createFrameUrls', () => {
  const store = state([
    { frameId: 'a', state: 'local' },
    { frameId: 'b', state: 'pending' },
  ]);
  const mk = () => createFrameUrls(store, { baseUri: 'file:///data/kopernikadr/', convertFileSrc: (u) => `conv:${u}` });

  it('converts the file uri of a local frame', () => {
    expect(mk().url('p', 'a', 'play')).toBe('conv:file:///data/kopernikadr/projects/p/frames/a.play.jpg');
    expect(framePath('p', 'a', 'full')).toBe('projects/p/frames/a.full.jpg');
  });
  it('is null for pending, unknown frames and unknown projects', () => {
    const u = mk();
    expect(u.url('p', 'b', 'play')).toBeNull();
    expect(u.url('p', 'zz', 'play')).toBeNull();
    expect(u.url('nope', 'a', 'play')).toBeNull();
  });
  it('is null for a kind known to be absent, other kinds stay', () => {
    const u = mk();
    u.markAbsent('p', 'a', 'play');
    expect(u.url('p', 'a', 'play')).toBeNull();
    expect(u.url('p', 'a', 'thumb')).not.toBeNull();
  });
});
