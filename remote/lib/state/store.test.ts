import { describe, expect, it, vi } from 'vitest';
import { createStore } from './store';

describe('store', () => {
  it('gets, sets and updates', () => {
    const s = createStore(1);
    s.set(2);
    s.update((n) => n + 3);
    expect(s.get()).toBe(5);
  });

  it('notifies subscribers on change only', () => {
    const s = createStore({ a: 1 });
    const l = vi.fn();
    s.subscribe(l);
    s.set(s.get());
    expect(l).not.toHaveBeenCalled();
    s.set({ a: 2 });
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes, and tolerates unsubscribing during notify', () => {
    const s = createStore(0);
    const a = vi.fn();
    const b = vi.fn();
    const offA = s.subscribe(() => { a(); offA(); });
    s.subscribe(b);
    s.set(1);
    s.set(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
