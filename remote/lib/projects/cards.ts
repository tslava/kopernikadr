/** Pure view model of the projects list (plan Task 16). */
import type { Project, ProjectIndex } from './model';

export interface ProjectCard {
  id: string;
  name: string;
  createdAt: string;
  /** Visible frames (not in a frame-Undo window). */
  frameCount: number;
  /** The first local visible frame (lowest seq) whose `thumb` is the cover; null = no cover yet. */
  coverFrameId: string | null;
  cameraId: string | null;
}

/**
 * Newest first. Projects in the Undo window are hidden. "Odzyskany ..." (recovered) projects are
 * ordinary projects and need no special handling.
 */
export function projectCards(index: ProjectIndex, projects: Readonly<Record<string, Project>>): ProjectCard[] {
  const pending = new Set(index.pendingProjectDeletes.map((p) => p.id));
  return index.projects
    .filter((e) => !pending.has(e.id))
    .map((e): ProjectCard => {
      const p = projects[e.id];
      const visible = (p?.frames ?? []).filter((f) => f.hiddenUntil === null);
      const cover = visible.filter((f) => f.state === 'local').sort((a, b) => a.seq - b.seq)[0];
      return {
        id: e.id,
        name: e.name,
        createdAt: e.createdAt,
        frameCount: visible.length,
        coverFrameId: cover?.frameId ?? null,
        cameraId: p?.cameraId ?? null,
      };
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
}

/** "Film N" with the smallest N > count that is not taken yet. `label` is the localized template. */
export function defaultProjectName(existingNames: readonly string[], label: (n: number) => string): string {
  const taken = new Set(existingNames.map((n) => n.trim()));
  let n = existingNames.length + 1;
  while (taken.has(label(n))) n++;
  return label(n);
}

/**
 * Tap on a card: capture, unless the project is bound to a different camera than the one we talk
 * to (connected, else the remembered one): then play only.
 */
export function cardTarget(card: Pick<ProjectCard, 'cameraId'>, currentCameraId: string | null): 'capture' | 'play' {
  return card.cameraId !== null && currentCameraId !== null && card.cameraId !== currentCameraId ? 'play' : 'capture';
}
