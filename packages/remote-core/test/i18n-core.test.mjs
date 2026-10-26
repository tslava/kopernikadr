import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLang, makeTranslator } from '../src/i18n-core.js';

const STRINGS = {
  pl: {
    frames: { one: '{n} klatka', few: '{n} klatki', many: '{n} klatek', other: '{n} klatki' },
    saving: 'Zapisuję… {i}/{n}',
    onlyPl: 'tylko po polsku',
  },
  ru: {
    frames: { one: '{n} кадр', few: '{n} кадра', many: '{n} кадров', other: '{n} кадра' },
    saving: 'Сохраняю… {i}/{n}',
  },
};
const LANGS = Object.keys(STRINGS);

test('pickLang: first known base subtag, else the fallback', () => {
  assert.equal(pickLang(['ru-RU', 'en'], LANGS, 'pl'), 'ru');
  assert.equal(pickLang(['en-US', 'pl-PL'], LANGS, 'pl'), 'pl');
  assert.equal(pickLang(['en-US'], LANGS, 'pl'), 'pl');
  assert.equal(pickLang('RU_ru', LANGS, 'pl'), 'ru');
  assert.equal(pickLang(undefined, LANGS, 'pl'), 'pl');
  assert.equal(pickLang([], LANGS, 'pl'), 'pl');
  assert.equal(pickLang(['constructor', 'toString'], LANGS, 'pl'), 'pl', 'no prototype keys');
  assert.equal(pickLang(['en'], ['en', 'pl'], 'pl'), 'en');
});

test('makeTranslator: plural rules per language, params, fallbacks', () => {
  const pl = makeTranslator(STRINGS, 'pl', 'pl');
  const ru = makeTranslator(STRINGS, 'ru', 'pl');
  assert.deepEqual([1, 2, 5, 22, 0].map((n) => pl('frames', { n })), ['1 klatka', '2 klatki', '5 klatek', '22 klatki', '0 klatek']);
  assert.deepEqual([1, 3, 11, 21, 1.5].map((n) => ru('frames', { n })), ['1 кадр', '3 кадра', '11 кадров', '21 кадр', '1.5 кадра']);
  assert.equal(pl('saving', { i: 12, n: 80 }), 'Zapisuję… 12/80');
  assert.equal(pl('saving', { i: 1 }), 'Zapisuję… 1/{n}', 'a missing param stays as is');
  assert.equal(ru('onlyPl'), 'tylko po polsku', 'missing key → fallback language');
  assert.equal(ru('nope'), 'nope', 'unknown key → the key');
  assert.equal(ru('constructor'), 'constructor', 'no prototype keys');
  const xx = makeTranslator(STRINGS, 'xx', 'pl');
  assert.equal(xx('frames', { n: 5 }), '5 klatek', 'unknown language → fallback table and rules');
});
