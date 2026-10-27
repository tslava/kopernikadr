// A short shutter "click-clack" synthesised with WebAudio (no files); port of remote-lite's sound.js.
let ctx: AudioContext | null = null;

function noiseBuffer(ac: AudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  return buf;
}

function click(ac: AudioContext, at: number, o: { freq: number; gain: number; dur: number }): void {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, o.dur);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = o.freq;
  bp.Q.value = 0.9;
  const g = ac.createGain();
  g.gain.setValueAtTime(o.gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + o.dur);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(at);
  src.stop(at + o.dur + 0.02);
}

/** Call from a user gesture (autoplay policy). Never throws: sound is a nicety. */
export function playShutter(): void {
  try {
    const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = g.AudioContext ?? g.webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + 0.005;
    click(ctx, t, { freq: 3200, gain: 0.9, dur: 0.045 });
    const thump = ctx.createOscillator();
    const tg = ctx.createGain();
    thump.frequency.setValueAtTime(180, t);
    thump.frequency.exponentialRampToValueAtTime(70, t + 0.06);
    tg.gain.setValueAtTime(0.35, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    thump.connect(tg).connect(ctx.destination);
    thump.start(t);
    thump.stop(t + 0.08);
    click(ctx, t + 0.075, { freq: 2200, gain: 0.6, dur: 0.06 });
  } catch {
    // ignore
  }
}
