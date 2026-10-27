'use client';

import { useEffect, useState } from 'react';
import type { Key, Translate } from '@/lib/i18n';

/**
 * The Undo toast shared by project delete and frame delete: a message and a countdown button,
 * driven by the persisted deadline. Past its deadline the window is over (Undo would be refused),
 * so it renders nothing.
 */
export default function UndoToast({ t, message, deadline, label, onUndo }: {
  t: Translate;
  message: string;
  /** ISO time the Undo window closes. */
  deadline: string;
  /** i18n key of the button text; it gets `{s}` seconds left. */
  label: Key;
  onUndo: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const h = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(h);
  }, [deadline]);
  const end = Date.parse(deadline);
  if (end <= now) return null;
  return (
    <div className="undo-toast" role="status">
      <span>{message}</span>
      <button type="button" className="primary" onClick={onUndo}>{t(label, { s: Math.max(0, Math.ceil((end - now) / 1000)) })}</button>
    </div>
  );
}
