// Preview WS binary message (PROTOCOL.md §7):
//   uint32 BE headerLength | UTF-8 JSON header (headerLength bytes) | JPEG bytes

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * @param {ArrayBuffer | Uint8Array} buf
 * @returns {{header: object, jpeg: Uint8Array}} `jpeg` is a view into `buf`, not a copy.
 */
export function parsePreviewFrame(buf) {
  const bytes = toBytes(buf);
  if (bytes.length < 4) {
    throw new Error(`preview frame: ${bytes.length} bytes, need at least 4 for headerLength`);
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  const remaining = bytes.length - 4;
  if (headerLength > remaining) {
    throw new Error(`preview frame: headerLength ${headerLength} exceeds the ${remaining} bytes after it`);
  }

  let header;
  try {
    header = JSON.parse(utf8.decode(bytes.subarray(4, 4 + headerLength)));
  } catch (e) {
    throw new Error(`preview frame: header is not valid UTF-8 JSON (${e.message})`);
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error(`preview frame: header must be a JSON object, got ${Array.isArray(header) ? 'array' : header === null ? 'null' : typeof header}`);
  }

  const jpeg = bytes.subarray(4 + headerLength);
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error(`preview frame: JPEG part (${jpeg.length} bytes) does not start with the SOI marker FF D8`);
  }
  return { header, jpeg };
}

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new TypeError('preview frame: expected an ArrayBuffer or Uint8Array');
}
