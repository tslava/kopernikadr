import { describe, expect, it, vi } from 'vitest';
import { CODEC_LADDER, encoderConfigFor, pickCodec } from './codecPick';

const input = { width: 1440, height: 1080, fps: 8, bitrate: 8_000_000 };

/** isConfigSupported that supports exactly the given codec strings. */
function supporting(...codecs: string[]) {
  return vi.fn(async (config: VideoEncoderConfig): Promise<VideoEncoderSupport> => ({
    supported: codecs.includes(config.codec),
    config,
  }));
}

describe('CODEC_LADDER', () => {
  it('goes AVC High → Main → Baseline → VP9, all level 4.0', () => {
    expect(CODEC_LADDER.map((c) => c.codecString)).toEqual([
      'avc1.640028',
      'avc1.4d0028',
      'avc1.42e028',
      'vp09.00.40.08',
    ]);
    expect(CODEC_LADDER.map((c) => c.codec)).toEqual(['avc', 'avc', 'avc', 'vp9']);
  });
});

describe('encoderConfigFor', () => {
  it('mirrors the config Mediabunny builds for an AVC track', () => {
    expect(encoderConfigFor(CODEC_LADDER[0], input)).toEqual({
      codec: 'avc1.640028',
      width: 1440,
      height: 1080,
      bitrate: 8_000_000,
      bitrateMode: 'variable',
      framerate: 8,
      alpha: 'discard',
      avc: { format: 'avc' },
    });
  });

  it('has no avc extension for VP9', () => {
    const config = encoderConfigFor(CODEC_LADDER[3], input);
    expect(config.codec).toBe('vp09.00.40.08');
    expect(config).not.toHaveProperty('avc');
  });
});

describe('pickCodec', () => {
  it('takes AVC High when supported and stops there', async () => {
    const isConfigSupported = supporting('avc1.640028', 'avc1.4d0028', 'vp09.00.40.08');
    const r = await pickCodec({ ...input, isConfigSupported });
    expect(r.chosen?.codecString).toBe('avc1.640028');
    expect(r.failed).toEqual([]);
    expect(r.tried).toEqual([{ codecString: 'avc1.640028', supported: true }]);
    expect(isConfigSupported).toHaveBeenCalledTimes(1);
    expect(isConfigSupported.mock.calls[0][0]).toEqual(encoderConfigFor(CODEC_LADDER[0], input));
  });

  it('falls down to Baseline and records what failed', async () => {
    const r = await pickCodec({ ...input, isConfigSupported: supporting('avc1.42e028') });
    expect(r.chosen?.codecString).toBe('avc1.42e028');
    expect(r.failed).toEqual(['avc1.640028', 'avc1.4d0028']);
  });

  it('falls back to VP9 in MP4 when no AVC encoder exists (the emulator)', async () => {
    const r = await pickCodec({ ...input, isConfigSupported: supporting('vp09.00.40.08') });
    expect(r.chosen).toEqual(CODEC_LADDER[3]);
    expect(r.failed).toEqual(['avc1.640028', 'avc1.4d0028', 'avc1.42e028']);
  });

  it('treats a rejection as unsupported and keeps its message', async () => {
    const isConfigSupported = vi.fn(async (config: VideoEncoderConfig) => {
      if (config.codec.startsWith('avc1')) throw new TypeError('bad config');
      return { supported: true, config };
    });
    const r = await pickCodec({ ...input, isConfigSupported });
    expect(r.chosen?.codec).toBe('vp9');
    expect(r.tried[0]).toEqual({ codecString: 'avc1.640028', supported: false, error: 'TypeError: bad config' });
  });

  it('returns no codec when nothing is supported', async () => {
    const r = await pickCodec({ ...input, isConfigSupported: supporting() });
    expect(r.chosen).toBeNull();
    expect(r.failed).toHaveLength(4);
  });

  it('reports every candidate as failed without WebCodecs (Node, old WebView)', async () => {
    const r = await pickCodec(input);
    expect(r.chosen).toBeNull();
    expect(r.tried.every((t) => !t.supported && t.error === 'VideoEncoder unavailable')).toBe(true);
  });

  it('accepts a custom ladder', async () => {
    const ladder = [CODEC_LADDER[3]];
    const r = await pickCodec({ ...input, ladder, isConfigSupported: supporting('vp09.00.40.08') });
    expect(r.chosen).toBe(CODEC_LADDER[3]);
  });
});
