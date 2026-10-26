// Unit tests for the pure remote-core modules (moved from remote-lite's pure.test.mjs).
// Run: npm test -w @kopernikadr/remote-core   (or `node --test` in packages/remote-core)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, Backoff } from '../src/backoff.js';
import { parsePreviewFrame } from '../src/preview-frame.js';
import { uuid, buildRequest, ControlClient } from '../src/protocol.js';
import { fixture } from './support.mjs';

test('backoff: 0.5, 1, 2, 4, 5, 5 s and reset', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10, 100].map((a) => backoffDelay(a)), [500, 1000, 2000, 4000, 5000, 5000, 5000]);
  const b = new Backoff();
  assert.equal(b.next(), 500);
  assert.equal(b.next(), 1000);
  b.reset();
  assert.equal(b.next(), 500);
});

test('preview frame parser: fixture header, errors', () => {
  const header = fixture('preview.header.json');
  const h = new TextEncoder().encode(JSON.stringify(header));
  const buf = new Uint8Array(4 + h.length + 4);
  new DataView(buf.buffer).setUint32(0, h.length, false);
  buf.set(h, 4);
  buf.set([0xff, 0xd8, 0xff, 0xd9], 4 + h.length);
  const r = parsePreviewFrame(buf.buffer);
  assert.deepEqual(r.header, header);
  assert.deepEqual([...r.jpeg], [0xff, 0xd8, 0xff, 0xd9]);
  assert.throws(() => parsePreviewFrame(new Uint8Array(2)), /at least 4/);
  const bad = buf.slice();
  bad[4 + h.length] = 0;
  assert.throws(() => parsePreviewFrame(bad), /SOI/);
});

test('protocol: uuid v4 shape, request envelope matches the fixture, res/evt routing', async () => {
  const id = uuid();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const fx = fixture('capture.req.json');
  assert.deepEqual(buildRequest('capture', fx.args, fx.reqId), fx);

  const listeners = {};
  const sent = [];
  const sock = { send: (s) => sent.push(JSON.parse(s)), close() {}, addEventListener: (n, fn) => { listeners[n] = fn; } };
  const events = [];
  const c = new ControlClient(sock, { onEvent: (n, d) => events.push([n, d]) });
  const p = c.request('capture', fx.args, { reqId: fx.reqId });
  listeners.message({ data: JSON.stringify(fixture('capture.res.json')) });
  assert.equal((await p).frameId, '01K8GZ4V7Q3M9X2B5N6R8T1WCD');
  const e = c.request('capture', fx.args, { reqId: fx.reqId });
  listeners.message({ data: JSON.stringify(fixture('capture.err.json')) });
  await assert.rejects(e, (err) => err.code === 'GEOMETRY_MISMATCH');
  listeners.message({ data: JSON.stringify(fixture('status.evt.json')) });
  assert.equal(events[0][0], 'status');
  const pending = c.request('ping');
  c.abort();
  await assert.rejects(pending, (err) => err.code === 'CLOSED' && err.local);
  const busy = fixture('hello.busy.json');
  const c2 = new ControlClient(sock);
  const h = c2.request('hello', {}, { reqId: busy.reqId });
  listeners.message({ data: JSON.stringify(busy) });
  await assert.rejects(h, (err) => err.code === 'BUSY' && err.retryAfterMs === 7350);
});
