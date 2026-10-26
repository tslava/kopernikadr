import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import * as commands from './commands.mjs';
import { parseTarget, describeError } from './http.mjs';
import { parseArgv, validateFlags, loadConfig } from './client.mjs';
import { startFakeCamera } from './fake-camera.mjs';

function makeCtx(host, extra = {}) {
  const lines = [];
  const warnings = [];
  return {
    lines,
    warnings,
    target: parseTarget(host),
    clientId: randomUUID(),
    projectId: randomUUID(),
    log: (l) => lines.push(l),
    warn: (l) => warnings.push(l),
    waitForEnter: async () => {},
    ...extra,
  };
}

async function withCamera(opts, fn) {
  const cam = await startFakeCamera(opts);
  try {
    await fn(cam);
  } finally {
    await cam.close();
    process.exitCode = 0;
  }
}

test('parseTarget: default port, explicit port, IPv6, bad input', () => {
  assert.equal(parseTarget('192.168.1.5').http, 'http://192.168.1.5:8765');
  assert.equal(parseTarget('phone.local:9000').ws, 'ws://phone.local:9000');
  assert.equal(parseTarget('[fe80::1]:81').http, 'http://[fe80::1]:81');
  assert.throws(() => parseTarget('a:b:c'), /bad host/);
  assert.throws(() => parseTarget('h:70000'), /bad port/);
  assert.throws(() => parseTarget(undefined), /missing/);
});

test('parseArgv / validateFlags', () => {
  const { positional, flags } = parseArgv(['capture', 'h', '--repeat', '--rotation', '180', '--reqId=0b0e7a3c-1f0e-4f43-9a54-6b7c8d9e0f12']);
  assert.deepEqual(positional, ['capture', 'h']);
  const v = validateFlags(flags);
  assert.equal(v.repeat, true);
  assert.equal(v.rotation, 180);
  assert.throws(() => parseArgv(['--nope']), /unknown option/);
  assert.throws(() => parseArgv(['--seconds']), /needs a value/);
  assert.throws(() => validateFlags({ clientId: 'x' }), /UUID/);
  assert.throws(() => validateFlags({ quality: 'ultra' }), /quality/);
  assert.throws(() => validateFlags({ args: '[1]' }), /JSON object/);
  assert.deepEqual(validateFlags({ args: '{"manualRestart":true}' }).args, { manualRestart: true });
});

test('loadConfig creates the file once and keeps the ids', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'probe-cfg-')), 'sub', 'probe-client.json');
  const a = loadConfig(file);
  const b = loadConfig(file);
  assert.equal(a.clientId, b.clientId);
  assert.equal(a.projectId, b.projectId);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), a);
});

