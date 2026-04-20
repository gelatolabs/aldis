"use strict";

let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { audioCtx = new Ctor(); } catch (e) { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Warm up audio output by playing a silent tone to ensure the first real
// sounds play when we want them to.
const AUDIO_WARMUP_MS = 220;
let audioRunningSince = -1;
let audioConfirmedWarm = false;

function audioReady() {
  const c = ensureAudio();
  if (!c) return true;
  if (c.state !== "running") {
    audioRunningSince = -1;
    return false;
  }
  if (audioConfirmedWarm) return true;
  if (audioRunningSince < 0) audioRunningSince = performance.now();
  if (performance.now() - audioRunningSince < AUDIO_WARMUP_MS) return false;
  audioConfirmedWarm = true;
  return true;
}

function primeAudio() {
  if (audioConfirmedWarm) return;
  const c = ensureAudio();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  g.gain.value = 0;
  osc.connect(g);
  g.connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.02);
}

// Short envelope-shaped beep; used for dot and dash feedback.
function playTone(freq, durationMs, type) {
  const c = ensureAudio();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type || "sine";
  osc.frequency.value = freq;
  const now = c.currentTime;
  const dur = durationMs / 1000;
  const vol = (settings.volume || 0) * 0.35;
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(vol,  now + 0.008);
  gain.gain.linearRampToValueAtTime(vol,  now + Math.max(0.01, dur - 0.02));
  gain.gain.linearRampToValueAtTime(0,    now + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

function playDot()  { playTone(760, 90);  }
function playDash() { playTone(520, 210); }

// ---- Shared reverb ----

let _reverbInput = null;

function ensureReverb() {
  const c = ensureAudio();
  if (!c || _reverbInput) return;
  const conv = c.createConvolver();
  const len = Math.max(1, Math.floor(c.sampleRate * 0.28));
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.8);
    }
  }
  conv.buffer = ir;
  const wet = c.createGain();
  wet.gain.value = 0.28;
  _reverbInput = c.createGain();
  _reverbInput.connect(conv);
  conv.connect(wet);
  wet.connect(c.destination);
}

function sendToReverb(node, amount) {
  ensureReverb();
  if (!_reverbInput) return;
  const send = audioCtx.createGain();
  send.gain.value = amount;
  node.connect(send);
  send.connect(_reverbInput);
}

// Populate an AudioBuffer with filter-shaped "pink-ish" noise.
function fillPinkNoise(data) {
  let lastOut = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    lastOut = 0.75 * lastOut + 0.25 * white;
    data[i] = lastOut * 1.4;
  }
}

function createNoiseBuffer(c, durSec, sparse) {
  const n = Math.max(1, Math.floor(c.sampleRate * durSec));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  if (sparse) {
    for (let i = 0; i < n; i++) {
      d[i] = Math.random() < 0.32 ? (Math.random() * 2 - 1) * 0.95 : 0;
    }
  } else {
    fillPinkNoise(d);
  }
  return buf;
}

