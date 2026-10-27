'use client';

import { useEffect, useMemo, useState } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { retryApp, startApp, useApp, useBootState } from '@/lib/app/app';
import { PREVIEW_QUALITIES } from '@/lib/app/drawerModel';
import { useFrameUrls, type FrameUrls } from '@/lib/app/frames';
import type { AppContext } from '@/lib/app/boot';
import type { PreviewQuality } from '@/lib/camera/previewController';
import { createStore } from '@/lib/state/store';
import { useStore } from '@/lib/state/useStore';
import type { TransferPause } from '@/lib/transfer/types';
import type { Translate } from '@/lib/i18n';
import { back, navigate, useRoute } from '@/lib/nav';
import { useTranslator } from '@/lib/i18n/useTranslator';
import CaptureDrawer from './CaptureDrawer';
import CaptureView from './CaptureView';
import ConnectView from './ConnectView';
import Diagnostics from './Diagnostics';
import Icon from './Icon';
import PlayView from './PlayView';
import ProjectsView from './ProjectsView';

const isQuality = (v: unknown): v is PreviewQuality => (PREVIEW_QUALITIES as readonly unknown[]).includes(v);

const NOT_EXPORTING = createStore(false);

export default function AppShell() {
  const { t } = useTranslator();
  const route = useRoute();
  const app = useApp();
  const boot = useBootState();

  // Boot once: ProjectStore load + sweep, then the camera client (see lib/app/boot.ts).
  useEffect(() => {
    void startApp();
  }, []);

  // Back to the foreground: the connection reconnects now (one loop, owned by remote-core).
  useEffect(() => {
    if (!app || !Capacitor.isNativePlatform()) return;
    const sub = App.addListener('appStateChange', (s) => {
      app.lifecycle.setActive(s.isActive); // client.resume() + preview + transfers: lib/app/lifecycle.ts
    });
    return () => void sub.then((h) => h.remove());
  }, [app]);

  // Android back button: first closes an open drawer/dialog; ignored while an export runs; else one
  // step back in our hash history, or to projects; exit from projects.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = App.addListener('backButton', () => {
      if (app?.overlays.closeTop()) return;
      if (app?.exporting.get()) return;
      if (!back()) void App.exitApp();
    });
    return () => void sub.then((h) => h.remove());
  }, [app]);

  const urls = useFrameUrls(app?.store);
  const exporting = useStore(app?.exporting ?? NOT_EXPORTING);
  // Parent settings shared by the capture view and its drawer; remembered on this tablet.
  const [quality, setQuality] = useRemembered<PreviewQuality>('kopernikadr.previewQuality', 'normal', isQuality);
  const [grid, setGrid] = useRemembered<boolean>('kopernikadr.grid', false, (v): v is boolean => typeof v === 'boolean');
  const goBack = () => void back();
  if (boot.phase === 'failed') {
    return (
      <main className="screen">
        <p className="note" role="alert">{t('boot.failed')}</p>
        <p className="note">{boot.error}</p>
        <button type="button" className="primary" onClick={() => void retryApp()}>{t('boot.retry')}</button>
      </main>
    );
  }
  switch (route.name) {
    case 'connect':
      return <ConnectView t={t} onBack={goBack} />;
    case 'capture':
      return app ? (
        <CaptureView
          t={t}
          id={route.id}
          app={app}
          urls={urls}
          onBack={goBack}
          onPlay={() => navigate({ name: 'play', id: route.id })}
          quality={quality}
          exporting={exporting}
          grid={grid}
          drawer={({ project }) => (
            <CaptureDrawer
              t={t}
              app={app}
              projectId={project.id}
              quality={quality}
              onQuality={setQuality}
              grid={grid}
              onGrid={setGrid}
            />
          )}
        />
      ) : (
        <main className="screen">
          <header className="bar">
            <button type="button" className="icon-btn" aria-label={t('nav.back')} title={t('nav.back')} onClick={goBack}>
              <Icon name="back" />
            </button>
          </header>
          <p className="note">{t('capture.loading')}</p>
        </main>
      );
    case 'play':
      return app ? <PlayRoute t={t} id={route.id} app={app} urls={urls} onBack={goBack} /> : <PlayView t={t} id={route.id} onBack={goBack} />;
    case 'diagnostics':
      return <Diagnostics t={t} onBack={goBack} yieldClient={app?.lifecycle.yieldToProbes} />;
    default:
      return (
        <ProjectsView
          t={t}
          onConnect={() => navigate({ name: 'connect' })}
          onDiagnostics={() => navigate({ name: 'diagnostics' })}
          frameUrl={urls ? (p, f, kind) => urls.url(p, f, kind) : undefined}
        />
      );
  }
}

/** PlayView with its project from the store and `frameUrl` over the local files. */
function PlayRoute({ t, id, app, urls, onBack }: { t: Translate; id: string; app: AppContext; urls: FrameUrls | null; onBack: () => void }) {
  const project = useStore(app.store.state, (s) => s.projects[id] ?? null);
  const frameUrl = useMemo(
    () =>
      urls
        ? (p: string, f: string, k: 'play' | 'full') => {
            const u = urls.url(p, f, k);
            if (!u) throw new Error('frame file not available');
            return u;
          }
        : undefined,
    [urls],
  );
  const exportEnv = useMemo(
    () =>
      app.transfer.pause && app.transfer.resume
        ? { key: app, transfer: app.transfer as TransferPause, exporting: app.exporting, overlays: app.overlays }
        : undefined,
    [app],
  );
  const snap = useStore(app.client.store);
  const link = useMemo(() => ({ online: snap.status === 'online' && snap.hello !== null, cameraId: snap.hello?.cameraId ?? null }), [snap.status, snap.hello]);
  return <PlayView t={t} id={id} onBack={onBack} project={project} frameUrl={frameUrl} exportEnv={exportEnv} link={link} />;
}

/** A small per-tablet setting in localStorage (try/catch: storage can be unavailable). */
function useRemembered<T>(key: string, initial: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const v: unknown = JSON.parse(raw);
      return valid(v) ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* not remembered, still applied */
    }
  };
  return [value, set];
}
