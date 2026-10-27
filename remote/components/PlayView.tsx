'use client';

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { FrameUrls } from '@/lib/app/frames';
import type { OverlayStack } from '@/lib/app/overlays';
import { reconcileSelection, stripTiles } from '@/lib/app/stripModel';
import type { Translate } from '@/lib/i18n';
import type { Project } from '@/lib/projects/model';
import { createFrameSource, PLAY_HEIGHT, PLAY_WIDTH, type FrameUrl } from '@/lib/play/frameSource';
import { createPlayer, timelineOf, type Clock, type Player, type PlayerStatus } from '@/lib/play/player';
import { createRing } from '@/lib/play/ring';
import { drawFrame, drawStickers } from '@/lib/render/compose';
import { bucketFor, SpriteCache } from '@/lib/render/sprites';
import { createNativeWriter } from '@/lib/export/nativeWriter';
import { isActive, type CameraLink } from '@/lib/export/projectExport';
import { sharedExportFor } from '@/lib/export/sharedExport';
import type { Store } from '@/lib/state/store';
import { useStore } from '@/lib/state/useStore';
import type { TransferPause } from '@/lib/transfer/types';
import ExportDialog from './ExportDialog';
import FrameStrip from './FrameStrip';
import Icon from './Icon';
import { FPS_CHOICES } from '@/lib/projects/model';

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
  /** Changes the movie's frame rate (playback and export use it). */
  onFps?: (fps: number) => void;
  /** The loaded project; null while the store is not ready. */
  project?: Project | null;
  /** `(projectId, frameId, kind) => Capacitor.convertFileSrc(...)`. */
  frameUrl?: FrameUrl;
  /** Frame files for the strip's thumbs (thumb, then play); without it the tiles are placeholders. */
  urls?: FrameUrls | null;
  /** What the export needs from the app; without it there is no export button. */
  exportEnv?: { key: object; transfer: TransferPause; exporting: Store<boolean>; overlays?: OverlayStack };
  /** Camera connection, for the export gate (frames of a gone camera are skippable). */
  link?: CameraLink;
  ref?: Ref<PlayViewHandle>;
}

const NOT_ACTIVE: Store<{ phase: 'idle' }> = { get: () => ({ phase: 'idle' }), set() {}, update() {}, subscribe: () => () => {} };

const IDLE: PlayerStatus = { playing: false, downloading: 0, playable: 0, shown: null };

