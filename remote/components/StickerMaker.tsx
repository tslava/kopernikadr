'use client';

import { useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { reduce, START, type Brush, type MakerNotice } from '@/lib/app/stickerMakerModel';
import type { Translate } from '@/lib/i18n';
import { KopernikadrNative, nativeErrorCode } from '@/lib/native';
import { removeStoreFile } from '@/lib/stickers/appLibrary';
import { createAppBinaryIO } from '@/lib/stickers/binaryFiles';
import { appendPoint, containRect, toNormalized } from '@/lib/stickers/cutGeometry';
import { composePreview, coverage } from '@/lib/stickers/cutPreview';
import { reopenFrom, runCut } from '@/lib/stickers/cutSession';
import { decodeImage, encodePng, storeFileUrl } from '@/lib/stickers/imageDecode';
import { StickerLibraryFullError, type StickerLibrary } from '@/lib/stickers/library';
import { createSegClient, SegError, SegSupersededError, type SegClient, type SegStrokeArg } from '@/lib/stickers/segClient';
import { cutout, encodeStickerWebps, makeSticker, type Img, type StickerStyle } from '@/lib/stickers/stickerize';
import { StyleCache } from '@/lib/stickers/styleCache';
import type { OverlayStack } from '@/lib/app/overlays';
import Icon from './Icon';

const STYLES: StickerStyle[] = ['naklejka', 'komiks'];

/**
 * Full-screen "Zrób naklejkę": source -> [cut ->] style -> save into the library (plan "Photo
 * stickers"). A picture that already has transparency goes straight to the style step; a photo gets
 * the cut step, where strokes over the toy drive the native segmenter. Every target >= 56 px.
 * The segmenter session is closed on leaving the cut step, on cancel, after save and on unmount.
 */
export default function StickerMaker({ t, library, overlays, seg: segProp, onDone, onClose }: {
  t: Translate;
  library: StickerLibrary;
  overlays?: OverlayStack;
  /** The segmenter client; tests inject a fake, the app creates its own. */
  seg?: SegClient;
  /** The sticker was saved to the library. */
  onDone: (id: string) => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(reduce, START);
  // styled stickers are computed once per picture and style; a chip tap and "Zapisz" only reuse them
  const cache = useRef(new StyleCache(makeSticker));
  const segRef = useRef<SegClient | null>(segProp ?? null);
  const seg = (): SegClient => (segRef.current ??= createSegClient());
  const live = useRef(true);
  /** The decoded photo of the cut step (what the native session holds, <= 1024 px), and its latest cut-out. */
  const [photo, setPhoto] = useState<Img | null>(null);
  const photoRef = useRef<Img | null>(null);
  const lastCut = useRef<Img | null>(null);
  const [preview, setPreview] = useState<Img | null>(null);
  const stepRef = useRef(state.step);
  stepRef.current = state.step;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      cache.current.clear();
      void seg().close();
    };
  }, []);
  // leaving the cut step (Dalej, back, save, close) frees the native session and the photo
  useEffect(() => {
    if (state.step === 'cut') return;
    void seg().close();
    if (state.step !== 'loading') {
      photoRef.current = null;
      lastCut.current = null;
      setPhoto(null);
      setPreview(null);
    }
  }, [state.step]);

  // one run per stroke list (and per retry); a newer list makes the older result stale and it is dropped
  const cutStrokes = state.step === 'cut' ? state.strokes : null;
  const attempt = state.step === 'cut' ? state.attempt : 0;
  useEffect(() => {
    if (!cutStrokes) return;
    if (cutStrokes.length === 0) {
      lastCut.current = null;
      setPreview(null);
      return;
    }
    const img = photoRef.current;
    if (!img) return;
    let stale = false;
    const client = seg();
    const reopen = reopenFrom(client, () => photoRef.current, {
      encodePng,
      write: (path, bytes) => createAppBinaryIO().writeBytes(path, bytes),
      remove: removeStoreFile,
      uuid: () => crypto.randomUUID(),
    });
    runCut(client, cutStrokes, reopen).then(
      (r) => {
        if (stale) return;
        const cut = cutout(img, r.mask, r.width, r.height);
        lastCut.current = cut;
        setPreview(composePreview(img, r.mask, r.width, r.height));
        dispatch({ type: 'cutDone', coverage: coverage(r.mask), empty: cut === null });
      },
      (e) => {
        if (stale || e instanceof SegSupersededError) return;
        console.error('segmentation', e);
        dispatch({ type: 'cutFailed' });
      },
    );
    return () => {
      stale = true;
    };
  }, [cutStrokes, attempt]);
  useEffect(() => overlays?.push(() => dispatch({ type: 'cancel' })), [overlays]);
  useEffect(() => {
    if (state.step === 'closed') onClose();
    else if (state.step === 'done') onDone(state.id);
  }, [state, onClose, onDone]);

  const styled = (style: StickerStyle): Img | null => cache.current.get(style);

  /**
   * Both sources hand back a file in `tmp/`; the native `segOpen` decodes it (EXIF applied, <= 1024 px,
   * deletes the source) and says whether it already has transparency. Then the picture is decoded in
   * the WebView from the session's image: with alpha it goes to the style step and the session is
   * closed, otherwise it is the photo of the cut step.
   */
  const onSource = async (get: () => Promise<{ path: string }>) => {
    dispatch({ type: 'pick' });
    let path: string | undefined;
    try {
      ({ path } = await get());
      const opened = await seg().open(path);
      const img = await decodeImage(await storeFileUrl(opened.image));
      if (!live.current || stepRef.current !== 'loading') {
        void seg().close(); // the kid backed out while the picture loaded
        return;
      }
      if (opened.hasAlpha) {
        void seg().close();
        cache.current.setSource(img);
        if (!styled('naklejka')) dispatch({ type: 'empty' });
        else dispatch({ type: 'picked', hasAlpha: true });
      } else {
        photoRef.current = img;
        setPhoto(img);
        dispatch({ type: 'picked', hasAlpha: false });
      }
    } catch (e) {
      if (path) void removeStoreFile(path); // `segOpen` deletes it only on success; the sweep does the rest
      void seg().close();
      if (live.current) dispatch({ type: 'pickFailed', code: e instanceof SegError ? (e.code === 'UNKNOWN' ? undefined : e.code) : nativeErrorCode(e) });
    }
  };

  const onNext = () => {
    cache.current.setSource(lastCut.current);
    dispatch({ type: 'next' });
  };

  const onSave = async () => {
    if (state.step !== 'style') return;
    const sticker = styled(state.style);
    dispatch({ type: 'save' });
    if (!sticker) {
      dispatch({ type: 'saveFailed', notice: 'empty' });
      return;
    }
    try {
      const { webp, thumb } = await encodeStickerWebps(sticker);
      const id = await library.add(webp, thumb);
      if (live.current) dispatch({ type: 'saved', id });
    } catch (e) {
      console.error('sticker save', e);
      if (live.current) dispatch({ type: 'saveFailed', notice: e instanceof StickerLibraryFullError ? 'full' : 'failed' });
    }
  };

  const notice = state.step === 'source' || state.step === 'style' || state.step === 'cut' ? state.notice : null;
  return (
    <div className="maker" role="dialog" aria-label={t('maker.title')}>
      <header className="bar">
        <button type="button" className="icon-btn" aria-label={t('maker.back')} title={t('maker.back')} onClick={() => dispatch({ type: 'cancel' })} disabled={state.step === 'saving'}>
          <Icon name="back" />
        </button>
        <h1>{t('maker.title')}</h1>
      </header>
      {state.step === 'source' && (
        <div className="maker-body">
          <div className="maker-sources">
            <button type="button" className="maker-source" data-testid="maker-camera" onClick={() => void onSource(() => KopernikadrNative.takePhoto())}>
              <Icon name="camera" />
              <span>{t('maker.camera')}</span>
            </button>
            <button type="button" className="maker-source" data-testid="maker-gallery" onClick={() => void onSource(() => KopernikadrNative.pickImage())}>
              <Icon name="film" />
              <span>{t('maker.gallery')}</span>
            </button>
          </div>
        </div>
      )}
      {state.step === 'loading' && <p className="maker-wait" role="status"><span className="spinner" aria-hidden="true" /> {t('maker.loading')}</p>}
      {state.step === 'cut' && photo && (
        <div className="maker-body cut">
          <CutStage
            photo={preview ?? photo}
            size={photo}
            strokes={state.strokes}
            brush={state.brush}
            busy={state.busy}
            label={t('maker.cutView')}
            message={state.busy ? t('maker.thinking') : state.wide ? t('maker.cutHint') : state.strokes.length === 0 ? t('maker.cutPrompt') : null}
            onStroke={(stroke) => dispatch({ type: 'stroke', stroke })}
          />
          <div className="maker-side">
            <div className="maker-styles" role="radiogroup">
              {(['add', 'erase'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={state.brush === b}
                  className={`maker-style brush${state.brush === b ? ' sel' : ''}`}
                  data-brush={b}
                  onClick={() => dispatch({ type: 'brush', brush: b })}
                >
                  {t(b === 'add' ? 'maker.brushAdd' : 'maker.brushErase')}
                </button>
              ))}
            </div>
            <div className="maker-row">
              <button type="button" className="maker-tool" data-testid="cut-undo" disabled={state.strokes.length === 0} onClick={() => dispatch({ type: 'undo' })}>
                <Icon name="undo" /> {t('maker.undo')}
              </button>
              <button type="button" className="maker-tool" data-testid="cut-reset" disabled={state.strokes.length === 0} onClick={() => dispatch({ type: 'reset' })}>
                {t('maker.reset')}
              </button>
            </div>
            {state.notice === 'cutFailed' && (
              <button type="button" className="maker-tool" data-testid="cut-retry" onClick={() => dispatch({ type: 'retry' })}>
                {t('maker.retry')}
              </button>
            )}
            <button type="button" className="primary maker-save" data-testid="cut-next" disabled={!state.ready || state.busy} onClick={onNext}>
              {t('maker.next')}
            </button>
          </div>
        </div>
      )}
      {(state.step === 'style' || state.step === 'saving') && (
        <div className="maker-body style">
          <Preview img={styled(state.style)} label={t('maker.preview')} />
          <div className="maker-side">
            <div className="maker-styles" role="radiogroup">
              {STYLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={state.style === s}
                  className={`maker-style${state.style === s ? ' sel' : ''}`}
                  data-style={s}
                  disabled={state.step === 'saving'}
                  onClick={() => dispatch({ type: 'style', style: s })}
                >
                  {state.style === s && <span className="maker-check" aria-hidden="true">✓</span>}
                  {t(s === 'naklejka' ? 'maker.styleNaklejka' : 'maker.styleKomiks')}
                </button>
              ))}
            </div>
            <button type="button" className="primary maker-save" data-testid="maker-save" disabled={state.step === 'saving'} onClick={() => void onSave()}>
              {state.step === 'saving' ? t('maker.saving') : t('maker.save')}
            </button>
          </div>
        </div>
      )}
      {notice && <p className="maker-notice" role="alert">{t(NOTICE_KEY[notice])}</p>}
    </div>
  );
}

