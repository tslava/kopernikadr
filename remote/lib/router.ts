// Hash router: pure parsing/formatting. Anything unknown or malformed resolves to `projects`.
export type Route =
  | { name: 'projects' }
  | { name: 'connect' }
  | { name: 'capture'; id: string }
  | { name: 'play'; id: string }
  | { name: 'diagnostics' };

export const PROJECTS: Route = { name: 'projects' };
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (!path.startsWith('/')) return PROJECTS;
  const [name, id, ...rest] = path.slice(1).split('/');
  if (rest.length) return PROJECTS;
  if (name === 'connect' && id === undefined) return { name: 'connect' };
  if (name === 'diagnostics' && id === undefined) return { name: 'diagnostics' };
  if ((name === 'capture' || name === 'play') && id !== undefined) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      return PROJECTS;
    }
    return ID.test(decoded) ? { name, id: decoded } : PROJECTS;
  }
  return PROJECTS;
}

export function formatRoute(route: Route): string {
  return 'id' in route ? `#/${route.name}/${encodeURIComponent(route.id)}` : `#/${route.name}`;
}

export const sameRoute = (a: Route, b: Route): boolean => formatRoute(a) === formatRoute(b);
