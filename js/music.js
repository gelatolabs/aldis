"use strict";

// ============================================================================
// Infinite procedural background music for gameplay. Seeded RNG + shared
// scheduler so multiplayer clients generate the same music. Fixed per-session
// tempo 90-140 BPM.
//
// Layers (all fire-and-forget events on audioCtx.currentTime):
//   - Vocal radio chatter: 1-3 overlapping low-register speakers with
//     varied vowel formants, pitch inflection, consonant transients, and
//     radio bandpass + bit crush. Fires every 2-6s.
//   - Choir cue: 4-6 staggered high-register sustained notes walking a
//     melodic line on the current scale. Fires every 14-36s.
//   - Textural drone gesture: 4-8s sub-bass or high-shimmer drone with
//     evolving parameters (FM index, ring-mod rate, granular rate, filter
//     cutoff). Fires every 5-12s.
//   - Rhythmic stems: sub-pulse kick, mid metal hit, high glitch,
//     arrhythmic industrial, high-perc gloss. Euclidean patterns on odd
//     step counts, re-rolled every 8-16 bars.
//
// The "harmonic bed" is just a pitch-set definition (tonic + partner
// interval + scale). Crossfades every 4-6 min at sustained cap.
//
// Two-axis intensity: base (game difficulty) × session (slow 45-90s sine
// + faster perturbation, 0.2-1.05). Anti-fatigue breather every 90-180s
// suppresses mid / high / industrial / gloss stems and the choir for
// 15-30s; chatter, texture, and sub-pulse keep playing.
//
// Hooks: musicOnDamage, musicOnMilestone, musicOnDeath fire short stingers.
// ============================================================================

// ---- Seeded RNG (LCG, cheap and deterministic) ----
function _mrMakeRng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 4294967296);
  };
}

// ---- Pitch sets ----
// Semitones above tonic. Non-integer entries are microtonal.
const MUSIC_SCALES = {
  octatonic: [0, 1, 3, 4, 6, 7, 9, 10],          // diminished (H-W-H-W-H-W-H-W)
  phrygian:  [0, 1, 3, 5, 7, 8, 10],
  locrian:   [0, 1, 3, 5, 6, 8, 10],
  hexatonic: [0, 3, 4, 7, 8, 11],                // augmented interlock
  microA:    [0, 1.3, 3.7, 6.2, 7.8, 10.4],
  microB:    [0, 2.7, 4.1, 6.6, 9.3],
};

// ---- Harmonic bed patches ----
// Each: tonic (Hz) + partner interval (semitones above tonic, never major
// 3rd) + scale for melodic content. Partner intervals are fifth, tritone,
// minor ninth, minor seventh, or microtonal neighbours.
const MUSIC_BEDS = [
  { tonic: 55.00, partner: 7.0,  scale: "phrygian",  tag: "fifth" },
  { tonic: 73.42, partner: 6.0,  scale: "locrian",   tag: "tritone" },
  { tonic: 41.20, partner: 13.0, scale: "octatonic", tag: "minor-ninth" },
  { tonic: 65.40, partner: 6.5,  scale: "microA",    tag: "micro-tritone" },
  { tonic: 82.41, partner: 10.0, scale: "hexatonic", tag: "minor-seventh" },
  { tonic: 49.00, partner: 11.3, scale: "microB",    tag: "micro-major-seventh" },
];

const MUSIC_STEPS_PER_BEAT = 4;  // 16th-note grid
const MUSIC_LOOKAHEAD_SEC = 0.22;
const MUSIC_SCHED_INTERVAL_MS = 40;

// ---- Module state ----
let musicRunning = false;
let musicRng = null;
let musicBpm = 100;
let musicSecPerStep = 0.15;
let musicStartedAt = 0;
let musicNextStepTime = 0;
let musicStep = 0;

let musicOutBus = null;        // master (volume)
let musicMainBus = null;       // pre-duck mix (everything sidechainable)
let musicDuckNode = null;      // ducks from kick envelope
let musicSubBus = null;        // sub-pulse, never ducked

let musicBedIdx = 0;
let musicLastBedChangeAt = 0;

let musicStems = null;
let musicStemsRerollAt = 0;

let musicBreatherUntil = 0;       // suppresses high-perc + texture layers
let musicLastBreatherAt = 0;

let musicNextChatterAt = 0;       // step count of next low vocal-chatter phrase
let musicNextChoirAt = 0;         // step count of next high-sustain choir cue
let musicNextTextureAt = 0;       // step count of next textural-drone gesture

let musicDifficulty = 0;
let musicDuckAmount = 0;       // external ducking 0..1
let musicSessionPeriodSec = 60;
let musicSessionOffset = 0;
let musicScheduler = null;
let musicVolumeScale = 0.32;   // master attenuation below SFX

let _mrGrainBuf = null;        // cached "metal" source for granular patch

// ---- Helpers ----
function _mrTimeSec() {
  const c = audioCtx;
  if (!c || !musicStartedAt) return 0;
  return Math.max(0, c.currentTime - musicStartedAt);
}

function _mrStepsFromSeconds(sec) {
  return Math.max(1, Math.round(sec / musicSecPerStep));
}

function _mrSessionIntensity(t) {
  // Primary slow sine (breath), 0.3-1.0.
  const s1 = (Math.sin(2 * Math.PI * (t + musicSessionOffset) / musicSessionPeriodSec) + 1) * 0.5;
  // Faster perturbation (~23s) — small depth.
  const s2 = (Math.sin(2 * Math.PI * t / 23.0 + musicSessionOffset) + 1) * 0.5;
  const v = 0.3 + 0.6 * s1 + 0.1 * s2;
  return Math.max(0.2, Math.min(1.05, v));
}

