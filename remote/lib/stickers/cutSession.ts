/**
 * One segmenter run for the cut step, with a transparent reopen.
 *
 * The native session closes itself after 5 idle minutes (and deletes `tmp/seg-<handle>.*`, the
 * decoded picture included), so a `run` after a long pause rejects with `NO_SESSION`. The cut step
 * keeps the decoded picture (`Img`, <= 1024 px) in memory anyway, so the simplest robust recovery is
 * to write that picture back to `tmp/` as a PNG, `open` it again (the native side deletes it) and
 * retry the run once. Coordinates are normalized, so the same strokes stay valid.
 */
import { SegError, SegSupersededError, type SegClient, type SegMaskResult, type SegStrokeArg } from './segClient';
import type { Img } from './stickerize';

/**
 * `isCurrent` says whether this run is still the newest one. Only the newest run recovers: an obsolete
 * one gives up with [SegSupersededError] before reopening (a reopen cancels a queued run, so an obsolete
 * recovery would cancel the newest stroke's run) and again before retrying; the newer run recovers itself.
 */
export async function runCut(
  seg: SegClient,
  strokes: SegStrokeArg[],
  reopen: (isCurrent: () => boolean) => Promise<void>,
  isCurrent: () => boolean = () => true,
): Promise<SegMaskResult> {
  try {
    return await seg.run(strokes);
  } catch (e) {
    if (!(e instanceof SegError) || e.code !== 'NO_SESSION') throw e;
  }
  if (!isCurrent()) throw new SegSupersededError();
  await reopen(isCurrent);
  if (!isCurrent()) throw new SegSupersededError();
  return seg.run(strokes);
}

export interface ReopenIO {
  encodePng(img: Img): Promise<Uint8Array>;
  /** Writes a store-relative file under `tmp/`. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  uuid(): string;
}

/** A `reopen` for [runCut]: `open`s a fresh session on a PNG of `photo`. */
export function reopenFrom(seg: SegClient, photo: () => Img | null, io: ReopenIO): (isCurrent?: () => boolean) => Promise<void> {
  return async (isCurrent = () => true) => {
    const img = photo();
    if (!img) throw new SegError('NO_SESSION', 'no picture to reopen');
    const path = `tmp/seg-src-${io.uuid()}.png`;
    // every failure path (encode, write, a superseded run, open) leaves no file behind; `open` deletes the
    // source itself only when it succeeds
    const cleanup = () => io.remove(path).catch(() => undefined);
    try {
      const bytes = await io.encodePng(img);
      await io.write(path, bytes);
      if (!isCurrent()) {
        // `open` would cancel the newest queued run: the newer cut recovers itself
        throw new SegSupersededError();
      }
      await seg.open(path);
    } catch (e) {
      await cleanup();
      throw e;
    }
  };
}
