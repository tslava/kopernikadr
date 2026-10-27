'use client';

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createLongPress, LONG_PRESS_MS } from '@/lib/longPress';

/** A parent-only control: acts only after being held for LONG_PRESS_MS. */
export default function LongPressButton({
  onLongPress, label, className, children,
}: { onLongPress: () => void; label: string; className?: string; children: ReactNode }) {
  const [held, setHeld] = useState(false);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  const lp = useMemo(() => createLongPress(() => { setHeld(false); cb.current(); }), []);
  const stop = () => { setHeld(false); lp.cancel(); };
  const style = { '--hold': `${LONG_PRESS_MS}ms` } as CSSProperties;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`${className ?? ''} longpress${held ? ' held' : ''}`}
      style={style}
      onPointerDown={() => { setHeld(true); lp.start(); }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}
