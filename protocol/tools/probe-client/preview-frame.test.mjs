import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePreviewFrame } from './preview-frame.mjs';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const HEADER = { seq: 7, bootId: 'b', generation: 3, w: 1280, h: 960, ts: 123,
  locks: { exposure: 'auto', whiteBalance: 'auto', focus: 'auto' } };

function frame(headerBytes, jpeg = JPEG, headerLength = headerBytes.length) {
  const out = new Uint8Array(4 + headerBytes.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, headerLength, false);
  out.set(headerBytes, 4);
  out.set(jpeg, 4 + headerBytes.length);
  return out;
}
const enc = (s) => new TextEncoder().encode(s);

test('parses a good frame from an ArrayBuffer and a Uint8Array', () => {
  const bytes = frame(enc(JSON.stringify(HEADER)));
  for (const input of [bytes.buffer, bytes]) {
    const { header, jpeg } = parsePreviewFrame(input);
    assert.deepEqual(header, HEADER);
    assert.deepEqual([...jpeg], [...JPEG]);
  }
});

test('handles a Uint8Array view with a non-zero byteOffset', () => {
  const bytes = frame(enc('{"w":1,"h":2}'));
  const padded = new Uint8Array(bytes.length + 5);
  padded.set(bytes, 5);
  assert.deepEqual(parsePreviewFrame(padded.subarray(5)).header, { w: 1, h: 2 });
});

test('rejects a buffer shorter than 4 bytes', () => {
  assert.throws(() => parsePreviewFrame(new Uint8Array(3)), /3 bytes, need at least 4/);
});

test('rejects a headerLength beyond the buffer', () => {
  const bytes = frame(enc('{}'), JPEG, 1000);
  assert.throws(() => parsePreviewFrame(bytes), /headerLength 1000 exceeds/);
});

test('rejects a header that is not JSON', () => {
  assert.throws(() => parsePreviewFrame(frame(enc('{"w":'))), /not valid UTF-8 JSON/);
});

test('rejects a header that is not valid UTF-8', () => {
  assert.throws(() => parsePreviewFrame(frame(Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d]))), /not valid UTF-8 JSON/);
});

test('rejects a header that is JSON but not an object', () => {
  assert.throws(() => parsePreviewFrame(frame(enc('[1,2]'))), /must be a JSON object, got array/);
  assert.throws(() => parsePreviewFrame(frame(enc('null'))), /got null/);
  assert.throws(() => parsePreviewFrame(frame(enc('42'))), /got number/);
});

test('rejects a JPEG part without the SOI marker', () => {
  assert.throws(() => parsePreviewFrame(frame(enc('{}'), Uint8Array.from([0x89, 0x50]))), /SOI marker/);
  assert.throws(() => parsePreviewFrame(frame(enc('{}'), new Uint8Array(0))), /0 bytes/);
});

test('rejects a non-binary input', () => {
  assert.throws(() => parsePreviewFrame('abc'), TypeError);
});
