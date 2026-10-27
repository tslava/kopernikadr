// Long-press helper for parent-only controls: fires once after `ms` of continuous holding;
// releasing or cancelling earlier (finger left, scroll) does nothing.
export const LONG_PRESS_MS = 1500;

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
