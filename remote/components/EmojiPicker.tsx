'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { loadCatalog, spriteUrl, type EmojiCatalog } from '@/lib/render/catalog';
import type { Lang, Translate } from '@/lib/i18n';
import type { OverlayStack } from '@/lib/app/overlays';
import { thumbSrc } from '@/lib/stickers/appLibrary';
import { STICKER_LIMIT, type StickerLibrary } from '@/lib/stickers/library';
import { customEmoji, deleteAsk, pickerTabs } from '@/lib/stickers/pickerTabs';
import Icon from './Icon';
import StickerMaker from './StickerMaker';

interface Mine {
  id: string;
  src: string | null;
}

/**
 * The sticker picker: category tabs over a 6-column grid of OpenMoji images. A tap picks and closes.
 * With a sticker `library` the first tab is "Moje": a "Zrób naklejkę" tile, then the kid's own
 * stickers (picked as `my:<uuid>`), each with a ✕ that asks before it deletes.
 */
export default function EmojiPicker({ t, lang, onPick, onClose, library, overlays }: {
  t: Translate;
  lang: Lang;
  /** A catalog hexcode, or `my:<uuid>` for a custom sticker. */
  onPick: (emoji: string) => void;
  onClose: () => void;
  library?: StickerLibrary;
  overlays?: OverlayStack;
}) {
  const [catalog, setCatalog] = useState<EmojiCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [making, setMaking] = useState(false);
  const [ask, dispatchAsk] = useReducer(deleteAsk, null);
  const [deleteFailed, setDeleteFailed] = useState(false);
  // bumped after a save or a delete: the "Moje" list is read again
  const [mineVersion, setMineVersion] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed(false);
    loadCatalog().then(
      (c) => live && setCatalog(c),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (!library) return;
    let live = true;
    (async () => {
      const items = await library.list();
      const rows = await Promise.all(items.map(async (it) => ({ id: it.id, src: await thumbSrc(library, it.id).catch(() => null) })));
      if (live) setMine(rows);
    })().catch((e) => {
      console.error('sticker library', e);
      if (live) setMine([]);
    });
    return () => {
      live = false;
    };
  }, [library, mineVersion]);

  const tabs = useMemo(() => pickerTabs(catalog?.categories.length ?? 0, !!library), [catalog, library]);
  const active = tabs[Math.min(tab, tabs.length - 1)] ?? null;
  // Android Back closes the confirm first, then the maker, then (PlayView's entry) the picker
  useEffect(() => (ask && overlays ? overlays.push(() => dispatchAsk({ type: 'cancel' })) : undefined), [ask, overlays]);
  const closeMaker = useCallback(() => setMaking(false), []);
  const onMade = useCallback(() => {
    setMaking(false);
    setTab(0); // "Moje", where the new sticker is the first tile
    setMineVersion((n) => n + 1);
  }, []);
  const doDelete = (id: string) => {
    dispatchAsk({ type: 'confirmed' });
    setDeleteFailed(false);
    library?.remove(id).then(
      () => setMineVersion((n) => n + 1),
      (e) => {
        console.error('sticker delete', e);
        setDeleteFailed(true);
      },
    );
  };

  const full = (mine?.length ?? 0) >= STICKER_LIMIT;
  const category = active?.kind === 'category' ? (catalog?.categories[active.index] ?? null) : null;
  const tabName = (i: number) => {
    const tb = tabs[i]!;
    return tb.kind === 'mine' ? t('picker.mine') : (catalog?.categories[tb.index]?.name[lang] ?? '');
  };
  return (
    <>
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog picker" role="dialog" aria-label={t('picker.title')} onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <h2>{t('picker.title')}</h2>
          <button type="button" className="icon-btn" aria-label={t('picker.close')} title={t('picker.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {failed && (
          <>
            <p className="err">{t('picker.failed')}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t('picker.retry')}</button>
          </>
        )}
        {!failed && !catalog && <p>{t('picker.loading')}</p>}
        {catalog && active && (
          <>
            <div className="picker-tabs" role="tablist">
              {tabs.map((tb, i) => (
                <button key={tb.kind === 'mine' ? 'mine' : catalog.categories[tb.index]!.id} type="button" role="tab" aria-selected={tb === active} className={tb === active ? 'sel' : ''} data-tab={tb.kind} onClick={() => setTab(i)}>
                  {tabName(i)}
                </button>
              ))}
            </div>
            {active.kind === 'mine' && (
              <div className="picker-grid mine">
                <button type="button" className="picker-item make" data-testid="picker-make" disabled={full} onClick={() => setMaking(true)}>
                  <Icon name="plus" />
                  <span>{t('picker.make')}</span>
                </button>
                {(mine ?? []).map((m, i) => (
                  <div className="mine-wrap" key={m.id}>
                    <button type="button" className="picker-item" data-sticker={m.id} aria-label={t('picker.mineItem', { n: i + 1 })} onClick={() => onPick(customEmoji(m.id))}>
                      {m.src && <img src={m.src} alt="" draggable={false} width={96} height={96} />}
                    </button>
                    <button type="button" className="mine-del" data-testid="mine-del" aria-label={t('sticker.mineDel')} title={t('sticker.mineDel')} onClick={() => dispatchAsk({ type: 'ask', id: m.id })}>
                      <Icon name="close" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {active.kind === 'mine' && full && <p className="err">{t('maker.full')}</p>}
            {active.kind === 'mine' && deleteFailed && <p className="err" role="alert">{t('picker.deleteFailed')}</p>}
            {category && (
              <div className="picker-grid">
                {category.hexcodes.map((hex, i) => (
                  <button key={hex} type="button" className="picker-item" data-hex={hex} aria-label={t('picker.item', { n: i + 1 })} onClick={() => onPick(hex)}>
                    <img src={spriteUrl(hex)} alt="" loading="lazy" draggable={false} width={72} height={72} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
      {ask && (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-label={t('picker.deleteTitle')}>
            <p>{t('picker.deleteTitle')}</p>
            <div className="row">
              <button type="button" onClick={() => dispatchAsk({ type: 'cancel' })}>{t('projects.cancel')}</button>
              <button type="button" className="danger" data-testid="mine-del-confirm" onClick={() => doDelete(ask.id)}>{t('projects.deleteConfirm')}</button>
            </div>
          </div>
        </div>
      )}
      {making && library && <StickerMaker t={t} library={library} overlays={overlays} onDone={onMade} onClose={closeMaker} />}
    </>
  );
}