function _mrIntensity() {
  // Base from difficulty × session. Clamp so the easy floor still plays.
  const base = Math.max(0.05, musicDifficulty);
  return Math.max(0.08, Math.min(1.0, base * _mrSessionIntensity(_mrTimeSec())));
}

function _mrHz(semitones, refHz) {
  return refHz * Math.pow(2, semitones / 12);
}

// Bjorklund-ish Euclidean rhythm: distribute k pulses across n steps.
function _mrEuclid(k, n) {
  const out = new Array(n).fill(false);
  if (k <= 0 || n <= 0) return out;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += k;
    if (acc >= n) { acc -= n; out[i] = true; }
  }
  return out;
}

// ---- Voice factories ----

// 2-op FM: a modulator at (freq × harmonicity) drives the carrier frequency.
function _mrMakeFmVoice(c, freq, harmonicity, modIndex) {
  const carrier = c.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = freq;
  const mod = c.createOscillator();
  mod.type = "sine";
  mod.frequency.value = freq * harmonicity;
  const modGain = c.createGain();
  modGain.gain.value = freq * modIndex;
  mod.connect(modGain);
  modGain.connect(carrier.frequency);
  const out = c.createGain();
  out.gain.value = 1;
  carrier.connect(out);
  return {
    out,
    carrier,
    start(t) { carrier.start(t); mod.start(t); },
    stop(t) { carrier.stop(t); mod.stop(t); },
  };
}

// 3-op FM: mod2 → mod1 → carrier.
function _mrMakeFm3Voice(c, freq, h1, i1, h2, i2) {
  const carrier = c.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = freq;
  const m1 = c.createOscillator(); m1.type = "sine";
  m1.frequency.value = freq * h1;
  const m2 = c.createOscillator(); m2.type = "sine";
  m2.frequency.value = freq * h1 * h2;
  const g2 = c.createGain(); g2.gain.value = freq * h1 * i2;
  const g1 = c.createGain(); g1.gain.value = freq * i1;
  m2.connect(g2); g2.connect(m1.frequency);
  m1.connect(g1); g1.connect(carrier.frequency);
  const out = c.createGain();
  carrier.connect(out);
  return {
    out,
    carrier,
    start(t) { carrier.start(t); m1.start(t); m2.start(t); },
    stop(t) { carrier.stop(t); m1.stop(t); m2.stop(t); },
  };
}

// Custom wavetable via PeriodicWave Fourier coefficients.
function _mrMakeWavetableVoice(c, freq, real, imag) {
  const wave = c.createPeriodicWave(real, imag);
  const osc = c.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = freq;
  const out = c.createGain();
  osc.connect(out);
  return {
    out,
    carrier: osc,
    start(t) { osc.start(t); },
    stop(t) { osc.stop(t); },
  };
}

// Procedural source buffer: "metal" (partials), "grain" (shaped noise),
// or "pink" (lowpassed white).
function _mrMakeSourceBuffer(c, durSec, kind) {
  const n = Math.max(1, Math.floor(c.sampleRate * durSec));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === "metal") {
    const freqs = [1423, 1781, 2371, 3181, 4099, 5273, 6301];
    const phases = freqs.map(() => Math.random() * Math.PI * 2);
    const sr = c.sampleRate;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < freqs.length; j++) {
        s += Math.sin(2 * Math.PI * freqs[j] * (i / sr) + phases[j]);
      }
      d[i] = (s / freqs.length) * (1 - i / n);
    }
  } else if (kind === "grain") {
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * t);
    }
  } else {
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = 0.7 * last + 0.3 * (Math.random() * 2 - 1);
      d[i] = last * 1.3;
    }
  }
  return buf;
}

// Granular voice: replays a slice of a source buffer at a pitch-mapped rate.
function _mrMakeGranularVoice(c, freq, baseFreq, grainBuf) {
  const src = c.createBufferSource();
  src.buffer = grainBuf;
  src.playbackRate.value = freq / baseFreq;
  // Random offset into the buffer so repeated grains aren't identical.
  const offset = musicRng() * Math.max(0, grainBuf.duration - 0.3);
  const out = c.createGain();
  src.connect(out);
  return {
    out,
    carrier: src,
    offset,
    start(t) { src.start(t, offset); },
    stop(t) { src.stop(t); },
  };
}

// Vocal-fragment voice: a sawtooth driven through three formant bandpasses
// tuned to a random vowel.
function _mrMakeVocalVoice(c, freq) {
  const saw = c.createOscillator();
  saw.type = "sawtooth";
  saw.frequency.value = freq;
  const vowels = [
    [700, 1100, 2700],
    [320, 870, 2250],
    [520, 1300, 2500],
    [480, 2000, 2500],
  ];
  const fm = vowels[Math.floor(musicRng() * vowels.length)];
  const mix = c.createGain();
  for (const f of fm) {
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f * (1 + (musicRng() - 0.5) * 0.04);
    bp.Q.value = 7 + musicRng() * 3;
    const g = c.createGain();
    g.gain.value = 0.5;
    saw.connect(bp); bp.connect(g); g.connect(mix);
  }
  const out = c.createGain();
  mix.connect(out);
  return {
    out,
    carrier: saw,
    start(t) { saw.start(t); },
    stop(t) { saw.stop(t); },
  };
}

// ---- Processing ----

function _mrMakeBitCrusher(c, bits) {
  const steps = Math.pow(2, Math.max(1, bits));
  const N = 1024;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N / 2)) - 1;
    curve[i] = Math.round(x * steps * 0.5) / (steps * 0.5);
  }
  const ws = c.createWaveShaper();
  ws.curve = curve;
  ws.oversample = "2x";
  return ws;
}

