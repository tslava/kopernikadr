'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraClient } from '@/lib/camera/client';
import {
  applyFps, applyPreviewQuality, applyRotation, compensationView, controlsPollMs, formatBytes, LOCK_STATE_KEY, lockView,
  PREVIEW_QUALITIES, readFreeBytes, rotationView, sendControl, unavailableCount,
  type Capabilities, type Controls, type LockKey, type PreviewQuality, type TransferStatusInfo,
} from '@/lib/app/drawerModel';
import type { Key } from '@/lib/i18n';
import { useTranslator } from '@/lib/i18n/useTranslator';
import { KopernikadrNative } from '@/lib/native';
import { FPS_CHOICES } from '@/lib/projects/model';
import type { ProjectStore } from '@/lib/projects/store';
import { useStore } from '@/lib/state/useStore';
import Icon from './Icon';

export interface ParentDrawerProps {
  client: Pick<CameraClient, 'store' | 'request'>;
  store: ProjectStore;
  projectId: string;
  /** Transfer queue status (Transfer is built in parallel; absent = row hidden). */
  transferStatus?: TransferStatusInfo;
  onClose: () => void;
  previewQuality: PreviewQuality;
  onPreviewQuality: (q: PreviewQuality) => void;
  grid: boolean;
  onGrid: (on: boolean) => void;
  /** Injected for tests/stories; defaults to the native plugin. */
  freeBytes?: (() => Promise<{ bytes: number }>) | null;
}

const LOCKS: Array<{ key: LockKey; label: Key }> = [
  { key: 'exposure', label: 'drawer.exposure' },
  { key: 'whiteBalance', label: 'drawer.whiteBalance' },
  { key: 'focus', label: 'drawer.focus' },
];
const Q_LABEL: Record<PreviewQuality, Key> = { low: 'drawer.q.low', normal: 'drawer.q.normal', high: 'drawer.q.high' };

