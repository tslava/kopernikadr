'use client';

import { useEffect, useState } from 'react';
import { FALLBACK, translatorFor } from './index';

/**
 * The translator for the device language. The static export is prerendered with the fallback
 * (`pl`); the real language is picked after mount, when `navigator` exists.
 */
export function useTranslator() {
  const [tr, setTr] = useState(() => translatorFor(FALLBACK));
  useEffect(() => {
    const next = translatorFor(navigator.languages);
    if (next.lang !== FALLBACK) setTr(next);
    document.documentElement.lang = next.lang;
  }, []);
  return tr;
}
