'use client';

// The real app wiring + the context the UI reads: a module-level observable store holding the
// AppContext once boot finished (the existing store pattern, no React context needed).
import { useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { nativeNsdAdapter } from '../discovery';
import { createAppFileAdapter } from '../projects/files';
import { createWebVerify } from '../projects/sweep';
import { createStore } from '../state/store';
import type { Transfer } from '../transfer/types';
import { boot, type AppContext, type Reconcile } from './boot';

export type BootState = { phase: 'booting' } | { phase: 'ready'; app: AppContext } | { phase: 'failed'; error: string };

export const bootState = createStore<BootState>({ phase: 'booting' });

// TODO Task 10/11: replace stub. Transfer (queue/download/ack) is being written in parallel.
export const stubTransfer: Transfer = {
  enqueue: () => {},
  ackNow: () => {},
};
// TODO Task 10/11: replace stub. Reconcile (§5.7, Task 11) is being written in parallel.
export const stubReconcile: Reconcile = () => {};

let started: Promise<void> | undefined;

/** Idempotent: the first call boots, later calls return the same promise. */
export function startApp(): Promise<void> {
  return (started ??= (async () => {
    try {
      const fs = createAppFileAdapter();
      const app = await boot({
        fs,
        verify: createWebVerify(fs, (u) => fetch(Capacitor.convertFileSrc(u)).then((r) => r.arrayBuffer())),
        nsd: nativeNsdAdapter(),
        createTransfer: () => stubTransfer, // TODO Task 10/11: replace stub
        reconcile: stubReconcile, // TODO Task 10/11: replace stub
      });
      bootState.set({ phase: 'ready', app });
    } catch (e) {
      bootState.set({ phase: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  })());
}

export function useBootState(): BootState {
  return useSyncExternalStore(bootState.subscribe, bootState.get, bootState.get);
}

/** The booted app, or null while booting / failed. */
export function useApp(): AppContext | null {
  const s = useBootState();
  return s.phase === 'ready' ? s.app : null;
}
