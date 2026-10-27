'use client';

import { useEffect, useRef, useState } from 'react';
import type { Key, Translate } from '@/lib/i18n';
import type { DiagnosticsRun } from '@/lib/probes/app';
import type { ProbeResult, PromptAnswer, PromptKey } from '@/lib/probes/runner';
import { PROBE_ORDER, PROBE_STORAGE, readStored, writeStored } from '@/lib/probes/shared';

type Status = { state: 'idle' } | { state: 'running' } | { state: 'done'; result: ProbeResult };

const WHY: Record<string, Key> = {
  'native-only': 'diag.why.nativeOnly',
  cancelled: 'diag.why.cancelled',
  user: 'diag.why.user',
  'no-input': 'diag.why.noInput',
};

const idle = (): Record<string, Status> => Object.fromEntries(PROBE_ORDER.map((n) => [n, { state: 'idle' }]));

function statusText(t: Translate, s: Status): string {
  if (s.state === 'idle') return t('diag.notRun');
  if (s.state === 'running') return t('diag.running');
  const r = s.result;
  if (r.skipped) return `${t('diag.skipped')}: ${WHY[r.skipped] ? t(WHY[r.skipped]) : r.skipped}`;
  return r.ok ? t('diag.pass', { ms: r.ms }) : `${t('diag.fail')}: ${r.error ?? ''}`;
}

export default function Diagnostics({ t, onBack }: { t: Translate; onBack: () => void }) {
  const [address, setAddress] = useState('');
  const [statuses, setStatuses] = useState(idle);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<PromptKey | null>(null);
  const [done, setDone] = useState<DiagnosticsRun | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const answer = useRef<((a: PromptAnswer) => void) | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => setAddress(readStored(PROBE_STORAGE.address) ?? ''), []);
  useEffect(() => () => abort.current?.abort(), []);

  const reply = (a: PromptAnswer) => {
    const fn = answer.current;
    answer.current = null;
    setPrompt(null);
    fn?.(a);
  };

  const run = async () => {
    setBusy(true);
    setDone(null);
    setFatal(null);
    setStatuses(idle());
    const ac = new AbortController();
    abort.current = ac;
    try {
      // Capacitor plugins and the probes load only now, never during the static prerender.
      const { runDiagnostics } = await import('@/lib/probes/app');
      const result = await runDiagnostics({
        manualAddress: address.trim(),
        signal: ac.signal,
        prompt: (key) =>
          new Promise<PromptAnswer>((resolve) => {
            if (ac.signal.aborted) return resolve('skip');
            answer.current = resolve;
            setPrompt(key);
          }),
        onUpdate: (u) => setStatuses((prev) => ({ ...prev, [u.name]: u.state === 'running' ? { state: 'running' } : { state: 'done', result: u.result } })),
      });
      setDone(result);
    } catch (e) {
      setFatal(String((e as Error)?.message ?? e));
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };

  const stop = () => {
    abort.current?.abort();
    reply('skip');
  };

  const save = done?.save;
  const saveLine = !save
    ? null
    : 'reason' in save
      ? t('diag.webNotSaved')
      : save.saved
        ? t('diag.saved', { name: [save.internal, save.external].filter((w) => w.ok).map((w) => w.uri ?? `kopernikadr/${w.path}`).join(', ') })
        : t('diag.notSaved', { error: [save.internal.error, save.external.error].filter(Boolean).join('; ') });

  return (
    <main className="screen diagnostics">
      <header>
        <button type="button" onClick={onBack} disabled={busy}>
          ← {t('diag.back')}
        </button>
        <h1>{t('diag.title')}</h1>
        <span className="count">{t('diag.count', { n: PROBE_ORDER.length })}</span>
      </header>

      <label className="address">
        <span>{t('diag.address')}</span>
        <input
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="10.0.2.2:8765"
          value={address}
          disabled={busy}
          onChange={(e) => {
            setAddress(e.target.value);
            writeStored(PROBE_STORAGE.address, e.target.value.trim());
          }}
        />
        <small>{t('diag.addressHint')}</small>
      </label>

      <ul className="probes">
        {PROBE_ORDER.map((name) => {
          const s = statuses[name];
          const result = s.state === 'done' ? s.result : null;
          const cls = !result ? s.state : result.skipped ? 'skip' : result.ok ? 'pass' : 'fail';
          return (
            <li key={name} className={cls}>
              <div className="row">
                <span>{t(`probe.${name}` as Key)}</span>
                <span className="status">{statusText(t, s)}</span>
              </div>
              {result?.data != null && (
                <details>
                  <summary>data</summary>
                  <pre>{JSON.stringify(result.data, null, 2)}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>

      {prompt && (
        <div className="prompt" role="alertdialog">
          <p>{t(`diag.prompt.${prompt}` as Key)}</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => reply('next')}>
              {t('diag.next')}
            </button>
            <button type="button" onClick={() => reply('skip')}>
              {t('diag.skipStep')}
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        <button type="button" className="primary" onClick={run} disabled={busy}>
          {t('diag.run')}
        </button>
        {busy && (
          <button type="button" onClick={stop}>
            {t('diag.stop')}
          </button>
        )}
      </div>

      {fatal && <p className="fail">{fatal}</p>}
      {done && (
        <section className="result">
          <p className="summary">{t('diag.summary', { ...done.report.summary })}</p>
          {saveLine && <p className="note">{saveLine}</p>}
          <details>
            <summary>{t('diag.reportJson')}</summary>
            <pre>{JSON.stringify(done.report, null, 2)}</pre>
          </details>
        </section>
      )}
    </main>
  );
}
