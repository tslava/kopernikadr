import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SEG_MODEL, fetchModel } from './fetch-models.mjs';

const body = Buffer.from('fake model bytes');
const model = { url: 'https://example.test/m.task', sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  return { cacheDir: path.join(dir, 'cache'), assetPath: path.join(dir, 'assets', 'mediapipe', 'm.task') };
}
const okFetch = (calls, data = body) => async (url) => {
  calls.push(url);
  return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) };
};

test('the pinned model constants look sane', () => {
  assert.match(SEG_MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.equal(SEG_MODEL.bytes, 30525312);
  assert.match(SEG_MODEL.url, /^https:\/\/storage\.googleapis\.com\/mediapipe-models\//);
});

test('downloads, verifies, fills the cache and the asset', async () => {
  const f = fixture();
  const calls = [];
  assert.equal(await fetchModel({ model, ...f, fetchFn: okFetch(calls) }), 'download');
  assert.deepEqual(calls, [model.url]);
  assert.deepEqual(fs.readFileSync(f.assetPath), body);
  assert.deepEqual(fs.readFileSync(path.join(f.cacheDir, `${model.sha256}.task`)), body);
  assert.deepEqual(fs.readdirSync(f.cacheDir), [`${model.sha256}.task`]);
});

test('an asset that already matches skips everything', async () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.assetPath), { recursive: true });
  fs.writeFileSync(f.assetPath, body);
  const calls = [];
  assert.equal(await fetchModel({ model, ...f, fetchFn: okFetch(calls) }), 'asset');
  assert.equal(calls.length, 0);
});

test('a cache hit is copied without a download', async () => {
  const f = fixture();
  fs.mkdirSync(f.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(f.cacheDir, `${model.sha256}.task`), body);
  const calls = [];
  assert.equal(await fetchModel({ model, ...f, fetchFn: okFetch(calls) }), 'cache');
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readFileSync(f.assetPath), body);
});

test('a wrong asset is replaced', async () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.assetPath), { recursive: true });
  fs.writeFileSync(f.assetPath, 'stale');
  assert.equal(await fetchModel({ model, ...f, fetchFn: okFetch([]) }), 'download');
  assert.deepEqual(fs.readFileSync(f.assetPath), body);
});

test('a hash mismatch fails and stores nothing', async () => {
  const f = fixture();
  const bad = Buffer.from('fake model byteX');
  await assert.rejects(fetchModel({ model, ...f, fetchFn: okFetch([], bad) }), /wrong/);
  assert.equal(fs.existsSync(f.assetPath), false);
  assert.equal(fs.existsSync(path.join(f.cacheDir, `${model.sha256}.task`)), false);
});

test('a corrupt cache file is deleted and re-downloaded', async () => {
  const f = fixture();
  fs.mkdirSync(f.cacheDir, { recursive: true });
  const cached = path.join(f.cacheDir, `${model.sha256}.task`);
  fs.writeFileSync(cached, 'corrupt');
  const calls = [];
  assert.equal(await fetchModel({ model, ...f, fetchFn: okFetch(calls) }), 'download');
  assert.equal(calls.length, 1);
  assert.deepEqual(fs.readFileSync(cached), body);
});

test('a corrupt cache file is deleted when the re-download fails', async () => {
  const f = fixture();
  fs.mkdirSync(f.cacheDir, { recursive: true });
  const cached = path.join(f.cacheDir, `${model.sha256}.task`);
  fs.writeFileSync(cached, 'corrupt');
  await assert.rejects(fetchModel({ model, ...f, fetchFn: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  assert.equal(fs.existsSync(cached), false);
});
