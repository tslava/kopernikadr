// Unit tests for nsd.js: a resolved DNS-SD service (PROTOCOL §3) → a camera entry.
// Run: npm test -w @kopernikadr/remote-core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseService, pickAddress, txtValue, NsdParseError, SERVICE_TYPE, PROTOCOL_VERSION } from '../src/nsd.js';

const utf8 = (s) => new TextEncoder().encode(s);

/** What the camera advertises (camera-android TxtRecord.forCamera / instanceName). */
const camera = (over = {}) => ({
  name: 'Kopernikadr Kamera (a1b2)',
  host: '192.168.1.20',
  port: 8765,
  txt: { id: 'cam-0001-a1b2', pv: '1-1', name: 'Kopernikadr Kamera' },
  ...over,
});

/** Asserts parseService throws an NsdParseError with this code. */
const rejects = (input, code) =>
  assert.throws(() => parseService(input), (e) => e instanceof NsdParseError && e.code === code, `expected ${code}`);

test('constants match PROTOCOL §3', () => {
  assert.equal(SERVICE_TYPE, '_kopernikadr._tcp');
  assert.equal(PROTOCOL_VERSION, 1);
});

test('the camera advertisement parses into a camera entry', () => {
  assert.deepEqual(parseService(camera()), {
    cameraId: 'cam-0001-a1b2',
    name: 'Kopernikadr Kamera',
    protocolVersions: { min: 1, max: 1 },
    host: '192.168.1.20',
    port: 8765,
  });
});

test('trailing dots are dropped from the host and the instance name', () => {
  const r = parseService(camera({ host: 'kamera-a1b2.local.', name: 'Kopernikadr Kamera (a1b2).', txt: { id: 'c1', pv: '1-1' } }));
  assert.equal(r.host, 'kamera-a1b2.local');
  assert.equal(r.name, 'Kopernikadr Kamera (a1b2)', 'no TXT name → the instance name');
});

test('the display name is the TXT name, else the instance name; blank TXT name falls back', () => {
  assert.equal(parseService(camera({ txt: { id: 'c1', pv: '1-1', name: '  ' } })).name, 'Kopernikadr Kamera (a1b2)');
  assert.equal(parseService(camera({ name: undefined, txt: { id: 'c1', pv: '1-1' } })).name, 'c1', 'nothing else → cameraId');
});

test('TXT values as Uint8Array, ArrayBuffer or byte arrays are decoded as UTF-8', () => {
  const r = parseService(camera({ txt: { id: utf8('c1'), pv: utf8('1-2').buffer, name: [...utf8('Kamera Łódź')] } }));
  assert.equal(r.cameraId, 'c1');
  assert.deepEqual(r.protocolVersions, { min: 1, max: 2 });
  assert.equal(r.name, 'Kamera Łódź');
});

test('TXT keys are case-insensitive (RFC 6763 §6.4)', () => {
  const r = parseService(camera({ txt: { ID: 'c1', Pv: '1-1', NAME: 'K' } }));
  assert.equal(r.cameraId, 'c1');
  assert.equal(r.name, 'K');
});

test('txtValue: missing key, null/key-only value, non-object txt', () => {
  assert.equal(txtValue({ a: 'x' }, 'b'), undefined);
  assert.equal(txtValue({ a: null }, 'a'), '');
  assert.equal(txtValue(null, 'a'), undefined);
  assert.equal(txtValue(undefined, 'a'), undefined);
});

test('a missing or blank id is rejected', () => {
  rejects(camera({ txt: { pv: '1-1', name: 'K' } }), 'NO_ID');
  rejects(camera({ txt: { id: ' ', pv: '1-1' } }), 'NO_ID');
  rejects(camera({ txt: undefined }), 'NO_ID');
});

test('pv must be "min-max" and cover version 1', () => {
  rejects(camera({ txt: { id: 'c1' } }), 'BAD_PV');
  for (const pv of ['', '1', '1-', '-1', 'a-b', '1-1-1', '2-1', '1.0-1', ' 1-1x']) {
    rejects(camera({ txt: { id: 'c1', pv } }), 'BAD_PV');
  }
  rejects(camera({ txt: { id: 'c1', pv: '2-3' } }), 'UNSUPPORTED_PV');
  rejects(camera({ txt: { id: 'c1', pv: '0-0' } }), 'UNSUPPORTED_PV');
  assert.deepEqual(parseService(camera({ txt: { id: 'c1', pv: '0-1' } })).protocolVersions, { min: 0, max: 1 });
  assert.deepEqual(parseService(camera({ txt: { id: 'c1', pv: ' 1-3 ' } })).protocolVersions, { min: 1, max: 3 });
});

test('the port must be an integer 1..65535 (a numeric string is accepted)', () => {
  for (const port of [0, -1, 65536, 1.5, NaN, undefined, null, '', 'x', '80a']) {
    rejects(camera({ port }), 'BAD_PORT');
  }
  assert.equal(parseService(camera({ port: '8080' })).port, 8080);
  assert.equal(parseService(camera({ port: 65535 })).port, 65535);
});

test('a missing host is rejected', () => {
  rejects(camera({ host: undefined }), 'NO_HOST');
  rejects(camera({ host: '' }), 'NO_HOST');
  rejects(camera({ host: '.', addresses: [] }), 'NO_HOST');
});

test('IPv4 is preferred when several addresses are given (host and/or addresses)', () => {
  assert.equal(parseService(camera({ host: 'fe80::1%wlan0', addresses: ['fe80::1%wlan0', '192.168.1.20'] })).host, '192.168.1.20');
  assert.equal(parseService(camera({ host: undefined, addresses: ['2001:db8::5', '10.0.0.7'] })).host, '10.0.0.7');
  assert.equal(parseService(camera({ host: ['fe80::2', '10.0.0.8'] })).host, '10.0.0.8', 'host may be an array');
  assert.equal(parseService(camera({ host: undefined, addresses: ['2001:db8::5'] })).host, '2001:db8::5', 'IPv6 only');
});

test('pickAddress: IPv4 > hostname > IPv6, trailing dots dropped, blanks skipped', () => {
  assert.equal(pickAddress(['fe80::1', 'kamera.local.', '10.1.2.3']), '10.1.2.3');
  assert.equal(pickAddress(['fe80::1', 'kamera.local.']), 'kamera.local');
  assert.equal(pickAddress(['', null, 'fe80::1']), 'fe80::1');
  assert.equal(pickAddress([]), undefined);
  assert.equal(pickAddress(['999.1.1.1', 'fe80::1']), '999.1.1.1', 'not a valid IPv4 → treated as a hostname');
});

test('parse errors carry a code and a message naming the service', () => {
  try {
    parseService(camera({ txt: { pv: '1-1' } }));
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'NsdParseError');
    assert.match(e.message, /Kopernikadr Kamera \(a1b2\)/);
  }
});

test('a non-object input is rejected without a TypeError', () => {
  rejects(undefined, 'NO_ID');
  rejects(null, 'NO_ID');
});
