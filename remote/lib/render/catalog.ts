/**
 * Typed loader for `public/openmoji/catalog.json` (written by scripts/openmoji-subset.mjs):
 * the curated emoji categories shown in the sticker picker. A malformed catalog throws: it is a
 * build artifact, not user data.
 */
import type { Lang } from '../i18n';
import { isCustomSticker } from '../projects/model';

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

/** Store-relative path of a custom sticker's copy in its movie; null for an invalid id. */
export function customStickerPath(projectId: string, emoji: string): string | null {
  return isCustomSticker(emoji) ? `projects/${projectId}/stickers/${emoji.slice(3)}.webp` : null;
}

/** emoji -> image url; null = unknown sprite (an invalid custom id). */
export type SpriteUrlOf = (emoji: string) => string | null;

/** Hexcodes give the OpenMoji SVG; a custom id has no url without a project (use `projectSpriteUrlOf`). */
export const openmojiUrlOf: SpriteUrlOf = (emoji) => (emoji.startsWith('my:') ? null : spriteUrl(emoji));

/** `urlOf` for one movie: a custom id resolves to the movie's own copy under `baseUri` (the file uri of `kopernikadr/`). */
export function projectSpriteUrlOf(projectId: string, baseUri: string, convertFileSrc: (uri: string) => string): SpriteUrlOf {
  const base = baseUri.replace(/\/+$/, '');
  return (emoji) => {
    if (!emoji.startsWith('my:')) return spriteUrl(emoji);
    const path = customStickerPath(projectId, emoji);
    return path === null ? null : convertFileSrc(`${base}/${path}`);
  };
}

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
    if (!isObj(name) || !nonEmpty(name.en) || !nonEmpty(name.pl) || !nonEmpty(name.ru)) throw new Error(`catalog: category ${c.id} needs en, pl and ru names`);
    if (!Array.isArray(c.hexcodes) || c.hexcodes.length === 0) throw new Error(`catalog: category ${c.id} is empty`);
    for (const h of c.hexcodes) {
      if (!nonEmpty(h)) throw new Error(`catalog: bad hexcode in ${c.id}`);
      if (seen.has(h)) throw new Error(`catalog: duplicate hexcode ${h}`);
      seen.add(h);
    }
    return { id: c.id, name: { en: name.en, pl: name.pl, ru: name.ru }, hexcodes: [...(c.hexcodes as string[])] };
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
