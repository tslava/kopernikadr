'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { PreviewController } from '@/lib/camera/previewController';

const stage = { position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#000', overflow: 'hidden' } as const;
const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' } as const;

/**
 * The live preview canvas, 4:3, filling its area. The controller draws into it; `children` are overlays
 * (onion skin, flash, badges). `message` shows while there is no live frame (waiting / offline).
 */
export default function Preview({
  controller,
  live,
  message,
  children,
}: {
  controller: PreviewController;
  live: boolean;
  message?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    controller.setCanvas(ref.current);
    return () => controller.setCanvas(null);
  }, [controller]);
  return (
    <div style={stage} data-live={live}>
      <canvas ref={ref} width={640} height={480} style={{ ...fill, filter: live ? undefined : 'brightness(.3) grayscale(.7)' }} />
      {children}
      {!live && message ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#aaa', fontWeight: 700 }}>{message}</div>
      ) : null}
    </div>
  );
}
