// Language pick and translator over an app's own string tables. Plural entries are objects keyed
// by Intl.PluralRules categories ({one, few, many, other}); `{name}` placeholders are filled from
// the params. Each app keeps its own STRINGS ({[lang]: {[key]: string | plural object}}).

/**
 * The first entry of `languages` (e.g. navigator.languages) whose base subtag is in `available`,
 * else `fallback`.
 * @param {readonly string[] | string | undefined} languages
 * @param {readonly string[]} available
 * @param {string} fallback
 * @returns {string}
 */
export function pickLang(languages, available, fallback) {
  const list = Array.isArray(languages) ? languages : [languages];
  for (const l of list) {
    const base = String(l ?? '').toLowerCase().split(/[-_]/)[0];
    if (available.includes(base)) return base;
  }
  return fallback;
}

/**
 * Returns `t(key, params)`; `params.n` also selects the plural form. A key missing in `lang`
 * falls back to `strings[fallback]`, then to the key itself; an unknown `lang` uses `fallback`.
 * @param {Record<string, Record<string, string | Record<string, string>>>} strings
 * @param {string} lang
 * @param {string} fallback
 * @returns {(key: string, params?: Record<string, unknown>) => string}
 */
export function makeTranslator(strings, lang, fallback) {
  const known = Object.hasOwn(strings, lang);
  const table = known ? strings[lang] : strings[fallback];
  const base = strings[fallback] ?? {};
  const rules = new Intl.PluralRules(known ? lang : fallback);
  return function t(key, params = {}) {
    let s = (Object.hasOwn(table, key) ? table[key] : undefined) ?? (Object.hasOwn(base, key) ? base[key] : undefined) ?? key;
    if (typeof s === 'object') s = s[rules.select(Number(params.n ?? 0))] ?? s.other;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  };
}
