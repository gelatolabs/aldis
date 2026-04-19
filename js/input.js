"use strict";

window.addEventListener("contextmenu", (e) => e.preventDefault());

function canvasCoords(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width  / r.width),
    y: (e.clientY - r.top)  * (canvas.height / r.height),
  };
}

// Scroll acceleration: multiply per-notch movement when the user scrolls
// quickly, leaving slow/single notches precise.
let lastScrollAt = 0;
let scrollSpeed = 0;

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (currentScene !== SCENE.game && currentScene !== SCENE.settings) return;

  const now = performance.now();
  const dt = Math.max(1, now - lastScrollAt);
  lastScrollAt = now;

  const decay = Math.exp(-dt / 120);
  const inst = Math.abs(e.deltaY) / dt;
  scrollSpeed = scrollSpeed * decay + inst * (1 - decay);

  const mul = 1 + Math.min(settings.accelMax - 1,
                           Math.max(0, (scrollSpeed - 0.4) * 2.0));
  setAim(lamp.aim + e.deltaY * settings.base * mul);
}, { passive: false });

// Any mouse button or the spacebar starts a press; releasing before DASH_MS
// sends a dot, holding past DASH_MS sends a dash and turns off the light.
const heldSources = new Set();
let press = null;

function pressBegin(id) {
  if (heldSources.has(id)) return;
  heldSources.add(id);
  if (!press) {
    press = {
      pressTime: performance.now(),
      committed: false,
    };
    lamp.held = true;
    lamp.beamKind = "dash";
    lamp.beamTimer = 220;
  }
}

function pressEnd(id) {
  if (!heldSources.has(id)) return;
  heldSources.delete(id);
  if (heldSources.size === 0 && press) {
    if (!press.committed) inputSignal("dot");
    press = null;
    lamp.held = false;
  }
}

function updatePressInput() {
  if (!press || press.committed) return;
  const now = performance.now();
  if (now - press.pressTime >= DASH_MS) {
    press.committed = true;
    inputSignal("dash");
    // Let the beam fade out naturally (same decay as a dot release) instead
    // of snapping off.
    lamp.held = false;
  }
}

function clearInputState() {
  heldSources.clear();
  press = null;
  lamp.held = false;
}

canvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const { x, y } = canvasCoords(e);

  if (currentScene === SCENE.splash) { enterScene(SCENE.menu); return; }
  if (currentScene === SCENE.game && gameOver) {
    if (e.button === 0) enterScene(SCENE.menu);
    return;
  }

  if (currentScene === SCENE.settings) {
    for (const s of sliders) {
      if (sliderHit(s, x, y)) {
        dragSlider = s;
        setSliderFromX(s, x);
        volumeSliderSound(s);
        return;
      }
    }
  }

  for (const btn of currentButtons()) {
    if (buttonHit(btn, x, y)) { btn.action(); return; }
  }

  if (currentScene === SCENE.game) {
    pressBegin("mouse:" + e.button);
  }
});

window.addEventListener("mouseup", (e) => {
  dragSlider = null;
  pressEnd("mouse:" + e.button);
});
window.addEventListener("mousemove", (e) => {
  if (!dragSlider) return;
  const { x } = canvasCoords(e);
  setSliderFromX(dragSlider, x);
  volumeSliderSound(dragSlider);
});

// Throttled dot-sound feedback while the volume slider is being moved, so
// the user hears the current level as they drag.
let lastVolumeSoundAt = 0;
function volumeSliderSound(s) {
  if (!s || s.key !== "volume") return;
  const now = performance.now();
  if (now - lastVolumeSoundAt < 120) return;
  lastVolumeSoundAt = now;
  playDot();
}
window.addEventListener("blur", clearInputState);

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (currentScene !== SCENE.game || gameOver) return;
  if (e.repeat) return;
  e.preventDefault();
  pressBegin("key:Space");
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  pressEnd("key:Space");
});

function inputSignal(kind) {
  if (kind === "dot") playDot(); else playDash();
  lastLetterMorse = "";
  lastLetterTimer = 0;
  inputMorse += (kind === "dot" ? "." : "-");
  inputResetTimer = LETTER_TIMEOUT_MS;

  const { enemy } = enemyHitByBeam();
  if (!enemy) {
    freezeInputDisplay();
    inputMorse = "";
    return;
  }
  tryMatch(enemy);
}

function freezeInputDisplay() {
  lastLetterMorse = inputMorse;
  lastLetterTimer = LAST_LETTER_DISPLAY_MS;
}

function tryMatch(enemy) {
  const expectedChar = enemy.word[enemy.typed];
  if (!expectedChar) return;
  const expectedMorse = MORSE[expectedChar];
  if (!expectedMorse) return;

  if (expectedMorse === inputMorse) {
    enemy.typed += 1;
    enemy.hitFlash = 160;
    freezeInputDisplay();
    inputMorse = "";
    inputResetTimer = 0;
    if (enemy.typed >= enemy.word.length) {
      enemy.alive = false;
      enemy.deathAnim = 400;
      const pts = enemy.typeKey === "runner" ? 250 : 50 * enemy.word.length;
      enemy.deathPoints = pts;
      score += pts;
    }
  } else if (expectedMorse.startsWith(inputMorse)) {
    enemy.hitFlash = 60;
  } else {
    enemy.typed = 0;
    enemy.hitFlash = 0;
    freezeInputDisplay();
    inputMorse = "";
    inputResetTimer = 0;
  }
}