// Ring modulator: a GainNode whose gain is driven by an oscillator at an
// audio-rate frequency. Input sums through the gain at that rate.
function _mrMakeRingMod(c, rate) {
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = rate;
  const g = c.createGain();
  g.gain.value = 0;
  osc.connect(g.gain);
  osc.start();
  return g;
}

// ---- Harmonic bed ----
//
// The bed is purely a pitch-set definition; it carries no sustained audio
// of its own. Chatter, choir, textures, and stems all read the active bed
// to pick a tonic / partner / scale.

function _mrStartBed(idx) {
  musicBedIdx = idx;
  musicLastBedChangeAt = musicStep;
}

// Swap the active bed. Since the bed is just a pitch-set definition the
// "crossfade" is instantaneous — in-flight chatter / choir / texture
// voices already in their envelopes continue unaffected; subsequent
// events pick up the new tonic + scale.
function _mrCrossfadeBed(newIdx) {
  _mrStartBed(newIdx);
}

// ---- Rhythmic stems ----

function _mrRerollStems() {
  const rng = musicRng;
  // Sub-pulse: simple steady pattern, 3-5 hits on 16.
  const subHits = 3 + Math.floor(rng() * 3);
  // Mid: Euclidean on 7, 9, or 11 — irregular odd counts.
  const midStepChoices = [7, 9, 11];
  const midSteps = midStepChoices[Math.floor(rng() * midStepChoices.length)];
  const midHits = 2 + Math.floor(rng() * (midSteps - 3));
  // High: Euclidean on 11 or 13.
  const highSteps = rng() < 0.5 ? 11 : 13;
  const highHits = 3 + Math.floor(rng() * 5);
  // Gloss: high-register percussive hits with varied timbres. Odd step
  // count so it drifts against the 16-step sub pattern.
  const glossStepChoices = [7, 9, 11, 13];
  const glossSteps = glossStepChoices[Math.floor(rng() * glossStepChoices.length)];
  const glossHits = 2 + Math.floor(rng() * Math.max(1, glossSteps - 3));
  musicStems = {
    sub: { pattern: _mrEuclid(subHits, 16), steps: 16 },
    mid: { pattern: _mrEuclid(midHits, midSteps), steps: midSteps },
    high: { pattern: _mrEuclid(highHits, highSteps), steps: highSteps },
    gloss: { pattern: _mrEuclid(glossHits, glossSteps), steps: glossSteps },
    arr: { density: 0.02 + rng() * 0.06 },
  };
}

function _mrPlayKick(at, level) {
  const c = audioCtx;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(85, at);
  osc.frequency.exponentialRampToValueAtTime(32, at + 0.14);
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.85 * level, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
  osc.connect(g); g.connect(musicSubBus);
  osc.start(at); osc.stop(at + 0.24);

  // Sidechain duck: drop the main bus briefly.
  const dg = musicDuckNode.gain;
  dg.cancelScheduledValues(at);
  dg.setValueAtTime(Math.max(0.2, dg.value || 1), at);
  dg.linearRampToValueAtTime(1 - 0.55 * level, at + 0.015);
  dg.exponentialRampToValueAtTime(1.0, at + 0.28);
}

function _mrPlayMetalHit(at, level) {
  const c = audioCtx;
  const buf = _mrMakeSourceBuffer(c, 0.22, "metal");
  const src = c.createBufferSource(); src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400 + musicRng() * 2200;
  bp.Q.value = 4.5;
  const crush = _mrMakeBitCrusher(c, 4 + Math.floor(musicRng() * 3));
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.38 * level, at + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
  src.connect(bp); bp.connect(crush); crush.connect(g); g.connect(musicMainBus);
  if (typeof sendToReverb === "function") sendToReverb(g, 0.35);
  src.start(at); src.stop(at + 0.24);
}

function _mrPlayGlitch(at, level) {
  const c = audioCtx;
  const dur = 0.04 + musicRng() * 0.12;
  const n = c.createBufferSource();
  n.buffer = _mrMakeSourceBuffer(c, dur, "grain");
  n.playbackRate.value = 0.4 + musicRng() * 2.4;
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1600 + musicRng() * 3200;
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.22 * level, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  n.connect(hp); hp.connect(g); g.connect(musicMainBus);
  n.start(at); n.stop(at + dur + 0.02);
}

function _mrPlayIndustrial(at, level) {
  const c = audioCtx;
  const rm = _mrMakeRingMod(c, 45 + musicRng() * 220);
  const osc = c.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 72 + musicRng() * 140;
  osc.connect(rm);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 300 + musicRng() * 800;
  bp.Q.value = 3.5;
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.24 * level, at + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
  rm.connect(bp); bp.connect(g); g.connect(musicMainBus);
  if (typeof sendToReverb === "function") sendToReverb(g, 0.5);
  osc.start(at); osc.stop(at + 0.6);
}

// ---- Textural drone gestures ----
//
// 4-8s evolving drone whose timbral parameters sweep over its duration
// (FM index, ring-mod rate, filter cutoff, granular rate). Always placed
// outside the midrange — either sub-bass (<400 Hz lowpass) or high
// shimmer (>2.2 kHz highpass) — so the vocal band stays clear for the
// chatter and choir.

