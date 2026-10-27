'use client';

import type { Translate } from '@/lib/i18n';
import Icon from './Icon';

// Stub: real discovery/pairing comes in a later task.
export default function ConnectView({ t, onBack }: { t: Translate; onBack: () => void }) {
  return (
    <main className="screen">
      <header className="bar">
        <button type="button" className="icon-btn" aria-label={t('nav.back')} title={t('nav.back')} onClick={onBack}>
          <Icon name="back" />
        </button>
        <h1>{t('connect.title')}</h1>
      </header>
      <p className="note"><Icon name="plug" /> {t('stub.soon')}</p>
    </main>
  );
}
