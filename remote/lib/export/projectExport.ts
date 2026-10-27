// Export of a project from the app (plan Task 18, ARCHITECTURE §5.7): the gate (frames still
// downloading, `unavailable` frames), the controller state machine, and the file name.
//
//   gate -> release the player ring -> transfer.pause() -> exporting flag on
//        -> frameSource (local play, else full resized) -> pickCodec -> exportVideo -> native writer
//        -> finally transfer.resume() + exporting flag off
//
// UI-free: everything the browser/native side provides is injected (see `ExportDeps`).
import type { FrameEntry, Project } from '../projects/model';
import { PLAY_HEIGHT, PLAY_WIDTH, type FrameSource } from '../play/frameSource';
import { playableFrames } from '../play/player';
import { createStore, type Store } from '../state/store';
import type { TransferPause } from '../transfer/types';
import { pickCodec, type CodecPickInput } from './codecPick';
import { exportVideo, ExportFrameError, type CreateEncoder, type ExportWriter } from './mediabunnyExport';

export const EXPORT_WIDTH = PLAY_WIDTH;
export const EXPORT_HEIGHT = PLAY_HEIGHT;
/** Bits per second (the value the 0b benchmark proved on the T610). */
export const EXPORT_BITRATE = 8_000_000;

// --- the file name -----------------------------------------------------------------------------

const PL: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z',
};
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
const translit = (ch: string): string => {
  if (ch in PL) return PL[ch];
  const lower = ch.toLowerCase();
  if (lower in CYR) {
    const r = CYR[lower];
    return lower === ch ? r : r.charAt(0).toUpperCase() + r.slice(1);
  }
  return ch;
};

export const MAX_NAME_PART = 60;

/**
 * The movie name as a file-name part: Polish/Cyrillic letters transliterated, everything the
 * native normalizer replaces (controls, `/ \ : * ? " < > |`) removed, other non-ASCII dropped,
 * whitespace runs -> `_`. Never empty; no leading/trailing dots or separators.
 */
export function sanitizeName(raw: string): string {
  const s = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  for (const ch of s) out += translit(ch);
  out = out
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // other Latin diacritics
    .replace(/[^\x20-\x7e]/g, '') // anything still non-ASCII (emoji, CJK, ...)
    .replace(/ +/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_NAME_PART)
    .replace(/[._-]+$/g, '');
  return out === '' ? 'film' : out;
}

export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The `displayName` for the native publish: `<project name>-<YYYY-MM-DD>` (native forces `kopernikadr-<it>.mp4`). */
export const exportDisplayName = (projectName: string, date: Date): string => `${sanitizeName(projectName)}-${isoDate(date)}`;

// --- the gate ----------------------------------------------------------------------------------

export type ExportGate =
  /** Frames are still downloading: wait (the caller re-evaluates when the project changes). */
  | { kind: 'waiting'; downloading: number }
  /** Frames the download gave up on: the parent must confirm that they are skipped. */
  | { kind: 'confirm'; unavailable: number; frames: number }
  | { kind: 'ready'; frames: number; skipped: number }
  | { kind: 'empty' };

const visible = (p: Project): FrameEntry[] => p.frames.filter((f) => f.hiddenUntil === null);

/**
 * `unavailable` frames are not "downloading" (the download gave up on them), so they never
 * deadlock the gate. `confirmedSkip`: the parent agreed to skip them.
 */
export function exportGate(project: Project, confirmedSkip = false): ExportGate {
  const frames = visible(project);
  const downloading = frames.filter((f) => f.state !== 'local' && !f.unavailable).length;
  if (downloading > 0) return { kind: 'waiting', downloading };
  const unavailable = frames.filter((f) => f.unavailable).length;
  const playable = playableFrames(project.frames).length;
  if (playable === 0) return { kind: 'empty' };
  if (unavailable > 0 && !confirmedSkip) return { kind: 'confirm', unavailable, frames: playable };
  return { kind: 'ready', frames: playable, skipped: unavailable };
}

// --- the state machine -------------------------------------------------------------------------

export type ExportFailure = 'frame' | 'codec' | 'space' | 'unknown';

export type ExportState =
  | { phase: 'idle' }
  /** Ring released, transfers pausing, codec and file being prepared. */
  | { phase: 'preparing' }
  | { phase: 'encoding'; i: number; n: number }
  | { phase: 'finalizing'; n: number }
  | { phase: 'publishing'; n: number }
  | { phase: 'done'; uri: string; frames: number; skipped: number }
  | { phase: 'cancelled' }
  | { phase: 'failed'; reason: ExportFailure; detail: string };

export type ExportPhase = ExportState['phase'];

/** Cancel is offered only while encoding: from `finalizing` on publish and abort stay exclusive. */
export const canCancel = (s: ExportState): boolean => s.phase === 'encoding';
export const isActive = (s: ExportState): boolean =>
  s.phase === 'preparing' || s.phase === 'encoding' || s.phase === 'finalizing' || s.phase === 'publishing';

