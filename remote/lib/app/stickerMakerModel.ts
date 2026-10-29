/**
 * The StickerMaker flow as a pure state machine (plan "Photo stickers", Task 5):
 * `source -> loading -> [cut ->] style -> saving -> done`, with cancel and an error at each step.
 * The cut step is only for an image without transparency (Task 9); auto-enhance is ON for photos, OFF for finished transparent art: strokes are kept here, the mask
 * and the preview pixels live in the component (big arrays stay out of the reducer).
 */
import type { NativeErrorCode } from '../native';
import { MAX_STROKES } from '../stickers/cutGeometry';
import type { SegStrokeArg } from '../stickers/segClient';
import type { StickerStyle } from '../stickers/stickerize';

/** What the kid sees as a one-line notice on the source or style step. */
export type MakerNotice = 'noApp' | 'tooLarge' | 'unsupported' | 'failed' | 'empty' | 'full' | 'cutEmpty' | 'cutFailed';

export type MakerState =
  | { step: 'source'; notice: MakerNotice | null }
  | { step: 'loading' }
  | CutState
  | { step: 'style'; style: StickerStyle; enhance: boolean; notice: MakerNotice | null }
  | { step: 'saving'; style: StickerStyle; enhance: boolean }
  | { step: 'done'; id: string }
  | { step: 'closed' };

export type Brush = 'add' | 'erase';

export interface CutState {
  step: 'cut';
  /** Every stroke so far, in order; the whole list goes to the segmenter on each run. */
  strokes: SegStrokeArg[];
  brush: Brush;
  /** A run is wanted or in flight for the current strokes. */
  busy: boolean;
  /** The last run for the current strokes produced a visible cut-out ("Dalej" is possible). */
  ready: boolean;
  /** The cut-out covers > [WIDE_MASK] of the picture: show "drag over the toy". */
  wide: boolean;
  /** Bumped by `retry`, so the component re-runs the same strokes. */
  attempt: number;
  notice: 'cutEmpty' | 'cutFailed' | null;
}

export type MakerEvent =
  | { type: 'pick' }
  /** The picked image is decoded; `hasAlpha` = it already has transparency (no cut-out needed). */
  | { type: 'picked'; hasAlpha: boolean }
  /** The picker or the decoding failed; `code` is the native error code when there is one. */
  | { type: 'pickFailed'; code?: NativeErrorCode }
  /** The image is decoded but nothing is visible in it. */
  | { type: 'empty' }
  /** A finished brush stroke (a tap is a one-point stroke); starts a run. */
  | { type: 'stroke'; stroke: SegStrokeArg }
  /** "Cofnij": pops the last stroke. */
  | { type: 'undo' }
  /** "Od nowa": drops every stroke. */
  | { type: 'reset' }
  | { type: 'brush'; brush: Brush }
  /** The latest run finished; `empty` = no pixel passed the threshold, `coverage` = share of the picture (0..1). */
  | { type: 'cutDone'; coverage: number; empty: boolean }
  /** The latest run failed (an error from the segmenter); the strokes stay, `retry` runs them again. */
  | { type: 'cutFailed' }
  | { type: 'retry' }
  /** "Dalej": cut -> style. */
  | { type: 'next' }
  | { type: 'style'; style: StickerStyle }
  /** The "Popraw" chip: auto-enhance on/off. */
  | { type: 'enhance'; on: boolean }
  | { type: 'save' }
  | { type: 'saved'; id: string }
  | { type: 'saveFailed'; notice: 'empty' | 'full' | 'failed' }
  /** One step back: cut, style or loading -> source, source -> closed. Ignored while saving. */
  | { type: 'cancel' };

export const START: MakerState = { step: 'source', notice: null };

/**
 * Request-generation token for the picks: each pick `begin`s a new generation, a request that finds
 * `current(token)` false after any await is stale (cancelled or replaced) and must not touch the state.
 */
export function createRequestGate(): { begin(): number; current(token: number): boolean; invalidate(): void } {
  let n = 0;
  return {
    begin: () => ++n,
    current: (token) => token === n,
    invalidate: () => void n++,
  };
}

