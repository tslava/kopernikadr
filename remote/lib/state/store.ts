// A tiny observable store: get/set/update/subscribe. Listeners run only when the state changes
// (Object.is), so it fits useSyncExternalStore directly.
export interface Store<S> {
  get(): S;
  set(next: S): void;
  update(fn: (prev: S) => S): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: S) => {
    if (Object.is(next, state)) return;
    state = next;
    for (const l of [...listeners]) l();
  };
  return {
    get: () => state,
    set,
    update: (fn) => set(fn(state)),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