const NOTICE_KEY = {
  cutEmpty: 'maker.cutEmpty',
  cutFailed: 'maker.cutFailed',
  noApp: 'maker.noApp',
  tooLarge: 'maker.tooLarge',
  unsupported: 'maker.unsupported',
  failed: 'maker.failed',
  empty: 'maker.empty',
  full: 'maker.full',
} as const satisfies Record<MakerNotice, string>;

/** The styled sticker on a checkerboard, so the transparent edge and the shadow are visible. */
function Preview({ img, label }: { img: Img | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx || !img) return;
    el.width = img.width;
    el.height = img.height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  }, [img]);
  return (
    <div className="maker-preview checker">
      <canvas ref={ref} role="img" aria-label={label} />
    </div>
  );
}

const STROKE_COLOR: Record<Brush, string> = { add: 'rgba(61, 220, 132, 0.75)', erase: 'rgba(255, 82, 82, 0.75)' };

/**
 * The photo (or its cut-out preview over a checkerboard) plus a transparent overlay with the strokes.
 * Both canvases are `object-fit: contain` in the stage; pointer positions are normalized to the
 * displayed image rect. Drawing uses pointer capture and `touch-action: none` (no scroll, no zoom).
 * A tap is a one-point stroke. The stage stays live while a run is in flight (a newer run supersedes).
 */
