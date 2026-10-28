/**
 * The StickerMaker flow as a pure state machine (plan "Photo stickers", Task 5):
 * `source -> loading -> style -> saving -> done`, with cancel and an error at each step.
 * The cut step (an image without transparency) comes in Task 9; until then such an image shows the
 * notice "soon" and returns to the source step.
 */
import type { NativeErrorCode } from '../native';
import type { StickerStyle } from '../stickers/stickerize';

/** What the kid sees as a one-line notice on the source or style step. */
export type MakerNotice = 'soon' | 'noApp' | 'tooLarge' | 'unsupported' | 'failed' | 'empty' | 'full';

export type MakerState =
  | { step: 'source'; notice: MakerNotice | null }
  | { step: 'loading' }
  | { step: 'style'; style: StickerStyle; notice: MakerNotice | null }
  | { step: 'saving'; style: StickerStyle }
  | { step: 'done'; id: string }
  | { step: 'closed' };

export type MakerEvent =
  | { type: 'pick' }
  /** The picked image is decoded; `hasAlpha` = it already has transparency (no cut-out needed). */
  | { type: 'picked'; hasAlpha: boolean }
  /** The picker or the decoding failed; `code` is the native error code when there is one. */
  | { type: 'pickFailed'; code?: NativeErrorCode }
  /** The image is decoded but nothing is visible in it. */
  | { type: 'empty' }
  | { type: 'style'; style: StickerStyle }
  | { type: 'save' }
  | { type: 'saved'; id: string }
  | { type: 'saveFailed'; notice: 'empty' | 'full' | 'failed' }
  /** One step back: style or loading -> source, source -> closed. Ignored while saving. */
  | { type: 'cancel' };

export const START: MakerState = { step: 'source', notice: null };

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
      return e.hasAlpha ? { step: 'style', style: 'naklejka', notice: null } : { step: 'source', notice: 'soon' };
    case 'pickFailed':
      return s.step === 'loading' ? { step: 'source', notice: noticeForPick(e.code) } : s;
    case 'empty':
      return s.step === 'loading' ? { step: 'source', notice: 'empty' } : s;
    case 'style':
      return s.step === 'style' ? { ...s, style: e.style } : s;
    case 'save':
      return s.step === 'style' ? { step: 'saving', style: s.style } : s;
    case 'saved':
      return s.step === 'saving' ? { step: 'done', id: e.id } : s;
    case 'saveFailed':
      return s.step === 'saving' ? { step: 'style', style: s.style, notice: e.notice } : s;
    case 'cancel':
      if (s.step === 'source') return { step: 'closed' };
      if (s.step === 'style' || s.step === 'loading') return { step: 'source', notice: null };
      return s;
  }
}
