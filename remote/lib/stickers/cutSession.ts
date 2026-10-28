/**
 * One segmenter run for the cut step, with a transparent reopen.
 *
 * The native session closes itself after 5 idle minutes (and deletes `tmp/seg-<handle>.*`, the
 * decoded picture included), so a `run` after a long pause rejects with `NO_SESSION`. The cut step
 * keeps the decoded picture (`Img`, <= 1024 px) in memory anyway, so the simplest robust recovery is
 * to write that picture back to `tmp/` as a PNG, `open` it again (the native side deletes it) and
 * retry the run once. Coordinates are normalized, so the same strokes stay valid.
 */
import { SegError, type SegClient, type SegMaskResult, type SegStrokeArg } from './segClient';
import type { Img } from './stickerize';

export async function runCut(seg: SegClient, strokes: SegStrokeArg[], reopen: () => Promise<void>): Promise<SegMaskResult> {
  try {
    return await seg.run(strokes);
  } catch (e) {
    if (!(e instanceof SegError) || e.code !== 'NO_SESSION') throw e;
  }
  await reopen();
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
export function reopenFrom(seg: SegClient, photo: () => Img | null, io: ReopenIO): () => Promise<void> {
  return async () => {
    const img = photo();
    if (!img) throw new SegError('NO_SESSION', 'no picture to reopen');
    const path = `tmp/seg-src-${io.uuid()}.png`;
    await io.write(path, await io.encodePng(img));
    try {
      await seg.open(path);
    } catch (e) {
      await io.remove(path); // open deletes the source only when it succeeds
      throw e;
    }
  };
}