function CutStage({ photo, size, strokes, brush, busy, label, message, onStroke }: {
  /** What the base canvas shows: the dimmed-photo preview once there is a mask, else the photo. */
  photo: Img;
  /** The photo itself, for the aspect ratio (the preview has the same size). */
  size: Img;
  strokes: SegStrokeArg[];
  brush: Brush;
  busy: boolean;
  label: string;
  message: string | null;
  onStroke: (stroke: SegStrokeArg) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ id: number; stroke: SegStrokeArg } | null>(null);

  useEffect(() => {
    const el = base.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    el.width = photo.width;
    el.height = photo.height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(photo.data), photo.width, photo.height), 0, 0);
  }, [photo]);

  const paint = () => {
    const el = over.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    if (el.width !== size.width || el.height !== size.height) {
      el.width = size.width;
      el.height = size.height;
    }
    ctx.clearRect(0, 0, el.width, el.height);
    const r = Math.max(size.width, size.height) * 0.012;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = r * 2;
    for (const s of drawing.current ? [...strokes, drawing.current.stroke] : strokes) {
      ctx.strokeStyle = ctx.fillStyle = STROKE_COLOR[s.mode === 'erase' ? 'erase' : 'add'];
      const pts = s.points.map(([x, y]) => [x * el.width, y * el.height] as const);
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      }
    }
  };
  useEffect(paint, [strokes, size]);

  const shown = () => {
    const b = stage.current?.getBoundingClientRect();
    return containRect({ x: b?.left ?? 0, y: b?.top ?? 0, w: b?.width ?? 0, h: b?.height ?? 0 }, size.width, size.height);
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing.current) return;
    const p = toNormalized(e.clientX, e.clientY, shown(), false);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = { id: e.pointerId, stroke: { mode: brush, points: [p] } };
    paint();
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    const p = toNormalized(e.clientX, e.clientY, shown(), true);
    if (!p) return;
    d.stroke = { ...d.stroke, points: appendPoint(d.stroke.points, p) };
    paint();
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    drawing.current = null;
    const p = toNormalized(e.clientX, e.clientY, shown(), true);
    onStroke(p ? { ...d.stroke, points: appendPoint(d.stroke.points, p) } : d.stroke);
  };
  const cancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drawing.current?.id !== e.pointerId) return;
    drawing.current = null;
    paint();
  };

  return (
    <div
      ref={stage}
      className="cut-stage checker"
      data-testid="cut-stage"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
    >
      <canvas ref={base} role="img" aria-label={label} />
      <canvas ref={over} aria-hidden="true" />
      {message && (
        <p className={`cut-msg${busy ? ' busy' : ''}`} role="status">
          {busy && <span className="spinner" aria-hidden="true" />} {message}
        </p>
      )}
    </div>
  );
}