function _mrPlayTextureGesture(at, intensity) {
  const c = audioCtx;
  const bed = MUSIC_BEDS[musicBedIdx];
  const scale = MUSIC_SCALES[bed.scale];
  const isHigh = musicRng() < 0.5;
  const deg = scale[Math.floor(musicRng() * scale.length)];
  const baseSemis = isHigh
    ? 36 + Math.floor(musicRng() * 14) + deg
    : -24 + Math.floor(musicRng() * 7) + deg;
  const freq = _mrHz(baseSemis, bed.tonic);
  const dur = 4 + musicRng() * 4;
  const peak = (isHigh ? 0.045 : 0.09) + intensity * 0.035;
  const type = Math.floor(musicRng() * 3);

  if (type === 0) {
    // FM voice with modulation-index gesture + filter-cutoff gesture.
    const carrier = c.createOscillator();
    carrier.type = "sine";
    carrier.frequency.value = freq;
    const mod = c.createOscillator();
    mod.type = "sine";
    mod.frequency.value = freq * (1.5 + musicRng() * 2.5);
    const modGain = c.createGain();
    const idxA = freq * (0.2 + musicRng() * 0.4);
    const idxB = freq * (1.0 + musicRng() * 3.0);
    modGain.gain.setValueAtTime(idxA, at);
    modGain.gain.linearRampToValueAtTime(idxB, at + dur * 0.55);
    modGain.gain.linearRampToValueAtTime(idxA * 0.5, at + dur);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const filt = c.createBiquadFilter();
    filt.type = isHigh ? "highpass" : "lowpass";
    filt.Q.value = 1.2;
    filt.frequency.setValueAtTime(isHigh ? 2200 : 380, at);
    filt.frequency.linearRampToValueAtTime(isHigh ? 5200 : 90, at + dur);

    const env = c.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + Math.min(1.2, dur * 0.25));
    env.gain.linearRampToValueAtTime(peak * 0.75, at + dur * 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    carrier.connect(filt); filt.connect(env); env.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(env, 0.55);
    carrier.start(at); carrier.stop(at + dur + 0.08);
    mod.start(at); mod.stop(at + dur + 0.08);
  } else if (type === 1) {
    // Ring-modulated saw with a slow ring-rate sweep.
    const src = c.createOscillator();
    src.type = "sawtooth";
    src.frequency.value = freq;
    const ringOsc = c.createOscillator();
    ringOsc.type = "sine";
    const rA = isHigh ? 900 + musicRng() * 1800 : 20 + musicRng() * 70;
    const rB = isHigh ? 1500 + musicRng() * 4000 : 140 + musicRng() * 260;
    ringOsc.frequency.setValueAtTime(rA, at);
    ringOsc.frequency.linearRampToValueAtTime(rB, at + dur * 0.6);
    ringOsc.frequency.linearRampToValueAtTime(rA * 1.2, at + dur);
    const rm = c.createGain();
    rm.gain.value = 0;
    ringOsc.connect(rm.gain);
    src.connect(rm);

    const filt = c.createBiquadFilter();
    filt.type = isHigh ? "highpass" : "lowpass";
    filt.Q.value = 0.9;
    filt.frequency.value = isHigh ? 2800 : 260;

    const env = c.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + Math.min(1.0, dur * 0.2));
    env.gain.linearRampToValueAtTime(peak * 0.7, at + dur * 0.75);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    rm.connect(filt); filt.connect(env); env.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(env, 0.6);
    src.start(at); src.stop(at + dur + 0.08);
    ringOsc.start(at); ringOsc.stop(at + dur + 0.08);
  } else {
    // Granular: many short grains whose rate/size evolves across the
    // gesture. Grain rate (Hz) rises or falls slowly.
    if (!_mrGrainBuf) _mrGrainBuf = _mrMakeSourceBuffer(c, 1.4, "metal");
    const rateA = 6 + musicRng() * 10;
    const rateB = 12 + musicRng() * 30;
    const rateDir = musicRng() < 0.5 ? 1 : -1;
    const filt = c.createBiquadFilter();
    filt.type = isHigh ? "highpass" : "lowpass";
    filt.Q.value = 0.7;
    filt.frequency.value = isHigh ? 3000 : 320;
    const env = c.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + Math.min(1.2, dur * 0.2));
    env.gain.linearRampToValueAtTime(peak * 0.7, at + dur * 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    filt.connect(env);
    env.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(env, 0.55);

    // Place grains through the gesture, stepping by 1/rate seconds.
    let t = at;
    while (t < at + dur) {
      const frac = (t - at) / dur;
      const rate = rateDir > 0
        ? rateA + (rateB - rateA) * frac
        : rateB - (rateB - rateA) * frac;
      const gap = 1 / rate;
      // Grain size scales inversely with rate so faster grains are shorter.
      const gSize = Math.max(0.02, Math.min(0.18, 1 / (rate * 0.9)));
      const src = c.createBufferSource();
      src.buffer = _mrGrainBuf;
      src.playbackRate.value = (freq / 220) * (0.8 + musicRng() * 0.4);
      const gEnv = c.createGain();
      gEnv.gain.setValueAtTime(0, t);
      gEnv.gain.linearRampToValueAtTime(0.7, t + 0.005);
      gEnv.gain.exponentialRampToValueAtTime(0.0001, t + gSize);
      src.connect(gEnv); gEnv.connect(filt);
      const offs = musicRng() * Math.max(0, _mrGrainBuf.duration - gSize);
      src.start(t, offs);
      src.stop(t + gSize + 0.02);
      t += gap;
    }
  }
}

// ---- High-register percussive / glitch hits ----
//
// Rhythmic contrast to the choir's sustain. One of four treatments per
// hit so repeats don't sound mechanical: metallic ping, granular stab,
// ring-modulated noise, or bit-crushed transient. All clipped to high
// frequencies.

