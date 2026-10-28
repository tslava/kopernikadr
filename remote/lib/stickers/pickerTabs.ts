/**
 * Tabs and the delete-confirm flow of the sticker picker. "Moje" (the kid's own stickers) is always
 * the first tab when a sticker library exists; the catalog categories follow in their order.
 */
export type PickerTab = { kind: 'mine' } | { kind: 'category'; index: number };

export function pickerTabs(categoryCount: number, hasLibrary: boolean): PickerTab[] {
  const tabs: PickerTab[] = hasLibrary ? [{ kind: 'mine' }] : [];
  for (let i = 0; i < categoryCount; i++) tabs.push({ kind: 'category', index: i });
  return tabs;
}

/** The sticker id a library sticker is placed with. */
export const customEmoji = (libraryId: string): string => `my:${libraryId}`;

/** "Usunąć naklejkę?": a plain tap on the ✕ asks first; only a confirm removes (the caller does it). */
export type DeleteAsk = { id: string } | null;
export type DeleteEvent = { type: 'ask'; id: string } | { type: 'cancel' } | { type: 'confirmed' };

export function deleteAsk(_s: DeleteAsk, e: DeleteEvent): DeleteAsk {
  return e.type === 'ask' ? { id: e.id } : null;
}
