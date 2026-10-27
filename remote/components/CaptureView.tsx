'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppContext } from '@/lib/app/boot';
import { badge } from '@/lib/app/connectModel';
import { frameCount, hasOutstandingFor, onionSourceFor, pendingCount, shutterState, toastKey } from '@/lib/app/captureModel';
import type { FrameUrls } from '@/lib/app/frames';
import { playShutter } from '@/lib/audio/shutterSound';
import { hostPort } from '@/lib/camera/discover';
import { ONION_OPACITY_DEFAULT } from '@/lib/camera/onion';
import { PreviewController, type PreviewQuality } from '@/lib/camera/previewController';
import type { Key, Translate } from '@/lib/i18n';
import type { Project } from '@/lib/projects/model';
import { useStore } from '@/lib/state/useStore';
import ConnectionBadge from './ConnectionBadge';
import Icon from './Icon';
import OnionSkin, { OnionControls } from './OnionSkin';
import Preview from './Preview';
import ShutterButton from './ShutterButton';

const TOAST_MS = 4000;

/** What the parent drawer (long-press) gets from the capture view. */
export interface DrawerContext {
  project: Project;
  controller: PreviewController;
  exporting: boolean;
}

export interface CaptureViewProps {
  t: Translate;
  /** The project id from the route. */
  id: string;
  app: AppContext;
  /** Null until the file base uri is known: the onion skin waits. */
  urls: FrameUrls | null;
  onBack: () => void;
  onPlay: () => void;
  /** Preview quality (a parent setting). */
  quality?: PreviewQuality;
  /** An export is running: no shooting. */
  exporting?: boolean;
  /** The 3x3 composition grid over the preview (a parent setting). */
  grid?: boolean;
  /** The parent drawer (Task 15). */
  drawer?: (ctx: DrawerContext) => ReactNode;
}

function usePreviewController(app: AppContext, quality: PreviewQuality): { controller: PreviewController; live: boolean } {
  const [live, setLive] = useState(false);
  const { client } = app;
  const [controller] = useState(
    () =>
      new PreviewController({
        urlFor: (sessionId) => {
          const target = client.snapshot.target;
          if (!target) throw new Error('no camera target');
          return `ws://${hostPort(target)}/ws/preview?session=${encodeURIComponent(sessionId)}`;
        },
        quality,
        applyQuality: (q) => client.request('setControl', { control: 'previewQuality', value: q }),
        onLive: setLive,
      }),
  );
  useEffect(() => {
    const off = controller.attach(client);
    controller.start();
    const unregister = app.lifecycle.registerPreview(controller); // stopped/restarted with the app state
    return () => {
      unregister();
      off();
      controller.dispose();
    };
  }, [controller, client, app]);
  useEffect(() => controller.setQuality(quality), [controller, quality]);
  return { controller, live };
}

/** The screen stays on while the kid shoots. */
function useKeepAwake(app: AppContext): void {
  useEffect(() => app.lifecycle.keepAwake.hold('view'), [app]);
}

export default function CaptureView({ t, id, app, urls, onBack, onPlay, quality = 'normal', exporting = false, grid = false, drawer }: CaptureViewProps) {
  const { store, client, capture } = app;
  const projects = useStore(store.state, (s) => s.projects);
  const snap = useStore(client.store);
  const project = projects[id] ?? null;
  const { controller, live } = usePreviewController(app, quality);
  useKeepAwake(app);

  const [pressing, setPressing] = useState(false);
  const [flashN, setFlashN] = useState(0);
  const [toast, setToast] = useState<Key | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [onionOn, setOnionOn] = useState(true);
  const [opacity, setOpacity] = useState(ONION_OPACITY_DEFAULT);
  const [absentN, setAbsentN] = useState(0); // bumps the onion source after a file turned out missing

  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const showToast = useCallback((k: Key) => {
    setToast(k);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const shutter = shutterState({
    online: snap.status === 'online' && snap.hello !== null,
    reconciling: snap.reconciling,
    outstanding: hasOutstandingFor(projects, snap.hello?.cameraId),
    exporting,
    pressing,
  });

  const onPress = useCallback(async () => {
    if (!shutter.enabled || !project) return;
    setPressing(true);
    setFlashN((n) => n + 1);
    playShutter();
    try {
      const k = toastKey(await capture.press(project.id));
      if (k) showToast(k);
    } finally {
      setPressing(false);
    }
  }, [shutter.enabled, project, capture, showToast]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onion = useMemo(() => onionSourceFor(project, urls ? urls.url : null), [project, urls, absentN]);

  const header = (
    <header className="bar">
      <button type="button" className="icon-btn" aria-label={t('capture.backToMovies')} title={t('capture.backToMovies')} onClick={onBack}>
        <Icon name="back" />
      </button>
      <h1>{project?.name || t('capture.title')}</h1>
      <ConnectionBadge t={t} client={client} />
    </header>
  );

  if (!project) {
    return (
      <main className="screen" data-project={id}>
        {header}
        <p className="note">{t('capture.noProject')}</p>
      </main>
    );
  }

  const count = frameCount(project);
  const pending = pendingCount(project);
  const b = badge(snap);

  return (
    <main className="screen capture" data-project={id}>
      {header}
      <div className="cap-bar">
        <span className="counter" role="status" aria-label={t('capture.frames', { n: count })}>
          <Icon name="film" />
          <b data-testid="frame-count">{count}</b>
        </span>
        {pending > 0 && (
          <span className="pending" aria-label={t('capture.pending')} title={t('capture.pending')}>
            {Array.from({ length: Math.min(pending, 5) }, (_, i) => (
              <i key={i} className="ph" />
            ))}
          </span>
        )}
        <OnionControls
          source={onion}
          enabled={onionOn}
          opacity={opacity}
          onEnabledChange={setOnionOn}
          onOpacityChange={setOpacity}
          labels={{ toggle: t('capture.onion'), opacity: t('capture.onionOpacity'), noFrames: t('capture.onionNone') }}
        />
        {drawer?.({ project, controller, exporting })}
      </div>
      <Preview controller={controller} live={live} message={t(b.key)}>
        <OnionSkin
          grid={grid}
          source={onion}
          enabled={onionOn}
          opacity={opacity}
          onError={() => {
            if (!onion) return;
            urls?.markAbsent(project.id, onion.frameId, onion.kind);
            setAbsentN((n) => n + 1);
          }}
        />
        {flashN > 0 && <div key={flashN} className="flash go" aria-hidden="true" />}
      </Preview>
      <div className="cap-actions">
        <button type="button" className="icon-btn" aria-label={t('capture.play')} title={t('capture.play')} onClick={onPlay} disabled={count === 0}>
          <Icon name="play" />
        </button>
        <ShutterButton enabled={shutter.enabled} label={t('capture.shutter')} onPress={() => void onPress()} />
        {exporting && <span className="note">{t('capture.exporting')}</span>}
      </div>
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {t(toast)}
        </div>
      )}
    </main>
  );
}
