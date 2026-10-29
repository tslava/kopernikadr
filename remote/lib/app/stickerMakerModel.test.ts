import { describe, expect, it } from 'vitest';
import { createOverlayStack } from './overlays';
import { armMakerBack, createRequestGate, noticeForPick, reduce, START, WIDE_MASK, type CutState, type MakerEvent, type MakerState } from './stickerMakerModel';

describe('createRequestGate', () => {
  it('only the newest request is current; invalidate makes all stale', () => {
    const g = createRequestGate();
    const a = g.begin();
    expect(g.current(a)).toBe(true);
    const b = g.begin(); // A cancelled, B requested while A still decodes
    expect(g.current(a)).toBe(false);
    expect(g.current(b)).toBe(true);
    g.invalidate();
    expect(g.current(b)).toBe(false);
  });
});

describe('armMakerBack', () => {
  const setup = (from: MakerState) => {
    const overlays = createOverlayStack();
    let s = from;
    const un = armMakerBack(overlays, () => s.step, () => { s = reduce(s, { type: 'cancel' }); });
    return { overlays, un, get s() { return s; } };
  };

  it('keeps the registration while Back only returns to the source step', () => {
    const t = setup({ step: 'style', style: 'naklejka', enhance: false, notice: null });
    expect(t.overlays.closeTop()).toBe(true);
    expect(t.s.step).toBe('source');
    expect(t.overlays.size).toBe(1); // the next Back must still reach the maker, not the picker below
    expect(t.overlays.closeTop()).toBe(true);
    expect(t.s.step).toBe('closed');
    expect(t.overlays.size).toBe(0);
  });

  it('keeps the registration when Back is ignored while saving', () => {
    const t = setup({ step: 'saving', style: 'naklejka', enhance: false });
    t.overlays.closeTop();
    expect(t.s.step).toBe('saving');
    expect(t.overlays.size).toBe(1);
  });

  it('unregisters the live registration on unmount', () => {
    const t = setup({ step: 'loading' });
    t.overlays.closeTop();
    expect(t.overlays.size).toBe(1);
    t.un();
    expect(t.overlays.size).toBe(0);
  });
});

const run = (events: MakerEvent[], from: MakerState = START): MakerState => events.reduce(reduce, from);

