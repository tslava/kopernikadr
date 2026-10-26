'use client';

import { useState } from 'react';
import type { Translate } from '@/lib/i18n';

export default function Home({ t, onDiagnostics }: { t: Translate; onDiagnostics: () => void }) {
  const [note, setNote] = useState(false);
  return (
    <main className="screen home">
      <h1>{t('app.title')}</h1>
      <p className="subtitle">{t('app.subtitle')}</p>
      <div className="actions">
        <button type="button" className="primary" onClick={() => setNote(true)}>
          {t('home.connect')}
        </button>
        <button type="button" onClick={onDiagnostics}>
          {t('home.diagnostics')}
        </button>
      </div>
      {note && <p className="note">{t('home.connectSoon')}</p>}
    </main>
  );
}
