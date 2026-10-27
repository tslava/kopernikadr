// Long-press helper for parent-only controls: fires once after `ms` of continuous holding;
// releasing or cancelling earlier (finger left, scroll) does nothing.
export const LONG_PRESS_MS = 1500;
/** A real finger drifts while held: moving less than this (CSS px) keeps the hold going. */
export const LONG_PRESS_SLOP_PX = 24;

export const beyondSlop = (dx: number, dy: number, slop: number = LONG_PRESS_SLOP_PX): boolean =>
  dx * dx + dy * dy > slop * slop;

export interface LongPress {
  start(): void;
  cancel(): void;
}

export function createLongPress(onLongPress: () => void, ms: number = LONG_PRESS_MS): LongPress {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (handle !== undefined) clearTimeout(handle);
    handle = undefined;
  };
  return {
    start() {
      cancel();
      handle = setTimeout(() => {
        handle = undefined;
        onLongPress();
      }, ms);
    },
    cancel,
  };
}
