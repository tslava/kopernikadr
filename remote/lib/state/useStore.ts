'use client';

import { useSyncExternalStore } from 'react';
import type { Store } from './store';

/** Subscribes a component to a store, optionally through a selector (must return a stable value). */
export function useStore<S, T = S>(store: Store<S>, select: (s: S) => T = (s) => s as unknown as T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}
