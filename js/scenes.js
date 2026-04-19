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
  if (s === SCENE.settings) setAim(0);
}

// ----- Buttons -----

function currentButtons() {
  const cx = W / 2;
  if (currentScene === SCENE.menu) {
    return [
      { label: "PLAY",    x: cx - 120, y: 340, w: 240, h: 56,
        action: () => enterScene(SCENE.settings) },
      { label: "CREDITS", x: cx - 120, y: 410, w: 240, h: 56,
        action: () => enterScene(SCENE.credits) },
    ];
  }
  if (currentScene === SCENE.settings) {
    return [
      { label: "START",   x: cx - 60, y: 560, w: 120, h: 44,
        action: () => { resetGame(); enterScene(SCENE.game); } },
    ];
  }
  if (currentScene === SCENE.credits) {
    return [
      { label: "BACK", x: cx - 60, y: H - 70, w: 120, h: 40,
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
  { key: "base",     label: "SCROLL SPEED",
    x: 240, y: 230, w: 540, h: 10,
    min: 0.00001, max: 0.002,
    format: v => Math.round(v * 100000).toString() },
  { key: "accelMax", label: "ACCELERATION",
    x: 240, y: 310, w: 540, h: 10,
    min: 1.0, max: 20.0,
    format: v => v.toFixed(1) + "x" },
  { key: "volume",   label: "VOLUME",
    x: 240, y: 390, w: 540, h: 10,
    min: 0.0, max: 1.0,
    format: v => Math.round(v * 100) + "%" },
];
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