describe('sticker maker flow', () => {
  it('enhance: ON for a photo, OFF for transparent art; the toggle sticks through style change and save', () => {
    const photo = run([{ type: 'pick' }, { type: 'picked', hasAlpha: false }, { type: 'stroke', stroke: { mode: 'add', points: [[0.5, 0.5]] } }, { type: 'cutDone', coverage: 0.2, empty: false }, { type: 'next' }]);
    expect(photo).toMatchObject({ step: 'style', enhance: true });
    const art = run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }]);
    expect(art).toMatchObject({ step: 'style', enhance: false });
    const toggled = run([{ type: 'enhance', on: false }, { type: 'style', style: 'komiks' }], photo);
    expect(toggled).toMatchObject({ enhance: false, style: 'komiks' });
    expect(run([{ type: 'save' }], toggled)).toEqual({ step: 'saving', style: 'komiks', enhance: false });
    expect(reduce(START, { type: 'enhance', on: false })).toBe(START);
  });

  it('a picture with transparency goes source -> loading -> style -> saving -> done', () => {
    expect(run([{ type: 'pick' }])).toEqual({ step: 'loading' });
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }])).toEqual({ step: 'style', style: 'naklejka', enhance: false, notice: null });
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }, { type: 'style', style: 'komiks' }, { type: 'save' }])).toEqual({ step: 'saving', style: 'komiks', enhance: false });
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }, { type: 'save' }, { type: 'saved', id: 'x' }])).toEqual({ step: 'done', id: 'x' });
  });

  it('the camera shares the pick events: backing out is silent, no camera app says so', () => {
    const loading = run([{ type: 'pick' }]);
    expect(reduce(loading, { type: 'pickFailed', code: 'CANCELLED' })).toEqual({ step: 'source', notice: null });
    expect(reduce(loading, { type: 'pickFailed', code: 'NO_APP' })).toEqual({ step: 'source', notice: 'noApp' });
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }]).step).toBe('style');
  });

  it('picker errors return to the source step with a notice; backing out of the picker is silent', () => {
    const loading = run([{ type: 'pick' }]);
    expect(reduce(loading, { type: 'pickFailed', code: 'CANCELLED' })).toEqual({ step: 'source', notice: null });
    expect(reduce(loading, { type: 'pickFailed', code: 'NO_APP' })).toEqual({ step: 'source', notice: 'noApp' });
    expect(reduce(loading, { type: 'pickFailed', code: 'TOO_LARGE' })).toEqual({ step: 'source', notice: 'tooLarge' });
    expect(reduce(loading, { type: 'pickFailed', code: 'UNSUPPORTED' })).toEqual({ step: 'source', notice: 'unsupported' });
    expect(reduce(loading, { type: 'pickFailed' })).toEqual({ step: 'source', notice: 'failed' });
    expect(reduce(loading, { type: 'empty' })).toEqual({ step: 'source', notice: 'empty' });
    expect(noticeForPick('IO')).toBe('failed');
  });

  it('a failed save returns to the style step with the notice, keeping the style', () => {
    const saving = run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }, { type: 'style', style: 'komiks' }, { type: 'save' }]);
    expect(reduce(saving, { type: 'saveFailed', notice: 'full' })).toEqual({ step: 'style', style: 'komiks', enhance: false, notice: 'full' });
  });

  it('cancel goes one step back, closes from the source step and is ignored while saving', () => {
    expect(reduce(START, { type: 'cancel' })).toEqual({ step: 'closed' });
    expect(run([{ type: 'pick' }, { type: 'cancel' }])).toEqual(START);
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }, { type: 'cancel' }])).toEqual(START);
    const saving = run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }, { type: 'save' }]);
    expect(reduce(saving, { type: 'cancel' })).toBe(saving);
  });

  it('events of another step are ignored (a late picker result after cancel)', () => {
    expect(reduce(START, { type: 'picked', hasAlpha: true })).toBe(START);
    expect(reduce(START, { type: 'save' })).toBe(START);
    expect(reduce({ step: 'closed' }, { type: 'pick' })).toEqual({ step: 'closed' });
  });

  describe('cut step', () => {
    const tap = (x: number, y: number, mode: 'add' | 'erase' = 'add'): MakerEvent => ({ type: 'stroke', stroke: { mode, points: [[x, y]] } });
    const cut = (events: MakerEvent[] = []) => run([{ type: 'pick' }, { type: 'picked', hasAlpha: false }, ...events]) as CutState;

    it('a picture without transparency opens the cut step', () => {
      expect(cut()).toMatchObject({ step: 'cut', strokes: [], brush: 'add', busy: false, ready: false, notice: null });
    });

    it('a stroke starts a run; the result makes "Dalej" possible', () => {
      const s = cut([tap(0.5, 0.5)]);
      expect(s).toMatchObject({ busy: true, ready: false });
      expect(reduce(s, { type: 'next' })).toBe(s); // not while a run is in flight
      const done = reduce(s, { type: 'cutDone', coverage: 0.2, empty: false }) as CutState;
      expect(done).toMatchObject({ busy: false, ready: true, wide: false, notice: null });
      expect(reduce(done, { type: 'next' })).toEqual({ step: 'style', style: 'naklejka', enhance: true, notice: null }); // a photo: enhance ON
    });

    it('the brush is a toggle and strokes keep their order', () => {
      const s = cut([{ type: 'brush', brush: 'erase' }, tap(0.1, 0.1), tap(0.2, 0.2, 'erase')]);
      expect(s.brush).toBe('erase');
      expect(s.strokes.map((x) => x.mode)).toEqual(['add', 'erase']);
    });

    it('undo pops the last stroke and re-runs with the rest; with none left nothing is run', () => {
      const two = cut([tap(0.1, 0.1), tap(0.2, 0.2)]);
      const one = reduce(two, { type: 'undo' }) as CutState;
      expect(one.strokes).toEqual([two.strokes[0]]);
      expect(one.busy).toBe(true);
      const none = reduce(one, { type: 'undo' }) as CutState;
      expect(none).toMatchObject({ strokes: [], busy: false, ready: false });
      expect(reduce(none, { type: 'undo' })).toBe(none);
    });

    it('"Od nowa" drops every stroke and the old result', () => {
      const done = reduce(cut([tap(0.1, 0.1)]), { type: 'cutDone', coverage: 0.7, empty: false });
      expect(reduce(done, { type: 'reset' })).toMatchObject({ strokes: [], busy: false, ready: false, wide: false });
    });

    it('the hint shows only above the threshold', () => {
      const s = cut([tap(0.5, 0.5)]);
      expect(reduce(s, { type: 'cutDone', coverage: WIDE_MASK, empty: false })).toMatchObject({ wide: false });
      expect(reduce(s, { type: 'cutDone', coverage: WIDE_MASK + 0.01, empty: false })).toMatchObject({ wide: true });
      const wide = reduce(s, { type: 'cutDone', coverage: 0.9, empty: false });
      expect(reduce(wide, { type: 'undo' })).toMatchObject({ wide: false });
    });

    it('an empty mask says so and keeps "Dalej" off', () => {
      const s = reduce(cut([tap(0.5, 0.5)]), { type: 'cutDone', coverage: 0, empty: true }) as CutState;
      expect(s).toMatchObject({ notice: 'cutEmpty', ready: false, wide: false, busy: false });
      expect(reduce(s, { type: 'next' })).toBe(s);
    });

    it('a segmenter error stays in the cut step; retry runs the same strokes again', () => {
      const s = cut([tap(0.5, 0.5)]);
      const failed = reduce(s, { type: 'cutFailed' }) as CutState;
      expect(failed).toMatchObject({ step: 'cut', notice: 'cutFailed', busy: false, ready: false });
      expect(failed.strokes).toBe(s.strokes);
      const retry = reduce(failed, { type: 'retry' }) as CutState;
      expect(retry).toMatchObject({ busy: true, notice: null, attempt: 1 });
      expect(retry.strokes).toBe(s.strokes);
      expect(reduce(retry, { type: 'retry' })).toBe(retry); // already running
    });

    it('a stroke after a failure clears it; a late result of another step is ignored', () => {
      const failed = reduce(cut([tap(0.5, 0.5)]), { type: 'cutFailed' });
      expect((reduce(failed, tap(0.6, 0.6)) as CutState).notice).toBeNull();
      expect(reduce(cut(), { type: 'cutDone', coverage: 0.1, empty: false })).toMatchObject({ ready: false });
      expect(reduce(START, { type: 'cutFailed' })).toBe(START);
    });

    it('at most 50 strokes; cancel goes back to the source step', () => {
      const s = cut(Array.from({ length: 60 }, () => tap(0.5, 0.5)));
      expect(s.strokes).toHaveLength(50);
      expect(reduce(s, { type: 'cancel' })).toEqual(START);
    });
  });
});
