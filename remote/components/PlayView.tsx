'use client';

import type { Translate } from '@/lib/i18n';
import Icon from './Icon';

// Stub: real playback comes in a later task. `id` is the project id from the route.
export default function PlayView({ t, id, onBack }: { t: Translate; id: string; onBack: () => void }) {
  return (
    <main className="screen" data-project={id}>
      <header className="bar">
        <button type="button" className="icon-btn" aria-label={t('nav.back')} title={t('nav.back')} onClick={onBack}>
          <Icon name="back" />
        </button>
        <h1>{t('play.title')}</h1>
      </header>
      <p className="note"><Icon name="play" /> {t('stub.soon')}</p>
    </main>
  );
}
