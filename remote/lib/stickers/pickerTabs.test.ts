import { describe, expect, it } from 'vitest';
import { isCustomSticker } from '../projects/model';
import { customEmoji, deleteAsk, pickerTabs, type DeleteAsk } from './pickerTabs';

describe('pickerTabs', () => {
  it('"Moje" is always the first tab, the categories follow in order', () => {
    expect(pickerTabs(3, true)).toEqual([{ kind: 'mine' }, { kind: 'category', index: 0 }, { kind: 'category', index: 1 }, { kind: 'category', index: 2 }]);
  });

  it('without a library there is no "Moje" tab', () => {
    expect(pickerTabs(2, false)).toEqual([{ kind: 'category', index: 0 }, { kind: 'category', index: 1 }]);
    expect(pickerTabs(0, false)).toEqual([]);
  });
});

describe('customEmoji', () => {
  it('a library id becomes a valid `my:` sticker id', () => {
    expect(isCustomSticker(customEmoji('0123abcd-0123-4abc-8abc-0123456789ab'))).toBe(true);
    expect(customEmoji('x')).toBe('my:x');
  });
});

describe('delete confirm', () => {
  it('a tap on ✕ asks; cancel and confirm both close the dialog', () => {
    const asked = deleteAsk(null, { type: 'ask', id: 'a' });
    expect(asked).toEqual({ id: 'a' });
    expect(deleteAsk(asked, { type: 'cancel' })).toBeNull();
    expect(deleteAsk(asked, { type: 'confirmed' })).toBeNull();
  });

  it('asking about another sticker replaces the pending one', () => {
    const s: DeleteAsk = { id: 'a' };
    expect(deleteAsk(s, { type: 'ask', id: 'b' })).toEqual({ id: 'b' });
  });
});
