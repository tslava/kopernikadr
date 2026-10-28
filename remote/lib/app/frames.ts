// URLs of local frame files for the WebView (onion skin, playback, export). A frame has a file
// only while it is `local`; `known absent` files (an <img> failed to load) are remembered so the
// onion skin can fall back (play -> thumb) instead of retrying forever.
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { useEffect, useState } from 'react';
import type { ProjectStore } from '../projects/store';
import { ROOT } from '../projects/files';
import { projectSpriteUrlOf, type SpriteUrlOf } from '../render/catalog';

export type FrameFileKind = 'play' | 'thumb' | 'full';
export type FrameUrlFn = (projectId: string, frameId: string, kind: FrameFileKind) => string | null;

export interface FrameUrls {
  url: FrameUrlFn;
  /** The file failed to load: `url` returns null for it from now on. */
  markAbsent(projectId: string, frameId: string, kind: FrameFileKind): void;
  /** Sprite urls of one movie (OpenMoji, and the movie's own copies of custom stickers). */
  spriteUrlOf(projectId: string): SpriteUrlOf;
}

export const framePath = (projectId: string, frameId: string, kind: FrameFileKind): string =>
  `projects/${projectId}/frames/${frameId}.${kind}.jpg`;

export interface FrameUrlDeps {
  /** The file uri of `kopernikadr/` (resolved once by the caller). Frame uris are `${base}/${path}`. */
  baseUri: string;
  convertFileSrc?: (uri: string) => string;
  now?: () => number;
}

/** How long a failed file load hides that file before it is tried again. */
export const ABSENT_TTL_MS = 10_000;

/** Pure part: the store gives the frame state, `baseUri` the root. */
export function createFrameUrls(store: Pick<ProjectStore, 'state'>, deps: FrameUrlDeps): FrameUrls {
  const convert = deps.convertFileSrc ?? ((u) => Capacitor.convertFileSrc(u));
  const base = deps.baseUri.replace(/\/+$/, '');
  // A cache file (play/thumb) arrives after its `full`, so "absent" is only remembered for a while.
  const absent = new Map<string, number>();
  const now = deps.now ?? (() => Date.now());
  const key = (p: string, f: string, k: FrameFileKind) => `${p}/${f}.${k}`;
  return {
    url(projectId, frameId, kind) {
      const frame = store.state.get().projects[projectId]?.frames.find((x) => x.frameId === frameId);
      if (!frame || frame.state !== 'local') return null;
      const since = absent.get(key(projectId, frameId, kind));
      if (since !== undefined && now() - since < ABSENT_TTL_MS) return null;
      return convert(`${base}/${framePath(projectId, frameId, kind)}`);
    },
    markAbsent(projectId, frameId, kind) {
      absent.set(key(projectId, frameId, kind), now());
    },
    spriteUrlOf: (projectId) => projectSpriteUrlOf(projectId, base, convert),
  };
}

/** The base uri of `kopernikadr/` in Directory.Data, resolved once. */
let baseUri: Promise<string> | undefined;
export function resolveFrameBaseUri(): Promise<string> {
  return (baseUri ??= Filesystem.getUri({ directory: Directory.Data, path: ROOT }).then((r) => r.uri));
}

/** `frameUrl(projectId, frameId, kind)` bound to the store. */
export async function createAppFrameUrls(store: Pick<ProjectStore, 'state'>): Promise<FrameUrls> {
  return createFrameUrls(store, { baseUri: await resolveFrameBaseUri() });
}

/** The app's FrameUrls once the base uri is known (null before). */
export function useFrameUrls(store: ProjectStore | undefined): FrameUrls | null {
  const [urls, setUrls] = useState<{ store: ProjectStore; urls: FrameUrls } | null>(null);
  useEffect(() => {
    if (!store) return;
    let live = true;
    createAppFrameUrls(store).then(
      (u) => live && setUrls({ store, urls: u }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [store]);
  return urls && urls.store === store ? urls.urls : null;
}
