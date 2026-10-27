'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { beyondSlop, createLongPress, LONG_PRESS_MS } from '@/lib/longPress';
import { useTranslator } from '@/lib/i18n/useTranslator';

const HINT_MS = 1800;

/**
 * A parent-only control: acts only after being held for LONG_PRESS_MS. The pointer is captured
 * and touch scrolling is off on it (`.longpress`), so a drifting finger does not cancel the hold;
 * a short tap shows a "hold longer" hint instead of doing nothing.
 */
export default function LongPressButton({
  onLongPress, label, className, children,
}: { onLongPress: () => void; label: string; className?: string; children: ReactNode }) {
  const { t } = useTranslator();
  const [held, setHeld] = useState(false);
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const lp = useMemo(() => createLongPress(() => { fired.current = true; setHeld(false); cb.current(); }), []);
  useEffect(() => () => lp.cancel(), [lp]);
  useEffect(() => {
    if (!hint) return;
    const h = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(h);
  }, [hint]);
  const stop = () => { start.current = null; setHeld(false); lp.cancel(); };
  const style = { '--hold': `${LONG_PRESS_MS}ms` } as CSSProperties;
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        className={`${className ?? ''} longpress${held ? ' held' : ''}`}
        style={style}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          start.current = { x: e.clientX, y: e.clientY };
          fired.current = false;
          setHint(null);
          setHeld(true);
          lp.start();
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (s && beyondSlop(e.clientX - s.x, e.clientY - s.y)) stop();
        }}
        onPointerUp={(e) => {
          const wasHolding = start.current !== null;
          stop();
          if (wasHolding && !fired.current) setHint({ x: e.clientX, y: e.clientY });
        }}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </button>
      {hint && typeof document !== 'undefined' &&
        createPortal(
          <span className="lp-hint" role="status" style={{ left: hint.x, top: hint.y }}>{t('longpress.hint')}</span>,
          document.body,
        )}
    </>
  );
}
