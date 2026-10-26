'use client';

import type { Key, Translate } from '@/lib/i18n';

// Placeholder list; the runner and the probes arrive in Tasks 10–12.
const PROBES: readonly Key[] = [
  'probe.env',
  'probe.nsd',
  'probe.camera',
  'probe.reconnect',
  'probe.download',
  'probe.videoFrame',
  'probe.export',
  'probe.storage',
];

export default function Diagnostics({ t, onBack }: { t: Translate; onBack: () => void }) {
  return (
    <main className="screen diagnostics">
      <header>
        <button type="button" onClick={onBack}>
          ← {t('diag.back')}
        </button>
        <h1>{t('diag.title')}</h1>
        <span className="count">{t('diag.count', { n: PROBES.length })}</span>
      </header>
      <ul className="probes">
        {PROBES.map((key) => (
          <li key={key}>
            <span>{t(key)}</span>
            <span className="status">{t('diag.notRun')}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="primary" disabled>
        {t('diag.run')}
      </button>
    </main>
  );
}
