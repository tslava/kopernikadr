import { describe, expect, it } from 'vitest';
import { NATIVE_ERROR_CODES, nativeErrorCode, toBase64 } from './native';

const ref = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

function pattern(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 131 + 7) & 0xff;
  return b;
}

describe('toBase64', () => {
  it('encodes empty and short arrays with padding', () => {
    expect(toBase64(new Uint8Array())).toBe('');
    expect(toBase64(new Uint8Array([0]))).toBe('AA==');
    expect(toBase64(new Uint8Array([0, 1]))).toBe('AAE=');
    expect(toBase64(new Uint8Array([0, 1, 2, 255]))).toBe('AAEC/w==');
  });

  it('covers every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase64(all)).toBe(ref(all));
  });

  it.each([0x7fff, 0x8000, 0x8001, 0x10000 + 1])('matches Buffer around chunk edges (%i bytes)', (n) => {
    const b = pattern(n);
    expect(toBase64(b)).toBe(ref(b));
  });

  it('handles a multi-MB array without overflowing the stack', () => {
    const b = pattern(5 * (1 << 20) + 3);
    expect(toBase64(b)).toBe(ref(b));
  });

  it('respects subarray offsets', () => {
    const b = pattern(100).subarray(10, 50);
    expect(toBase64(b)).toBe(ref(b));
  });
});

describe('nativeErrorCode', () => {
  it('reads known codes from a rejection', () => {
    for (const code of NATIVE_ERROR_CODES) {
      expect(nativeErrorCode(Object.assign(new Error('x'), { code }))).toBe(code);
    }
  });

  it('knows the image and segmenter codes', () => {
    for (const code of ['CANCELLED', 'NO_APP', 'TOO_LARGE', 'UNSUPPORTED', 'SEG_FAILED', 'MODEL_MISSING', 'NO_SESSION']) {
      expect(nativeErrorCode({ code })).toBe(code);
    }
  });

  it('ignores other errors', () => {
    expect(nativeErrorCode(new Error('x'))).toBeUndefined();
    expect(nativeErrorCode({ code: 'UNIMPLEMENTED' })).toBeUndefined();
    expect(nativeErrorCode({ code: 3 })).toBeUndefined();
    expect(nativeErrorCode(null)).toBeUndefined();
    expect(nativeErrorCode(undefined)).toBeUndefined();
  });
});
