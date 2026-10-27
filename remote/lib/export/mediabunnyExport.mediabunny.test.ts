// The real Mediabunny muxer + StreamTarget in Node. Node has no WebCodecs, so a registered custom
// encoder emits fake VP9 packets and samples are built from raw pixels; everything between the
// encoder and the writer (MP4 muxing, chunking, positions, finalize) is Mediabunny's own code.
import {
  ALL_FORMATS,
  BufferSource,
  CustomVideoEncoder,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  VideoSample,
  registerEncoder,
} from 'mediabunny';
import { beforeAll, describe, expect, it } from 'vitest';
import { CODEC_LADDER } from './codecPick';
import { exportVideo, mediabunnyEncoderFactory, type ExportImage, type ExportWriter } from './mediabunnyExport';

const W = 64;
const H = 48;
const PACKET = 3000;

class FakeVp9Encoder extends CustomVideoEncoder {
  static override supports(codec: string) {
    return codec === 'vp9';
  }
  private n = 0;
  init() {}
  encode(sample: VideoSample) {
    const key = this.n % 8 === 0;
    const packet = new EncodedPacket(new Uint8Array(PACKET).fill(this.n & 0xff), key ? 'key' : 'delta', sample.timestamp, sample.duration);
    this.onPacket(
      packet,
      this.n === 0 ? { decoderConfig: { codec: this.config.codec, codedWidth: W, codedHeight: H } } : undefined,
    );
    this.n++;
  }
  flush() {}
  close() {}
}

beforeAll(() => registerEncoder(FakeVp9Encoder));

const createEncoder = mediabunnyEncoderFactory({
  toSample: (_image, timestamp, duration) =>
    new VideoSample(new Uint8Array(W * H * 4), { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp, duration }),
});

function memoryWriter() {
  const writes: { position: number; size: number }[] = [];
  let file = new Uint8Array(0);
  const calls: string[] = [];
  const writer: ExportWriter = {
    async open() {
      calls.push('open');
    },
    async writeAt(position, bytes) {
      writes.push({ position, size: bytes.byteLength });
      const end = position + bytes.byteLength;
      if (end > file.length) {
        const grown = new Uint8Array(end);
        grown.set(file);
        file = grown;
      }
      file.set(bytes, position);
    },
    async close() {
      calls.push('close');
    },
    async publish(name) {
      calls.push(`publish ${name}`);
      return { uri: 'content://x' };
    },
    async abort() {
      calls.push('abort');
    },
  };
  return { writer, writes, calls, file: () => file };
}

const frames = (count: number) => ({
  count,
  load: async () => ({ close() {} }) as unknown as ExportImage,
});

describe('createMediabunnyEncoder (real Mediabunny 1.61.4, fake VP9 packets)', () => {
  it('produces a valid MP4 through positional, ≤chunkSize writes', async () => {
    const m = memoryWriter();
    const fps = 8;
    const n = 20;
    const chunkSize = 4096;
    const r = await exportVideo({
      source: frames(n),
      fps,
      width: W,
      height: H,
      bitrate: 1_000_000,
      codec: CODEC_LADDER[3],
      writer: m.writer,
      displayName: 'it',
      chunkSize,
      createEncoder,
    });

    expect(m.calls).toEqual(['open', 'close', 'publish it']);
    expect(r.bytes).toBe(m.file().length);
    expect(r.writes).toBe(m.writes.length);
    expect(r.bytes).toBeGreaterThan(n * PACKET);
    expect(m.writes.every((w) => w.size <= chunkSize)).toBe(true);
    // fastStart: false → the mdat header is patched after later data was written
    let end = 0;
    let backwards = 0;
    for (const w of m.writes) {
      if (w.position < end) backwards++;
      end = Math.max(end, w.position + w.size);
    }
    expect(backwards).toBeGreaterThan(0);

    const file = m.file();
    const ascii = (at: number) => String.fromCharCode(...file.subarray(at, at + 4));
    expect(ascii(4)).toBe('ftyp');

    const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    expect(track?.codec).toBe('vp9');
    expect(await track!.getCodecParameterString()).toBe('vp09.00.40.08');
    expect(await input.computeDuration()).toBeCloseTo(n / fps, 5);
    let packets = 0;
    for await (const p of new EncodedPacketSink(track!).packets()) {
      expect(p.byteLength).toBe(PACKET);
      packets++;
    }
    expect(packets).toBe(n);
  });

  it('aborts and never publishes when a write fails mid-stream', async () => {
    const m = memoryWriter();
    let count = 0;
    const writeAt = m.writer.writeAt;
    m.writer.writeAt = async (p, b) => {
      if (++count === 3) throw Object.assign(new Error('no space'), { code: 'NO_SPACE' });
      return writeAt(p, b);
    };
    const err = await exportVideo({
      source: frames(20),
      fps: 8,
      width: W,
      height: H,
      bitrate: 1_000_000,
      codec: CODEC_LADDER[3],
      writer: m.writer,
      displayName: 'it',
      chunkSize: 4096,
      createEncoder,
    }).catch((e) => e);
    expect(err.code).toBe('NO_SPACE');
    expect(m.calls).toEqual(['open', 'abort']);
  });

  it('cancel stops the real output and aborts the file', async () => {
    const m = memoryWriter();
    const ac = new AbortController();
    const err = await exportVideo({
      source: frames(20),
      fps: 8,
      width: W,
      height: H,
      bitrate: 1_000_000,
      codec: CODEC_LADDER[3],
      writer: m.writer,
      displayName: 'it',
      chunkSize: 4096,
      createEncoder,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'encoding' && p.i === 5) ac.abort();
      },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(m.calls).toEqual(['open', 'abort']);
  });
});
