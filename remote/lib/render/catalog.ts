/**
 * Typed loader for `public/openmoji/catalog.json` (written by scripts/openmoji-subset.mjs):
 * the curated emoji categories shown in the sticker picker. A malformed catalog throws: it is a
 * build artifact, not user data.
 */
import type { Lang } from '../i18n';

export interface EmojiCategory {
  id: string;
  name: Record<Lang, string>;
  /** OpenMoji hexcodes, e.g. "1F436"; each has `public/openmoji/<hexcode>.svg`. */
  hexcodes: string[];
}

export interface EmojiCatalog {
  categories: EmojiCategory[];
}

export const OPENMOJI_DIR = '/openmoji';
export const CATALOG_URL = `${OPENMOJI_DIR}/catalog.json`;

export const spriteUrl = (hexcode: string): string => `${OPENMOJI_DIR}/${hexcode}.svg`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function parseCatalog(raw: unknown): EmojiCatalog {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.categories) || raw.categories.length === 0) throw new Error('catalog: bad shape');
  const ids = new Set<string>();
  const seen = new Set<string>();
  const categories = raw.categories.map((c: unknown): EmojiCategory => {
    if (!isObj(c) || !nonEmpty(c.id)) throw new Error('catalog: category without id');
    if (ids.has(c.id)) throw new Error(`catalog: duplicate category ${c.id}`);
    ids.add(c.id);
    const name = c.name;
    if (!isObj(name) || !nonEmpty(name.pl) || !nonEmpty(name.ru)) throw new Error(`catalog: category ${c.id} needs pl and ru names`);
    if (!Array.isArray(c.hexcodes) || c.hexcodes.length === 0) throw new Error(`catalog: category ${c.id} is empty`);
    for (const h of c.hexcodes) {
      if (!nonEmpty(h)) throw new Error(`catalog: bad hexcode in ${c.id}`);
      if (seen.has(h)) throw new Error(`catalog: duplicate hexcode ${h}`);
      seen.add(h);
    }
    return { id: c.id, name: { pl: name.pl, ru: name.ru }, hexcodes: [...(c.hexcodes as string[])] };
  });
  return { categories };
}

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  return res.json();
};

let cached: Promise<EmojiCatalog> | undefined;

/** Loads and validates the catalog once; a failure is not cached, so the picker can retry. */
export function loadCatalog(fetchJson: FetchJson = defaultFetchJson): Promise<EmojiCatalog> {
  if (!cached) {
    cached = fetchJson(CATALOG_URL).then(parseCatalog);
    cached.catch(() => {
      cached = undefined;
    });
  }
  return cached;
}

/** Test seam: forget the cached catalog. */
export function resetCatalogCache(): void {
  cached = undefined;
}
