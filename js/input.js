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
  if (currentScene !== SCENE.game
      && currentScene !== SCENE.settings
      && currentScene !== SCENE.tutorial
      && currentScene !== SCENE.story) return;
  if (tutorialScrollLocked()) return;
  if (currentScene === SCENE.story && story.gameOver) return;

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
  primeAudio();
  const { x, y } = canvasCoords(e);

  if (currentScene === SCENE.splash) { enterScene(SCENE.menu); return; }
  // While scores are loading between game end and scene transition, swallow
  // clicks so the leaderboard/entry scene isn't missed.
  if (currentScene === SCENE.game && gameOver) return;
  if (currentScene === SCENE.storyText) { storyTextClickAdvance(); return; }
  if (currentScene === SCENE.highScoreEntry) {
    for (const btn of currentButtons()) {
      if (buttonHit(btn, x, y)) {
        if (!btn.disabled) btn.action();
        return;
      }
    }
    if (inNameEntry()) pressBegin("mouse:" + e.button);
    return;
  }

  if (currentScene === SCENE.settings) {
    for (const btn of displayButtons()) {
      if (buttonHit(btn, x, y)) {
        if (btn.key === "fullscreen" && settings.display !== "fullscreen") {
          preFullscreenMode = settings.display;
        }
        settings.display = btn.key;
        saveSettings();
        applyDisplay();
        return;
      }
    }
    for (const btn of postProcessButtons()) {
      if (buttonHit(btn, x, y)) {
        settings.postProcess = btn.key;
        saveSettings();
        return;
      }
    }
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

  if (currentScene === SCENE.game
      || currentScene === SCENE.tutorial
      || (currentScene === SCENE.story && !story.gameOver)) {
    pressBegin("mouse:" + e.button);
  }
});

window.addEventListener("mouseup", (e) => {
  dragSlider = null;
  pressEnd("mouse:" + e.button);
});

// Track the mouse so the renderer can highlight hovered controls. Coordinates
// are in canvas space.
let mouseCanvasX = -9999;
let mouseCanvasY = -9999;

window.addEventListener("mousemove", (e) => {
  const { x, y } = canvasCoords(e);
  mouseCanvasX = x;
  mouseCanvasY = y;
  if (dragSlider) {
    setSliderFromX(dragSlider, x);
    volumeSliderSound(dragSlider);
  }
});
window.addEventListener("mouseleave", () => {
  mouseCanvasX = -9999;
  mouseCanvasY = -9999;
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
  primeAudio();
  if (e.code === "Space") {
    const inGame  = currentScene === SCENE.game && !gameOver;
    const inEntry = inNameEntry();
    const inTut   = currentScene === SCENE.tutorial;
    const inStory = currentScene === SCENE.story && !story.gameOver;
    if (!inGame && !inEntry && !inTut && !inStory) return;
    if (e.repeat) return;
    e.preventDefault();
    pressBegin("key:Space");
    return;
  }
  // P pauses the running game and toggles the options screen.
  if (e.code === "KeyP" && !e.repeat) {
    if ((currentScene === SCENE.game && !gameOver)
        || currentScene === SCENE.tutorial
        || (currentScene === SCENE.story && !story.gameOver)) {
      paused = true;
      pausedFrom = currentScene;
      enterScene(SCENE.settings);
    } else if (currentScene === SCENE.settings && paused) {
      paused = false;
      enterScene(pausedFrom);
    }
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  pressEnd("key:Space");
});

function inputSignal(kind) {
  if (kind === "dot") playDot(); else playDash();

  if (currentScene === SCENE.tutorial) tutorialOnSignal(kind);

  // Name entry uses global buffer. Game uses per-enemy buffers below.
  if (inNameEntry()) {
    lastLetterMorse = "";
    lastLetterTimer = 0;
    inputMorse += (kind === "dot" ? "." : "-");
    inputResetTimer = LETTER_TIMEOUT_MS;
    return;
  }

  const targets = enemiesHitByBeam();
  if (targets.length === 0) return;
  const sym = kind === "dot" ? "." : "-";
  for (const enemy of targets) {
    enemy.lastMorse = "";
    enemy.lastTimer = 0;
    enemy.morse = (enemy.morse || "") + sym;
    enemy.morseTimer = LETTER_TIMEOUT_MS;
    matchEnemy(enemy);
  }
}

// Match an enemy against its  morse buffer. Mutates the enemy:
//   full match  → advance `typed`, freeze the buffer for display, may kill.
//   prefix      → keep buffer, brief hitFlash.
//   mismatch    → reset `typed` and the buffer.
function matchEnemy(enemy) {
  const expectedChar = enemy.word[enemy.typed];
  if (!expectedChar) return;
  const expectedMorse = MORSE[expectedChar];
  if (!expectedMorse) return;

  if (expectedMorse === enemy.morse) {
    enemy.typed += 1;
    enemy.hitFlash = 160;
    enemy.lastMorse = enemy.morse;
    enemy.lastTimer = LAST_LETTER_DISPLAY_MS;
    enemy.morse = "";
    enemy.morseTimer = 0;
    if (enemy.typed >= enemy.word.length) {
      enemy.alive = false;
      enemy.deathAnim = 400;
      const pts = enemy.typeKey === "runner" ? 250 : 50 * enemy.word.length;
      enemy.deathPoints = pts;
      score += pts;
      spawnEnemyExplosion(enemy);
    }
  } else if (expectedMorse.startsWith(enemy.morse)) {
    enemy.hitFlash = 60;
  } else {
    enemy.typed = 0;
    enemy.hitFlash = 0;
    enemy.lastMorse = enemy.morse;
    enemy.lastTimer = LAST_LETTER_DISPLAY_MS;
    enemy.morse = "";
    enemy.morseTimer = 0;
  }
}
