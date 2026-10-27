// A tiny stack of open overlays (parent drawer, export dialog, rename dialog) so the Android Back
// button closes the topmost one before it navigates. No React here.
export interface OverlayStack {
  /** Registers an overlay; returns its (idempotent) unregister function. */
  push(close: () => void): () => void;
  /** Closes the topmost overlay; false when none is open. */
  closeTop(): boolean;
  readonly size: number;
}

export function createOverlayStack(): OverlayStack {
  const stack: Array<{ close: () => void }> = [];
  return {
    push(close) {
      const entry = { close };
      stack.push(entry);
      return () => {
        const i = stack.indexOf(entry);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    closeTop() {
      const top = stack.pop();
      if (!top) return false;
      top.close();
      return true;
    },
    get size() {
      return stack.length;
    },
  };
}