export default function PlayView({ t, id, onBack, project = null, frameUrl, urls, exportEnv, link, onFps, ref }: PlayViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stickerCanvas = useRef<HTMLCanvasElement>(null);
  const sprites = useRef<SpriteCache | null>(null);
  const player = useRef<Player | null>(null);
  const [status, setStatus] = useState<PlayerStatus>(IDLE);

  useImperativeHandle(ref, () => ({ release: () => player.current?.release() }), []);

  // The sticker canvas is its own layer: it is redrawn on every shown entry or sticker change
  // without the frame bitmap (the ring closes that right after drawing).
  const stickersRef = useRef(project?.stickers ?? []);
  stickersRef.current = project?.stickers ?? [];
  const shownRef = useRef<string | null>(null);
  const paintStickers = useRef((_entryId: string | null): void => {});
  paintStickers.current = (entryId) => {
    shownRef.current = entryId;
    const el = stickerCanvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    const cache = (sprites.current ??= new SpriteCache());
    const list = stickersRef.current.filter((st) => entryId !== null && st.on.includes(entryId));
    // rasterize at the size the sticker is shown at (device pixels)
    const scale = (el.clientWidth * window.devicePixelRatio) / PLAY_WIDTH;
    const bucket = bucketFor(Math.max(0, ...list.map((st) => st.size * PLAY_WIDTH * scale)));
    for (const st of list) {
      if (cache.get(st.emoji, bucket)) continue;
      cache.load(st.emoji, bucket).then(
        () => {
          if (shownRef.current === entryId) paintStickers.current(entryId);
        },
        () => {}, // unknown emoji: skipped
      );
    }
    drawStickers(ctx, stickersRef.current, entryId, (hex) => cache.get(hex, bucket));
  };
  useEffect(() => () => sprites.current?.clear(), []);

  // Export (Task 18): the controller reads the latest project through a ref.
  const projectRef = useRef(project);
  projectRef.current = project;
  const linkRef = useRef(link);
  linkRef.current = link;
  // One controller per app: coming back to Play while an export runs shows that export.
  const shared = useMemo(
    () => (exportEnv ? sharedExportFor(exportEnv.key, { transfer: exportEnv.transfer, exporting: exportEnv.exporting, createWriter: () => createNativeWriter() }) : null),
    [exportEnv],
  );
  const exporter = frameUrl ? (shared?.controller ?? null) : null;
  useEffect(() => {
    if (!shared || !frameUrl) return;
    shared.bind({
      getProject: () => projectRef.current,
      link: () => linkRef.current,
      releasePlayer: () => player.current?.release(),
      frameSource: createFrameSource({ frameUrl }),
    });
  }, [shared, frameUrl]);
  const exportPhase = useStore(exporter?.state ?? NOT_ACTIVE, (s) => s.phase);
  const exportBusy = exportPhase !== 'idle' && exportPhase !== 'done' && exportPhase !== 'cancelled' && exportPhase !== 'failed';
  const [exportOpen, setExportOpen] = useState(() => (exporter ? isActive(exporter.state.get()) : false));
  // Android Back closes the dialog first (an active export keeps it: there is nothing to dismiss).
  const overlays = exportEnv?.overlays;
  useEffect(() => {
    if (!exportOpen || !overlays || !exporter) return;
    return overlays.push(() => {
      if (!isActive(exporter.state.get())) {
        exporter.reset();
        setExportOpen(false);
      } else setExportOpen(true);
    });
  }, [exportOpen, overlays, exporter]);

  useEffect(() => {
    if (!frameUrl) return;
    const source = createFrameSource({ frameUrl });
    const ring = createRing({ load: (frameId, signal) => source.load(id, frameId, signal) });
    const p = createPlayer({
      ring,
      clock: browserClock,
      fps: 8,
      loop: false,
      draw: (bmp, entryId) => {
        const ctx = canvas.current?.getContext('2d');
        if (ctx) drawFrame(ctx, bmp);
        paintStickers.current(entryId);
      },
      onChange: setStatus,
    });
    player.current = p;
    return () => {
      p.destroy();
      player.current = null;
    };
  }, [id, frameUrl]);

  // Looping is off by default (the movie plays once); the kid can switch it on.
  const [loop, setLoop] = useState(false);
  useEffect(() => player.current?.setLoop(loop), [loop]);
  const fps = project?.fps ?? 8;
  const fpsIndex = Math.max(0, FPS_CHOICES.indexOf(fps as (typeof FPS_CHOICES)[number]));

  useEffect(() => {
    if (exportBusy) return; // the ring is released for the export: do not reload it meanwhile
    player.current?.setFps(project?.fps ?? 8);
    const t = timelineOf({ frames: project?.frames ?? [], cut: project?.cut });
    player.current?.setTimeline(t.items, t.downloading);
  }, [project, frameUrl, id, exportBusy]);
  useEffect(() => paintStickers.current(shownRef.current), [project?.stickers]);

  // The strip: a tap selects the entry (and pauses on it); a second tap opens the big view.
  const [selected, setSelected] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const tiles = useMemo(() => stripTiles({ frames: project?.frames ?? [], cut: project?.cut, stickers: project?.stickers }), [project?.frames, project?.cut, project?.stickers]);
  useEffect(() => setSelected((cur) => reconcileSelection(cur, tiles)), [tiles]);
  const bigOpen = big && selected !== null;
  const onTile = (entryId: string) => {
    if (entryId === selected) {
      setBig(true);
      return;
    }
    setSelected(entryId);
    player.current?.seekTo(entryId);
  };
  // Android Back closes the big view first.
  useEffect(() => {
    if (!bigOpen || !overlays) return;
    return overlays.push(() => setBig(false));
  }, [bigOpen, overlays]);
  // the stage changes size: repaint stickers at the new device-pixel size
  useEffect(() => paintStickers.current(shownRef.current), [bigOpen]);

  return (
    <main className="screen play" data-project={id}>
      <header className="bar">
        <button type="button" className="icon-btn" aria-label={t('nav.back')} title={t('nav.back')} onClick={onBack} disabled={exportBusy}>
          <Icon name="back" />
        </button>
        <h1>{t('play.title')}</h1>
      </header>
      <div className={`play-stage${bigOpen ? ' big' : ''}`} onClick={bigOpen ? () => setBig(false) : undefined} role={bigOpen ? 'button' : undefined} aria-label={bigOpen ? t('strip.closeBig') : undefined}>
        <canvas ref={canvas} className="play-canvas" width={PLAY_WIDTH} height={PLAY_HEIGHT} />
        <canvas ref={stickerCanvas} className="play-stickers" width={PLAY_WIDTH} height={PLAY_HEIGHT} />
      </div>
      <div className="play-controls">
        <button type="button" className="icon-btn" aria-label={t('play.restart')} title={t('play.restart')} onClick={() => player.current?.seekToStart()} disabled={status.playable === 0}>
          <Icon name="restart" />
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
        <button
          type="button"
          className={`icon-btn${loop ? ' on' : ''}`}
          aria-label={t('play.loop')}
          title={t('play.loop')}
          aria-pressed={loop}
          onClick={() => setLoop((v) => !v)}
        >
          <Icon name="repeat" />
        </button>
        <label className="speed">
          <span>{t('play.speed', { n: fps })}</span>
          <input
            type="range"
            min={0}
            max={FPS_CHOICES.length - 1}
            step={1}
            value={fpsIndex}
            disabled={!project || !onFps}
            onChange={(e) => onFps?.(FPS_CHOICES[Number(e.target.value)])}
          />
        </label>
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
      {project && <FrameStrip t={t} project={project} selected={selected} onTap={onTile} urls={urls} />}
      {status.playable === 0 && status.downloading === 0 && <p className="note">{t('play.empty')}</p>}
      {status.downloading > 0 && <p className="note">{t('play.downloading', { n: status.downloading })}</p>}
      {exporter && exportOpen && project && (
        <ExportDialog t={t} project={project} controller={exporter} link={link} onClose={() => setExportOpen(false)} />
      )}
    </main>
  );
}
