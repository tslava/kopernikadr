'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Translate } from '@/lib/i18n';
import { useApp } from '@/lib/app/app';
import type { AppContext } from '@/lib/app/boot';
import { navigate } from '@/lib/nav';
import { ProjectDeletion } from '@/lib/projects/deletion';
import { cardTarget, defaultProjectName, projectCards, type ProjectCard } from '@/lib/projects/cards';
import { createAppFileAdapter, type FileAdapter } from '@/lib/projects/files';
import { renameProject } from '@/lib/projects/reducers';
import { useStore } from '@/lib/state/useStore';
import ConnectionBadge from './ConnectionBadge';
import Icon from './Icon';
import LongPressButton from './LongPressButton';
import UndoToast from './UndoToast';

export type FrameUrl = (projectId: string, frameId: string, kind: 'thumb' | 'play' | 'full') => string | null | undefined;

/** One deletion controller per booted app; it keeps its timer when the view unmounts. */
const deletions = new WeakMap<AppContext, ProjectDeletion>();
function deletionFor(app: AppContext, fs: FileAdapter): ProjectDeletion {
  let d = deletions.get(app);
  if (!d) {
    d = new ProjectDeletion({ store: app.store, fs, transfer: app.transfer, onError: (e) => console.error('project delete', e) });
    deletions.set(app, d);
    d.schedule(); // a deletion still pending after a restart expires at its deadline
  }
  return d;
}

export default function ProjectsView({ t, onConnect, onDiagnostics, frameUrl }: {
  t: Translate; onConnect: () => void; onDiagnostics: () => void;
  /** Cover source (`thumb`); wired by the shell from `lib/app/frames.ts`. No cover when absent. */
  frameUrl?: FrameUrl;
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
      {app ? <Movies t={t} app={app} frameUrl={frameUrl} /> : null}
    </main>
  );
}

function Movies({ t, app, frameUrl }: { t: Translate; app: AppContext; frameUrl?: FrameUrl }) {
  const state = useStore(app.store.state);
  const snap = useStore(app.client.store);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const deletion = useMemo(() => deletionFor(app, createAppFileAdapter()), [app]);
  useEffect(() => (renaming ? app.overlays.push(() => setRenaming(null)) : undefined), [renaming, app]);
  useEffect(() => (confirmDelete ? app.overlays.push(() => setConfirmDelete(null)) : undefined), [confirmDelete, app]);

  const cards = useMemo(() => projectCards(state.index, state.projects), [state.index, state.projects]);
  const currentCamera = snap.hello?.cameraId ?? state.index.rememberedCamera?.cameraId ?? null;
  const run = (job: Promise<unknown>) => job.then(() => setFailed(false), () => setFailed(true));

  const create = () =>
    run(
      app.store
        .createProject(defaultProjectName(state.index.projects.map((p) => p.name), (n) => t('projects.defaultName', { n })))
        .then((p) => navigate({ name: 'capture', id: p.id })),
    );
  const open = (c: ProjectCard) => navigate({ name: cardTarget(c, currentCamera), id: c.id });
  const saveName = (id: string, name: string) =>
    run(
      app.store.mutate((s) => {
        const p = s.projects[id];
        const r = p ? renameProject(s.index, p, name) : null;
        if (!p || !r) return { result: null };
        return { result: null, index: r.index, projects: [r.project] };
      }),
    );

  return (
    <>
      <section className="grid">
        <button type="button" className="card new" disabled={!state.ready || state.readOnly} aria-label={t('projects.new')} title={t('projects.new')} onClick={create}>
          <Icon name="plus" />
          <span>{t('projects.new')}</span>
        </button>
        {cards.map((c) => {
          const cover = c.coverFrameId ? frameUrl?.(c.id, c.coverFrameId, 'thumb') : null;
          return (
            <div className="movie-wrap" key={c.id} data-testid="movie-card" data-project-id={c.id}>
              <button type="button" className="card movie" onClick={() => open(c)}>
                <span className="cover">
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local file URL
                    <img src={cover} alt="" />
                  ) : (
                    <Icon name="film" />
                  )}
                </span>
                <span className="meta">
                  <span className="title">{c.name}</span>
                  <span className="count">{t('projects.frames', { n: c.frameCount })}</span>
                </span>
              </button>
              <span className="tools">
                <button type="button" className="icon-btn" aria-label={t('projects.rename')} title={t('projects.rename')} onClick={() => setRenaming({ id: c.id, name: c.name })}>
                  <Icon name="pencil" />
                </button>
                <button type="button" className="icon-btn" aria-label={t('projects.delete')} title={t('projects.delete')} onClick={() => setConfirmDelete({ id: c.id, name: c.name })}>
                  <Icon name="trash" />
                </button>
              </span>
            </div>
          );
        })}
      </section>
      {cards.length === 0 && state.ready && <p className="empty"><Icon name="film" /> {t('projects.empty')}</p>}
      {failed && <p className="empty" role="alert">{t('projects.error')}</p>}
      {renaming && (
        <RenameDialog
          t={t}
          initial={renaming.name}
          onCancel={() => setRenaming(null)}
          onSave={(name) => { void saveName(renaming.id, name); setRenaming(null); }}
        />
      )}
      {confirmDelete && (
        <DeleteDialog
          t={t}
          name={confirmDelete.name}
          onCancel={() => setConfirmDelete(null)}
          onDelete={() => { run(deletion.requestDelete(confirmDelete.id)); setConfirmDelete(null); }}
        />
      )}
      <ProjectUndo t={t} app={app} deletion={deletion} />
    </>
  );
}

function RenameDialog({ t, initial, onSave, onCancel }: { t: Translate; initial: string; onSave: (n: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog" role="dialog" aria-label={t('projects.renameTitle')} onSubmit={(e) => { e.preventDefault(); if (name.trim() !== '') onSave(name); }}>
        <label htmlFor="rename-input">{t('projects.renameTitle')}</label>
        <input id="rename-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
        <div className="row">
          <button type="button" onClick={onCancel}>{t('projects.cancel')}</button>
          <button type="submit" className="primary" disabled={name.trim() === ''}>{t('projects.save')}</button>
        </div>
      </form>
    </div>
  );
}

/** A plain tap on the trash icon asks first; the Undo toast still follows the deletion. */
function DeleteDialog({ t, name, onDelete, onCancel }: { t: Translate; name: string; onDelete: () => void; onCancel: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-label={t('projects.deleteTitle', { name })}>
        <p>{t('projects.deleteTitle', { name })}</p>
        <div className="row">
          <button type="button" onClick={onCancel}>{t('projects.cancel')}</button>
          <button type="button" className="danger" onClick={onDelete}>{t('projects.deleteConfirm')}</button>
        </div>
      </div>
    </div>
  );
}

/** The latest project in its Undo window (the shared toast counts down to the persisted deadline). */
function ProjectUndo({ t, app, deletion }: { t: Translate; app: AppContext; deletion: ProjectDeletion }) {
  const pending = useStore(app.store.state, (s) => s.index.pendingProjectDeletes);
  const names = useStore(app.store.state, (s) => s.index.projects);
  const last = pending[pending.length - 1];
  if (!last) return null;
  const name = names.find((p) => p.id === last.id)?.name ?? '';
  return <UndoToast t={t} message={t('projects.deleted', { name })} deadline={last.deadline} label="projects.undo" onUndo={() => void deletion.undo(last.id)} />;
}
