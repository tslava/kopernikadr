'use client';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { toolStates, type EditController, type EditTool } from '@/lib/app/editController';
import type { FrameUrls } from '@/lib/app/frames';
import { reconcileSticker, stickersOn, withLivePose, type StickerController } from '@/lib/app/stickerController';
import type { OverlayStack } from '@/lib/app/overlays';
import { reconcileSelection, stripTiles } from '@/lib/app/stripModel';
import type { Translate } from '@/lib/i18n';
import type { Project } from '@/lib/projects/model';
import type { Pose } from '@/lib/projects/stickers';
import { useTranslator } from '@/lib/i18n/useTranslator';
import { createFrameSource, PLAY_HEIGHT, PLAY_WIDTH, type FrameUrl } from '@/lib/play/frameSource';
import { createPlayer, timelineOf, type Clock, type Player, type PlayerStatus } from '@/lib/play/player';
import { createRing } from '@/lib/play/ring';
import { drawFrame, drawStickers } from '@/lib/render/compose';
import { bucketFor, needsNewSpriteCache, SpriteCache } from '@/lib/render/sprites';
import { openmojiUrlOf } from '@/lib/render/catalog';
import { appStickerLibrary } from '@/lib/stickers/appLibrary';
import { StickerCopyError } from '@/lib/app/stickerController';
import { createNativeWriter } from '@/lib/export/nativeWriter';
import { isActive, type CameraLink } from '@/lib/export/projectExport';
import { sharedExportFor } from '@/lib/export/sharedExport';
import type { Store } from '@/lib/state/store';
import { useStore } from '@/lib/state/useStore';
import type { TransferPause } from '@/lib/transfer/types';
import type { FrameDeletion } from '@/lib/projects/frameDeletion';
import EditTools from './EditTools';
import EmojiPicker from './EmojiPicker';
import StickerLayer from './StickerLayer';
import ExportDialog from './ExportDialog';
import FrameStrip from './FrameStrip';
import Icon from './Icon';
import UndoToast from './UndoToast';
import { FPS_CHOICES, isCustomSticker } from '@/lib/projects/model';

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
  /** The edit tools (Task 8); without it there is no tools row. */
  edit?: { controller: EditController; stickers: StickerController; frameDeletion: Pick<FrameDeletion, 'undo'> };
  ref?: Ref<PlayViewHandle>;
}

const NOT_ACTIVE: Store<{ phase: 'idle' }> = { get: () => ({ phase: 'idle' }), set() {}, update() {}, subscribe: () => () => {} };

/** The largest sprite raster the stage asks for (the export rasterizes at its own size). */
const STAGE_BUCKET_MAX = 512;

const IDLE: PlayerStatus = { playing: false, downloading: 0, playable: 0, shown: null };

