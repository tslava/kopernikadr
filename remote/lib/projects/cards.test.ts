import { describe, expect, it } from 'vitest';
import { cardTarget, defaultProjectName, projectCards } from './cards';
import type { FrameEntry, Project, ProjectIndex } from './model';

const fr = (frameId: string, seq: number, state: 'local' | 'pending', hiddenUntil: string | null = null): FrameEntry =>
  ({ frameId, seq, bytes: 1, sha256: 'x', state, hiddenUntil });
const proj = (id: string, frames: FrameEntry[], cameraId: string | null = null): Project => ({
  version: 1, id, name: id, createdAt: '', fps: 8, geometry: { aspect: '4:3', rotation: 0 },
  cameraId, frames, deletedFrameIds: [], outstanding: [],
});
const index = (entries: [string, string, string][], pending: string[] = []): ProjectIndex => ({
  version: 1, clientId: 'c', rememberedCamera: null, deletedProjects: [],
  projects: entries.map(([id, name, createdAt]) => ({ id, name, createdAt })),
  pendingProjectDeletes: pending.map((id) => ({ id, deadline: '2026-01-01T00:00:00.000Z' })),
});

describe('projectCards', () => {
  it('sorts newest first, counts visible frames, picks the first local frame as cover', () => {
    const idx = index([['a', 'A', '2026-10-01T00:00:00Z'], ['b', 'B', '2026-10-02T00:00:00Z']]);
    const cards = projectCards(idx, {
      a: proj('a', [fr('f3', 3, 'local'), fr('f1', 1, 'pending'), fr('f2', 2, 'local'), fr('fh', 4, 'local', '2026-10-27T00:00:00Z')]),
      b: proj('b', []),
    });
    expect(cards.map((c) => c.id)).toEqual(['b', 'a']);
    expect(cards[0]).toMatchObject({ frameCount: 0, coverFrameId: null });
    expect(cards[1]).toMatchObject({ frameCount: 3, coverFrameId: 'f2' });
  });

  it('hides projects in the Undo window; recovered projects are ordinary cards', () => {
    const idx = index([['a', 'Odzyskany 27.10', '2026-10-01T00:00:00Z'], ['b', 'B', '2026-10-02T00:00:00Z']], ['b']);
    const cards = projectCards(idx, { a: proj('a', [fr('f1', 1, 'local')], 'cam') });
    expect(cards).toEqual([
      { id: 'a', name: 'Odzyskany 27.10', createdAt: '2026-10-01T00:00:00Z', frameCount: 1, coverFrameId: 'f1', cameraId: 'cam' },
    ]);
  });

  it('survives a project missing from memory', () => {
    expect(projectCards(index([['a', 'A', '2026-10-01T00:00:00Z']]), {})[0]).toMatchObject({ frameCount: 0, coverFrameId: null });
  });
});

describe('defaultProjectName', () => {
  const label = (n: number) => `Film ${n}`;
  it('is Film <count+1>', () => {
    expect(defaultProjectName([], label)).toBe('Film 1');
    expect(defaultProjectName(['x', 'y'], label)).toBe('Film 3');
  });
  it('skips taken names', () => {
    expect(defaultProjectName(['Film 2', 'Film 3'], label)).toBe('Film 4');
  });
});

describe('cardTarget', () => {
  it('capture unless bound to a different camera', () => {
    expect(cardTarget({ cameraId: null }, 'cam')).toBe('capture');
    expect(cardTarget({ cameraId: 'cam' }, 'cam')).toBe('capture');
    expect(cardTarget({ cameraId: 'cam' }, 'other')).toBe('play');
    expect(cardTarget({ cameraId: 'cam' }, null)).toBe('capture');
  });
});