// Layered enemy-kill sound: splat, explosion, and burn. Each layer uses detuned
// sources, colored noise, and small randomizations so successive kills sound
// different, plus a small reverb tail.
function playExplosion(typeKey) {
  const c = ensureAudio();
  if (!c) return;
  ensureReverb();
  const now = c.currentTime;
  const master = (settings.volume || 0);

  // Higher pitch for runners, lower for heavies.
  const pMul = typeKey === "runner" ? 1.4
             : typeKey === "heavy"  ? 0.75
             :                        1;

  // --- Squish ----------------------------------------------------------
  // Brittle onset, irregular pitched pops, wet body with chaotic band movement,
  // and a bubbly ooze tail.
  {
    // Crack: short transient with strong midrange.
    {
      const n = c.createBufferSource();
      n.buffer = createNoiseBuffer(c, 0.014, false);
      const bp = c.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 1600 * pMul; bp.Q.value = 0.9;
      const g = c.createGain();
      g.gain.setValueAtTime(master * 0.48, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);
      n.connect(bp); bp.connect(g); g.connect(c.destination);
      sendToReverb(g, 0.35);
      n.start(now); n.stop(now + 0.017);
    }

    // 5-7 pitched pops: short sine with sharp pitch drop.
    const popCount = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < popCount; i++) {
      const t = now + 0.004 + Math.random() * 0.18;
      const f0 = (420 + Math.random() * 520) * pMul;
      const dur = 0.022 + Math.random() * 0.045;
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(master * (0.1 + Math.random() * 0.14),
                                     t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(c.destination);
      sendToReverb(g, 0.4);
      osc.start(t); osc.stop(t + dur + 0.01);
    }

    // Wet body: pink noise through three parallel bandpass filters at different
    // formants, each with an irregular staircase envelope.
    {
      const bodyDur = 0.32;
      const n = c.createBufferSource();
      n.buffer = createNoiseBuffer(c, bodyDur, false);
      const bands = [
        { f: 820  * pMul, q: 4.5, g: 0.28 },
        { f: 1650 * pMul, q: 3.8, g: 0.22 },
        { f: 2800 * pMul, q: 3.2, g: 0.14 },
      ];
      const mix = c.createGain();
      for (const b of bands) {
        const bp = c.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = b.f; bp.Q.value = b.q;
        const bg = c.createGain();
        // Start silent, ramp to a target, then wobble through random values
        // over the body's duration.
        bg.gain.setValueAtTime(0, now);
        bg.gain.linearRampToValueAtTime(master * b.g, now + 0.01);
        const steps = 7;
        for (let s = 1; s <= steps; s++) {
          const t = now + (s / steps) * bodyDur * 0.92;
          const v = master * b.g * (0.45 + Math.random() * 0.55);
          bg.gain.linearRampToValueAtTime(v, t);
        }
        bg.gain.exponentialRampToValueAtTime(0.0001, now + bodyDur);
        n.connect(bp); bp.connect(bg); bg.connect(mix);
      }
      mix.connect(c.destination);
      sendToReverb(mix, 0.38);
      n.start(now); n.stop(now + bodyDur + 0.02);
    }

    // Squelch: one bandpass whose center frequency hops chaotically between
    // cavity values.
    {
      const dur = 0.28;
      const n = c.createBufferSource();
      n.buffer = createNoiseBuffer(c, dur, false);
      const bp = c.createBiquadFilter();
      bp.type = "bandpass"; bp.Q.value = 5.5;
      const waypoints = [
        [now + 0.00,  1150 * pMul],
        [now + 0.045, 2400 * pMul],
        [now + 0.09,  1400 * pMul],
        [now + 0.14,  1900 * pMul],
        [now + 0.195, 1000 * pMul],
        [now + 0.26,   580 * pMul],
      ];
      bp.frequency.setValueAtTime(waypoints[0][1], waypoints[0][0]);
      for (let i = 1; i < waypoints.length; i++) {
        bp.frequency.exponentialRampToValueAtTime(waypoints[i][1],
                                                  waypoints[i][0]);
      }
      const g = c.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(master * 0.3, now + 0.008);
      g.gain.linearRampToValueAtTime(master * 0.2, now + 0.17);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      n.connect(bp); bp.connect(g); g.connect(c.destination);
      sendToReverb(g, 0.4);
      n.start(now); n.stop(now + dur);
    }

    // Ooze tail: lowpassed pink noise with a fast tremolo.
    {
      const start = now + 0.06;
      const dur = 0.38;
      const n = c.createBufferSource();
      n.buffer = createNoiseBuffer(c, dur, false);
      const lp = c.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1100 * pMul; lp.Q.value = 1.4;
      const g = c.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(master * 0.17, start + 0.06);
      g.gain.linearRampToValueAtTime(master * 0.1, start + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      // Tremolo LFO for bubbling motion.
      const lfo = c.createOscillator();
      lfo.type = "sine"; lfo.frequency.value = 18;
      const ld = c.createGain(); ld.gain.value = master * 0.08;
      lfo.connect(ld); ld.connect(g.gain);
      lfo.start(start); lfo.stop(start + dur);
      n.connect(lp); lp.connect(g); g.connect(c.destination);
      sendToReverb(g, 0.32);
      n.start(start); n.stop(start + dur);
    }
  }

  // --- Explosion -------------------------------------------------------
  {
    const start = now + 0.045;
    const dur = 0.4;
    const jit = 1 + (Math.random() - 0.5) * 0.12;

    // Initial crack: bright noise burst.
    const cBuf = createNoiseBuffer(c, 0.02, false);
    const cSrc = c.createBufferSource(); cSrc.buffer = cBuf;
    const cHp = c.createBiquadFilter();
    cHp.type = "highpass"; cHp.frequency.value = 3000 * pMul;
    const cg = c.createGain();
    cg.gain.setValueAtTime(master * 0.24, start);
    cg.gain.exponentialRampToValueAtTime(0.0001, start + 0.02);
    cSrc.connect(cHp); cHp.connect(cg); cg.connect(c.destination);
    sendToReverb(cg, 0.45);
    cSrc.start(start); cSrc.stop(start + 0.03);

    // Main body: pink noise with lowpass sweep + slow amplitude shake.
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, dur, false);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(3800 * pMul, start);
    lp.frequency.exponentialRampToValueAtTime(220 * pMul, start + dur);
    const env = c.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(master * 0.27, start + 0.022);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    n.connect(lp); lp.connect(env); env.connect(c.destination);
    sendToReverb(env, 0.35);
    // Amplitude shake at ~7Hz.
    const lfo = c.createOscillator();
    lfo.type = "sine"; lfo.frequency.value = 7;
    const lfoAmp = c.createGain(); lfoAmp.gain.value = master * 0.06;
    lfo.connect(lfoAmp); lfoAmp.connect(env.gain);
    lfo.start(start); lfo.stop(start + dur);
    n.start(start); n.stop(start + dur);

    // Detuned sub rumble: sine + triangle.
    for (const [type, f0, f1, gain] of [
      ["sine",    255, 58, 0.24],
      ["triangle", 235, 54, 0.16],
    ]) {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0 * jit * pMul, start);
      osc.frequency.exponentialRampToValueAtTime(f1 * pMul, start + 0.26);
      const og = c.createGain();
      og.gain.setValueAtTime(0, start);
      og.gain.linearRampToValueAtTime(master * gain, start + 0.008);
      og.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      osc.connect(og); og.connect(c.destination);
      sendToReverb(og, 0.2);
      osc.start(start); osc.stop(start + 0.34);
    }
  }

  // --- Burn crackle tail -----------------------------------------------
  {
    const start = now + 0.18;
    const dur = 0.5;
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, dur, true);
    const bp1 = c.createBiquadFilter();
    bp1.type = "bandpass"; bp1.frequency.value = 2400 * pMul; bp1.Q.value = 3.2;
    const bp2 = c.createBiquadFilter();
    bp2.type = "bandpass"; bp2.frequency.value = 4200 * pMul; bp2.Q.value = 2.2;
    const mix = c.createGain(); mix.gain.value = 0.75;
    const sidePath = c.createGain(); sidePath.gain.value = 0.45;
    const env = c.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(master * 0.13, start + 0.05);
    env.gain.linearRampToValueAtTime(master * 0.09, start + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    // Parallel bandpasses.
    n.connect(bp1); bp1.connect(mix); mix.connect(env);
    n.connect(bp2); bp2.connect(sidePath); sidePath.connect(env);
    env.connect(c.destination);
    sendToReverb(env, 0.3);
    n.start(start); n.stop(start + dur);
  }
}

