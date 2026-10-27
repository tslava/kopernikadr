// Boot runner: memoised start + retry after a failure (the error screen's button).
import type { Store } from '../state/store';

export type BootStateLike<A> = { phase: 'booting' } | { phase: 'ready'; app: A } | { phase: 'failed'; error: string };

export function createBootRunner<A>(state: Store<BootStateLike<A>>, boot: () => Promise<A>) {
  let started: Promise<void> | undefined;
  const start = (): Promise<void> =>
    (started ??= (async () => {
      try {
        state.set({ phase: 'ready', app: await boot() });
      } catch (e) {
        state.set({ phase: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    })());
  /** Only after a failure: resets the memo and the state, runs boot again. */
  const retry = (): Promise<void> => {
    if (state.get().phase !== 'failed') return started ?? start();
    started = undefined;
    state.set({ phase: 'booting' });
    return start();
  };
  return { start, retry };
}
