'use client';

import { useEffect } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { startApp, useApp } from '@/lib/app/app';
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

  const goBack = () => void back();
  switch (route.name) {
    case 'connect':
      return <ConnectView t={t} onBack={goBack} />;
    case 'capture':
      return <CaptureView t={t} id={route.id} onBack={goBack} />;
    case 'play':
      return <PlayView t={t} id={route.id} onBack={goBack} />;
    case 'diagnostics':
      return <Diagnostics t={t} onBack={goBack} />;
    default:
      return (
        <ProjectsView t={t} onConnect={() => navigate({ name: 'connect' })} onDiagnostics={() => navigate({ name: 'diagnostics' })} />
      );
  }
}