// Upward chirp — versus reflect sound
function playBounce() {
  const c = ensureAudio();
  if (!c) return;
  const now = c.currentTime;
  const vol = (settings.volume || 0) * 0.35;
  const dur = 0.14;

  const osc = c.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(380, now);
  osc.frequency.exponentialRampToValueAtTime(920, now + dur);

  const g = c.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(vol, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.connect(g);
  g.connect(c.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// Two-stage damage cue: physical impact (click + thump + thud) followed by
// vocal "oof" grunt — detuned saws through three "UH" formants with vibrato and
// a breath noise layer.
function playDamage() {
  const c = ensureAudio();
  if (!c) return;
  ensureReverb();
  const now = c.currentTime;
  const master = (settings.volume || 0);
  // Slight pitch variation so repeated grunts don't sound identical.
  const pitchJit = 1 + (Math.random() - 0.5) * 0.08;

  // --- Physical impact -------------------------------------------------
  {
    // Sharp high click: short highpassed noise.
    const clk = c.createBufferSource();
    clk.buffer = createNoiseBuffer(c, 0.008, false);
    const clkHp = c.createBiquadFilter();
    clkHp.type = "highpass"; clkHp.frequency.value = 3000;
    const clkG = c.createGain();
    clkG.gain.setValueAtTime(master * 0.4, now);
    clkG.gain.exponentialRampToValueAtTime(0.0001, now + 0.008);
    clk.connect(clkHp); clkHp.connect(clkG); clkG.connect(c.destination);
    sendToReverb(clkG, 0.3);
    clk.start(now); clk.stop(now + 0.01);

    // Flesh thud: lowpassed pink noise burst, slight pitch resonance.
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, 0.08, false);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 3;
    lp.frequency.setValueAtTime(900, now);
    lp.frequency.exponentialRampToValueAtTime(380, now + 0.08);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0, now);
    ng.gain.linearRampToValueAtTime(master * 0.34, now + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    n.connect(lp); lp.connect(ng); ng.connect(c.destination);
    sendToReverb(ng, 0.35);
    n.start(now); n.stop(now + 0.1);
  }

  // --- Vocal "oof" -----------------------------------------------------
  // Klatt-style parallel-formant synthesis: a glottal-pulse source (custom
  // periodic wave, spectrum rolling off at 1/√n) driving three summed
  // formant bandpasses plus a quiet dry path for body. Long vowel at 128Hz.
  const oofStart = now + 0.04;
  const vowelDur = 0.22;
  const base = 145 * pitchJit;

  // Build a glottal pulse waveform via Fourier series with 1/√n rolloff —
  // richer in upper harmonics than a sawtooth (1/n) but less raspy than an
  // impulse train. Cached on audioCtx so repeat triggers don't rebuild.
  if (!audioCtx._oofWave) {
    const N = 24;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let n = 1; n < N; n++) real[n] = 1 / Math.sqrt(n);
    audioCtx._oofWave = audioCtx.createPeriodicWave(real, imag);
  }

  const src = c.createOscillator();
  src.setPeriodicWave(audioCtx._oofWave);
  src.frequency.setValueAtTime(base, oofStart);
  src.frequency.linearRampToValueAtTime(base * 0.78, oofStart + vowelDur);
  src.start(oofStart); src.stop(oofStart + vowelDur + 0.03);

  // Parallel formant bank for a rounded back-vowel between [u] and [ʌ] —
  // what "oof" sits on. Values from Klatt-ish tuning, widened slightly for
  // warmth.
  const vocal = c.createGain();
  for (const fm of [
    { f: 420,  q: 6,  g: 1.0  },
    { f: 960,  q: 9,  g: 0.4  },
    { f: 2600, q: 10, g: 0.14 },
  ]) {
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = fm.f; bp.Q.value = fm.q;
    const fg = c.createGain(); fg.gain.value = fm.g;
    src.connect(bp); bp.connect(fg); fg.connect(vocal);
  }
  // Dry path: keeps the voice from being perfectly filter-shaped.
  const dry = c.createGain(); dry.gain.value = 0.22;
  src.connect(dry); dry.connect(vocal);

  // Final radiation / mouth-opening lowpass around 2.8 kHz.
  const mouth = c.createBiquadFilter();
  mouth.type = "lowpass"; mouth.frequency.value = 2800; mouth.Q.value = 0.7;
  vocal.connect(mouth);

  // Breath noise mixed into the vocal path so the tone has air throughout, not
  // just at the edges.
  const breath = c.createBufferSource();
  breath.buffer = createNoiseBuffer(c, vowelDur + 0.04, false);
  const bBp = c.createBiquadFilter();
  bBp.type = "bandpass"; bBp.frequency.value = 900; bBp.Q.value = 0.6;
  const bG = c.createGain();
  bG.gain.setValueAtTime(0, oofStart);
  bG.gain.linearRampToValueAtTime(master * 0.09, oofStart + 0.03);
  bG.gain.exponentialRampToValueAtTime(0.0001, oofStart + vowelDur);
  breath.connect(bBp); bBp.connect(bG); bG.connect(mouth);
  breath.start(oofStart); breath.stop(oofStart + vowelDur + 0.04);

  // Vowel envelope — slow held attack, natural decay.
  const vowelEnv = c.createGain();
  vowelEnv.gain.setValueAtTime(0, oofStart);
  vowelEnv.gain.linearRampToValueAtTime(master * 0.8, oofStart + 0.025);
  vowelEnv.gain.linearRampToValueAtTime(master * 0.65, oofStart + vowelDur * 0.55);
  vowelEnv.gain.exponentialRampToValueAtTime(0.0001, oofStart + vowelDur);
  mouth.connect(vowelEnv); vowelEnv.connect(c.destination);
  sendToReverb(vowelEnv, 0.28);
}

// ---- Powerup sounds ----

function playPowerupKill(kind) {
  if (kind === "clear")  playBigExplosion();
  else if (kind === "freeze") playFreezeShatter();
  else if (kind === "heal")   playHealChoir();
}

// Bomb: larger, longer cousin of the regular explosion — deeper sub, bigger
// crack, and a long rumble tail.
function playBigExplosion() {
  const c = ensureAudio();
  if (!c) return;
  ensureReverb();
  const now = c.currentTime;
  const master = (settings.volume || 0);

  // Huge crack transient.
  {
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, 0.03, false);
    const hp = c.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 1500;
    const g = c.createGain();
    g.gain.setValueAtTime(master * 0.85, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
    n.connect(hp); hp.connect(g); g.connect(c.destination);
    sendToReverb(g, 0.5);
    n.start(now); n.stop(now + 0.04);
  }

  // Main body: long sweeping broadband noise.
  {
    const dur = 1.2;
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, dur, false);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(3800, now);
    lp.frequency.exponentialRampToValueAtTime(110, now + dur);
    const env = c.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(master * 0.85, now + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    n.connect(lp); lp.connect(env); env.connect(c.destination);
    sendToReverb(env, 0.5);
    // Slow 5 Hz tremor for motion.
    const lfo = c.createOscillator();
    lfo.type = "sine"; lfo.frequency.value = 5;
    const ld = c.createGain(); ld.gain.value = master * 0.2;
    lfo.connect(ld); ld.connect(env.gain);
    lfo.start(now); lfo.stop(now + dur);
    n.start(now); n.stop(now + dur);
  }

  // Deep sub rumble — triangle+sine detuned, longer than the regular kill.
  for (const [type, f0, f1, gain, dur] of [
    ["sine",    150, 30, 0.7, 0.9],
    ["triangle", 130, 26, 0.5, 0.95],
    ["sine",     75, 20, 0.45, 1.1],
  ]) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + dur * 0.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(master * gain, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g); g.connect(c.destination);
    sendToReverb(g, 0.3);
    osc.start(now); osc.stop(now + dur + 0.02);
  }

  // Long burn tail.
  {
    const start = now + 0.25;
    const dur = 1.25;
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, dur, true);
    const bp1 = c.createBiquadFilter();
    bp1.type = "bandpass"; bp1.frequency.value = 1800; bp1.Q.value = 3;
    const bp2 = c.createBiquadFilter();
    bp2.type = "bandpass"; bp2.frequency.value = 3800; bp2.Q.value = 2.2;
    const mix = c.createGain(); mix.gain.value = 0.75;
    const side = c.createGain(); side.gain.value = 0.4;
    const env = c.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(master * 0.35, start + 0.08);
    env.gain.linearRampToValueAtTime(master * 0.22, start + dur * 0.5);
    env.gain.linearRampToValueAtTime(master * 0.12, start + dur * 0.85);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    n.connect(bp1); bp1.connect(mix); mix.connect(env);
    n.connect(bp2); bp2.connect(side); side.connect(env);
    env.connect(c.destination);
    sendToReverb(env, 0.45);
    n.start(start); n.stop(start + dur);
  }
}

