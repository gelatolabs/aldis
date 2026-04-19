"use strict";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

const lamp = {
  x: 70,
  y: H / 2,
  angle: 0,
  // aim is in [-1, 1], mapped linearly to angle in [-π/2, π/2].
  // Scroll speed acceleration is applied in the wheel handler.
  aim: 0,
  beamTimer: 0,
  beamKind: null,
  held: false,
};

function setAim(v) {
  lamp.aim = Math.max(-1, Math.min(1, v));
  lamp.angle = lamp.aim * (Math.PI / 2);
}

const player = {
  maxHealth: 10,
  missed: 0,
};

let inputMorse = "";
let inputResetTimer = 0;
const LETTER_TIMEOUT_MS = 1200;

// Freezes the completed (or aborted) morse string briefly so the final
// dot/dash is visible above the enemy word before it clears.
let lastLetterMorse = "";
let lastLetterTimer = 0;
const LAST_LETTER_DISPLAY_MS = 350;

let enemies = [];
let spawnTimer = 3000;
let elapsed = 0;
let gameOver = false;
let score = 0;

// Tracks the aim angle from the previous frame so a scroll that jumps the
// lamp across multiple degrees still "sweeps" and pings any enemies the aim
// line passed over between frames.
let prevLampAngle = 0;

// Beam cone geometry (constants — referenced by both radar/illum logic and
// the beam-light renderer).
const BEAM_LEN = 1500;
const BEAM_HALF_WIDTH = 80;       // perpendicular half-width at full range
const BEAM_NEAR_WIDTH = 12;       // near-field half-width at the lens
const RADAR_FADE_MS = 1400;

// Scene / screen state
const SCENE = {
  splash: "splash",
  menu: "menu",
  settings: "settings",
  scores: "scores",
  credits: "credits",
  game: "game",
  highScoreEntry: "highScoreEntry",
  leaderboard: "leaderboard",
};
let currentScene = SCENE.splash;
let sceneTime = 0;

// Input tuning, editable from the settings screen
const settings = {
  base: 0.0002,
  accelMax: 10.0,
  volume: 0.5,
};

// Press → morse translation: hold duration threshold between dot and dash.
const DASH_MS = 180;

// ----- Persist user settings in localStorage -----
const SETTINGS_KEY = "aldis_settings";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.base === "number")     settings.base = data.base;
    if (typeof data.accelMax === "number") settings.accelMax = data.accelMax;
    if (typeof data.volume === "number")   settings.volume = data.volume;
  } catch (e) { /* ignore */ }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      base: settings.base,
      accelMax: settings.accelMax,
      volume: settings.volume,
    }));
  } catch (e) { /* quota or privacy mode — ignore */ }
}

loadSettings();

const BASE_SPEED = 28;
function baseSpeed() {
  return BASE_SPEED + Math.random() * 4;
}

function difficulty() {
  return Math.min(1, elapsed / 720000);
}

function spawnInterval() {
  const d = difficulty();
  return 7500 - 4000 * d + Math.random() * 1000;
}