function _mrPlayHighPerc(at, level) {
  const c = audioCtx;
  const bed = MUSIC_BEDS[musicBedIdx];
  const scale = MUSIC_SCALES[bed.scale];
  const deg = scale[Math.floor(musicRng() * scale.length)];
  const pitch = _mrHz(deg + 36 + Math.floor(musicRng() * 14), bed.tonic);
  const kind = Math.floor(musicRng() * 4);

  if (kind === 0) {
    // Metallic ping — triangle through ring-mod for inharmonic sparkle.
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = pitch;
    const rm = _mrMakeRingMod(c, pitch * (1.4 + musicRng() * 1.6));
    const hp = c.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 1400;
    const g = c.createGain();
    const peak = 0.16 * level;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(rm); rm.connect(hp); hp.connect(g); g.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(g, 0.55);
    osc.start(at); osc.stop(at + 0.24);
  } else if (kind === 1) {
    // Granular stab — high-playback-rate slice of the metal buffer.
    if (!_mrGrainBuf) _mrGrainBuf = _mrMakeSourceBuffer(c, 1.4, "metal");
    const src = c.createBufferSource();
    src.buffer = _mrGrainBuf;
    src.playbackRate.value = pitch / 220;
    const hp = c.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 1600;
    const g = c.createGain();
    const peak = 0.20 * level;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
    src.connect(hp); hp.connect(g); g.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(g, 0.45);
    src.start(at, musicRng() * 0.6);
    src.stop(at + 0.14);
  } else if (kind === 2) {
    // Ring-modulated noise hit.
    const n = c.createBufferSource();
    n.buffer = _mrMakeSourceBuffer(c, 0.12, "grain");
    const ringOsc = c.createOscillator();
    ringOsc.type = "sine";
    ringOsc.frequency.value = pitch;
    const rm = c.createGain();
    rm.gain.value = 0;
    ringOsc.connect(rm.gain);
    n.connect(rm);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = pitch * (1.2 + musicRng() * 0.8);
    bp.Q.value = 5;
    const g = c.createGain();
    const peak = 0.17 * level;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    rm.connect(bp); bp.connect(g); g.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(g, 0.45);
    ringOsc.start(at); ringOsc.stop(at + 0.12);
    n.start(at); n.stop(at + 0.12);
  } else {
    // Bit-crushed transient.
    const n = c.createBufferSource();
    n.buffer = _mrMakeSourceBuffer(c, 0.07, "grain");
    const hp = c.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 1500;
    const crush = _mrMakeBitCrusher(c, 3 + Math.floor(musicRng() * 2));
    const g = c.createGain();
    const peak = 0.19 * level;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    n.connect(hp); hp.connect(crush); crush.connect(g); g.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(g, 0.35);
    n.start(at); n.stop(at + 0.09);
  }
}

// ---- Low vocal radio chatter ----
//
// Short low-register vocal bursts with radio-like coloring (narrow
// bandpass + bit crush + heavy reverb). Multiple speakers overlap to read
// as a crowd rather than a single voice.

let _mrChatterWave = null;

function _mrEnsureChatterWave(c) {
  if (_mrChatterWave) return _mrChatterWave;
  // Glottal-pulse-ish spectrum with 1/√n rolloff — rich in low harmonics
  // without being as raspy as a straight sawtooth.
  const N = 18;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let n = 1; n < N; n++) real[n] = 1 / Math.sqrt(n);
  _mrChatterWave = c.createPeriodicWave(real, imag);
  return _mrChatterWave;
}

// A single speaker saying a short utterance: 3-7 syllables with brief
// consonant-like noise transients between vowels, per-syllable pitch
// inflection, and formant sweeps inside each vowel. All of it pushed
// through a narrow radio bandpass + bit crusher so it reads as a distant
// transmission rather than a clean voice.
function _mrChatterVoice(at, intensity) {
  const c = audioCtx;
  const bed = MUSIC_BEDS[musicBedIdx];
  const scale = MUSIC_SCALES[bed.scale];

  // Each speaker has a stable base pitch across their utterance.
  const baseOct = musicRng() < 0.5 ? -12 : 0;
  const baseDeg = scale[Math.floor(musicRng() * scale.length)];
  const baseFreq = _mrHz(baseDeg + baseOct, bed.tonic)
                 * (1 + (musicRng() - 0.5) * 0.08);  // voice detune

  // Shared radio coloring for this speaker.
  const radioCenter = 900 + musicRng() * 1100;
  const radio = c.createBiquadFilter();
  radio.type = "bandpass";
  radio.frequency.value = radioCenter;
  radio.Q.value = 1.0 + musicRng() * 0.8;
  const highCut = c.createBiquadFilter();
  highCut.type = "lowpass";
  highCut.frequency.value = 3200 + musicRng() * 1200;
  highCut.Q.value = 0.5;
  const crush = _mrMakeBitCrusher(c, 4 + Math.floor(musicRng() * 3));
  radio.connect(highCut); highCut.connect(crush);

  const utteranceEnv = c.createGain();
  utteranceEnv.gain.value = 0.85 + musicRng() * 0.3;
  crush.connect(utteranceEnv);
  utteranceEnv.connect(musicMainBus);
  if (typeof sendToReverb === "function") sendToReverb(utteranceEnv, 0.7);

  const syllables = 3 + Math.floor(musicRng() * 5);   // 3-7 syllables
  let t = at;

  const vowels = [
    { f1: 280, f2: 700,  f3: 2500 },  // OO
    { f1: 320, f2: 870,  f3: 2250 },  // OH
    { f1: 520, f2: 1300, f3: 2500 },  // UH
    { f1: 480, f2: 2000, f3: 2700 },  // AY
    { f1: 700, f2: 1100, f3: 2700 },  // AH
    { f1: 400, f2: 1700, f3: 2500 },  // EH
    { f1: 270, f2: 2300, f3: 3000 },  // EE
  ];

  for (let i = 0; i < syllables; i++) {
    // Short syllable lengths — speech cadence, not chant.
    const dur = 0.08 + musicRng() * 0.12;

    // Per-syllable pitch inflection around the speaker's base (±15%).
    const startFreq = baseFreq * (0.92 + musicRng() * 0.16);
    const endFreq = startFreq * (0.88 + musicRng() * 0.24);

    // Optional consonant-like noise transient (~10ms) kicking off the
    // syllable. ~60% of syllables get one.
    if (musicRng() < 0.6) {
      const nBuf = _mrMakeSourceBuffer(c, 0.012, "grain");
      const nSrc = c.createBufferSource(); nSrc.buffer = nBuf;
      const nHp = c.createBiquadFilter();
      nHp.type = "highpass";
      nHp.frequency.value = 2500 + musicRng() * 2500;
      const ng = c.createGain();
      const nPeak = (0.15 + intensity * 0.07) * (0.5 + musicRng() * 0.8);
      ng.gain.setValueAtTime(0, t);
      ng.gain.linearRampToValueAtTime(nPeak, t + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.011);
      nSrc.connect(nHp); nHp.connect(ng); ng.connect(radio);
      nSrc.start(t); nSrc.stop(t + 0.014);
    }

    // Voiced vowel body.
    const osc = c.createOscillator();
    osc.setPeriodicWave(_mrEnsureChatterWave(c));
    osc.frequency.setValueAtTime(startFreq, t);
    osc.frequency.linearRampToValueAtTime(endFreq, t + dur);

    // Formant sweep inside the syllable — transition between two vowels.
    const vA = vowels[Math.floor(musicRng() * vowels.length)];
    const vB = vowels[Math.floor(musicRng() * vowels.length)];
    const mix = c.createGain();
    for (const key of ["f1", "f2", "f3"]) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 7 + musicRng() * 2;
      bp.frequency.setValueAtTime(vA[key], t);
      bp.frequency.linearRampToValueAtTime(vB[key], t + dur);
      const fg = c.createGain();
      fg.gain.value = key === "f1" ? 0.6 : key === "f2" ? 0.45 : 0.2;
      osc.connect(bp); bp.connect(fg); fg.connect(mix);
    }

    const env = c.createGain();
    const peak = 0.14 + intensity * 0.06;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + Math.min(0.012, dur * 0.2));
    env.gain.linearRampToValueAtTime(peak * 0.55, t + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mix.connect(env);
    env.connect(radio);
    osc.start(t);
    osc.stop(t + dur + 0.02);

    // Inter-syllable gap (shorter than syllable to keep speech rhythm).
    t += dur + 0.02 + musicRng() * 0.06;
  }
}