// Ice cube: a cluster of bell-like sine chimes with inharmonic partials, plus a
// high shimmer noise layer and a long reverberant tail.
function playFreezeShatter() {
  const c = ensureAudio();
  if (!c) return;
  ensureReverb();
  const now = c.currentTime;
  const master = (settings.volume || 0);

  // Bell chimes: each bell is a fundamental with a few inharmonic overtones
  // struck with a fast attack and slow exponential decay.
  const bells = [
    { t: 0.00, f: 1200, amp: 0.55 },
    { t: 0.05, f: 1800, amp: 0.45 },
    { t: 0.09, f: 2400, amp: 0.40 },
    { t: 0.15, f: 3200, amp: 0.32 },
    { t: 0.22, f: 1600, amp: 0.28 },
    { t: 0.32, f: 2100, amp: 0.22 },
  ];
  // Inharmonic partial ratios — classic bell model.
  const partials = [
    { r: 1.0,  g: 1.0,  d: 1.0 },
    { r: 2.76, g: 0.55, d: 0.7 },
    { r: 5.4,  g: 0.28, d: 0.4 },
    { r: 8.9,  g: 0.14, d: 0.25 },
  ];
  for (const b of bells) {
    const start = now + b.t;
    for (const p of partials) {
      const dur = 1.1 * p.d;
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = b.f * p.r;
      const g = c.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(master * b.amp * p.g * 0.28, start + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g); g.connect(c.destination);
      sendToReverb(g, 0.55);
      osc.start(start); osc.stop(start + dur + 0.02);
    }
  }

  // Glassy high shimmer: sparse noise through a very high resonant bandpass.
  {
    const dur = 0.8;
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, dur, true);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 6500; bp.Q.value = 3.5;
    const env = c.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(master * 0.25, now + 0.03);
    env.gain.linearRampToValueAtTime(master * 0.14, now + dur * 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    n.connect(bp); bp.connect(env); env.connect(c.destination);
    sendToReverb(env, 0.6);
    n.start(now); n.stop(now + dur);
  }

  // Low cold swell: a quiet sine pad at a minor third below the bell root.
  {
    const dur = 1.0;
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 300;
    const g = c.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(master * 0.18, now + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g); g.connect(c.destination);
    sendToReverb(g, 0.4);
    osc.start(now); osc.stop(now + dur + 0.02);
  }
}

