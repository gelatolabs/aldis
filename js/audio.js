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
