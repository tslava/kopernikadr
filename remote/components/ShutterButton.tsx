'use client';

/** The big round shutter. All feedback (sound, flash) is the parent's: it runs in `onPress`. */
export default function ShutterButton({ enabled, label, onPress }: { enabled: boolean; label: string; onPress: () => void }) {
  return (
    <button type="button" className="shutter" aria-label={label} title={label} disabled={!enabled} onClick={onPress}>
      <span className="shutter-ring" aria-hidden="true" />
    </button>
  );
}
