import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, ControlClient, ProtocolError, describeClose } from './protocol.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class FakeSocket extends EventTarget {
  sent = [];
  closed = null;
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code = 1000, reason = '') { this.closed = { code, reason }; this.serverClose(code, reason); }
  receive(obj) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(obj) })); }
  serverClose(code, reason = '') { this.dispatchEvent(Object.assign(new Event('close'), { code, reason })); }
  last() { return this.sent.at(-1); }
}

const res = (reqId, data) => ({ v: 1, t: 'res', reqId, ok: true, data });
const err = (reqId, error) => ({ v: 1, t: 'res', reqId, ok: false, error });

test('buildRequest builds the v1 envelope with a random UUID reqId', () => {
  const a = buildRequest('capture', { rotation: 0 });
  assert.deepEqual(Object.keys(a), ['v', 't', 'reqId', 'op', 'args']);
  assert.equal(a.v, 1);
  assert.equal(a.t, 'req');
  assert.equal(a.op, 'capture');
  assert.deepEqual(a.args, { rotation: 0 });
  assert.match(a.reqId, UUID_RE);
  assert.notEqual(buildRequest('ping').reqId, a.reqId);
  assert.deepEqual(buildRequest('ping').args, {});
  assert.equal(buildRequest('ping', {}, 'fixed').reqId, 'fixed');
});

test('responses are correlated by reqId, in any order', async () => {
  const s = new FakeSocket();
  const c = new ControlClient(s);
  const p1 = c.request('ping');
  const p2 = c.request('getStatus');
  const [r1, r2] = s.sent;
  s.receive(res('someone-else', { x: 1 }));
  s.receive(res(r2.reqId, { batteryPct: 80 }));
  s.receive(res(r1.reqId, { serverTimeMs: 5 }));
  assert.deepEqual(await p1, { serverTimeMs: 5 });
  assert.deepEqual(await p2, { batteryPct: 80 });
  assert.equal(c.pendingCount, 0);
});

test('an explicit reqId is used as is; a duplicate pending reqId is refused', async () => {
  const s = new FakeSocket();
  const c = new ControlClient(s);
  const p = c.request('capture', { rotation: 0 }, { reqId: 'r-1' });
  assert.equal(s.last().reqId, 'r-1');
  await assert.rejects(c.request('capture', {}, { reqId: 'r-1' }), /already pending/);
  s.receive(res('r-1', { frameId: 'F' }));
  assert.deepEqual(await p, { frameId: 'F' });
});

test('an error response rejects with ProtocolError carrying code and retryAfterMs', async () => {
  const s = new FakeSocket();
  const c = new ControlClient(s);
  const p = c.hello({ clientId: 'c-1' });
  s.receive(err(s.last().reqId, { code: 'BUSY', message: 'held by another client', retryable: true, retryAfterMs: 4000 }));
  const e = await p.catch((x) => x);
  assert.ok(e instanceof ProtocolError);
  assert.equal(e.code, 'BUSY');
  assert.equal(e.retryAfterMs, 4000);
  assert.equal(e.retryable, true);
  assert.match(e.message, /hello: BUSY - held by another client \(retry after 4000 ms\)/);
  assert.equal(c.session, null);
});

test('a request times out, and the late response is ignored', async () => {
  const s = new FakeSocket();
  const c = new ControlClient(s, { timeoutMs: 20 });
  const p = c.request('capture');
  const e = await p.catch((x) => x);
  assert.equal(e.code, 'TIMEOUT');
  assert.equal(e.local, true);
  assert.equal(c.pendingCount, 0);
  s.receive(res(s.last().reqId, {})); // must not throw
});

test('evt messages reach onEvent; junk is ignored', () => {
  const s = new FakeSocket();
  const events = [];
  new ControlClient(s, { onEvent: (name, data) => events.push([name, data]) });
  s.dispatchEvent(Object.assign(new Event('message'), { data: 'not json' }));
  s.dispatchEvent(Object.assign(new Event('message'), { data: new ArrayBuffer(4) }));
  s.receive({ v: 1, t: 'evt', name: 'status', data: { batteryPct: 50 } });
  assert.deepEqual(events, [['status', { batteryPct: 50 }]]);
});

test('hello sends the probe-client args and then pings every interval', async () => {
  const s = new FakeSocket();
  const rtts = [];
  const c = new ControlClient(s, { pingIntervalMs: 10, onPing: (rtt) => rtts.push(rtt) });
  const p = c.hello({ clientId: 'c-1' });
  const hello = s.last();
  assert.equal(hello.op, 'hello');
  assert.deepEqual(hello.args, {
    clientId: 'c-1', protocolVersions: { min: 1, max: 1 }, appVersion: 'probe-client', platform: 'node',
  });
  s.receive(res(hello.reqId, { sessionId: 's-1' }));
  assert.deepEqual(await p, { sessionId: 's-1' });
  assert.equal(c.session.sessionId, 's-1');

  await new Promise((r) => setTimeout(r, 35));
  const pings = s.sent.filter((m) => m.op === 'ping');
  assert.ok(pings.length >= 2, `expected >= 2 pings, got ${pings.length}`);
  s.receive(res(pings[0].reqId, { serverTimeMs: 1 }));
  await new Promise((r) => setImmediate(r));
  assert.equal(rtts.length, 1);
  c.close();
  const count = s.sent.length;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.sent.length, count, 'no pings after close');
});

test('a 4001 close rejects pending requests and reports "replaced"', async () => {
  const s = new FakeSocket();
  let closed;
  const c = new ControlClient(s, { onClose: (info) => { closed = info; } });
  const p = c.request('capture');
  s.serverClose(4001, 'replaced');
  const e = await p.catch((x) => x);
  assert.equal(e.code, 'CLOSED');
  assert.match(e.message, /4001 replaced/);
  assert.deepEqual(closed, { code: 4001, reason: 'replaced', label: 'replaced', byClient: false });
  await assert.rejects(c.request('ping'), /CLOSED/);
});

test('describeClose labels 4002 and passes other codes through', () => {
  assert.equal(describeClose(4002, ''), '4002 lease lost');
  assert.equal(describeClose(4003, ''), '4003 busy');
  assert.equal(describeClose(4000, ''), '4000 protocol error');
  assert.equal(describeClose(1006, 'abnormal'), '1006 "abnormal"');
  assert.equal(describeClose(1000), '1000');
});

test('a client-initiated close is flagged byClient', () => {
  const s = new FakeSocket();
  let closed;
  const c = new ControlClient(s, { onClose: (info) => { closed = info; } });
  c.close();
  assert.equal(closed.byClient, true);
  assert.equal(s.closed.code, 1000);
});
