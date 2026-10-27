'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CameraClient } from '@/lib/camera/client';
import type { Translate } from '@/lib/i18n';
import { useApp } from '@/lib/app/app';
import { cameraRows, justWentOnline, manualErrorKey, statusView, type StatusKind } from '@/lib/app/connectModel';
import { useStore } from '@/lib/state/useStore';
import Icon from './Icon';

type ClientLike = Pick<CameraClient, 'store' | 'takeOver' | 'connectManual' | 'connectTo'>;

// Thin shell: all decisions live in lib/app/connectModel.ts (pure, unit-tested).
export default function ConnectView({ t, onBack }: { t: Translate; onBack: () => void }) {
  const app = useApp();
  return (
    <main className="screen connect">
      <header className="bar">
        <button type="button" className="icon-btn" aria-label={t('nav.back')} title={t('nav.back')} onClick={onBack}>
          <Icon name="back" />
        </button>
        <h1>{t('connect.title')}</h1>
      </header>
      {app ? (
        <ConnectScreen t={t} client={app.client} onConnected={onBack} />
      ) : (
        <p className="note"><Icon name="plug" /> {t('connect.status.searching')}</p>
      )}
    </main>
  );
}

export function ConnectScreen({ t, client, onConnected }: { t: Translate; client: ClientLike; onConnected: () => void }) {
  const snap = useStore(client.store);
  const [elapsed, setElapsed] = useState(0);
  const [address, setAddress] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // BUSY countdown: restart the clock whenever a new retry delay arrives.
  useEffect(() => {
    setElapsed(0);
    if (snap.status !== 'busy' || snap.retryAfterMs === undefined) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 500);
    return () => clearInterval(id);
  }, [snap.status, snap.retryAfterMs]);

  // Back to where the user came from once the camera is online (it was not when the screen opened).
  const view = statusView(snap, elapsed);
  const prev = useRef<StatusKind | undefined>(undefined);
  useEffect(() => {
    if (justWentOnline(prev.current, view.kind)) onConnected();
    prev.current = view.kind;
  }, [view.kind, onConnected]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const r = await client.connectManual(address);
      if (!r.ok) setError(t(manualErrorKey(r)));
    } catch {
      setError(t('connect.err.unreachable'));
    } finally {
      setChecking(false);
    }
  }

  const rows = cameraRows(snap);
  return (
    <>
      <p className={`note status ${view.kind}`} role="status">
        <Icon name="plug" /> {t(view.messageKey, view.params)}
      </p>
      {view.canTakeOver && (
        <button type="button" className="primary" onClick={() => client.takeOver()}>
          {t('connect.takeOver')}
        </button>
      )}
      <section aria-label={t('connect.found')}>
        <h2>{t('connect.found')}</h2>
        {rows.length === 0 ? (
          <p className="note">{t('connect.none')}</p>
        ) : (
          <ul className="cameras">
            {rows.map((r) => (
              <li key={r.cameraId}>
                {/* a found camera that is not the current one is a button: tap to switch to it */}
                <button
                  type="button"
                  className={`camera ${r.state}`}
                  disabled={r.state !== 'available'}
                  onClick={() => client.connectTo(r.cameraId)}
                >
                  <Icon name="camera" />
                  <span className="name">{t('connect.cameraName', { name: r.name })}</span>
                  <span className="state">{t(r.state === 'available' ? 'connect.use' : `connect.state.${r.state}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form className="manual" onSubmit={submit}>
        <label>
          {t('connect.address')}
          <input
            type="text"
            data-testid="connect-address"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t('connect.addressHint')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <button type="submit" disabled={checking || address.trim() === ''}>
          {checking ? t('connect.checking') : t('connect.connect')}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </>
  );
}
