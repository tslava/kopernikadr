'use client';

import { useEffect, useReducer, useRef } from 'react';
import { reduce, START, type MakerNotice } from '@/lib/app/stickerMakerModel';
import type { Translate } from '@/lib/i18n';
import { KopernikadrNative, nativeErrorCode } from '@/lib/native';
import { removeStoreFile } from '@/lib/stickers/appLibrary';
import { decodeImage, hasTransparency, storeFileUrl } from '@/lib/stickers/imageDecode';
import { StickerLibraryFullError, type StickerLibrary } from '@/lib/stickers/library';
import { encodePng, makeSticker, makeThumbnail, type Img, type StickerStyle } from '@/lib/stickers/stickerize';
import type { OverlayStack } from '@/lib/app/overlays';
import Icon from './Icon';

const STYLES: StickerStyle[] = ['naklejka', 'komiks'];

/**
 * Full-screen "Zrób naklejkę": source -> style -> save into the library (plan "Photo stickers").
 * A picture that already has transparency goes straight to the style step; the cut step for
 * photos comes later. Plain taps only, every target >= 56 px.
 */
export default function StickerMaker({ t, library, overlays, onDone, onClose }: {
  t: Translate;
  library: StickerLibrary;
  overlays?: OverlayStack;
  /** The sticker was saved to the library. */
  onDone: (id: string) => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(reduce, START);
  const cut = useRef<Img | null>(null);
  // styled stickers are computed once per picture; a chip tap only swaps the preview
  const made = useRef(new Map<StickerStyle, Img>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      cut.current = null;
      made.current.clear();
    };
  }, []);
  useEffect(() => overlays?.push(() => dispatch({ type: 'cancel' })), [overlays]);
  useEffect(() => {
    if (state.step === 'closed') onClose();
    else if (state.step === 'done') onDone(state.id);
  }, [state, onClose, onDone]);

  const styled = (style: StickerStyle): Img | null => {
    const hit = made.current.get(style);
    if (hit) return hit;
    const img = cut.current ? makeSticker(cut.current, style) : null;
    if (img) made.current.set(style, img);
    return img;
  };

  const onGallery = async () => {
    dispatch({ type: 'pick' });
    try {
      const { path } = await KopernikadrNative.pickImage();
      let img: Img;
      try {
        img = await decodeImage(await storeFileUrl(path));
      } finally {
        void removeStoreFile(path); // the sweep would do it at the next start; the space is freed now
      }
      if (!live.current) return;
      made.current.clear();
      cut.current = img;
      const alpha = hasTransparency(img);
      if (alpha && !styled('naklejka')) dispatch({ type: 'empty' });
      else dispatch({ type: 'picked', hasAlpha: alpha });
    } catch (e) {
      if (live.current) dispatch({ type: 'pickFailed', code: nativeErrorCode(e) });
    }
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
      const id = await library.add(await encodePng(sticker), await encodePng(makeThumbnail(sticker)));
      if (live.current) dispatch({ type: 'saved', id });
    } catch (e) {
      console.error('sticker save', e);
      if (live.current) dispatch({ type: 'saveFailed', notice: e instanceof StickerLibraryFullError ? 'full' : 'failed' });
    }
  };

  const notice = state.step === 'source' || state.step === 'style' ? state.notice : null;
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
            <button type="button" className="maker-source" data-testid="maker-gallery" onClick={() => void onGallery()}>
              <Icon name="film" />
              <span>{t('maker.gallery')}</span>
            </button>
          </div>
        </div>
      )}
      {state.step === 'loading' && <p className="maker-wait" role="status"><span className="spinner" aria-hidden="true" /> {t('maker.loading')}</p>}
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
  soon: 'maker.soon',
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
