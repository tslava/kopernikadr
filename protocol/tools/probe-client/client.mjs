#!/usr/bin/env node
// probe-client: talk to the Kopernikadr camera from the Mac. See README.md.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTarget, describeError, UsageError } from './http.mjs';
import * as commands from './commands.mjs';

const USAGE = `usage: node client.mjs <command> <host[:port]> [options]    (default port 8765)

  info     <host>                                   GET /info
  hello    <host>                                   open /ws/control, hello, close
  capture  <host> [--projectId <uuid>] [--rotation 0|180] [--reqId <uuid>] [--repeat]
  preview  <host> [--seconds 10] [--quality low|normal|high]
  download <host> <frameId> [--variant full|play|thumb] [--sha256 <hex>] [--out <path>]
  probe    <host> <name> [--args <json>]            run a /diag probe, answer prompts, fetch the report
  backup   <host> --out <dir>                       save + verify every unacked full of --clientId (never acks)

common: --clientId <uuid>  (default: persistent id in ~/.config/kopernikadr/probe-client.json)
        --json             print the raw JSON result on stdout (progress goes to stderr)
        --verbose          also print control-socket events`;

const BOOLEAN_FLAGS = new Set(['repeat', 'json', 'verbose', 'help']);
const VALUE_FLAGS = new Set(['clientId', 'projectId', 'rotation', 'reqId', 'seconds', 'quality', 'variant', 'sha256', 'out', 'args']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq < 0 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq >= 0) throw new UsageError(`--${key} takes no value`);
      flags[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`--${key} needs a value`);
      flags[key] = value;
    } else {
      throw new UsageError(`unknown option --${key}`);
    }
  }
  return { positional, flags };
}

export function validateFlags(flags) {
  const out = { ...flags };
  for (const k of ['clientId', 'projectId', 'reqId']) {
    if (k in flags && !UUID_RE.test(flags[k])) throw new UsageError(`--${k} must be a UUID`);
  }
  if ('rotation' in flags) {
    if (!['0', '180'].includes(flags.rotation)) throw new UsageError('--rotation must be 0 or 180');
    out.rotation = Number(flags.rotation);
  }
  if ('seconds' in flags) {
    out.seconds = Number(flags.seconds);
    if (!(out.seconds > 0)) throw new UsageError('--seconds must be a positive number');
  }
  if ('quality' in flags && !['low', 'normal', 'high'].includes(flags.quality)) {
    throw new UsageError('--quality must be low, normal or high');
  }
  if ('variant' in flags && !['full', 'play', 'thumb'].includes(flags.variant)) {
    throw new UsageError('--variant must be full, play or thumb');
  }
  if ('sha256' in flags && !/^[0-9a-f]{64}$/i.test(flags.sha256)) throw new UsageError('--sha256 must be 64 hex chars');
  if ('args' in flags) {
    try {
      out.args = JSON.parse(flags.args);
    } catch (e) {
      throw new UsageError(`--args is not valid JSON: ${e.message}`);
    }
    if (out.args === null || typeof out.args !== 'object' || Array.isArray(out.args)) {
      throw new UsageError('--args must be a JSON object');
    }
  }
  return out;
}

/** Reads (or creates on first use) the persistent ids. */
export function loadConfig(file = configPath()) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`cannot read ${file}: ${e.message}`);
  }
  if (UUID_RE.test(cfg.clientId ?? '') && UUID_RE.test(cfg.projectId ?? '')) return cfg;
  cfg = { clientId: randomUUID(), projectId: randomUUID(), ...cfg };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'kopernikadr', 'probe-client.json');
}

async function waitForEnter(text, signal, output) {
  const rl = createInterface({ input: process.stdin, output });
  try {
    await rl.question(text, { signal });
  } finally {
    rl.close();
  }
}

export async function main(argv) {
  const { positional, flags: rawFlags } = parseArgv(argv);
  const [command, hostSpec, ...rest] = positional;
  if (rawFlags.help || !command) {
    console.log(USAGE);
    return;
  }
  const run = commands[command];
  if (!['info', 'hello', 'capture', 'preview', 'download', 'probe', 'backup'].includes(command) || !run) {
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }
  const flags = validateFlags(rawFlags);
  const target = parseTarget(hostSpec);
  const cfg = loadConfig();
  const out = flags.json ? process.stderr : process.stdout;
  const ctx = {
    target,
    clientId: flags.clientId ?? cfg.clientId,
    projectId: cfg.projectId,
    verbose: Boolean(flags.verbose),
    log: (line) => out.write(line + '\n'),
    warn: (line) => process.stderr.write(`warning: ${line}\n`),
    waitForEnter: (text, signal) => waitForEnter(text, signal, out),
  };

  let result;
  switch (command) {
    case 'download':
      if (!rest[0]) throw new UsageError('download needs a <frameId>');
      result = await commands.download(ctx, rest[0], flags);
      break;
    case 'probe':
      if (!rest[0]) throw new UsageError('probe needs a <name>');
      if (!/^[A-Za-z0-9_-]+$/.test(rest[0])) throw new UsageError('probe name must match [A-Za-z0-9_-]+');
      result = await commands.probe(ctx, rest[0], { args: flags.args ?? {}, outRoot: join(REPO_ROOT, 'diagnostics') });
      break;
    default:
      result = await run(ctx, flags);
  }
  if (flags.json) console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${describeError(e)}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  });
}
