import { describe, expect, it } from 'vitest';
import { formatRoute, parseHash } from './router';

describe('parseHash', () => {
  it('parses every view', () => {
    expect(parseHash('#/projects')).toEqual({ name: 'projects' });
    expect(parseHash('#/connect')).toEqual({ name: 'connect' });
    expect(parseHash('#/diagnostics')).toEqual({ name: 'diagnostics' });
    expect(parseHash('#/capture/abc-1_X')).toEqual({ name: 'capture', id: 'abc-1_X' });
    expect(parseHash('#/play/p1')).toEqual({ name: 'play', id: 'p1' });
  });

  it('defaults to projects', () => {
    for (const h of ['', '#', '#/', '#diagnostics', '#/nope', '#/capture', '#/capture/', '#/play/a/b',
      '#/connect/x', '#/capture/%E0%A4%A', '#/capture/a b', '#/play/..%2Fx', `#/play/${'a'.repeat(65)}`]) {
      expect(parseHash(h), h).toEqual({ name: 'projects' });
    }
  });

  it('round-trips through formatRoute', () => {
    for (const h of ['#/projects', '#/connect', '#/diagnostics', '#/capture/a1', '#/play/b_2']) {
      expect(formatRoute(parseHash(h))).toBe(h);
    }
  });
});
