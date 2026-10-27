'use client';

import type { Translate } from '@/lib/i18n';
import type { CameraClient } from '@/lib/camera/client';
import { useApp } from '@/lib/app/app';
import { badge } from '@/lib/app/connectModel';
import { useStore } from '@/lib/state/useStore';
import Icon from './Icon';
import LongPressButton from './LongPressButton';

// Stub: the real list comes with ProjectStore. No fake data: an empty state and a placeholder card.
export default function ProjectsView({ t, onConnect, onDiagnostics }: {
  t: Translate; onConnect: () => void; onDiagnostics: () => void;
}) {
  const app = useApp();
  return (
    <main className="screen projects">
      <header className="bar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element -- static export, no image optimizer */}
          <img className="logo" src="/logo.svg" alt="" width={96} height={96} />
          <h1>{t('app.title')}</h1>
        </div>
        <div className="bar-actions">
          {app && <ConnectionBadge t={t} client={app.client} />}
          <button type="button" className="icon-btn" aria-label={t('projects.connect')} title={t('projects.connect')} onClick={onConnect}>
            <Icon name="plug" />
          </button>
          <LongPressButton className="icon-btn" label={t('projects.parent')} onLongPress={onDiagnostics}>
            <Icon name="wrench" />
          </LongPressButton>
        </div>
      </header>
      <section className="grid">
        <button type="button" className="card new" disabled aria-label={t('projects.new')} title={t('projects.new')}>
          <Icon name="plus" />
          <span>{t('projects.new')}</span>
        </button>
      </section>
      <p className="empty"><Icon name="film" /> {t('projects.empty')}</p>
    </main>
  );
}

function ConnectionBadge({ t, client }: { t: Translate; client: CameraClient }) {
  const b = badge(useStore(client.store));
  return (
    <span className={`conn-badge ${b.tone}`} role="status">
      <span className="dot" aria-hidden="true" />
      {t(b.key)}
    </span>
  );
}
