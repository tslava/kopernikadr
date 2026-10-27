'use client';

import { useRef } from 'react';
import { pickSticker, type StickerController, type StickerGesture } from '@/lib/app/stickerController';
import type { Translate } from '@/lib/i18n';
import type { Project, Sticker } from '@/lib/projects/model';
import type { Pose } from '@/lib/projects/stickers';
import { handlePoint, stickerBox } from '@/lib/render/stickerGeometry';

/**
 * The touch layer over the stage: a tap picks the topmost sticker of the shown entry, a drag moves
 * it, and the corner handle of the selected one scales and rotates it. Pointer events with pointer
 * capture and `touch-action: none` (a finger drag must not become a scroll). The live pose goes up
 * through `onLive` while the finger is down; the store is written once, on pointerup.
 */
export default function StickerLayer({ t, project, entryId, stickers, selectedId, controller, onSelect, onLive }: {
  t: Translate;
  project: Project;
  /** The entry shown on the stage. */
  entryId: string | null;
  /** The stickers shown on it, with any live pose already laid over. */
  stickers: Sticker[];
  selectedId: string | null;
  controller: StickerController;
  onSelect: (id: string | null) => void;
  onLive: (live: { id: string; pose: Pose } | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ g: StickerGesture; pointer: number } | null>(null);

  const local = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { p: { x: e.clientX - r.left, y: e.clientY - r.top }, w: r.width, h: r.height };
  };
  const begin = (e: React.PointerEvent, sticker: Sticker, kind: 'move' | 'handle') => {
    const { p, w, h } = local(e);
    gesture.current = { g: controller.begin(sticker, kind, p, w, h), pointer: e.pointerId };
    box.current!.setPointerCapture(e.pointerId);
  };

  const onDown = (e: React.PointerEvent) => {
    if (gesture.current || !box.current) return;
    const { p, w, h } = local(e);
    if ((e.target as HTMLElement).dataset.handle !== undefined && selectedId !== null) {
      const st = project.stickers?.find((s) => s.id === selectedId);
      if (st) begin(e, st, 'handle');
      return;
    }
    const hit = pickSticker({ stickers: project.stickers }, entryId, p, w, h);
    onSelect(hit ? hit.id : null);
    if (hit) begin(e, hit, 'move');
  };
  const onMove = (e: React.PointerEvent) => {
    const cur = gesture.current;
    if (!cur || cur.pointer !== e.pointerId) return;
    onLive({ id: cur.g.id, pose: cur.g.update(local(e).p) });
  };
  const finish = (e: React.PointerEvent, commit: boolean) => {
    const cur = gesture.current;
    if (!cur || cur.pointer !== e.pointerId) return;
    gesture.current = null;
    if (commit) {
      cur.g.update(local(e).p);
      // the live pose stays until the store has the new one, so the sticker does not jump back
      void cur.g.commit(project.id).catch((err) => console.error('sticker', err)).finally(() => onLive(null));
    } else {
      cur.g.cancel();
      onLive(null);
    }
  };

  const sel = selectedId === null ? null : stickers.find((s) => s.id === selectedId) ?? null;
  const r = box.current?.getBoundingClientRect();
  const w = r?.width ?? 0;
  const h = r?.height ?? 0;
  let outline: React.CSSProperties | null = null;
  let handle: { left: number; top: number } | null = null;
  if (sel && w > 0) {
    const b = stickerBox(sel, w, h);
    outline = { left: b.cx - b.side / 2, top: b.cy - b.side / 2, width: b.side, height: b.side, transform: `rotate(${b.rot}deg)` };
    const hp = handlePoint(sel, w, h);
    handle = { left: hp.x, top: hp.y };
  }

  return (
    <div
      ref={box}
      className="sticker-layer"
      role="group"
      aria-label={t('sticker.layer')}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
    >
      {outline && <div className="sticker-outline" style={outline} aria-label={t('sticker.selected')} />}
      {handle && <div className="sticker-handle" data-handle="" style={handle} role="button" aria-label={t('sticker.handle')} />}
    </div>
  );
}
