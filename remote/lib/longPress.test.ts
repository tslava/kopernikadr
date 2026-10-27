import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beyondSlop, createLongPress, LONG_PRESS_SLOP_PX } from './longPress';

describe('createLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the hold time', () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, 1000);
    lp.start();
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not fire when cancelled early', () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, 1000);
    lp.start();
    vi.advanceTimersByTime(600);
    lp.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('restarting resets the clock', () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, 1000);
    lp.start();
    vi.advanceTimersByTime(800);
    lp.start();
    vi.advanceTimersByTime(800);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('beyondSlop', () => {
  it('a small drift keeps the hold, a real move cancels it', () => {
    expect(beyondSlop(0, 0)).toBe(false);
    expect(beyondSlop(8, 12)).toBe(false);
    expect(beyondSlop(LONG_PRESS_SLOP_PX, 0)).toBe(false);
    expect(beyondSlop(LONG_PRESS_SLOP_PX + 1, 0)).toBe(true);
    expect(beyondSlop(-20, -20)).toBe(true);
  });
});
