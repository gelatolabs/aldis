"use strict";

// Logo used on splash
const logoImg = new Image();
logoImg.src = "assets/logo.png";

// Splash timing
const SPLASH_FADE_IN  = 600;
const SPLASH_HOLD     = 1400;
const SPLASH_FADE_OUT = 600;
const SPLASH_TOTAL    = SPLASH_FADE_IN + SPLASH_HOLD + SPLASH_FADE_OUT;

function splashAlpha() {
  const t = sceneTime;
  if (t < SPLASH_FADE_IN) return t / SPLASH_FADE_IN;
  if (t < SPLASH_FADE_IN + SPLASH_HOLD) return 1;
  const r = t - SPLASH_FADE_IN - SPLASH_HOLD;
  return Math.max(0, 1 - r / SPLASH_FADE_OUT);
}

function enterScene(s) {
  currentScene = s;
  sceneTime = 0;
  dragSlider = null;
  if (typeof clearInputState === "function") clearInputState();
  // Reset the aim only when fresh-opening the calibration screen — not when
  // pausing, which should preserve the in-game aim.
  if (s === SCENE.settings && !paused) setAim(0);
}

// ----- Buttons -----

function currentButtons() {
  const cx = W / 2;
  if (currentScene === SCENE.menu) {
    return [
      { label: "PLAY",    x: cx - 120, y: 292, w: 240, h: 56,
        action: () => enterScene(SCENE.settings) },
      { label: "SCORES",  x: cx - 120, y: 362, w: 240, h: 56,
        action: () => { fetchTopScores(); enterScene(SCENE.scores); } },
      { label: "CREDITS", x: cx - 120, y: 432, w: 240, h: 56,
        action: () => enterScene(SCENE.credits) },
    ];
  }
  if (currentScene === SCENE.settings) {
    return [
      paused
        ? { label: "RESUME", x: cx - 70, y: 560, w: 140, h: 44,
            action: () => { paused = false; enterScene(SCENE.game); } }
        : { label: "START",  x: cx - 60, y: 560, w: 120, h: 44,
            action: () => { resetGame(); enterScene(SCENE.game); } },
    ];
  }
  if (currentScene === SCENE.credits || currentScene === SCENE.scores
      || currentScene === SCENE.leaderboard) {
    return [
      { label: "MENU", x: cx - 60, y: H - 70, w: 120, h: 40,
        action: () => enterScene(SCENE.menu) },
    ];
  }
  if (currentScene === SCENE.highScoreEntry) {
    const boxSize = 60, boxGap = 14;
    const totalBoxW = boxSize * 3 + boxGap * 2;
    const panelCX = 700;
    const startX = panelCX - totalBoxW / 2;
    const boxY = 240;
    return [
      { label: "<",
        x: startX + totalBoxW + boxGap, y: boxY, w: boxSize, h: boxSize,
        disabled: entryName.length === 0,
        action: () => { if (entryName.length > 0) entryName = entryName.slice(0, -1); } },
      { label: "SUBMIT",
        x: panelCX - 100, y: boxY + boxSize + 40, w: 200, h: 44,
        disabled: entryName.length !== 3,
        action: () => {
          submitTopScore();
          enterScene(SCENE.leaderboard);
        } },
      { label: "MENU",
        x: cx - 60, y: H - 70, w: 120, h: 40,
        action: () => enterScene(SCENE.menu) },
    ];
  }
  return [];
}

function buttonHit(btn, x, y) {
  return x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h;
}

// ----- Sliders (settings screen) -----

const sliders = [
  { key: "volume",   label: "VOLUME",
    x: 240, y: 206, w: 540, h: 10,
    min: 0.0, max: 1.0,
    format: v => Math.round(v * 100) + "%" },
  { key: "base",     label: "SCROLL SPEED",
    x: 240, y: 354, w: 540, h: 10,
    min: 0.00001, max: 0.002,
    format: v => Math.round(v * 100000).toString() },
  { key: "accelMax", label: "ACCELERATION",
    x: 240, y: 414, w: 540, h: 10,
    min: 1.0, max: 20.0,
    format: v => v.toFixed(1) + "x" },
];

// Display segmented control — three buttons (Default / Scaled / Fullscreen).
// "Scaled" is hidden when the viewport already can't fit the canvas natively.
const DISPLAY_ROW_Y = 116;
const DISPLAY_BTN_H = 34;
const DISPLAY_BTN_W = 130;
const DISPLAY_BTN_GAP = 8;
const DISPLAY_LABELS = { default: "Default", scaled: "Scaled", fullscreen: "Fullscreen" };

function displayButtons() {
  const options = ["default", "scaled", "fullscreen"]
    .filter(o => displayOptionAvailable(o));
  const startX = 240;
  return options.map((opt, i) => ({
    key: opt,
    label: DISPLAY_LABELS[opt],
    x: startX + i * (DISPLAY_BTN_W + DISPLAY_BTN_GAP),
    y: DISPLAY_ROW_Y,
    w: DISPLAY_BTN_W,
    h: DISPLAY_BTN_H,
  }));
}
let dragSlider = null;

function sliderHit(s, x, y) {
  return x >= s.x - 10 && x <= s.x + s.w + 10
      && y >= s.y - 14 && y <= s.y + s.h + 14;
}

function setSliderFromX(s, x) {
  const t = Math.max(0, Math.min(1, (x - s.x) / s.w));
  settings[s.key] = s.min + t * (s.max - s.min);
  saveSettings();
}

// ----- Credits -----

const CREDITS_LINES = [
  "",
];
