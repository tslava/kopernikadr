import { describe, expect, it } from 'vitest';
import type { Sticker } from '../projects/model';
import { drawFrame, drawStickers, stickerPaint, type Ctx2D } from './compose';
import { stickerBox } from './stickerGeometry';

function recorder(width: number, height: number) {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]) => void calls.push([name, ...a]);
  const ctx: Ctx2D = {
    canvas: { width, height },
    fillStyle: '',
    fillRect: rec('fillRect'),
    drawImage: rec('drawImage') as Ctx2D['drawImage'],
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    rotate: rec('rotate'),
  };
  return { ctx, calls };
}

const img = (id: string, w = 1440, h = 1080) => ({ id, width: w, height: h }) as unknown as ImageBitmap;
const stk = (id: string, emoji: string, on: string[], over: Partial<Sticker> = {}): Sticker => ({ id, emoji, x: 0.5, y: 0.5, size: 0.25, rot: 0, on, ...over });

describe('drawFrame', () => {
  it('fills the canvas with a frame of the same aspect, no bars', () => {
    const { ctx, calls } = recorder(1440, 1080);
    const b = img('a');
    drawFrame(ctx, b);
    expect(calls).toEqual([['drawImage', b, 0, 0, 1440, 1080]]);
  });

  it('letterboxes a wider frame, centred, over black', () => {
    const { ctx, calls } = recorder(1440, 1080);
    const b = img('w', 1920, 1080);
    drawFrame(ctx, b);
    expect(calls[0]).toEqual(['fillRect', 0, 0, 1440, 1080]);
    expect(calls[1]).toEqual(['drawImage', b, 0, 1080 / 2 - 810 / 2, 1440, 810]);
  });

  it('scales a smaller 4:3 frame up to the canvas', () => {
    const { ctx, calls } = recorder(1440, 1080);
    const b = img('s', 720, 540);
    drawFrame(ctx, b);
    expect(calls).toEqual([['drawImage', b, 0, 0, 1440, 1080]]);
  });
});

describe('drawStickers', () => {
  const sprites: Record<string, ImageBitmap> = { A: img('A', 1024, 1024), B: img('B', 1024, 1024) };
  const lookup = (h: string) => sprites[h];

  it('draws only the stickers on this entry, in array order', () => {
    const { ctx, calls } = recorder(1440, 1080);
    drawStickers(ctx, [stk('s1', 'A', ['e1', 'e2']), stk('s2', 'B', ['e2']), stk('s3', 'B', ['e1'])], 'e1', lookup);
    expect(calls.filter((c) => c[0] === 'drawImage').map((c) => c[1])).toEqual([sprites.A, sprites.B]);
    const other = recorder(1440, 1080);
    drawStickers(other.ctx, [stk('s1', 'A', ['e1', 'e2']), stk('s2', 'B', ['e2'])], 'e2', lookup);
    expect(other.calls.filter((c) => c[0] === 'drawImage').map((c) => c[1])).toEqual([sprites.A, sprites.B]);
  });

  it('transforms like the geometry: translate to the centre, rotate, square box', () => {
    const { ctx, calls } = recorder(1440, 1080);
    const s = stk('s', 'A', ['e'], { x: 0.25, y: 0.75, size: 0.5, rot: 90 });
    drawStickers(ctx, [s], 'e', lookup);
    const b = stickerBox(s, 1440, 1080);
    expect(calls).toEqual([
      ['save'],
      ['translate', b.cx, b.cy],
      ['rotate', Math.PI / 2],
      ['drawImage', sprites.A, -b.side / 2, -b.side / 2, b.side, b.side],
      ['restore'],
    ]);
  });

  it('skips a missing sprite and draws nothing without an entry', () => {
    const { ctx, calls } = recorder(1440, 1080);
    drawStickers(ctx, [stk('s', 'ZZ', ['e'])], 'e', lookup);
    expect(calls).toEqual([]);
    drawStickers(ctx, [stk('s', 'A', ['e'])], null, lookup);
    expect(calls).toEqual([]);
  });
});

const MY = 'my:0123abcd-0123-4abc-8abc-0123456789ab';

describe('stickerPaint', () => {
  it('draws a loaded sprite, placeholders a failed custom one, skips everything else', () => {
    expect(stickerPaint(MY, true, false)).toBe('draw');
    expect(stickerPaint('1F436', true, false)).toBe('draw');
    expect(stickerPaint(MY, false, true)).toBe('placeholder');
    expect(stickerPaint(MY, false, false)).toBe('skip'); // still loading
    expect(stickerPaint('1F436', false, true)).toBe('skip'); // unknown OpenMoji
  });

  it('drawStickers puts the placeholder at the sticker geometry only when told it failed', () => {
    const s = stk('s', MY, ['e'], { x: 0.25, y: 0.75, size: 0.5, rot: 90 });
    const none = recorder(1440, 1080);
    drawStickers(none.ctx, [s], 'e', () => undefined);
    expect(none.calls).toEqual([]);
    const { ctx, calls } = recorder(1440, 1080);
    const extra: unknown[][] = [];
    Object.assign(ctx, { beginPath: () => extra.push(['beginPath']), roundRect: (...a: unknown[]) => extra.push(['roundRect', ...a]), fill: () => {}, stroke: () => {}, setLineDash: () => {}, fillText: (...a: unknown[]) => extra.push(['fillText', ...a]) });
    drawStickers(ctx, [s], 'e', () => undefined, (id) => id === MY);
    const b = stickerBox(s, 1440, 1080);
    expect(calls.slice(0, 3)).toEqual([['save'], ['translate', b.cx, b.cy], ['rotate', Math.PI / 2]]);
    expect(calls.at(-1)).toEqual(['restore']);
    expect(extra.find((c) => c[0] === 'roundRect')?.slice(1, 5)).toEqual([-b.side / 2, -b.side / 2, b.side, b.side]);
    expect(extra.find((c) => c[0] === 'fillText')?.[1]).toBe('?');
  });
});