// Heal: choir on a major triad singing "ah": three stacked voices, each a pair
// of detuned saws pushed through "ah" vowel formants. Slow attack, long tail.
function playHealChoir() {
  const c = ensureAudio();
  if (!c) return;
  ensureReverb();
  const now = c.currentTime;
  const master = (settings.volume || 0);

  // Major triad tuning: F4, A4, C5.
  const voices = [349.23, 440.00, 523.25];
  const dur = 1.6;

  for (let vi = 0; vi < voices.length; vi++) {
    const f = voices[vi];
    const voiceStart = now + vi * 0.08;  // stagger entries slightly

    // Two detuned saws (a bit apart) per voice so each fundamental has
    // chorus-like width.
    const vocal = c.createGain();
    for (const detune of [-8, +8]) {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.detune.value = detune;
      osc.frequency.value = f;
      osc.connect(vocal);
      osc.start(voiceStart); osc.stop(voiceStart + dur + 0.05);
    }

    // Small slow vibrato (~4.5 Hz).
    const lfo = c.createOscillator();
    lfo.type = "sine"; lfo.frequency.value = 4.5;
    const lfoDepth = c.createGain(); lfoDepth.gain.value = 0.05;
    lfo.connect(lfoDepth);
    const am = c.createGain(); am.gain.value = 1.0;
    lfoDepth.connect(am.gain);
    lfo.start(voiceStart); lfo.stop(voiceStart + dur + 0.05);
    vocal.connect(am);

    // "Ah" (/ɑː/) formants: F1 ≈ 700, F2 ≈ 1150, F3 ≈ 2700.
    const mix = c.createGain();
    for (const fm of [
      { f: 700,  q: 2.6, g: 1.0  },
      { f: 1150, q: 2.2, g: 0.55 },
      { f: 2700, q: 3.0, g: 0.18 },
    ]) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = fm.f; bp.Q.value = fm.q;
      const fg = c.createGain(); fg.gain.value = fm.g;
      am.connect(bp); bp.connect(fg); fg.connect(mix);
    }

    // Slight lowpass to soften top-end for a smooth choir quality.
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 3800; lp.Q.value = 0.5;
    mix.connect(lp);

    const env = c.createGain();
    // Long swell attack + plateau + long release.
    env.gain.setValueAtTime(0, voiceStart);
    env.gain.linearRampToValueAtTime(master * 0.22, voiceStart + 0.22);
    env.gain.linearRampToValueAtTime(master * 0.2, voiceStart + dur * 0.65);
    env.gain.exponentialRampToValueAtTime(0.0001, voiceStart + dur);
    lp.connect(env); env.connect(c.destination);
    sendToReverb(env, 0.55);
  }

  // Airy breath layer under the chord for choral "space".
  {
    const n = c.createBufferSource();
    n.buffer = createNoiseBuffer(c, dur, false);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 0.7;
    const env = c.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(master * 0.12, now + 0.25);
    env.gain.linearRampToValueAtTime(master * 0.09, now + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    n.connect(bp); bp.connect(env); env.connect(c.destination);
    sendToReverb(env, 0.4);
    n.start(now); n.stop(now + dur);
  }
}