async function closedPort() {
  const srv = createServer().listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('describeError: connection refused is one readable line', async () => {
  const url = `http://127.0.0.1:${await closedPort()}/`;
  const e = await fetch(url).catch((x) => Object.assign(x, { url }));
  assert.equal(describeError(e), `${url}: connection refused (is the camera app running and in the foreground?)`);
});

test('info, hello, and BUSY for a second clientId', () => withCamera({}, async (cam) => {
  const ctx = makeCtx(cam.host);
  assert.equal((await commands.info(ctx)).cameraId, 'cam-1');
  const s = await commands.hello(ctx);
  assert.match(s.sessionId, /-/);
  const other = makeCtx(cam.host);
  await assert.rejects(commands.hello(other), (e) => e.code === 'BUSY' && e.retryAfterMs === 10000);
}));

test('capture --repeat returns the same frameId; rotation comes from hello controls', () => withCamera({}, async (cam) => {
  const ctx = makeCtx(cam.host);
  const r = await commands.capture(ctx, { repeat: true });
  assert.equal(r.pass, true);
  assert.equal(r.first.frameId, r.second.frameId);
  assert.equal(r.first.rotation, 180);
  assert.equal(r.first.projectId, ctx.projectId);
  assert.ok(ctx.lines.some((l) => l.startsWith('PASS')));
}));

test('download checks Content-Length and sha256, and saves the file', () => withCamera({}, async (cam) => {
  const ctx = makeCtx(cam.host);
  const { first } = await commands.capture(ctx);
  const out = join(await mkdtemp(join(tmpdir(), 'probe-dl-')), 'f.jpg');
  const r = await commands.download(ctx, first.frameId, { sha256: first.full.sha256, out });
  assert.equal(r.contentLengthOk, true);
  assert.equal(r.sha256Ok, true);
  assert.equal(r.jpegSoi, true);
  assert.deepEqual(await readFile(out), cam.fullBytes);
  const bad = await commands.download(ctx, first.frameId, { sha256: '0'.repeat(64) });
  assert.equal(bad.sha256Ok, false);
  assert.equal(process.exitCode, 1);
  await assert.rejects(commands.download(ctx, 'nope'), /HTTP 404/);
}));

test('preview pulls frames, sets quality, and recovers from a stall', () => withCamera({ stallNexts: 1 }, async (cam) => {
  const ctx = makeCtx(cam.host);
  const s = await commands.preview(ctx, { seconds: 1, quality: 'high', stallMs: 150 });
  assert.deepEqual(cam.state.controls, [{ previewQuality: 'high' }]);
  assert.equal(s.recoveries, 1);
  assert.ok(s.frames > 5, `frames ${s.frames}`);
  assert.deepEqual(Object.keys(s.sizes), ['1280x960']);
  assert.ok(cam.state.hellos >= 2, 're-hello after the stall');
}));

test('preview warns and continues when /diag/controls is 404', () => withCamera({ diag: false }, async (cam) => {
  const ctx = makeCtx(cam.host);
  const s = await commands.preview(ctx, { seconds: 0.3, quality: 'low' });
  assert.ok(s.frames > 0);
  assert.ok(ctx.warnings.some((w) => w.includes('404')));
}));

test('probe: answers a prompt, survives a short outage, saves report + safe files', () => withCamera({
  downRequests: 2,
  probeSteps: [
    { state: 'running', step: 'S1 auto' },
    { state: 'waiting', step: 'prompt', prompt: { id: 'p1', text: 'Put the card into the frame' } },
    { state: 'running', step: 'S4' },
    { state: 'done', step: 'done' },
  ],
}, async (cam) => {
  const prompts = [];
  const ctx = makeCtx(cam.host, { waitForEnter: async (text) => { prompts.push(text); } });
  const outRoot = await mkdtemp(join(tmpdir(), 'probe-out-'));
  const r = await commands.probe(ctx, 'locks', { args: { manualRestart: true }, outRoot, pollMs: 10, maxBackoffMs: 20 });
  assert.equal(r.state, 'done');
  assert.deepEqual(cam.state.probeArgs, { manualRestart: true });
  assert.deepEqual(cam.state.continues, [{ runId: 'run-1', promptId: 'p1' }]);
  assert.equal(prompts.length, 1);
  assert.ok(ctx.lines.includes('>>> Put the card into the frame'));
  assert.ok(ctx.warnings.some((w) => w.includes('unreachable')));
  assert.ok(ctx.warnings.some((w) => w.includes('../evil')));
  assert.deepEqual((await readdir(r.dir)).sort(), ['overlay-0.png', 'report.json']);
  assert.match(r.dir, /\d{4}-\d{2}-\d{2}[/\\]run-1$/);
  assert.equal(JSON.parse(await readFile(join(r.dir, 'report.json'), 'utf8')).runId, 'run-1');
}));

test('probe: gives up when the server stays down longer than maxDownMs', () => withCamera({
  downRequests: 1000,
  probeSteps: [{ state: 'running' }],
}, async (cam) => {
  const ctx = makeCtx(cam.host);
  await assert.rejects(
    commands.probe(ctx, 'caps', { outRoot: tmpdir(), pollMs: 10, maxBackoffMs: 20, maxDownMs: 100 }),
    /server unreachable for over/,
  );
}));

test('probe: a refused start fails at once (not retried)', async () => {
  const ctx = makeCtx(`127.0.0.1:${await closedPort()}`);
  await assert.rejects(commands.probe(ctx, 'caps', { outRoot: tmpdir() }), (e) => /connection refused/.test(describeError(e)));
});
