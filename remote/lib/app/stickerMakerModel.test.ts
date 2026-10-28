import { describe, expect, it } from 'vitest';
import { noticeForPick, reduce, START, type MakerEvent, type MakerState } from './stickerMakerModel';

const run = (events: MakerEvent[], from: MakerState = START): MakerState => events.reduce(reduce, from);

describe('sticker maker flow', () => {
  it('a picture with transparency goes source -> loading -> style -> saving -> done', () => {
    expect(run([{ type: 'pick' }])).toEqual({ step: 'loading' });
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }])).toEqual({ step: 'style', style: 'naklejka', notice: null });
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }, { type: 'style', style: 'komiks' }, { type: 'save' }])).toEqual({ step: 'saving', style: 'komiks' });
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: true }, { type: 'save' }, { type: 'saved', id: 'x' }])).toEqual({ step: 'done', id: 'x' });
  });

  it('a picture without transparency shows "soon" and returns to the source step', () => {
    expect(run([{ type: 'pick' }, { type: 'picked', hasAlpha: false }])).toEqual({ step: 'source', notice: 'soon' });
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
    expect(reduce(saving, { type: 'saveFailed', notice: 'full' })).toEqual({ step: 'style', style: 'komiks', notice: 'full' });
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
});
