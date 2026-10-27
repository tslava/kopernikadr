'use client';

import { useState } from 'react';
import type { AppContext } from '@/lib/app/boot';
import type { PreviewQuality } from '@/lib/camera/previewController';
import type { TransferStatusInfo } from '@/lib/app/drawerModel';
import type { Translate } from '@/lib/i18n';
import { useStore } from '@/lib/state/useStore';
import { createStore, type Store } from '@/lib/state/store';
import Icon from './Icon';
import LongPressButton from './LongPressButton';
import ParentDrawer from './ParentDrawer';

type QueueStatus = { queued: number; unavailable: number };

/** Stand-in while the app runs without the real Transfer service (it has no status store). */
const EMPTY: Store<QueueStatus> = createStore<QueueStatus>({ queued: 0, unavailable: 0 });

/** The capture view's parent corner: a long-press wrench that opens the parent drawer. */
export default function CaptureDrawer({
  t, app, projectId, quality, onQuality, grid, onGrid,
}: {
  t: Translate;
  app: AppContext;
  projectId: string;
  quality: PreviewQuality;
  onQuality: (q: PreviewQuality) => void;
  grid: boolean;
  onGrid: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const statusStore = (app.transfer as { status?: Store<QueueStatus> }).status ?? null;
  const status = useStore(statusStore ?? EMPTY);
  const transferStatus: TransferStatusInfo | undefined = statusStore ? { queued: status.queued, failed: status.unavailable } : undefined;
  return (
    <>
      <LongPressButton className="icon-btn" label={t('drawer.title')} onLongPress={() => setOpen(true)}>
        <Icon name="wrench" />
      </LongPressButton>
      {open ? (
        <ParentDrawer
          client={app.client}
          store={app.store}
          projectId={projectId}
          transferStatus={transferStatus}
          onClose={() => setOpen(false)}
          previewQuality={quality}
          onPreviewQuality={onQuality}
          grid={grid}
          onGrid={onGrid}
        />
      ) : null}
    </>
  );
}