// Schedule a crowd of 1-3 speakers starting around `at`, each slightly
// offset in time so they read as overlapping voices rather than one source.
function _mrPlayVocalChatter(at, intensity) {
  const voices = 1 + Math.floor(musicRng() * 3);
  for (let v = 0; v < voices; v++) {
    const offset = v === 0 ? 0 : musicRng() * 0.6;
    _mrChatterVoice(at + offset, intensity);
  }
}

// ---- Choir cue ----
//
// A sequence of 4-6 staggered sustained notes, each 5-9 s long and
// starting 1.5-3 s after the previous, so 2-4 notes overlap at any moment.
// Each voice is detuned-saw pair → "AH" formants → lowpass → slow-attack
// sustained envelope with mid-note swell. The note sequence walks the
// current scale, producing a melodic line.

function _mrChoirNoteAt(startAt, freq, dur, intensity) {
  const c = audioCtx;

  const vocalMix = c.createGain();
  for (const detune of [-7, +7]) {
    const saw = c.createOscillator();
    saw.type = "sawtooth";
    saw.detune.value = detune;
    saw.frequency.value = freq;
    saw.connect(vocalMix);
    saw.start(startAt);
    saw.stop(startAt + dur + 0.25);
  }

  // Slow vibrato as amplitude tremor.
  const lfo = c.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 3.6 + musicRng() * 1.6;
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = 0.05 + musicRng() * 0.03;
  lfo.connect(lfoDepth);
  const am = c.createGain();
  am.gain.value = 1;
  lfoDepth.connect(am.gain);
  lfo.start(startAt);
  lfo.stop(startAt + dur + 0.25);
  vocalMix.connect(am);

  // "AH" (/ɑː/) vowel formants.
  const mix = c.createGain();
  for (const fm of [
    { f: 700,  q: 2.4, g: 1.0  },
    { f: 1150, q: 2.0, g: 0.55 },
    { f: 2700, q: 3.0, g: 0.18 },
  ]) {
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = fm.f;
    bp.Q.value = fm.q;
    const fg = c.createGain();
    fg.gain.value = fm.g;
    am.connect(bp); bp.connect(fg); fg.connect(mix);
  }
  const warm = c.createBiquadFilter();
  warm.type = "lowpass";
  warm.frequency.value = 4000 + musicRng() * 400;
  warm.Q.value = 0.5;
  mix.connect(warm);

  // Slow attack, gentle mid-note swell (±10%), long release.
  const env = c.createGain();
  const peak = 0.085 + 0.04 * intensity;
  const attack = 0.9 + musicRng() * 0.8;
  const mid = dur * (0.45 + musicRng() * 0.2);
  env.gain.setValueAtTime(0, startAt);
  env.gain.linearRampToValueAtTime(peak, startAt + Math.min(attack, dur * 0.4));
  env.gain.linearRampToValueAtTime(peak * (0.8 + musicRng() * 0.25),
                                   startAt + mid);
  env.gain.linearRampToValueAtTime(peak * 0.7, startAt + dur * 0.85);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  warm.connect(env);
  env.connect(musicMainBus);
  if (typeof sendToReverb === "function") sendToReverb(env, 0.72);
}

