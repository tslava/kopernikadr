'use client';

import { ONION_OPACITY_MAX, ONION_OPACITY_MIN, onionOpacityValue, type OnionSource } from '@/lib/camera/onion';

const overlay = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' } as const;

/** Overlay of the last local frame over the preview (place inside the Preview stage). */
export default function OnionSkin({
  source,
  enabled,
  opacity,
  grid = false,
  onError,
}: {
  /** From selectOnionSource; null = "no frames yet" (nothing is drawn). */
  source: OnionSource;
  enabled: boolean;
  /** Slider percent, 10..80. */
  opacity: number;
  /** The 3x3 composition grid (a separate, parent-owned toggle). */
  grid?: boolean;
  /** The image failed to load (e.g. the file vanished): the parent can re-select. */
  onError?: () => void;
}) {
  return (
    <>
      {enabled && source ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={source.url}
          src={source.url}
          alt=""
          draggable={false}
          onError={onError}
          style={{ ...overlay, objectFit: 'contain', opacity: onionOpacityValue(opacity) }}
        />
      ) : null}
      {grid ? (
        <svg style={overlay} viewBox="0 0 3 3" preserveAspectRatio="none" aria-hidden="true">
          <path d="M1 0V3M2 0V3M0 1H3M0 2H3" stroke="rgba(255,255,255,.55)" strokeWidth="0.012" vectorEffect="non-scaling-stroke" fill="none" />
        </svg>
      ) : null}
    </>
  );
}

/** Toggle + opacity slider, as in remote-lite. With no source ("no frames yet") both are disabled. */
export function OnionControls({
  source,
  enabled,
  opacity,
  onEnabledChange,
  onOpacityChange,
  labels,
}: {
  source: OnionSource;
  enabled: boolean;
  opacity: number;
  onEnabledChange: (on: boolean) => void;
  onOpacityChange: (percent: number) => void;
  labels: { toggle: string; opacity: string; noFrames: string };
}) {
  const none = source === null;
  return (
    <div className="onion-ctl" data-empty={none}>
      <button type="button" className={`pill-btn${enabled ? ' on' : ''}`} aria-pressed={enabled} disabled={none} onClick={() => onEnabledChange(!enabled)}>
        {none ? labels.noFrames : labels.toggle}
      </button>
      <input
        type="range"
        min={ONION_OPACITY_MIN}
        max={ONION_OPACITY_MAX}
        step={5}
        value={opacity}
        aria-label={labels.opacity}
        disabled={none || !enabled}
        onChange={(e) => onOpacityChange(Number(e.target.value))}
      />
    </div>
  );
}
