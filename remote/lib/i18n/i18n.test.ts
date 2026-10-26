import { describe, expect, it } from 'vitest';
import { FALLBACK, LANGS, STRINGS, translatorFor } from './index';

describe('i18n tables', () => {
  it('every language has exactly the keys of pl', () => {
    const plKeys = Object.keys(STRINGS.pl).sort();
    for (const lang of LANGS) expect(Object.keys(STRINGS[lang]).sort(), lang).toEqual(plKeys);
  });

  it('plural entries are plural in every language and have `other`', () => {
    for (const [key, v] of Object.entries(STRINGS.pl)) {
      for (const lang of LANGS) {
        const w = STRINGS[lang][key as keyof typeof STRINGS.pl];
        expect(typeof w, `${lang}:${key}`).toBe(typeof v);
        if (typeof w === 'object') expect(w.other, `${lang}:${key}.other`).toBeTypeOf('string');
      }
    }
  });

  it('placeholders match across languages', () => {
    const names = (v: unknown) => [...JSON.stringify(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, v] of Object.entries(STRINGS.pl)) {
      const want = [...new Set(names(v))];
      for (const lang of LANGS) {
        const got = [...new Set(names(STRINGS[lang][key as keyof typeof STRINGS.pl]))];
        expect(got, `${lang}:${key}`).toEqual(want);
      }
    }
  });
});

describe('translatorFor', () => {
  it('picks the language from navigator.languages, falling back to pl', () => {
    expect(translatorFor(['ru-RU', 'en']).lang).toBe('ru');
    expect(translatorFor(['en-US', 'de']).lang).toBe(FALLBACK);
    expect(translatorFor(undefined).lang).toBe('pl');
    expect(translatorFor(['de', 'pl-PL']).t('home.connect')).toBe('Połącz z kamerą');
  });

  it('selects Polish and Russian plural forms', () => {
    const { t: tpl } = translatorFor('pl');
    expect([1, 2, 5, 22, 25].map((n) => tpl('diag.count', { n }))).toEqual([
      '1 test', '2 testy', '5 testów', '22 testy', '25 testów',
    ]);
    const { t: tru } = translatorFor('ru');
    expect([1, 3, 5, 21].map((n) => tru('diag.count', { n }))).toEqual([
      '1 тест', '3 теста', '5 тестов', '21 тест',
    ]);
  });
});