function _mrPlayChoirCue(at, intensity) {
  const bed = MUSIC_BEDS[musicBedIdx];
  const scale = MUSIC_SCALES[bed.scale];

  // Register is fixed per cue so the sequence hangs together.
  const octaveShift = 36 + (musicRng() < 0.4 ? 12 : 0);
  const intervalPool = [0, 7, 5, 3];  // root, P5, P4, m3 (consonant-ish)

  // Melodic walk on scale indices: mostly stepwise with occasional holds
  // and small leaps — this is the primary melodic line the ear tracks.
  let idx = Math.floor(musicRng() * scale.length);
  const noteCount = 4 + Math.floor(musicRng() * 3);
  let t = at;
  for (let i = 0; i < noteCount; i++) {
    if (i > 0) {
      const r = musicRng();
      let step;
      if (r < 0.2)      step = 0;                                 // hold
      else if (r < 0.78) step = musicRng() < 0.5 ? -1 : 1;        // stepwise
      else if (r < 0.94) step = Math.floor(musicRng() * 5) - 2;   // ±1-2 leap
      else              step = (musicRng() < 0.5 ? -1 : 1)
                              * (3 + Math.floor(musicRng() * 2));  // larger leap
      idx = (idx + step + scale.length * 8) % scale.length;
    }
    const deg = scale[idx];
    const iv = intervalPool[Math.floor(musicRng() * intervalPool.length)];
    const freq = _mrHz(deg + iv + octaveShift, bed.tonic);
    const dur = 5 + musicRng() * 4;                   // 5-9 s per note
    _mrChoirNoteAt(t, freq, dur, intensity);
    // Stagger: next note starts 1.5-3 s after this one, so at any time
    // 2-4 notes are ringing simultaneously.
    t += 1.5 + musicRng() * 1.5;
  }
}

// ---- Scheduler ----

function _mrTick() {
  const c = audioCtx;
  if (!c || !musicRunning) return;

  // Track volume from settings live.
  if (musicOutBus) {
    const target = musicVolumeScale * (settings.volume || 0) * (1 - musicDuckAmount * 0.7);
    musicOutBus.gain.value = target;
  }

  const horizon = c.currentTime + MUSIC_LOOKAHEAD_SEC;
  const stepsPerSec = 1 / musicSecPerStep;

  // Breather: 15-30s every 90-180s. Suppresses mid/high/industrial/gloss
  // stems and the choir; chatter, texture, and sub-pulse keep playing.
  if (musicStep - musicLastBreatherAt > Math.floor((90 + musicRng() * 90) * stepsPerSec)) {
    musicLastBreatherAt = musicStep;
    musicBreatherUntil = musicStep + Math.floor((15 + musicRng() * 15) * stepsPerSec);
  }

  // Textural drone gesture every 5-12s.
  if (musicStep >= musicNextTextureAt && _mrTimeSec() > 3) {
    const textAt = c.currentTime + 0.1;
    _mrPlayTextureGesture(textAt, _mrIntensity());
    musicNextTextureAt = musicStep + Math.floor((5 + musicRng() * 7) * stepsPerSec);
  }

  // Rotate the harmonic bed every 4-6 min at sustained cap.
  if (musicDifficulty > 0.85
      && musicStep - musicLastBedChangeAt > Math.floor((240 + musicRng() * 120) * stepsPerSec)) {
    let nxt = musicBedIdx;
    while (nxt === musicBedIdx) nxt = Math.floor(musicRng() * MUSIC_BEDS.length);
    _mrCrossfadeBed(nxt);
  }

  // Vocal chatter every 2-6s. Scheduled on c.currentTime rather than the
  // step grid so it sits off the beat.
  if (musicStep >= musicNextChatterAt) {
    const chatterAt = c.currentTime + 0.08;
    _mrPlayVocalChatter(chatterAt, _mrIntensity());
    musicNextChatterAt = musicStep + Math.floor((2 + musicRng() * 4) * stepsPerSec);
  }

  // Choir cue every 14-36s. Skipped during breathers.
  if (musicStep >= musicNextChoirAt && musicStep >= musicBreatherUntil
      && _mrTimeSec() > 8) {
    const choirAt = c.currentTime + 0.1;
    _mrPlayChoirCue(choirAt, _mrIntensity());
    musicNextChoirAt = musicStep + Math.floor((14 + musicRng() * 22) * stepsPerSec);
  }

  while (musicNextStepTime < horizon) {
    const stepTime = musicNextStepTime;
    const step = musicStep;

    if (step >= musicStemsRerollAt) {
      _mrRerollStems();
      // 8-16 bars at 16 steps/bar = 128-256 steps.
      musicStemsRerollAt = step + 128 + Math.floor(musicRng() * 128);
    }

    const intensity = _mrIntensity();
    const level = 0.35 + 0.65 * intensity;
    const inBreather = step < musicBreatherUntil;

    // Sub-pulse always fires — the only percussion layer at intensity 0
    // and the sidechain source for the main-bus duck.
    if (musicStems.sub.pattern[step % musicStems.sub.steps]) {
      _mrPlayKick(stepTime, 0.6 + 0.4 * intensity);
    }
    // Mid / high / industrial / gloss are all breather-gated.
    if (!inBreather && musicRng() < 0.92
        && musicStems.mid.pattern[step % musicStems.mid.steps]
        && intensity > 0.15) {
      _mrPlayMetalHit(stepTime, level * 0.9);
    }
    if (!inBreather
        && musicStems.high.pattern[step % musicStems.high.steps]
        && intensity > 0.35) {
      _mrPlayGlitch(stepTime, level);
    }
    if (!inBreather && musicRng() < musicStems.arr.density * (0.5 + intensity)) {
      _mrPlayIndustrial(stepTime, level * 0.8);
    }
    // Gloss picks a random timbre (ping / stab / ring-mod / bit-crush)
    // inside _mrPlayHighPerc so repetitions don't lock into a pattern.
    if (!inBreather
        && musicStems.gloss.pattern[step % musicStems.gloss.steps]
        && intensity > 0.15) {
      _mrPlayHighPerc(stepTime, level * 0.95);
    }

    musicNextStepTime += musicSecPerStep;
    musicStep += 1;
  }
}

