// One export controller per app (like the project-deletion controller): re-entering the Play
// screen while an export runs shows the same running export instead of a second one. The parts
// that belong to a mounted Play screen (project, player ring, frame source) are re-bound on mount.
import type { FrameSource } from '../play/frameSource';
import type { Project } from '../projects/model';
import { openmojiUrlOf, type SpriteUrlOf } from '../render/catalog';
import type { Store } from '../state/store';
import type { TransferPause } from '../transfer/types';
import type { ExportWriter } from './mediabunnyExport';
import { createExportController, type CameraLink, type ExportController } from './projectExport';

export interface ExportBindings {
  getProject: () => Project | null;
  link?: () => CameraLink | undefined;
  releasePlayer: () => void;
  frameSource: FrameSource;
  spriteUrlOf?: (projectId: string) => SpriteUrlOf;
}

export interface SharedExport {
  controller: ExportController;
  /** The latest mount wins. The binding is kept after unmount so a running export can finish. */
  bind(b: ExportBindings): void;
}

export interface SharedExportEnv {
  transfer: TransferPause;
  exporting: Store<boolean>;
  createWriter: () => ExportWriter;
}

const shared = new WeakMap<object, SharedExport>();

export function sharedExportFor(key: object, env: SharedExportEnv): SharedExport {
  let s = shared.get(key);
  if (!s) {
    let b: ExportBindings | null = null;
    const controller = createExportController({
      getProject: () => b?.getProject() ?? null,
      link: () => b?.link?.(),
      transfer: env.transfer,
      exporting: env.exporting,
      releasePlayer: () => b?.releasePlayer(),
      frameSource: { load: (...a) => b!.frameSource.load(...a) },
      createWriter: env.createWriter,
      spriteUrlOf: (pid) => b?.spriteUrlOf?.(pid) ?? openmojiUrlOf,
    });
    s = { controller, bind: (x) => void (b = x) };
    shared.set(key, s);
  }
  return s;
}
