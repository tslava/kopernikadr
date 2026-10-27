'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { formatBytes } from '@/lib/app/drawerModel';
import {
  clearQuarantine, createAppQuarantineFs, isClearAnswer, listQuarantine, newClearQuestion, thumbEntries,
  type ClearQuestion, type QuarantineFs, type QuarantineSummary,
} from '@/lib/app/quarantine';
import { useTranslator } from '@/lib/i18n/useTranslator';

const THUMB_W = 160;

/** One decode at a time: up to 12 full 8 MP blobs at once could exhaust a weak tablet's memory. */
let thumbQueue: Promise<void> = Promise.resolve();
const queueThumb = (job: () => Promise<void>): void => {
  thumbQueue = thumbQueue.then(job, job);
};

/** One thumbnail: the 8 MP full is decoded already scaled down (`resizeWidth`), never at full size. */
function Thumb({ fs, name, alt }: { fs: QuarantineFs; name: string; alt: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    queueThumb(async () => {
      if (!live) return; // scrolled away / cleared while waiting in the queue
      try {
        const res = await fetch(Capacitor.convertFileSrc(await fs.uri(name)));
        const bmp = await createImageBitmap(await res.blob(), { resizeWidth: THUMB_W, resizeQuality: 'low' });
        const c = ref.current;
        if (live && c) {
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext('2d')?.drawImage(bmp, 0, 0);
        }
        bmp.close();
      } catch {
        // an undecodable file just shows an empty tile; it is still listed and cleared
      }
    });
    return () => { live = false; };
  }, [fs, name]);
  return <canvas ref={ref} className="q-thumb" role="img" aria-label={alt} />;
}

/** Parent-only upkeep, on the Diagnostics screen (behind the long-press wrench): quarantine and "O aplikacji". */
export default function ParentMaintenance() {
  const { lang, t } = useTranslator();
  const fs = useMemo(() => createAppQuarantineFs(), []);
  const [sum, setSum] = useState<QuarantineSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<ClearQuestion | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSum(await listQuarantine(fs));
      setError(null);
    } catch (e) {
      setError(t('quarantine.loadFailed', { error: String((e as Error)?.message ?? e) }));
    }
  }, [fs, t]);
  useEffect(() => { void load(); }, [load]);

  const size = formatBytes(sum?.bytes ?? 0, lang) ?? '0 MB';
  const ask = () => {
    setTyped('');
    setQuestion(newClearQuestion());
  };
  const clear = async () => {
    if (!sum) return;
    setBusy(true);
    try {
      const r = await clearQuarantine(fs, sum.entries.map((e) => e.name));
      setNote(r.failed.length ? t('quarantine.failed', { n: r.failed.length, error: r.failed[0]!.error }) : t('quarantine.cleared', { n: r.removed }));
    } catch (e) {
      setNote(t('quarantine.failed', { n: sum?.count ?? 0, error: String((e as Error)?.message ?? e) }));
    } finally {
      setQuestion(null);
      setBusy(false);
      await load();
    }
  };

  return (
    <>
      <section className="parent-sec quarantine">
        <h2>{t('quarantine.title')}</h2>
        <p className="note">{t('quarantine.hint')}</p>
        {error && <p className="fail">{error}</p>}
        {sum && (sum.count === 0 ? (
          <p>{t('quarantine.empty')}</p>
        ) : (
          <>
            <div className="q-head">
              <strong>{t('quarantine.summary', { n: sum.count, size })}</strong>
              <button type="button" className="danger" disabled={busy} onClick={ask}>{t('quarantine.clear')}</button>
            </div>
            <div className="q-thumbs">
              {thumbEntries(sum).map((e) => <Thumb key={e.name} fs={fs} name={e.name} alt={t('quarantine.thumb', { name: e.name })} />)}
            </div>
          </>
        ))}
        {note && <p className="note" role="status">{note}</p>}
      </section>

      <section className="parent-sec about">
        <h2>{t('about.title')}</h2>
        <p>{t('about.version', { v: process.env.NEXT_PUBLIC_APP_VERSION ?? '' })}</p>
        <p>{t('about.openmoji')}</p>
        <p className="note">{t('about.license')}</p>
      </section>

      {question && sum && (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="alertdialog" aria-label={t('quarantine.title')}>
            <p>{t('quarantine.confirm', { n: sum.count, size })}</p>
            <p><strong>{t('quarantine.ask', { a: question.a, b: question.b })}</strong></p>
            <input
              type="text" inputMode="numeric" autoComplete="off" value={typed} aria-label={t('quarantine.answer')}
              onChange={(ev) => setTyped(ev.target.value)}
            />
            <div className="row">
              <button type="button" disabled={busy} onClick={() => setQuestion(null)}>{t('quarantine.cancel')}</button>
              <button type="button" className="danger" disabled={busy || !isClearAnswer(question, typed)} onClick={() => void clear()}>{t('quarantine.confirmGo')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
