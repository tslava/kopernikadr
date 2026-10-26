import { makeTranslator, pickLang } from '@kopernikadr/remote-core/i18n-core';
import { pl } from './pl';
import { ru } from './ru';

export type Key = keyof typeof pl;
/** A plural entry: Intl.PluralRules categories, `other` required. */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
/** A language table: every key of `pl`, each a string or a plural entry. */
export type Strings = { readonly [K in Key]: string | Plural };
export type Translate = (key: Key, params?: Record<string, unknown>) => string;

export const LANGS = ['pl', 'ru'] as const;
export type Lang = (typeof LANGS)[number];
export const FALLBACK: Lang = 'pl';
export const STRINGS: Record<Lang, Strings> = { pl, ru };

/** Picks the language from e.g. navigator.languages (fallback `pl`) and returns its translator. */
export function translatorFor(languages?: readonly string[] | string): { lang: Lang; t: Translate } {
  const lang = pickLang(languages, LANGS, FALLBACK) as Lang;
  return { lang, t: makeTranslator(STRINGS, lang, FALLBACK) };
}
