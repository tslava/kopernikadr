// DNS-SD discovery results (PROTOCOL §3) → camera entries. Pure: the native side (Capacitor plugin)
// browses `_kopernikadr._tcp`, resolves each service and hands the result here.

/** DNS-SD service type of the camera. */
export const SERVICE_TYPE = '_kopernikadr._tcp';

/** The protocol version this remote speaks; a camera's `pv` range must cover it. */
export const PROTOCOL_VERSION = 1;

/** A resolved service that is not a usable camera. `code`: NO_ID, BAD_PV, UNSUPPORTED_PV, BAD_PORT, NO_HOST. */
export class NsdParseError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'NsdParseError';
    this.code = code;
  }
}

/**
 * @typedef {string | Uint8Array | ArrayBuffer | ArrayLike<number> | null | undefined} TxtRaw
 *   A TXT value as a plugin delivers it: text, or the raw bytes (UTF-8).
 * @typedef {{ name?: string, host?: string | string[], addresses?: string[], port?: number | string,
 *   txt?: Record<string, TxtRaw> | null }} RawService
 * @typedef {{ cameraId: string, name: string, protocolVersions: { min: number, max: number },
 *   host: string, port: number }} ParsedService
 */

const utf8 = new TextDecoder('utf-8');

/** @param {TxtRaw} v @returns {string} */
function decode(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return utf8.decode(v);
  if (v instanceof ArrayBuffer) return utf8.decode(new Uint8Array(v));
  if (typeof v === 'object' && typeof v.length === 'number') return utf8.decode(Uint8Array.from(v));
  return String(v);
}

/**
 * The TXT value of `key` (keys are case-insensitive, RFC 6763 §6.4), decoded as UTF-8; `''` for a
 * key without a value, `undefined` if absent.
 * @param {Record<string, TxtRaw> | null | undefined} txt @param {string} key
 * @returns {string | undefined}
 */
export function txtValue(txt, key) {
  if (!txt || typeof txt !== 'object') return undefined;
  const want = key.toLowerCase();
  for (const k of Object.keys(txt)) {
    if (k.toLowerCase() === want) return decode(txt[k]);
  }
  return undefined;
}

/** @param {unknown} s @returns {string} */
const dropDot = (s) => (typeof s === 'string' ? s.trim().replace(/\.+$/, '') : '');

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * The best address to connect to: an IPv4 address, else a hostname, else an IPv6 address
 * (link-local ones need a zone, and a URL needs brackets). Trailing dots are dropped.
 * @param {ReadonlyArray<string | null | undefined>} candidates
 * @returns {string | undefined}
 */
export function pickAddress(candidates) {
  const list = candidates.map(dropDot).filter(Boolean);
  const rank = (/** @type {string} */ a) => (IPV4.test(a) ? 0 : a.includes(':') ? 2 : 1);
  let best;
  for (const a of list) if (best === undefined || rank(a) < rank(best)) best = a;
  return best;
}

/** @param {string} pv @returns {{ min: number, max: number } | null} */
function parseRange(pv) {
  const m = /^(\d+)-(\d+)$/.exec(pv.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  return min <= max ? { min, max } : null;
}

/** @param {unknown} port @returns {number | null} */
function parsePort(port) {
  const n = typeof port === 'number' ? port : typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * A resolved `_kopernikadr._tcp` service → a camera entry. The display name is the TXT `name`,
 * else the instance name. Throws {@link NsdParseError} if the service is not a usable camera.
 * @param {RawService | null | undefined} service
 * @returns {ParsedService}
 */
export function parseService(service) {
  const { name, host, addresses, port, txt } = service ?? {};
  const instance = dropDot(name);
  const label = instance ? `"${instance}"` : 'service';
  const fail = (/** @type {string} */ code, /** @type {string} */ why) => new NsdParseError(code, `${label}: ${why}`);

  const cameraId = (txtValue(txt, 'id') ?? '').trim();
  if (!cameraId) throw fail('NO_ID', 'TXT id is missing');

  const pv = txtValue(txt, 'pv');
  if (pv === undefined) throw fail('BAD_PV', 'TXT pv is missing');
  const protocolVersions = parseRange(pv);
  if (!protocolVersions) throw fail('BAD_PV', `TXT pv "${pv}" is not "min-max"`);
  if (PROTOCOL_VERSION < protocolVersions.min || PROTOCOL_VERSION > protocolVersions.max) {
    throw fail('UNSUPPORTED_PV', `TXT pv "${pv}" does not cover version ${PROTOCOL_VERSION}`);
  }

  const p = parsePort(port);
  if (p === null) throw fail('BAD_PORT', `bad port ${JSON.stringify(port)}`);

  const hosts = [...(Array.isArray(host) ? host : [host]), ...(Array.isArray(addresses) ? addresses : [])];
  const address = pickAddress(hosts);
  if (!address) throw fail('NO_HOST', 'no host address');

  const display = (txtValue(txt, 'name') ?? '').trim() || instance || cameraId;
  return { cameraId, name: display, protocolVersions, host: address, port: p };
}
