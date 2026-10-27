'use client';

import { useEffect, useMemo } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { startApp, useApp } from '@/lib/app/app';
import { useFrameUrls, type FrameUrls } from '@/lib/app/frames';
import type { AppContext } from '@/lib/app/boot';
import { useStore } from '@/lib/state/useStore';
import type { Translate } from '@/lib/i18n';
import { back, navigate, useRoute } from '@/lib/nav';
import { useTranslator } from '@/lib/i18n/useTranslator';
import CaptureView from './CaptureView';
import ConnectView from './ConnectView';
import Diagnostics from './Diagnostics';
import PlayView from './PlayView';
import ProjectsView from './ProjectsView';

export default function AppShell() {
  const { t } = useTranslator();
  const route = useRoute();
  const app = useApp();

  // Boot once: ProjectStore load + sweep, then the camera client (see lib/app/boot.ts).
  useEffect(() => {
    void startApp();
  }, []);

  // Back to the foreground: the connection reconnects now (one loop, owned by remote-core).
  useEffect(() => {
    if (!app || !Capacitor.isNativePlatform()) return;
    const sub = App.addListener('appStateChange', (s) => {
      if (s.isActive) app.client.resume();
    });
    return () => void sub.then((h) => h.remove());
  }, [app]);

  // Android back button: one step back in our hash history, or to projects; exit from projects.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = App.addListener('backButton', () => {
      if (!back()) void App.exitApp();
    });
    return () => void sub.then((h) => h.remove());
  }, []);

  const urls = useFrameUrls(app?.store);
  const goBack = () => void back();
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
        />
      ) : (
        <main className="screen"><p className="note">{t('capture.loading')}</p></main>
      );
    case 'play':
      return app ? <PlayRoute t={t} id={route.id} app={app} urls={urls} onBack={goBack} /> : <PlayView t={t} id={route.id} onBack={goBack} />;
    case 'diagnostics':
      return <Diagnostics t={t} onBack={goBack} />;
    default:
      return (
        <ProjectsView t={t} onConnect={() => navigate({ name: 'connect' })} onDiagnostics={() => navigate({ name: 'diagnostics' })} />
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
  return <PlayView t={t} id={id} onBack={onBack} project={project} frameUrl={frameUrl} />;
}
