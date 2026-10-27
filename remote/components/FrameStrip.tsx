'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FrameUrls } from '@/lib/app/frames';
import { stripTiles, tileImage, visibleWindow } from '@/lib/app/stripModel';
import type { Translate } from '@/lib/i18n';
import type { Project } from '@/lib/projects/model';

/** Tile width and the gap between tiles (CSS px; keep in sync with `.strip-tile` in globals.css). */
export const TILE_W = 112;
export const TILE_GAP = 8;
const PITCH = TILE_W + TILE_GAP;

export interface FrameStripProps {
  t: Translate;
  project: Project;
  /** Selected entry id. */
  selected: string | null;
  /** A tap on a tile (the parent decides: select, or open the big view on the selected one). */
  onTap: (entryId: string) => void;
  /** Frame files for tiles; without it every tile is a placeholder. */
  urls?: FrameUrls | null;
  /** The sticker whose frames get a colored bar. */
  stickerId?: string | null;
}

/** Horizontal scroller of the timeline entries, virtualized by index window. */
export default function FrameStrip({ t, project, selected, onTap, urls, stickerId }: FrameStripProps) {
  const tiles = stripTiles(project, stickerId);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1280 });
  const [, setAbsentN] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (el) setView({ left: el.scrollLeft, width: el.clientWidth });
  }, []);
  // keep the selected tile on screen (it was picked on the stage, or moved)
  const at = selected === null ? -1 : tiles.findIndex((x) => x.entryId === selected);
  useEffect(() => {
    const el = box.current;
    if (!el || at < 0) return;
    const x = at * PITCH;
    if (x < el.scrollLeft) el.scrollLeft = x;
    else if (x + TILE_W > el.scrollLeft + el.clientWidth) el.scrollLeft = x + TILE_W - el.clientWidth;
  }, [at]);

  const { start, end } = visibleWindow({ count: tiles.length, scrollLeft: view.left, viewport: view.width, pitch: PITCH, overscan: 4 });
  const url = urls ? urls.url : undefined;

  return (
    <div
      ref={box}
      className="strip"
      onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}
    >
      <ul className="strip-track" style={{ width: Math.max(0, tiles.length * PITCH - TILE_GAP) }}>
        {tiles.slice(start, end).map((tile, k) => {
          const i = start + k;
          const img = tileImage(url, project.id, tile.frameId);
          return (
            <li key={tile.entryId} style={{ left: i * PITCH }}>
              <button
                type="button"
                className={`strip-tile ${tile.state}${tile.entryId === selected ? ' selected' : ''}`}
                aria-label={t('strip.tile', { n: i + 1 })}
                aria-pressed={tile.entryId === selected}
                data-entry={tile.entryId}
                onClick={() => onTap(tile.entryId)}
              >
                {img && (
                  <img
                    src={img.url}
                    alt=""
                    draggable={false}
                    onError={() => {
                      urls?.markAbsent(project.id, tile.frameId, img.kind);
                      setAbsentN((n) => n + 1);
                    }}
                  />
                )}
                {tile.hold > 1 && <span className="strip-hold">×{tile.hold}</span>}
                {tile.state === 'deleting' && <span className="strip-flag">{t('strip.deleting')}</span>}
                {tile.state === 'downloading' && <span className="strip-flag">{t('strip.downloading')}</span>}
                {tile.state === 'unavailable' && <span className="strip-flag">{t('strip.unavailable')}</span>}
                {tile.marked && <span className="strip-mark" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
