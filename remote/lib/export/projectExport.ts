// Export of a project from the app (plan Task 18, ARCHITECTURE §5.7): the gate (frames still
// downloading, `unavailable` frames), the controller state machine, and the file name.
//
//   gate -> release the player ring -> transfer.pause() -> exporting flag on
//        -> preload the stickers' sprites (1024) -> pickCodec
//        -> exportVideo over the timeline (frameSource -> compose frame + stickers -> sample, hold/fps each)
//        -> native writer
//        -> finally transfer.resume() + exporting flag off
//
// UI-free: everything the browser/native side provides is injected (see `ExportDeps`).
import type { Project } from '../projects/model';
import { PLAY_HEIGHT, PLAY_WIDTH, type FrameSource } from '../play/frameSource';
import { playableItems, timeline } from '../projects/timeline';
import { drawFrame, drawStickers, type Ctx2D } from '../render/compose';
import { SpriteCache, type PinnedSprites } from '../render/sprites';
import { createStore, type Store } from '../state/store';
import type { TransferPause } from '../transfer/types';
import { pickCodec, type CodecPickInput } from './codecPick';
import { exportVideo, ExportFrameError, type CreateEncoder, type ExportImage, type ExportWriter } from './mediabunnyExport';

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

/** Frames the movie uses: referenced by an on-entry and visible (off frames never block or count). */
function usedFrames(p: Project): Project['frames'] {
  const used = new Set(timeline(p).filter((e) => !e.off).map((e) => e.frameId));
  return p.frames.filter((f) => used.has(f.frameId) && f.hiddenUntil === null);
}

/** Used frames that will not be in the movie: unavailable ones (and, once confirmed, ones that cannot arrive). */
function skippedCount(p: Project): number {
  const playable = new Set(playableItems(p).map((e) => e.frameId));
  return usedFrames(p).filter((f) => !playable.has(f.frameId)).length;
}

/** What the gate needs to know about the camera connection. */
export interface CameraLink {
  online: boolean;
  /** The connected camera's id (null while not online). */
  cameraId: string | null;
}

const cameraGone = (project: Project, link: CameraLink): boolean =>
  !link.online || (project.cameraId !== null && link.cameraId !== project.cameraId);

/**
 * `unavailable` frames are not "downloading" (the download gave up on them), so they never
 * deadlock the gate. `confirmedSkip`: the parent agreed to skip them.
 */
export function exportGate(project: Project, confirmedSkip = false, link?: CameraLink): ExportGate {
  const frames = usedFrames(project);
  const downloading = frames.filter((f) => f.state !== 'local' && !f.unavailable).length;
  // The camera is gone (or it is another camera): the not-yet-local frames cannot arrive, so they
  // are treated like `unavailable` ones (skip them, with a confirm) instead of waiting forever.
  const stuck = downloading > 0 && link !== undefined && cameraGone(project, link);
  if (downloading > 0 && !stuck) return { kind: 'waiting', downloading };
  const unavailable = frames.filter((f) => f.unavailable).length + (stuck ? downloading : 0);
  const playable = playableItems(project).length;
  if (playable === 0) return { kind: 'empty' };
  if (unavailable > 0 && !confirmedSkip) return { kind: 'confirm', unavailable, frames: playable };
  return { kind: 'ready', frames: playable, skipped: unavailable };
}

// --- the state machine -------------------------------------------------------------------------

export type ExportFailure = 'frame' | 'sprite' | 'codec' | 'space' | 'unknown';

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

/** A sticker's sprite could not be loaded: the export fails instead of silently dropping the sticker. */
export class SpriteLoadError extends Error {
  readonly code = 'SPRITE_LOAD_FAILED';
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SpriteLoadError';
  }
}

export function classifyFailure(e: unknown): ExportFailure {
  if (e instanceof ExportFrameError) return 'frame';
  if (e instanceof SpriteLoadError) return 'sprite';
  if (e instanceof NoCodecError) return 'codec';
  if ((e as { code?: unknown } | null)?.code === 'NO_SPACE') return 'space';
  return 'unknown';
}

/** The canvas the frame and its stickers are composed on, and the snapshot taken from it. */
export interface ComposeCanvas {
  ctx: Ctx2D;
  /** A copy of what is drawn now (a VideoFrame), so the next composition cannot overwrite it. */
  snapshot(): ExportImage;
}

export const createOffscreenCompose = (width: number, height: number): ComposeCanvas => {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('export: no 2d context');
  return { ctx: ctx as unknown as Ctx2D, snapshot: () => new VideoFrame(canvas, { timestamp: 0 }) };
};

/** Sprites are rasterized at the largest bucket: a full-width sticker is 1440 px. */
export const EXPORT_SPRITE_BUCKET = 1024;