// ---- Public API ----

function musicStart(seed) {
  const c = ensureAudio();
  if (!c) return;
  if (musicRunning) return;
  if (typeof ensureReverb === "function") ensureReverb();

  musicRng = _mrMakeRng(seed || Math.floor(Math.random() * 1_000_000_007));
  musicBpm = 90 + Math.floor(musicRng() * 51);          // 90-140
  const secPerBeat = 60 / musicBpm;
  musicSecPerStep = secPerBeat / MUSIC_STEPS_PER_BEAT;
  musicSessionPeriodSec = 45 + musicRng() * 45;
  musicSessionOffset = musicRng() * 240;

  musicStartedAt = c.currentTime + 0.12;
  musicNextStepTime = musicStartedAt;
  musicStep = 0;
  musicLastBreatherAt = 0;
  musicBreatherUntil = 0;

  // Bus graph: out ← duck ← main; sub bypasses duck.
  musicOutBus = c.createGain();
  musicOutBus.gain.value = musicVolumeScale * (settings.volume || 0);
  musicOutBus.connect(c.destination);
  musicMainBus = c.createGain();
  musicMainBus.gain.value = 1;
  musicDuckNode = c.createGain();
  musicDuckNode.gain.value = 1;
  musicMainBus.connect(musicDuckNode);
  musicDuckNode.connect(musicOutBus);
  musicSubBus = c.createGain();
  musicSubBus.gain.value = 0.9;
  musicSubBus.connect(musicOutBus);
  // Music bus sends a small amount to the shared reverb for spatial glue.
  if (typeof sendToReverb === "function") sendToReverb(musicMainBus, 0.22);

  _mrGrainBuf = _mrMakeSourceBuffer(c, 1.4, "metal");

  musicBedIdx = Math.floor(musicRng() * MUSIC_BEDS.length);
  _mrStartBed(musicBedIdx);
  _mrRerollStems();
  musicStemsRerollAt = 128;

  musicNextChatterAt = Math.floor((2 + musicRng() * 3) / musicSecPerStep);
  musicNextChoirAt = Math.floor((12 + musicRng() * 20) / musicSecPerStep);
  musicNextTextureAt = Math.floor((3 + musicRng() * 6) / musicSecPerStep);

  musicRunning = true;
  if (musicScheduler) clearInterval(musicScheduler);
  musicScheduler = setInterval(_mrTick, MUSIC_SCHED_INTERVAL_MS);
}

function musicStop() {
  if (!musicRunning) return;
  musicRunning = false;
  if (musicScheduler) { clearInterval(musicScheduler); musicScheduler = null; }
  const c = audioCtx;
  if (!c) return;
  const at = c.currentTime;
  // Fade all buses to silence, then disconnect after a delay.
  if (musicOutBus) {
    musicOutBus.gain.cancelScheduledValues(at);
    musicOutBus.gain.setValueAtTime(musicOutBus.gain.value, at);
    musicOutBus.gain.linearRampToValueAtTime(0, at + 0.6);
  }
  const bus = musicOutBus;
  const main = musicMainBus;
  const duck = musicDuckNode;
  const sub = musicSubBus;
  musicOutBus = musicMainBus = musicDuckNode = musicSubBus = null;
  setTimeout(() => {
    try { bus && bus.disconnect(); } catch (e) {}
    try { main && main.disconnect(); } catch (e) {}
    try { duck && duck.disconnect(); } catch (e) {}
    try { sub && sub.disconnect(); } catch (e) {}
  }, 800);
}

function musicSetDifficulty(d) {
  musicDifficulty = Math.max(0, Math.min(1, d || 0));
}

function musicSetDucking(v) {
  musicDuckAmount = Math.max(0, Math.min(1, v || 0));
}

function musicOnDamage() {
  if (!musicRunning) return;
  const c = audioCtx;
  const at = c.currentTime + 0.02;
  const bed = MUSIC_BEDS[musicBedIdx];
  const v = _mrMakeFmVoice(c, _mrHz(bed.partner + 1, bed.tonic), 1.33, 2.4);
  const env = c.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(0.22, at + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
  v.out.connect(env); env.connect(musicMainBus);
  if (typeof sendToReverb === "function") sendToReverb(env, 0.45);
  v.start(at); v.stop(at + 0.6);
}

function musicOnMilestone() {
  if (!musicRunning) return;
  let nxt = musicBedIdx;
  while (nxt === musicBedIdx) nxt = Math.floor(musicRng() * MUSIC_BEDS.length);
  _mrCrossfadeBed(nxt);
}

function musicOnDeath() {
  if (!musicRunning) return;
  const c = audioCtx;
  const at = c.currentTime + 0.02;
  const bed = MUSIC_BEDS[musicBedIdx];
  for (let i = 0; i < 3; i++) {
    const freq = bed.tonic * 2 * (1 + (i - 1) * 0.006);
    const real = new Float32Array([0, 1, 0.5, 0.3, 0.2]);
    const imag = new Float32Array(5);
    const v = _mrMakeWavetableVoice(c, freq, real, imag);
    const env = c.createGain();
    env.gain.setValueAtTime(0.22, at);
    env.gain.linearRampToValueAtTime(0.18, at + 1.6);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 2.1);
    v.carrier.frequency.setValueAtTime(freq, at);
    v.carrier.frequency.exponentialRampToValueAtTime(freq * 0.5, at + 2.1);
    v.out.connect(env); env.connect(musicMainBus);
    if (typeof sendToReverb === "function") sendToReverb(env, 0.5);
    v.start(at); v.stop(at + 2.2);
  }
}
