/** In-memory FileAdapter with failure injection and crash points, for tests. */
import type { InstallResult } from '../native';
import type { BinaryIO } from '../stickers/binaryFiles';
import type { FileAdapter } from './files';

export type FsOp = 'move' | 'readText' | 'writeTextAtomic' | 'list' | 'mkdir' | 'remove' | 'uri' | 'writeBytes' | 'readBytes' | 'copy' | 'installFile';

export class CrashError extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'CrashError';
  }
}

export function noSpace(): Error {
  return Object.assign(new Error('NO_SPACE'), { code: 'NO_SPACE' });
}

export interface FailRule {
  op: FsOp;
  /** Exact path, or a regexp tested against it. Omitted = any path. */
  path?: string | RegExp;
  error?: Error;
  /** Skip this many matching calls first. Default 0. */
  skip?: number;
  /** Fail this many times, then stop (default: forever). */
  times?: number;
}

export class FakeFs implements FileAdapter {
  readonly files = new Map<string, string>();
  /** Binary files (sticker PNGs); listed and removed like the text ones. */
  readonly binaries = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  /** Every mutating call that took effect: `"write index.json"`, `"mkdir projects/a"`, ... */
  readonly log: string[] = [];
  private rules: (FailRule & { seen: number; failed: number })[] = [];
  private crashAt: number | null = null;
  private mutations = 0;

  failOn(rule: FailRule): void {
    this.rules.push({ ...rule, seen: 0, failed: 0 });
  }
  clearFailures(): void {
    this.rules = [];
  }
  /** After `n` more mutating calls took effect, every call throws `CrashError` until `restart()`. */
  crashAfter(n: number): void {
    this.crashAt = this.mutations + n;
  }
  /** "The process was killed and started again": the disk stays, injected faults go. */
  restart(): void {
    this.crashAt = null;
    this.rules = [];
  }

  json(path: string): unknown {
    const t = this.files.get(path);
    return t === undefined ? undefined : JSON.parse(t);
  }

  gate(op: FsOp, path: string): void {
    if (this.crashAt !== null && this.mutations >= this.crashAt) throw new CrashError();
    for (const r of this.rules) {
      if (r.op !== op) continue;
      if (r.path !== undefined && !(typeof r.path === 'string' ? r.path === path : r.path.test(path))) continue;
      if (r.seen++ < (r.skip ?? 0)) continue;
      if (r.times !== undefined && r.failed >= r.times) continue;
      r.failed++;
      throw r.error ?? new Error(`injected ${op} failure: ${path}`);
    }
  }
  done(entry: string): void {
    this.mutations++;
    this.log.push(entry);
  }
  addParents(path: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }

  async readText(path: string): Promise<string | null> {
    this.gate('readText', path);
    return this.files.get(path) ?? null;
  }
  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.gate('writeTextAtomic', path);
    this.files.set(path, text);
    this.addParents(path);
    this.done(`write ${path}`);
  }
  async list(dir: string): Promise<string[]> {
    this.gate('list', dir);
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.binaries.keys(), ...this.dirs]) {
      if (p.startsWith(prefix) && p !== dir) names.add(p.slice(prefix.length).split('/')[0]!);
    }
    return [...names].sort();
  }
  async mkdir(dir: string): Promise<void> {
    this.gate('mkdir', dir);
    this.dirs.add(dir);
    this.addParents(dir);
    this.done(`mkdir ${dir}`);
  }
  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.gate('remove', path);
    this.files.delete(path);
    this.binaries.delete(path);
    if (opts?.recursive) {
      for (const p of [...this.binaries.keys()]) if (p.startsWith(`${path}/`)) this.binaries.delete(p);
      for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`)) this.files.delete(p);
      for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d);
    }
    this.done(`remove ${path}`);
  }
  async move(from: string, to: string): Promise<void> {
    this.gate('move', from);
    const t = this.files.get(from);
    if (t === undefined) throw new Error(`no such file: ${from}`);
    this.files.set(to, t);
    this.files.delete(from);
    this.addParents(to);
    this.done(`move ${from} ${to}`);
  }
  async uri(path: string): Promise<string> {
    this.gate('uri', path);
    return `file:///data/kopernikadr/${path}`;
  }
}

/** `BinaryIO` over a `FakeFs`: tmp writes, copy, and a verified, idempotent `installFile` like the native one. */
export class FakeBinaryIO implements BinaryIO {
  private n = 0;
  constructor(private readonly fs: FakeFs) {}

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.fs.gate('writeBytes', path);
    this.fs.binaries.set(path, bytes.slice());
    this.fs.addParents(path);
    this.fs.done(`writeBytes ${path}`);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    this.fs.gate('readBytes', path);
    const b = this.fs.binaries.get(path);
    if (!b) throw new Error(`no such file: ${path}`);
    return b.slice();
  }
  async copy(from: string, to: string): Promise<void> {
    this.fs.gate('copy', from);
    const b = this.fs.binaries.get(from);
    if (!b) throw new Error(`no such file: ${from}`);
    this.fs.binaries.set(to, b.slice());
    this.fs.addParents(to);
    this.fs.done(`copy ${from} ${to}`);
  }
  async installFile(o: { tmp: string; dest: string; bytes: number; sha256: string }): Promise<InstallResult> {
    this.fs.gate('installFile', o.tmp);
    const tmp = this.fs.binaries.get(o.tmp);
    if (!tmp) {
      const d = this.fs.binaries.get(o.dest);
      if (d && d.length === o.bytes) return 'ALREADY_INSTALLED';
      throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    }
    if (tmp.length !== o.bytes || (await this.sha256(tmp)) !== o.sha256) {
      throw Object.assign(new Error('CHECKSUM_MISMATCH'), { code: 'CHECKSUM_MISMATCH' });
    }
    this.fs.binaries.set(o.dest, tmp);
    this.fs.binaries.delete(o.tmp);
    this.fs.addParents(o.dest);
    this.fs.done(`install ${o.tmp} ${o.dest}`);
    return 'INSTALLED';
  }
  async sha256(bytes: Uint8Array): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  uuid(): string {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
  }
}
