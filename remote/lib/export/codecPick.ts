// Codec choice for the MP4 export (ARCHITECTURE §5.7): ask WebCodecs which encoder config works,
// best first. The configs mirror what Mediabunny 1.61.4 passes to `VideoEncoder.configure` for a
// `VideoSampleSource` with `fullCodecString` + `Quality({bitrate})` (see `buildVideoEncoderConfigs`
// in mediabunny/dist/modules/src/encode.js), so a "supported" here means the real export can open
// the same encoder.

export type ExportVideoCodec = 'avc' | 'vp9';

export interface CodecCandidate {
  /** Mediabunny's codec name (`VideoEncodingConfig.codec`). */
  codec: ExportVideoCodec;
  /** Full WebCodecs codec string; goes to Mediabunny as `fullCodecString`. */
  codecString: string;
  label: string;
}

/**
 * Level 4.0 everywhere (fits ≤1920×1080 at 30 fps; Mediabunny itself derives 4.0 for 1440×1080).
 * The VP9 level is not cosmetic: the MP4 muxer copies the codec string's profile/level/bit depth
 * into the `vpcC` box, so `vp09.00.10.08` (level 1.0) would label a 1440×1080 stream as level 1.
 */
export const CODEC_LADDER: readonly CodecCandidate[] = [
  { codec: 'avc', codecString: 'avc1.640028', label: 'AVC High 4.0' },
  { codec: 'avc', codecString: 'avc1.4d0028', label: 'AVC Main 4.0' },
  { codec: 'avc', codecString: 'avc1.42e028', label: 'AVC Constrained Baseline 4.0' },
  { codec: 'vp9', codecString: 'vp09.00.40.08', label: 'VP9 profile 0, 4.0, 8-bit (in MP4)' },
];

export interface CodecPickInput {
  width: number;
  height: number;
  fps: number;
  /** Bits per second. */
  bitrate: number;
  /** Defaults to `VideoEncoder.isConfigSupported`; injectable for tests. */
  isConfigSupported?: (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>;
  ladder?: readonly CodecCandidate[];
}

export interface CodecTry {
  codecString: string;
  supported: boolean;
  error?: string;
}

export interface CodecPickResult {
  /** The first supported candidate, or null if none. */
  chosen: CodecCandidate | null;
  /** Every candidate asked, in order (stops at the first supported one). */
  tried: CodecTry[];
  /** Codec strings that were asked and are not supported. */
  failed: string[];
}

/** The `VideoEncoderConfig` Mediabunny will configure for this candidate. */
export function encoderConfigFor(
  candidate: CodecCandidate,
  { width, height, fps, bitrate }: Pick<CodecPickInput, 'width' | 'height' | 'fps' | 'bitrate'>,
): VideoEncoderConfig {
  return {
    codec: candidate.codecString,
    width,
    height,
    bitrate,
    bitrateMode: 'variable',
    framerate: fps,
    alpha: 'discard',
    ...(candidate.codec === 'avc' ? { avc: { format: 'avc' as const } } : {}),
  };
}

function defaultIsConfigSupported(): CodecPickInput['isConfigSupported'] {
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  return VE ? (config) => VE.isConfigSupported(config) : undefined;
}

export async function pickCodec(input: CodecPickInput): Promise<CodecPickResult> {
  const isConfigSupported = input.isConfigSupported ?? defaultIsConfigSupported();
  const tried: CodecTry[] = [];
  for (const candidate of input.ladder ?? CODEC_LADDER) {
    const { codecString } = candidate;
    if (!isConfigSupported) {
      tried.push({ codecString, supported: false, error: 'VideoEncoder unavailable' });
      continue;
    }
    try {
      const support = await isConfigSupported(encoderConfigFor(candidate, input));
      if (support.supported === true) {
        tried.push({ codecString, supported: true });
        return { chosen: candidate, tried, failed: failedOf(tried) };
      }
      tried.push({ codecString, supported: false });
    } catch (e) {
      tried.push({ codecString, supported: false, error: String(e) });
    }
  }
  return { chosen: null, tried, failed: failedOf(tried) };
}

const failedOf = (tried: CodecTry[]) => tried.filter((t) => !t.supported).map((t) => t.codecString);
