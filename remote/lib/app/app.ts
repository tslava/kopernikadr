'use client';

// The real app wiring + the context the UI reads: a module-level observable store holding the
// AppContext once boot finished (the existing store pattern, no React context needed).
import { useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { nativeNsdAdapter } from '../discovery';
import { createAppFileAdapter } from '../projects/files';
import { createFetchBytes, createWebVerify } from '../projects/sweep';
import { createStore } from '../state/store';
import { createAppTransferIO } from '../transfer/appIO';
import { createTransfer, type TransferService } from '../transfer/queue';
import { createReconcile, type Reconcile } from '../transfer/reconcile';
import { boot, type AppContext } from './boot';

export type BootState = { phase: 'booting' } | { phase: 'ready'; app: AppContext } | { phase: 'failed'; error: string };

export const bootState = createStore<BootState>({ phase: 'booting' });

let started: Promise<void> | undefined;

/** Idempotent: the first call boots, later calls return the same promise. */
export function startApp(): Promise<void> {
  return (started ??= (async () => {
    try {
      const fs = createAppFileAdapter();
      let hook: Reconcile | undefined;
      const app = await boot({
        fs,
        verify: createWebVerify(fs, createFetchBytes((u) => fetch(u), (u) => Capacitor.convertFileSrc(u))),
        nsd: nativeNsdAdapter(),
        createTransfer: ({ store, request, target, cameraId }) => {
          const service: TransferService = createTransfer({ store, io: createAppTransferIO(), request, target, cameraId });
          hook = createReconcile({ store, transfer: service });
          return service;
        },
        // runs after resolveOutstanding on every session; calls transfer.kick() itself (also when the listing fails)
        reconcile: (ctx) => hook!(ctx),
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