/**
 * Android Back for the maker: `closeTop` pops the registration before it calls us, so we arm again
 * unless this Back really closes the maker (cancel on the source step, or already closed). Cancelling
 * a deeper step, or Back while saving (ignored by the model), keeps the maker on top of the picker.
 * Returns the unregister function of whichever registration is live.
 */
export function armMakerBack(
  overlays: { push(close: () => void): () => void },
  step: () => MakerState['step'],
  cancel: () => void,
): () => void {
  let unregister = () => {};
  const arm = () => {
    unregister = overlays.push(() => {
      const closing = step() === 'source' || step() === 'closed' || step() === 'done';
      cancel();
      if (!closing) arm();
    });
  };
  arm();
  return () => unregister();
}

/** A share of the picture above which the segmenter probably took the whole sheet. */
export const WIDE_MASK = 0.55;

const CUT_START: CutState = { step: 'cut', strokes: [], brush: 'add', busy: false, ready: false, wide: false, attempt: 0, notice: null };

/** The strokes changed: a run is due when there are strokes, otherwise the preview is cleared. */
function withStrokes(s: CutState, strokes: SegStrokeArg[]): CutState {
  return { ...s, strokes, busy: strokes.length > 0, ready: false, wide: false, notice: null };
}

/** The notice for a failed pick; `CANCELLED` is the kid backing out and says nothing. */
export function noticeForPick(code: NativeErrorCode | undefined): MakerNotice | null {
  switch (code) {
    case 'CANCELLED': return null;
    case 'NO_APP': return 'noApp';
    case 'TOO_LARGE': return 'tooLarge';
    case 'UNSUPPORTED': return 'unsupported';
    default: return 'failed';
  }
}

export function reduce(s: MakerState, e: MakerEvent): MakerState {
  switch (e.type) {
    case 'pick':
      return s.step === 'source' ? { step: 'loading' } : s;
    case 'picked':
      if (s.step !== 'loading') return s;
      return e.hasAlpha ? { step: 'style', style: 'naklejka', enhance: false, notice: null } : CUT_START;
    case 'pickFailed':
      return s.step === 'loading' ? { step: 'source', notice: noticeForPick(e.code) } : s;
    case 'empty':
      return s.step === 'loading' ? { step: 'source', notice: 'empty' } : s;
    case 'stroke':
      return s.step === 'cut' && s.strokes.length < MAX_STROKES ? withStrokes(s, [...s.strokes, e.stroke]) : s;
    case 'undo':
      return s.step === 'cut' && s.strokes.length > 0 ? withStrokes(s, s.strokes.slice(0, -1)) : s;
    case 'reset':
      return s.step === 'cut' && s.strokes.length > 0 ? withStrokes(s, []) : s;
    case 'brush':
      return s.step === 'cut' ? { ...s, brush: e.brush } : s;
    case 'cutDone':
      if (s.step !== 'cut' || !s.busy) return s;
      return { ...s, busy: false, ready: !e.empty, wide: !e.empty && e.coverage > WIDE_MASK, notice: e.empty ? 'cutEmpty' : null };
    case 'cutFailed':
      return s.step === 'cut' && s.busy ? { ...s, busy: false, ready: false, wide: false, notice: 'cutFailed' } : s;
    case 'retry':
      return s.step === 'cut' && s.strokes.length > 0 && !s.busy ? { ...s, busy: true, notice: null, attempt: s.attempt + 1 } : s;
    case 'next':
      return s.step === 'cut' && s.ready && !s.busy ? { step: 'style', style: 'naklejka', enhance: true, notice: null } : s;
    case 'style':
      return s.step === 'style' ? { ...s, style: e.style } : s;
    case 'enhance':
      return s.step === 'style' ? { ...s, enhance: e.on } : s;
    case 'save':
      return s.step === 'style' ? { step: 'saving', style: s.style, enhance: s.enhance } : s;
    case 'saved':
      return s.step === 'saving' ? { step: 'done', id: e.id } : s;
    case 'saveFailed':
      return s.step === 'saving' ? { step: 'style', style: s.style, enhance: s.enhance, notice: e.notice } : s;
    case 'cancel':
      if (s.step === 'source') return { step: 'closed' };
      if (s.step === 'style' || s.step === 'loading' || s.step === 'cut') return { step: 'source', notice: null };
      return s;
  }
}