export interface ExportDeps {
  /** The current project (read at start and again after the pause). */
  getProject: () => Project | null;
  /** Camera connection, for the gate (frames that cannot arrive any more are skippable). */
  link?: () => CameraLink | undefined;
  transfer: TransferPause;
  /** App-wide flag; shooting is blocked while it is on. */
  exporting: Store<boolean>;
  /** Closes the player ring buffer (`PlayViewHandle.release`). */
  releasePlayer: () => void;
  frameSource: FrameSource;
  /** Preloads every sprite the movie uses (default: a SpriteCache). */
  sprites?: Pick<SpriteCache, 'preload'>;
  /** Default: an OffscreenCanvas of the export size. */
  createCanvas?: (width: number, height: number) => ComposeCanvas;
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

interface Composer {
  load(index: number, opts: { signal: AbortSignal }): Promise<ExportImage>;
  /** Closes the cached decoded frame. */
  dispose(): void;
}

const ignore = () => {};

/**
 * `source.load` of the export: decodes the entry's frame (the last decoded frame is reused when the
 * next entry is a copy of it), draws frame + stickers onto one canvas and returns a snapshot, so the
 * prefetched frame never shares pixels with the one being encoded. The draw and the snapshot run in
 * one synchronous step, so two loads in flight cannot interleave on the canvas.
 */
function createComposer(project: Project, items: ReturnType<typeof playableItems>, sprites: PinnedSprites | undefined, deps: ExportDeps): Composer {
  const stickers = project.stickers ?? [];
  const canvas = (deps.createCanvas ?? createOffscreenCompose)(EXPORT_WIDTH, EXPORT_HEIGHT);
  let cached: { frameId: string; bitmap: Promise<ImageBitmap> } | null = null;
  const closeLater = (c: typeof cached) => void c?.bitmap.then((b) => b.close(), ignore);
  return {
    async load(i, { signal }) {
      const { id, frameId } = items[i];
      let mine = cached;
      if (!mine || mine.frameId !== frameId) {
        // an earlier load awaits the old bitmap before this close runs (reactions run in order)
        closeLater(cached);
        mine = cached = { frameId, bitmap: deps.frameSource.load(project.id, frameId, signal) };
      }
      let bitmap: ImageBitmap;
      try {
        bitmap = await mine.bitmap;
      } catch (e) {
        if (cached === mine) cached = null; // a retry decodes again
        throw e;
      }
      drawFrame(canvas.ctx, bitmap);
      drawStickers(canvas.ctx, stickers, id, (hex) => sprites?.get(hex));
      return canvas.snapshot();
    },
    dispose() {
      closeLater(cached);
      cached = null;
    },
  };
}

const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AbortError';

export function createExportController(deps: ExportDeps): ExportController {
  const state = createStore<ExportState>({ phase: 'idle' });
  const spriteCache = deps.sprites ?? new SpriteCache();
  let abort: AbortController | null = null;
  let running = false;

  async function run(): Promise<void> {
    const ctl = (abort = new AbortController());
    let skipped = 0;
    let pinned: PinnedSprites | undefined;
    let composer: Composer | undefined;
    let final: ExportState;
    state.set({ phase: 'preparing' });
    deps.exporting.set(true);
    try {
      deps.releasePlayer();
      await deps.transfer.pause();
      // Downloads that finished while pausing are included; shooting is blocked, so nothing else changed.
      const project = deps.getProject();
      if (!project) throw new Error('project is gone');
      const items = playableItems(project);
      if (items.length === 0) throw new Error('nothing to export');
      skipped = skippedCount(project);
      const fps = project.fps;
      const bitrate = deps.bitrate ?? EXPORT_BITRATE;
      const stickers = project.stickers ?? [];
      const entryIds = new Set(items.map((e) => e.id));
      const hexcodes = stickers.filter((st) => st.on.some((id) => entryIds.has(id))).map((st) => st.emoji);
      if (hexcodes.length > 0) {
        try {
          pinned = await spriteCache.preload(hexcodes, EXPORT_SPRITE_BUCKET);
        } catch (e) {
          throw new SpriteLoadError(e);
        }
      }
      const pick = await pickCodec({ width: EXPORT_WIDTH, height: EXPORT_HEIGHT, fps, bitrate, isConfigSupported: deps.isConfigSupported });
      if (!pick.chosen) throw new NoCodecError(pick.tried.map((t) => t.codecString));
      composer = createComposer(project, items, pinned, deps);
      const result = await exportVideo({
        source: { count: items.length, hold: (i) => items[i].hold, load: composer.load },
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
      composer?.dispose();
      pinned?.release();
      try {
        deps.transfer.resume();
      } catch (e) {
        console.error('export: transfer.resume failed', e); // the final state must still be set
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
      if (running || isActive(state.get()) || deps.exporting.get()) return { started: false, reason: 'busy' };
      const project = deps.getProject();
      if (!project) return { started: false, reason: 'no-project' };
      const gate = exportGate(project, opts.confirmedSkip === true, deps.link?.());
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
