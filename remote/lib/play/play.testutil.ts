import type { FrameEntry } from '../projects/model';
import type { Clock } from './player';

export interface FakeBitmap {
  id: string;
  closed: boolean;
  close(): void;
}
export const bmp = (id: string): FakeBitmap => ({ id, closed: false, close() { this.closed = true; } });
export const asBitmap = (b: FakeBitmap): ImageBitmap => b as unknown as ImageBitmap;

export const frame = (n: number, over: Partial<FrameEntry> = {}): FrameEntry => ({
  frameId: `f${n}`,
  seq: n,
  bytes: 1,
  sha256: 'x',
  state: 'local',
  hiddenUntil: null,
  ...over,
});

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

export class FakeClock implements Clock {
  t = 0;
  private next = 1;
  private cbs = new Map<number, () => void>();
  now = (): number => this.t;
  request = (cb: () => void): number => {
    const h = this.next++;
    this.cbs.set(h, cb);
    return h;
  };
  cancel = (h: number): void => void this.cbs.delete(h);
  get pending(): number {
    return this.cbs.size;
  }
  /** Advance in `step` ms (a rAF every step), letting promises settle between steps. */
  async advance(ms: number, step = 4): Promise<void> {
    for (let done = 0; done < ms; done += step) {
      this.t += step;
      const run = [...this.cbs.values()];
      this.cbs.clear();
      run.forEach((cb) => cb());
      await flush();
    }
  }
}
