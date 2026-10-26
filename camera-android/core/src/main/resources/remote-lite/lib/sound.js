// A short shutter "click-clack" synthesised with WebAudio (no audio files).

let ctx = null;

function noiseBuffer(ac, seconds) {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  return buf;
}

function click(ac, at, { freq, gain, dur }) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 0.9;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(at);
  src.stop(at + dur + 0.02);
}

/** Must be called from a user gesture the first time (autoplay policy). */
export function playShutter() {
  try {
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') ctx.resume();
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
    // sound is a nicety
  }
}