export default function PlayView({ t, id, onBack, project = null, frameUrl, urls, exportEnv, link, onFps, edit, ref }: PlayViewProps) {
  const { lang } = useTranslator();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stickerCanvas = useRef<HTMLCanvasElement>(null);
  const sprites = useRef<SpriteCache | null>(null);
  const spritesFor = useRef<{ id: string; urls: FrameUrls | null | undefined } | null>(null);
  const player = useRef<Player | null>(null);
  const [status, setStatus] = useState<PlayerStatus>(IDLE);

  useImperativeHandle(ref, () => ({ release: () => player.current?.release() }), []);

  // The sticker canvas is its own layer: it is redrawn on every shown entry or sticker change
  // without the frame bitmap (the ring closes that right after drawing).
  // a sticker being dragged is drawn at its live pose; the store is written on pointerup
  const [live, setLive] = useState<{ id: string; pose: Pose } | null>(null);
  const stickerList = useMemo(() => withLivePose(project?.stickers ?? [], live), [project?.stickers, live]);
  const stickersRef = useRef(stickerList);
  stickersRef.current = stickerList;
  const shownRef = useRef<string | null>(null);
  const paintStickers = useRef((_entryId: string | null): void => {});
  paintStickers.current = (entryId) => {
    shownRef.current = entryId;
    const el = stickerCanvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    // the cache is per project and per url resolver: a custom sticker resolves to the movie's own copy
    if (!sprites.current || needsNewSpriteCache(spritesFor.current, id, urls)) {
      sprites.current?.clear();
      sprites.current = new SpriteCache(undefined, undefined, urls ? urls.spriteUrlOf(id) : openmojiUrlOf);
      spritesFor.current = { id, urls };
    }
    const cache = sprites.current;
    const list = stickersRef.current.filter((st) => entryId !== null && st.on.includes(entryId));
    // rasterize at the size the sticker is shown at (device pixels)
    const scale = (el.clientWidth * window.devicePixelRatio) / PLAY_WIDTH;
    // capped: at 1024 the 32 MB cache holds only 8 sprites, and an entry with a 9th would evict and reload forever
    const bucket = bucketFor(Math.min(STAGE_BUCKET_MAX, Math.max(0, ...list.map((st) => st.size * PLAY_WIDTH * scale))));
    for (const st of list) {
      if (cache.get(st.emoji, bucket) || cache.hasFailed(st.emoji, bucket)) continue;
      cache.load(st.emoji, bucket).then(
        () => {
          if (shownRef.current === entryId) paintStickers.current(entryId);
        },
        // unknown emoji: skipped; a custom sticker whose picture is missing gets the "?" placeholder
        () => {
          if (isCustomSticker(st.emoji) && shownRef.current === entryId) paintStickers.current(entryId);
        },
      );
    }
    drawStickers(ctx, stickersRef.current, entryId, (hex) => cache.get(hex, bucket), (hex) => cache.hasFailed(hex, bucket));
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
      spriteUrlOf: urls ? (pid) => urls.spriteUrlOf(pid) : undefined,
    });
  }, [shared, frameUrl, urls]);
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
  useEffect(() => paintStickers.current(shownRef.current), [stickerList]);

  // The strip: a tap selects the entry (and pauses on it); a second tap opens the big view.
  const [selected, setSelected] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const tiles = useMemo(() => stripTiles({ frames: project?.frames ?? [], cut: project?.cut, stickers: project?.stickers }), [project?.frames, project?.cut, project?.stickers]);
  useEffect(() => setSelected((cur) => reconcileSelection(cur, tiles)), [tiles]);
  const bigOpen = big && selected !== null;
  // the selected sticker (its handles show only while the entry on the stage carries it)
  const [stickerSel, setStickerSel] = useState<string | null>(null);
  useEffect(() => setStickerSel((cur) => reconcileSticker(cur, project)), [project?.stickers]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const stickerOnStage = stickerSel !== null && stickersOn({ stickers: stickerList }, status.shown).some((s) => s.id === stickerSel);
  // its actions stay while another entry is shown: that is how the range is extended to a frame without it
  const stickerShown = stickerSel !== null ? (project?.stickers?.find((s) => s.id === stickerSel) ?? null) : null;
  // stable, so the memoized strip does not re-render on every player tick
  const onTile = useCallback((entryId: string) => {
    if (entryId === selected) {
      setBig(true);
      return;
    }
    setSelected(entryId);
    player.current?.seekTo(entryId);
  }, [selected]);
  // "Od początku": the stage goes to the first playable entry, and so does the selection
  const onRestart = () => {
    player.current?.seekToStart();
    setSelected(tiles.find((x) => x.state === 'ready')?.entryId ?? null);
  };
  // bumped by every tool tap: a sticker gesture still in flight is cancelled instead of overwriting the edit
  const [gestureEpoch, setGestureEpoch] = useState(0);
  // The tools row: one controller call per tap; the project store update re-renders the strip.
  const canUndo = edit?.controller.canUndo(id) ?? false;
  const states = useMemo(() => toolStates(project, selected, { exporting: exportBusy, canUndo }), [project, selected, exportBusy, canUndo]);
  const selectedTileState = useMemo(() => tiles.find((x) => x.entryId === selected)?.state, [tiles, selected]);
  const selectedOff = selectedTileState === 'off';
  // a sticker added on an entry the stage cannot show (off, downloading, unavailable) would be invisible
  const emojiOk = selectedTileState === 'ready';
  const onTool = (tool: EditTool) => {
    const c = edit?.controller;
    if (!c || (selected === null && tool !== 'undo')) return;
    setGestureEpoch((n) => n + 1);
    setLive(null);
    const sel = selected ?? '';
    const run: Promise<unknown> =
      tool === 'delete' ? c.delete(id, sel).then((r) => { if (r === 'frame') setSelected(null); })
      : tool === 'duplicate' ? c.duplicate(id, sel)
      : tool === 'holdUp' ? c.hold(id, sel, 1)
      : tool === 'holdDown' ? c.hold(id, sel, -1)
      : tool === 'moveLeft' ? c.move(id, sel, -1)
      : tool === 'moveRight' ? c.move(id, sel, 1)
      : tool === 'off' ? c.off(id, sel, !selectedOff)
      : tool === 'startHere' ? c.startHere(id, sel)
      : tool === 'endHere' ? c.endHere(id, sel)
      : c.undo(id);
    run.catch((e) => console.error('edit', e));
  };
  const [stickerToast, setStickerToast] = useState(false);
  useEffect(() => {
    if (!stickerToast) return;
    const h = setTimeout(() => setStickerToast(false), 4000);
    return () => clearTimeout(h);
  }, [stickerToast]);
  const onPick = (hex: string) => {
    setPickerOpen(false);
    if (selected === null) return;
    edit?.stickers
      .add(id, selected, hex)
      .then((sid) => sid && setStickerSel(sid))
      .catch((e) => {
        console.error('sticker', e);
        if (e instanceof StickerCopyError) setStickerToast(true);
      });
  };
  const onStickerTool = (what: 'from' | 'to' | 'delete') => {
    const c = edit?.stickers;
    if (!c || stickerSel === null) return;
    setGestureEpoch((n) => n + 1);
    const run = what === 'delete' ? c.remove(id, stickerSel) : selected === null ? Promise.resolve(false) : what === 'from' ? c.rangeFrom(id, stickerSel, selected) : c.rangeTo(id, stickerSel, selected);
    run.catch((e) => console.error('sticker', e));
  };
  useEffect(() => {
    if (!pickerOpen || !overlays) return;
    return overlays.push(() => setPickerOpen(false));
  }, [pickerOpen, overlays]);
  const toolsShown = !!edit && (selected !== null || states.undo);
  // the latest frame in its Undo window (the Undo toast of a frame Delete)
  const hiding = useMemo(
    () => project?.frames.filter((f) => f.hiddenUntil !== null).sort((a, b) => Date.parse(a.hiddenUntil!) - Date.parse(b.hiddenUntil!)).pop(),
    [project?.frames],
  );
  // Android Back closes the big view first.
  useEffect(() => {
    if (!bigOpen || !overlays) return;
    return overlays.push(() => setBig(false));
  }, [bigOpen, overlays]);
  // the stage changes size: repaint stickers at the new device-pixel size
  useEffect(() => paintStickers.current(shownRef.current), [bigOpen]);
  // the url resolver became available (or changed): custom stickers can load now
  useEffect(() => paintStickers.current(shownRef.current), [urls]);

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
        {edit && project && !bigOpen && !exportBusy && (
          <StickerLayer
            t={t}
            project={project}
            entryId={status.shown}
            stickers={stickersOn({ stickers: stickerList }, status.shown)}
            selectedId={stickerOnStage && !status.playing ? stickerSel : null}
            cancelEpoch={gestureEpoch}
            controller={edit.stickers}
            onSelect={setStickerSel}
            onLive={setLive}
          />
        )}
      </div>
      <div className="play-side">
        <div className="play-controls">
          <button type="button" className="icon-btn" aria-label={t('play.restart')} title={t('play.restart')} onClick={onRestart} disabled={status.playable === 0}>
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
        </div>
        {toolsShown && (
          <EditTools
            t={t}
            states={states}
            isOff={selectedOff}
            onTool={onTool}
            onEmoji={() => setPickerOpen(true)}
            emojiOk={emojiOk}
            sticker={stickerShown ? { src: (urls ? urls.spriteUrlOf(id) : openmojiUrlOf)(stickerShown.emoji), onFrom: () => onStickerTool('from'), onTo: () => onStickerTool('to'), onDelete: () => onStickerTool('delete') } : null}
          />
        )}
        {status.playable === 0 && status.downloading === 0 && <p className="note">{t('play.empty')}</p>}
        {status.downloading > 0 && <p className="note">{t('play.downloading', { n: status.downloading })}</p>}
      </div>
      {project && <FrameStrip t={t} project={project} selected={selected} onTap={onTile} urls={urls} stickerId={stickerSel} />}
      {edit && hiding && (
        <UndoToast t={t} message={t('tools.frameDeleted')} deadline={hiding.hiddenUntil!} label="tools.frameUndo" onUndo={() => void edit.frameDeletion.undo(id, hiding.frameId)} />
      )}
      {stickerToast && (
        <div className="toast" role="alert" onClick={() => setStickerToast(false)}>
          {t('sticker.addFailed')}
        </div>
      )}
      {pickerOpen && <EmojiPicker t={t} lang={lang} onPick={onPick} onClose={() => setPickerOpen(false)} library={edit ? appStickerLibrary() : undefined} overlays={overlays} />}
      {exporter && exportOpen && project && (
        <ExportDialog t={t} project={project} controller={exporter} link={link} onClose={() => setExportOpen(false)} />
      )}
    </main>
  );
}