// Animalese-style per-character chirp for story text. Every letter uses the
// same voice — a sawtooth "vocal cord" source filtered by two bandpass
// filters tuned to the F1/F2 formants of the letter's dominant vowel sound.
// Letters that start with a plosive consonant get a brief F1 sweep at the
// attack so the syllable "opens" like a stop release, rather than being a
// foreign noise burst.

// Formants chosen to match the dominant vowel in each letter's English name:
//   EE (/iː/)   — B C D E G P T V Z
//   EH (/ɛ/)    — F L M N S X
//   AY (/eɪ/)   — A H J K
//   AH (/ɑː aɪ/) — I R Y
//   OH/OO (/oʊ uː/) — O Q U W
const LETTER_FORMANTS = {
  A: [480, 2000], B: [290, 2300], C: [290, 2300], D: [290, 2300],
  E: [290, 2300], F: [560, 1770], G: [290, 2300], H: [480, 2000],
  I: [700, 1250], J: [480, 2000], K: [480, 2000], L: [560, 1770],
  M: [560, 1770], N: [560, 1770], O: [420, 900],  P: [290, 2300],
  Q: [420, 900],  R: [700, 1250], S: [560, 1770], T: [290, 2300],
  U: [420, 900],  V: [290, 2300], W: [420, 900],  X: [560, 1770],
  Y: [700, 1250], Z: [290, 2300],
  // Digits keyed by the vowel in their spoken English name:
  //   0 "oh"      → OH           5 "five"   → AY
  //   1 "one"     → AH            6 "six"    → EH
  //   2 "two"     → OO            7 "seven"  → EH
  //   3 "three"   → EE            8 "eight"  → AY
  //   4 "four"    → AH            9 "nine"   → AH
  "0": [420, 900],  "1": [700, 1250], "2": [420, 900],  "3": [290, 2300],
  "4": [700, 1250], "5": [480, 2000], "6": [560, 1770], "7": [560, 1770],
  "8": [480, 2000], "9": [700, 1250],
};