export class NoCodecError extends Error {
  readonly code = 'NO_ENCODER';
  constructor(tried: string[]) {
    super(`no supported video encoder (tried ${tried.join(', ')})`);
    this.name = 'NoCodecError';
  }
}

export function classifyFailure(e: unknown): ExportFailure {
  if (e instanceof ExportFrameError) return 'frame';
  if (e instanceof NoCodecError) return 'codec';
  if ((e as { code?: unknown } | null)?.code === 'NO_SPACE') return 'space';
  return 'unknown';
}

export interface ExportDeps {
  /** The current project (read at start and again after the pause). */
  getProject: () => Project | null;
  transfer: TransferPause;
  /** App-wide flag; shooting is blocked while it is on. */
  exporting: Store<boolean>;
  /** Closes the player ring buffer (`PlayViewHandle.release`). */
  releasePlayer: () => void;
  frameSource: FrameSource;
  /** One writer per export (it holds one temp file). */
  createWriter: () => ExportWriter;
  now?: () => Date;
  isConfigSupported?: CodecPickInput['isConfigSupported'];
  createEncoder?: CreateEncoder;
  bitrate?: number;
}

export type StartResult = { started: true } | { started: false; reason: 'busy' | 'no-project' | ExportGate['kind'] };

export interface ExportController {
  readonly state: Store<ExportState>;
  /**
   * Starts when the gate is `ready` (pass `confirmedSkip` after the parent agreed to skip
   * `unavailable` frames). Resolves when the export ended (done / cancelled / failed).
   * Otherwise resolves at once with the reason it did not start.
   */
  start(opts?: { confirmedSkip?: boolean }): Promise<StartResult>;
  /** Only in `encoding`; returns whether it was accepted. */
  cancel(): boolean;
  /** Back to `idle` after done / cancelled / failed (e.g. before a retry or when the dialog closes). */
  reset(): void;
}

const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AbortError';

export function createExportController(deps: ExportDeps): ExportController {
  const state = createStore<ExportState>({ phase: 'idle' });
  let abort: AbortController | null = null;
  let running = false;

  async function run(): Promise<void> {
    const ctl = (abort = new AbortController());
    let skipped = 0;
    let final: ExportState;
    state.set({ phase: 'preparing' });
    deps.exporting.set(true);
    try {
      deps.releasePlayer();
      await deps.transfer.pause();
      // Downloads that finished while pausing are included; shooting is blocked, so nothing else changed.
      const project = deps.getProject();
      if (!project) throw new Error('project is gone');
      const ids = playableFrames(project.frames).map((f) => f.frameId);
      if (ids.length === 0) throw new Error('nothing to export');
      skipped = visible(project).length - ids.length;
      const fps = project.fps;
      const bitrate = deps.bitrate ?? EXPORT_BITRATE;
      const pick = await pickCodec({ width: EXPORT_WIDTH, height: EXPORT_HEIGHT, fps, bitrate, isConfigSupported: deps.isConfigSupported });
      if (!pick.chosen) throw new NoCodecError(pick.tried.map((t) => t.codecString));
      const result = await exportVideo({
        source: { count: ids.length, load: (i, { signal }) => deps.frameSource.load(project.id, ids[i], signal) },
        fps,
        width: EXPORT_WIDTH,
        height: EXPORT_HEIGHT,
        bitrate,
        codec: pick.chosen,
        writer: deps.createWriter(),
        displayName: exportDisplayName(project.name, (deps.now ?? (() => new Date()))()),
        signal: ctl.signal,
        createEncoder: deps.createEncoder,
        onProgress: (p) => {
          if (p.phase === 'encoding') {
            if (!ctl.signal.aborted) state.set({ phase: 'encoding', i: p.i, n: p.n });
          } else if (p.phase === 'finalizing') state.set({ phase: 'finalizing', n: p.n });
          else if (p.phase === 'publishing') state.set({ phase: 'publishing', n: p.n });
        },
      });
      final = { phase: 'done', uri: result.uri, frames: result.frames, skipped };
    } catch (e) {
      final =
        isAbort(e) || (ctl.signal.aborted && classifyFailure(e) === 'unknown')
          ? { phase: 'cancelled' }
          : { phase: 'failed', reason: classifyFailure(e), detail: e instanceof Error ? e.message : String(e) };
    } finally {
      // always: success, failure and cancel
      try {
        deps.transfer.resume();
      } finally {
        deps.exporting.set(false);
      }
    }
    abort = null;
    state.set(final);
  }

  return {
    state,
    async start(opts = {}) {
      if (running || isActive(state.get())) return { started: false, reason: 'busy' };
      const project = deps.getProject();
      if (!project) return { started: false, reason: 'no-project' };
      const gate = exportGate(project, opts.confirmedSkip === true);
      if (gate.kind !== 'ready') return { started: false, reason: gate.kind };
      running = true;
      try {
        await run();
      } finally {
        running = false;
      }
      return { started: true };
    },
    cancel() {
      if (!canCancel(state.get()) || !abort) return false;
      abort.abort();
      return true;
    },
    reset() {
      if (!isActive(state.get())) state.set({ phase: 'idle' });
    },
  };
}
