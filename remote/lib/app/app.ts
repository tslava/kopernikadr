'use client';

// The real app wiring + the context the UI reads: a module-level observable store holding the
// AppContext once boot finished (the existing store pattern, no React context needed).
import { useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { nativeNsdAdapter } from '../discovery';
import { createAppFileAdapter } from '../projects/files';
import { createFetchBytes, createWebVerify } from '../projects/sweep';
import { createStore } from '../state/store';
import { createAppTransferIO } from '../transfer/appIO';
import { createTransfer, type TransferService } from '../transfer/queue';
import { createReconcile, type Reconcile } from '../transfer/reconcile';
import { boot, type AppContext } from './boot';
import { createBootRunner } from './bootRunner';

export type BootState = { phase: 'booting' } | { phase: 'ready'; app: AppContext } | { phase: 'failed'; error: string };

export const bootState = createStore<BootState>({ phase: 'booting' });

async function bootReal(): Promise<AppContext> {
  const fs = createAppFileAdapter();
  let hook: Reconcile | undefined;
  return boot({
    fs,
    verify: createWebVerify(fs, createFetchBytes((u) => fetch(u), (u) => Capacitor.convertFileSrc(u))),
    nsd: nativeNsdAdapter(),
    keepAwake: { acquire: () => KeepAwake.keepAwake(), release: () => KeepAwake.allowSleep() },
    createTransfer: ({ store, request, target, cameraId }) => {
      const service: TransferService = createTransfer({ store, io: createAppTransferIO(), request, target, cameraId });
      hook = createReconcile({ store, transfer: service });
      return service;
    },
    // runs after resolveOutstanding on every session; calls transfer.kick() itself (also when the listing fails)
    reconcile: (ctx) => hook!(ctx),
  });
}

const runner = createBootRunner<AppContext>(bootState, bootReal);

/** Idempotent: the first call boots, later calls return the same promise. */
export const startApp = runner.start;
/** After a failed boot: reset and boot again (the error screen's button). */
export const retryApp = runner.retry;

export function useBootState(): BootState {
  return useSyncExternalStore(bootState.subscribe, bootState.get, bootState.get);
}

/** The booted app, or null while booting / failed. */
export function useApp(): AppContext | null {
  const s = useBootState();
  return s.phase === 'ready' ? s.app : null;
}
