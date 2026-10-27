'use client';

import { badge } from '@/lib/app/connectModel';
import type { Translate } from '@/lib/i18n';
import type { CameraClient } from '@/lib/camera/client';
import { useStore } from '@/lib/state/useStore';

/** Camera connection status: a coloured dot + a short word. */
export default function ConnectionBadge({ t, client }: { t: Translate; client: CameraClient }) {
  const b = badge(useStore(client.store));
  return (
    <span className={`conn-badge ${b.tone}`} role="status">
      <span className="dot" aria-hidden="true" />
      {t(b.key)}
    </span>
  );
}
