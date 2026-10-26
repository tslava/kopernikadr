// Small fetch helpers plus error classification and readable error messages.

export const DEFAULT_PORT = 8765;

/** `host`, `host:port`, `[v6]` or `[v6]:port` → base URLs. */
export function parseTarget(spec) {
  if (!spec) throw new UsageError('missing <host[:port]>');
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(spec) ?? /^([^:\[\]]+)(?::(\d+))?$/.exec(spec);
  if (!m) throw new UsageError(`bad host "${spec}", expected host[:port]`);
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`bad port in "${spec}"`);
  const host = m[1].includes(':') ? `[${m[1]}]` : m[1];
  return { host: m[1], port, http: `http://${host}:${port}`, ws: `ws://${host}:${port}` };
}

export class UsageError extends Error {
  name = 'UsageError';
}

export class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} → HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** fetch with a timeout; throws HttpError on a non-2xx status. */
export async function request(base, path, { method = 'GET', json, timeoutMs = 5_000 } = {}) {
  const url = base + path;
  const init = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (json !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    e.url = url;
    throw e;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(method, url, res.status, body.trim());
  }
  return res;
}

export async function getJson(base, path, opts) {
  return readJson(await request(base, path, opts));
}

export async function postJson(base, path, json, opts) {
  return readJson(await request(base, path, { ...opts, method: 'POST', json }));
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${res.url}: response is not JSON: ${text.slice(0, 200)}`);
  }
}

/** True for "the phone is not answering right now" (refused, unreachable, timeout, 502–504). */
export function isUnreachable(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  if (err instanceof HttpError) return err.status >= 502 && err.status <= 504;
  return err instanceof TypeError && err.message === 'fetch failed';
}

export function describeError(err) {
  if (err instanceof HttpError || err?.name === 'ProtocolError' || err?.name === 'UsageError') return err.message;
  const where = err?.url ? `${err.url}: ` : '';
  if (err?.name === 'TimeoutError') return `${where}timed out`;
  if (err instanceof TypeError && err.message === 'fetch failed') {
    const cause = err.cause;
    const code = cause?.code ?? cause?.errors?.[0]?.code;
    if (code === 'ECONNREFUSED') return `${where}connection refused (is the camera app running and in the foreground?)`;
    if (code) return `${where}cannot connect (${code})`;
    if (cause?.message === 'bad port') return `${where}fetch refuses this port (it is on the WHATWG "bad ports" list)`;
    return `${where}cannot connect (${cause?.message ?? 'network error'})`;
  }
  return err?.message ?? String(err);
}
