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
