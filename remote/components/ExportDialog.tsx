'use client';

import { useState } from 'react';
import type { Key, Translate } from '@/lib/i18n';
import { canCancel, exportGate, isActive, type ExportController, type ExportFailure } from '@/lib/export/projectExport';
import type { Project } from '@/lib/projects/model';
import { useStore } from '@/lib/state/useStore';

const ERROR_KEY: Record<ExportFailure, Key> = {
  frame: 'export.errFrame',
  codec: 'export.errCodec',
  space: 'export.errSpace',
  unknown: 'export.errUnknown',
};

export interface ExportDialogProps {
  t: Translate;
  /** The live project: the gate follows it (frames arriving, going unavailable). */
  project: Project;
  controller: ExportController;
  onClose: () => void;
}

/** Thin view over the export gate + controller state (all logic lives in lib/export/projectExport.ts). */
export default function ExportDialog({ t, project, controller, onClose }: ExportDialogProps) {
  const state = useStore(controller.state);
  const [confirmed, setConfirmed] = useState(false);
  const gate = exportGate(project, confirmed);

  const start = (confirmedSkip: boolean) => void controller.start({ confirmedSkip });
  const close = () => {
    controller.reset();
    onClose();
  };

  let body: React.ReactNode;
  let actions: React.ReactNode;
  if (state.phase === 'idle') {
    switch (gate.kind) {
      case 'waiting':
        body = (
          <>
            <p role="status">{t('export.waiting', { n: gate.downloading })}</p>
            <p className="note">{t('export.waitingHint')}</p>
          </>
        );
        actions = <button type="button" onClick={close}>{t('export.close')}</button>;
        break;
      case 'confirm':
        body = <p>{t('export.confirm', { n: gate.unavailable })}</p>;
        actions = (
          <>
            <button type="button" onClick={close}>{t('export.cancel')}</button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setConfirmed(true);
                start(true);
              }}
            >
              {t('export.confirmGo')}
            </button>
          </>
        );
        break;
      case 'ready':
        body = <p>{t('export.ready', { n: gate.frames })}</p>;
        actions = (
          <>
            <button type="button" onClick={close}>{t('export.cancel')}</button>
            <button type="button" className="primary" onClick={() => start(confirmed)}>{t('export.start')}</button>
          </>
        );
        break;
      case 'empty':
        body = <p>{t('export.empty')}</p>;
        actions = <button type="button" onClick={close}>{t('export.close')}</button>;
        break;
    }
  } else if (isActive(state)) {
    body =
      state.phase === 'encoding' ? (
        <>
          <p role="status">{t('export.progress', { i: state.i, n: state.n })}</p>
          <progress value={state.i} max={state.n} />
        </>
      ) : (
        <p role="status">
          {t(state.phase === 'finalizing' ? 'export.finalizing' : state.phase === 'publishing' ? 'export.publishing' : 'export.preparing')}
        </p>
      );
    // Cancel exists only while encoding; later the export runs to done or failed (ARCHITECTURE §5.7).
    actions = canCancel(state) ? <button type="button" onClick={() => controller.cancel()}>{t('export.cancel')}</button> : null;
  } else if (state.phase === 'done') {
    body = (
      <>
        <p role="status">{t('export.done')}</p>
        {state.skipped > 0 && <p className="note">{t('export.doneSkipped', { n: state.skipped })}</p>}
      </>
    );
    actions = <button type="button" className="primary" onClick={close}>{t('export.close')}</button>;
  } else if (state.phase === 'cancelled') {
    body = <p role="status">{t('export.cancelled')}</p>;
    actions = <button type="button" onClick={close}>{t('export.close')}</button>;
  } else if (state.phase === 'failed') {
    body = <p role="alert">{t(ERROR_KEY[state.reason])}</p>;
    actions = (
      <>
        <button type="button" onClick={close}>{t('export.close')}</button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            controller.reset();
            start(confirmed);
          }}
        >
          {t('export.retry')}
        </button>
      </>
    );
  } else {
    body = null;
    actions = null;
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-label={t('export.title')}>
        <h2>{t('export.title')}</h2>
        {body}
        {actions && <div className="row">{actions}</div>}
      </div>
    </div>
  );
}
