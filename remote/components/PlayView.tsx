'use client';

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { Translate } from '@/lib/i18n';
import type { Project } from '@/lib/projects/model';
import { createFrameSource, PLAY_HEIGHT, PLAY_WIDTH, type FrameUrl } from '@/lib/play/frameSource';
import { createPlayer, type Clock, type Player, type PlayerStatus } from '@/lib/play/player';
import { createRing } from '@/lib/play/ring';
import { createNativeWriter } from '@/lib/export/nativeWriter';
import { createExportController } from '@/lib/export/projectExport';
import type { Store } from '@/lib/state/store';
import { useStore } from '@/lib/state/useStore';
import type { TransferPause } from '@/lib/transfer/types';
import ExportDialog from './ExportDialog';
import Icon from './Icon';

/** For export (Task 18): closes the ring buffer and pauses. Playing again reloads it. */
export interface PlayViewHandle {
  release(): void;
}

const browserClock: Clock = {
  now: () => performance.now(),
  request: (cb) => requestAnimationFrame(() => cb()),
  cancel: (h) => cancelAnimationFrame(h),
};

export interface PlayViewProps {
  t: Translate;
  /** The project id from the route. */
  id: string;
  onBack: () => void;
  /** The loaded project; null while the store is not ready. */
  project?: Project | null;
  /** `(projectId, frameId, kind) => Capacitor.convertFileSrc(...)`. */
  frameUrl?: FrameUrl;
  /** What the export needs from the app; without it there is no export button. */
  exportEnv?: { transfer: TransferPause; exporting: Store<boolean> };
  ref?: Ref<PlayViewHandle>;
}

const NOT_ACTIVE: Store<{ phase: 'idle' }> = { get: () => ({ phase: 'idle' }), set() {}, update() {}, subscribe: () => () => {} };

const IDLE: PlayerStatus = { playing: false, downloading: 0, playable: 0, shown: null };

export default function PlayView({ t, id, onBack, project = null, frameUrl, exportEnv, ref }: PlayViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const player = useRef<Player | null>(null);
  const [status, setStatus] = useState<PlayerStatus>(IDLE);

  useImperativeHandle(ref, () => ({ release: () => player.current?.release() }), []);

  // Export (Task 18): the controller reads the latest project through a ref.
  const projectRef = useRef(project);
  projectRef.current = project;
  const exporter = useMemo(
    () =>
      exportEnv && frameUrl
        ? createExportController({
            getProject: () => projectRef.current,
            transfer: exportEnv.transfer,
            exporting: exportEnv.exporting,
            releasePlayer: () => player.current?.release(),
            frameSource: createFrameSource({ frameUrl }),
            createWriter: () => createNativeWriter(),
          })
        : null,
    [exportEnv, frameUrl],
  );
  const exportPhase = useStore(exporter?.state ?? NOT_ACTIVE, (s) => s.phase);
  const exportBusy = exportPhase !== 'idle' && exportPhase !== 'done' && exportPhase !== 'cancelled' && exportPhase !== 'failed';
  const [exportOpen, setExportOpen] = useState(false);
  // Leaving the screen: stop an export that is still cancellable (later phases run to the end).
  useEffect(() => () => void exporter?.cancel(), [exporter]);

  useEffect(() => {
    if (!frameUrl) return;
    const source = createFrameSource({ frameUrl });
    const ring = createRing({ load: (frameId, signal) => source.load(id, frameId, signal) });
    const p = createPlayer({
      ring,
      clock: browserClock,
      fps: 8,
      draw: (bmp) => canvas.current?.getContext('2d')?.drawImage(bmp, 0, 0, PLAY_WIDTH, PLAY_HEIGHT),
      onChange: setStatus,
    });
    player.current = p;
    return () => {
      p.destroy();
      player.current = null;
    };
  }, [id, frameUrl]);

  useEffect(() => {
    player.current?.setFps(project?.fps ?? 8);
    player.current?.setFrames(project?.frames ?? []);
  }, [project, frameUrl, id]);

  return (
    <main className="screen" data-project={id}>
      <header className="bar">
        <button type="button" className="icon-btn" aria-label={t('nav.back')} title={t('nav.back')} onClick={onBack} disabled={exportBusy}>
          <Icon name="back" />
        </button>
        <h1>{t('play.title')}</h1>
      </header>
      <canvas ref={canvas} className="play-canvas" width={PLAY_WIDTH} height={PLAY_HEIGHT} />
      <div className="play-controls">
        <button type="button" className="icon-btn" aria-label={t('play.restart')} title={t('play.restart')} onClick={() => player.current?.seekToStart()} disabled={status.playable === 0}>
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={status.playing ? t('play.pause') : t('play.play')}
          title={status.playing ? t('play.pause') : t('play.play')}
          onClick={() => player.current?.toggle()}
          disabled={status.playable === 0}
        >
          <Icon name={status.playing ? 'pause' : 'play'} />
        </button>
        {exporter && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t('export.button')}
            title={t('export.button')}
            onClick={() => setExportOpen(true)}
            disabled={!project || project.frames.length === 0}
          >
            <Icon name="save" />
          </button>
        )}
      </div>
      {status.playable === 0 && status.downloading === 0 && <p className="note">{t('play.empty')}</p>}
      {status.downloading > 0 && <p className="note">{t('play.downloading', { n: status.downloading })}</p>}
      {exporter && exportOpen && project && (
        <ExportDialog t={t} project={project} controller={exporter} onClose={() => setExportOpen(false)} />
      )}
    </main>
  );
}