export default function ParentDrawer({
  client, store, projectId, transferStatus, onClose, previewQuality, onPreviewQuality, grid, onGrid,
  freeBytes = () => KopernikadrNative.freeBytes(),
}: ParentDrawerProps) {
  const { lang, t } = useTranslator();
  const snap = useStore(client.store);
  const project = useStore(store.state, (s) => s.projects[projectId] ?? null);
  const hello = snap.hello;
  const online = snap.status === 'online';
  const caps = (hello?.capabilities ?? null) as Capabilities | null;

  const [controls, setControls] = useState<Controls | null>((hello?.controls ?? null) as Controls | null);
  const [error, setError] = useState<Key | null>(null);
  const [free, setFree] = useState<number | null>(null);
  const dragging = useRef(false);
  const [steps, setSteps] = useState<number | null>(null);

  // Follow the camera: refresh on a timer (fast while settling), and right after a change.
  const refresh = useCallback(async () => {
    try {
      setControls((await client.request('getControls')) as Controls);
    } catch {
      setControls((c) => (c ? { ...c } : c)); // offline: keep the last known controls, re-arm the timer
    }
  }, [client]);
  useEffect(() => {
    if (!online) return;
    // One timer per controls change: each answer re-arms it with the right cadence.
    const timer = setTimeout(() => { if (!dragging.current) void refresh(); }, controlsPollMs(controls));
    return () => clearTimeout(timer);
  }, [online, refresh, controls]);

  useEffect(() => {
    let live = true;
    void readFreeBytes(freeBytes).then((b) => live && setFree(b));
    return () => { live = false; };
  }, [freeBytes]);

  const send = async (change: Parameters<typeof sendControl>[1]) => {
    const r = await sendControl(client.request, change);
    if (r.ok) { setError(null); setControls(r.controls); } else setError(r.messageKey);
    return r;
  };

  const comp = compensationView(controls, caps);
  const rot = project ? rotationView(project, caps) : null;
  const qualities = PREVIEW_QUALITIES.filter((q) => !caps?.previewQualities || caps.previewQualities.includes(q));
  const unavailable = project ? unavailableCount(project) : 0;
  const freeText = formatBytes(free, lang);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={t('drawer.title')}>
        <header className="drawer-head">
          <h2>{t('drawer.title')}</h2>
          <button type="button" className="icon-btn" aria-label={t('drawer.close')} onClick={onClose}><Icon name="back" /></button>
        </header>
        <div className="drawer-body">
          {!online && <p className="hint">{t('drawer.offline')}</p>}
          {error && <p className="err" role="alert">{t(error)}</p>}

          {LOCKS.map(({ key, label }) => {
            const v = lockView(key, controls, caps);
            return (
              <section className="row" key={key}>
                <div className="row-head"><h3>{t(label)}</h3><span className={`state st-${v.state}`}>{t(LOCK_STATE_KEY[v.state])}</span></div>
                {v.canSet && (
                  <div className="seg" role="group">
                    {(['auto', 'locked'] as const).map((m) => (
                      <button key={m} type="button" disabled={!online} aria-pressed={v.current === m} className={v.current === m ? 'sel' : ''}
                        onClick={() => void send({ control: key, mode: m })}>
                        {t(m === 'auto' ? 'drawer.auto' : 'drawer.lock')}
                      </button>
                    ))}
                  </div>
                )}
                {key === 'exposure' && comp && (
                  <>
                    <div className="row-head"><h3>{t('drawer.compensation')}</h3><span className="state">{comp.label}</span></div>
                    <input type="range" min={comp.min} max={comp.max} step={1} value={steps ?? comp.steps} disabled={!online}
                      onPointerDown={() => { dragging.current = true; }}
                      onChange={(e) => setSteps(Number(e.target.value))}
                      onPointerUp={(e) => {
                        dragging.current = false;
                        const n = Number((e.target as HTMLInputElement).value);
                        void send({ control: 'exposureCompensation', steps: n }).finally(() => setSteps(null));
                      }} />
                  </>
                )}
              </section>
            );
          })}

          {rot && (
            <section className="row">
              <div className="row-head"><h3>{t('drawer.rotation')}</h3></div>
              <div className="seg" role="group">
                {rot.options.map((r) => (
                  <button key={r} type="button" disabled={rot.locked} aria-pressed={rot.current === r} className={rot.current === r ? 'sel' : ''}
                    onClick={() => void applyRotation(store, projectId, r)}>{r}°</button>
                ))}
              </div>
              {rot.locked && <p className="hint">{t('drawer.rotationOnlyEmpty')}</p>}
            </section>
          )}

          <section className="row">
            <div className="row-head"><h3>{t('drawer.quality')}</h3></div>
            <div className="seg" role="group">
              {qualities.map((q) => (
                <button key={q} type="button" disabled={!online} aria-pressed={previewQuality === q} className={previewQuality === q ? 'sel' : ''}
                  onClick={() => void applyPreviewQuality(client.request, q, onPreviewQuality).then((r) => setError(r.ok ? null : r.messageKey))}>
                  {t(Q_LABEL[q])}
                </button>
              ))}
            </div>
          </section>

          {project && (
            <section className="row">
              <div className="row-head"><h3>{t('drawer.fps')}</h3></div>
              <div className="seg" role="group">
                {FPS_CHOICES.map((f) => (
                  <button key={f} type="button" aria-pressed={project.fps === f} className={project.fps === f ? 'sel' : ''}
                    onClick={() => void applyFps(store, projectId, f)}>{f}</button>
                ))}
              </div>
            </section>
          )}

          <section className="row">
            <div className="row-head"><h3>{t('drawer.grid')}</h3></div>
            <div className="seg" role="group">
              <button type="button" aria-pressed={grid} className={grid ? 'sel' : ''} onClick={() => onGrid(!grid)}>{grid ? '✓' : '○'}</button>
            </div>
          </section>

          <section className="row">
            <div className="row-head"><h3>{t('drawer.info')}</h3></div>
            <dl>
              <dt>{t('drawer.info.camera')}</dt><dd>{hello ? `${hello.name ?? ''} ${hello.cameraId}`.trim() : '—'}</dd>
              <dt>{t('drawer.info.boot')}</dt><dd>{hello?.bootId ?? '—'}</dd>
              {transferStatus && (
                <>
                  <dt>{t('drawer.info.transfer')}</dt>
                  <dd>{transferStatus.queued + (transferStatus.failed ?? 0) === 0
                    ? t('drawer.info.transferIdle')
                    : t('drawer.info.transferBusy', { queued: transferStatus.queued, failed: transferStatus.failed ?? 0 })}</dd>
                </>
              )}
              <dt>{t('drawer.info.unavailable')}</dt><dd>{unavailable}</dd>
              {freeText && (<><dt>{t('drawer.info.storage')}</dt><dd>{freeText}</dd></>)}
            </dl>
          </section>
        </div>
      </aside>
    </>
  );
}
