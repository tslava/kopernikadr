'use client';

import { useEffect, useState } from 'react';
import { loadCatalog, spriteUrl, type EmojiCatalog } from '@/lib/render/catalog';
import type { Lang, Translate } from '@/lib/i18n';
import Icon from './Icon';

/** The sticker picker: category tabs over a 6-column grid of OpenMoji images. A tap picks and closes. */
export default function EmojiPicker({ t, lang, onPick, onClose }: {
  t: Translate;
  lang: Lang;
  onPick: (hexcode: string) => void;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<EmojiCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState(0);
  const [attempt, setAttempt] = useState(0);

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

  const cat = catalog?.categories[tab] ?? null;
  return (
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
        {catalog && cat && (
          <>
            <div className="picker-tabs" role="tablist">
              {catalog.categories.map((c, i) => (
                <button key={c.id} type="button" role="tab" aria-selected={i === tab} className={i === tab ? 'sel' : ''} onClick={() => setTab(i)}>
                  {c.name[lang]}
                </button>
              ))}
            </div>
            <div className="picker-grid">
              {cat.hexcodes.map((hex, i) => (
                <button key={hex} type="button" className="picker-item" data-hex={hex} aria-label={t('picker.item', { n: i + 1 })} onClick={() => onPick(hex)}>
                  <img src={spriteUrl(hex)} alt="" loading="lazy" draggable={false} width={72} height={72} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
