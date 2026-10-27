'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { Translate } from '@/lib/i18n';
import type { Project } from '@/lib/projects/model';
import { createFrameSource, PLAY_HEIGHT, PLAY_WIDTH, type FrameUrl } from '@/lib/play/frameSource';
import { createPlayer, type Clock, type Player, type PlayerStatus } from '@/lib/play/player';
import { createRing } from '@/lib/play/ring';
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
  ref?: Ref<PlayViewHandle>;
}

const IDLE: PlayerStatus = { playing: false, downloading: 0, playable: 0, shown: null };

export default function PlayView({ t, id, onBack, project = null, frameUrl, ref }: PlayViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const player = useRef<Player | null>(null);
  const [status, setStatus] = useState<PlayerStatus>(IDLE);

  useImperativeHandle(ref, () => ({ release: () => player.current?.release() }), []);

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
        <button type="button" className="icon-btn" aria-label={t('nav.back')} title={t('nav.back')} onClick={onBack}>
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
      </div>
      {status.playable === 0 && status.downloading === 0 && <p className="note">{t('play.empty')}</p>}
      {status.downloading > 0 && <p className="note">{t('play.downloading', { n: status.downloading })}</p>}
    </main>
  );
}
