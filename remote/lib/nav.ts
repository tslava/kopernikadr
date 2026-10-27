'use client';

import { useSyncExternalStore } from 'react';
import { PROJECTS, formatRoute, parseHash, sameRoute, type Route } from './router';

// Routing lives in location.hash. `depth` counts the entries our own navigate() pushed in this
// page load, so back() knows whether history.back() stays inside the app.
let depth = 0;
let cached: { hash: string; route: Route } | undefined;

function current(): Route {
  const hash = location.hash;
  if (cached?.hash !== hash) cached = { hash, route: parseHash(hash) };
  return cached.route;
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current, () => PROJECTS);
}

export function navigate(route: Route): void {
  if (sameRoute(route, current())) return;
  depth++;
  location.hash = formatRoute(route);
}

/** One step back in the app history; with nothing of ours behind, to projects. False at the root. */
export function back(): boolean {
  if (depth > 0) {
    depth--;
    history.back();
    return true;
  }
  if (current().name === 'projects') return false;
  history.replaceState(null, '', location.pathname + '#/projects');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  return true;
}