// Per-letter fundamental so letters sharing a vowel group don't sound
// identical. 160–205 Hz keeps them all clearly in the same voice.
const LETTER_PITCH = {
  A: 188, B: 200, C: 178, D: 184, E: 192,
  F: 180, G: 170, H: 198, I: 186, J: 194,
  K: 174, L: 196, M: 168, N: 186, O: 182,
  P: 172, Q: 196, R: 204, S: 190, T: 188,
  U: 200, V: 178, W: 168, X: 176, Y: 182,
  Z: 164,
  "0": 180, "1": 172, "2": 188, "3": 196, "4": 170,
  "5": 184, "6": 176, "7": 194, "8": 200, "9": 178,
};

// Letters/digits whose English name starts with a plosive — they get a
// short F1 sweep-up at the attack to simulate stop-release.
const PLOSIVE_LETTERS = new Set(["B", "C", "D", "G", "J", "K", "P", "Q", "T", "2"]);

function playAnimalese(ch, pitchMul) {
  if (!/[A-Za-z0-9]/.test(ch)) return;
  const c = ensureAudio();
  if (!c) return;
  const letter = ch.toUpperCase();
  const [f1, f2] = LETTER_FORMANTS[letter];
  const pitch = LETTER_PITCH[letter] * (pitchMul || 1);

  const now = c.currentTime;
  const dur = 0.08;
  const vol = (settings.volume || 0) * 0.07;

  const env = c.createGain();
  env.gain.value = 0;
  env.gain.linearRampToValueAtTime(vol, now + 0.010);
  env.gain.linearRampToValueAtTime(vol * 0.85, now + dur - 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  env.connect(c.destination);

  // Tame the square wave's high-frequency buzz so rapid chirps don't
  // accumulate into hiss.
  const tame = c.createBiquadFilter();
  tame.type = "lowpass";
  tame.frequency.value = 3200;
  tame.Q.value = 0.5;
  tame.connect(env);

  // Square "carrier" with a tiny pitch wobble for a rough, transmitter-like
  // edge rather than pure chiptune.
  const src = c.createOscillator();
  src.type = "square";
  src.frequency.setValueAtTime(pitch, now);
  src.frequency.linearRampToValueAtTime(pitch * 0.97, now + dur);

  const f1f = c.createBiquadFilter();
  f1f.type = "bandpass";
  f1f.Q.value = 2.5;
  const f2f = c.createBiquadFilter();
  f2f.type = "bandpass";
  f2f.frequency.value = f2;
  f2f.Q.value = 3;

  if (PLOSIVE_LETTERS.has(letter)) {
    f1f.frequency.setValueAtTime(f1 * 0.35, now);
    f1f.frequency.linearRampToValueAtTime(f1, now + 0.022);
  } else {
    f1f.frequency.value = f1;
  }

  const f2g = c.createGain();
  f2g.gain.value = 0.55;

  // Subtle electronic ring-mod flutter. Gentler depth + a triangle
  // modulator so it doesn't buzz.
  const ringGain = c.createGain();
  ringGain.gain.value = 0.8;
  const ringOsc = c.createOscillator();
  ringOsc.type = "triangle";
  ringOsc.frequency.value = 55;
  const ringDepth = c.createGain();
  ringDepth.gain.value = 0.18;
  ringOsc.connect(ringDepth);
  ringDepth.connect(ringGain.gain);
  ringOsc.start(now);
  ringOsc.stop(now + dur + 0.02);

  src.connect(f1f);
  f1f.connect(ringGain);
  src.connect(f2f);
  f2f.connect(f2g);
  f2g.connect(ringGain);
  ringGain.connect(tame);
  src.start(now);
  src.stop(now + dur + 0.02);
}
