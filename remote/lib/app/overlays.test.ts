import { describe, expect, it } from 'vitest';
import { createOverlayStack } from './overlays';

describe('overlay stack', () => {
  it('closes the topmost overlay first; false when empty', () => {
    const s = createOverlayStack();
    const log: string[] = [];
    s.push(() => log.push('drawer'));
    s.push(() => log.push('dialog'));
    expect(s.closeTop()).toBe(true);
    expect(log).toEqual(['dialog']);
    expect(s.closeTop()).toBe(true);
    expect(s.closeTop()).toBe(false);
    expect(log).toEqual(['dialog', 'drawer']);
  });
  it('unregister removes an overlay (idempotent)', () => {
    const s = createOverlayStack();
    const off = s.push(() => {});
    off();
    off();
    expect(s.size).toBe(0);
    expect(s.closeTop()).toBe(false);
  });
});
