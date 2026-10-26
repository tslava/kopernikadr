'use client';

import { useCallback, useEffect, useState } from 'react';
import Diagnostics from '@/components/Diagnostics';
import Home from '@/components/Home';
import { useTranslator } from '@/lib/i18n/useTranslator';

// One route with in-page views. The view lives in location.hash so a WebView reload (and the
// Android back button, via WebView history) keeps working without extra routes.
type View = 'home' | 'diagnostics';
const viewFromHash = (hash: string): View => (hash === '#diagnostics' ? 'diagnostics' : 'home');

export default function Page() {
  const { t } = useTranslator();
  const [view, setView] = useState<View>('home');

  useEffect(() => {
    const sync = () => setView(viewFromHash(location.hash));
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const go = useCallback((next: View) => {
    if (next !== 'home') {
      location.hash = next;
    } else if (history.length > 1) {
      history.back(); // pops the #diagnostics entry, like the Android back button
    } else {
      history.replaceState(null, '', location.pathname);
      setView('home');
    }
  }, []);

  return view === 'diagnostics' ? (
    <Diagnostics t={t} onBack={() => go('home')} />
  ) : (
    <Home t={t} onDiagnostics={() => go('diagnostics')} />
  );
}
