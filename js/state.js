"use strict";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

// The lamp the local player controls. In multiplayer modes its `x`/`y` and
// the direction its beam swings are reconfigured by setupForMode().
const lamp = {
  x: 70,
  y: H / 2,
  angle: 0,
  // aim is in [-1, 1], mapped linearly to a swing range that depends on the
  // current mode (see lampAimRange).
  aim: 0,
  beamTimer: 0,
  beamKind: null,
  held: false,
};

// Mirror of the peer's lamp used for rendering only — in multiplayer this is
// updated from received "input" messages.
const peerLamp = {
  x: 0,
  y: 0,
  angle: 0,
  aim: 0,
  beamTimer: 0,
  beamKind: null,
  held: false,
  active: false,
};

// Aim range for the local lamp. Survival/co-op players sweep ±π/2 around
// "facing right". The right-side versus player faces left, so its aim range is
// mirrored: aim=-1 → angle=π+π/2, aim=+1 → angle=π-π/2.
let lampAimMid  = 0;          // center angle (radians)
let lampAimSpan = Math.PI / 2; // half-range in radians

function setAim(v) {
  lamp.aim = Math.max(-1, Math.min(1, v));
  lamp.angle = lampAimMid + lamp.aim * lampAimSpan;
}

const player = {
  maxHealth: 10,
  missed: 0,
};

// Versus-only: the peer's HP we display alongside our own.
const peerPlayer = {
  maxHealth: 3,
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
let freezeTimer = 0;
let elapsed = 0;
let animTime = 0;
let enemyAnimTime = 0;    // paused during freeze powerup
let windowFocused = true;
let gameOver = false;
let score = 0;

// Per-player co-op contributions. `score` is the shared total; these track
// each player's individual contribution so the end-of-game screens can show
// a "you / them" breakdown.
let coopOwnScore = 0;
let coopPeerScore = 0;

// Tracks the aim angle from the previous frame so a scroll that jumps the
// lamp across multiple degrees still "sweeps" and pings any enemies the aim
// line passed over between frames.
let prevLampAngle = 0;
let prevPeerLampAngle = 0;

// Beam cone geometry (constants — referenced by both radar/illum logic and
// the beam-light renderer).
const BEAM_LEN = 1500;
const BEAM_HALF_WIDTH = 80;       // perpendicular half-width at full range
const BEAM_NEAR_WIDTH = 8;        // near-field half-width at the lens
const RADAR_FADE_MS = 1400;

// Scene / screen state
const SCENE = {
  splash: "splash",
  menu: "menu",
  settings: "settings",
  scores: "scores",
  credits: "credits",
  tutorial: "tutorial",
  game: "game",
  story: "story",
  storyText: "storyText",
  highScoreEntry: "highScoreEntry",
  leaderboard: "leaderboard",
  matchmaking: "matchmaking",
  versusEnd: "versusEnd",
};

// Active gameplay mode — set when a game starts. "survival" / "story" use the
// standard single-lamp setup. "coop" pairs two lamps stacked on the left side.
// "versus" puts one lamp on each side and adds a per-player HP.
let gameMode = "survival";

// Versus-only: did we win or lose?
let versusWon = false;

// Counter used to assign deterministic ids to enemies spawned by the host so
// peers can address them in kill / miss events.
let nextEnemyId = 1;

// Which flow the player chose on the menu; read by the START button on the
// options screen to route into survival or story.
let pendingStart = "survival";
let currentScene = SCENE.splash;
let sceneTime = 0;

// Message shown briefly on the menu after a match disconnects with the reason.
let menuNotice = null;
let menuNoticeUntil = 0;
function setMenuNotice(text, durationMs) {
  menuNotice = text;
  menuNoticeUntil = performance.now() + (durationMs || 5000);
}

// Input tuning, editable from the settings screen
const settings = {
  base: 0.0002,
  accelMax: 10.0,
  volume: 0.5,
  display: "default",  // "default" | "scaled" | "fullscreen"
  postProcess: true,
};

// Set true while pausing the game from the Options screen; resumes instead of
// restarting when the user clicks the primary button. `pausedFrom` records
// which scene the player paused out of so RESUME returns there.
let paused = false;
let pausedFrom = SCENE.game;

// Press → morse translation: hold duration threshold between dot and dash.
const DASH_MS = 180;

// ----- Persist user settings in localStorage -----
const SETTINGS_KEY = "aldis_settings";
const OPTIONS_SEEN_KEY = "aldis_options_seen";

function optionsSeen() {
  try { return localStorage.getItem(OPTIONS_SEEN_KEY) === "1"; }
  catch (e) { return false; }
}

function markOptionsSeen() {
  try { localStorage.setItem(OPTIONS_SEEN_KEY, "1"); } catch (e) { /* ignore */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.base === "number")     settings.base = data.base;
    if (typeof data.accelMax === "number") settings.accelMax = data.accelMax;
    if (typeof data.volume === "number")   settings.volume = data.volume;
    if (typeof data.display === "string" &&
        ["default","scaled","fullscreen"].includes(data.display)) {
      settings.display = data.display;
    }
    if (typeof data.postProcess === "boolean") settings.postProcess = data.postProcess;
  } catch (e) { /* ignore */ }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      base: settings.base,
      accelMax: settings.accelMax,
      volume: settings.volume,
      display: settings.display,
      postProcess: settings.postProcess,
    }));
  } catch (e) { /* quota or privacy mode — ignore */ }
}

loadSettings();

// ----- Display (canvas scaling / fullscreen) -----

function viewportTooSmall() {
  return window.innerWidth < 1024 || window.innerHeight < 640;
}

// Frozen when entering fullscreen so the Scaled button's visibility doesn't
// flicker on/off just because the fullscreen viewport is bigger than the
// windowed one.
let scaledHiddenAtFsEntry = false;

// Remembers the display mode that was active before entering fullscreen, so
// dropping out of fullscreen returns to that mode instead of "default".
let preFullscreenMode = "default";

function displayOptionAvailable(opt) {
  if (opt === "scaled") {
    if (document.fullscreenElement) return !scaledHiddenAtFsEntry;
    return !viewportTooSmall();
  }
  return true;
}

function applyDisplay() {
  const mode = settings.display || "default";
  const useScaled = mode !== "default" || viewportTooSmall();
  canvas.classList.toggle("scaled", useScaled);

  const inFs = !!document.fullscreenElement;
  if (mode === "fullscreen" && !inFs) {
    scaledHiddenAtFsEntry = viewportTooSmall();
    try {
      const p = document.documentElement.requestFullscreen &&
                document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* no-op */ }
  } else if (mode !== "fullscreen" && inFs) {
    try {
      const p = document.exitFullscreen && document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* no-op */ }
  }
}

// Apply once now and on viewport/fullscreen changes.
applyDisplay();
window.addEventListener("resize", applyDisplay);
document.addEventListener("fullscreenchange", () => {
  // If fullscreen was exited (e.g. Esc pressed), return to the mode the
  // user was in before they enabled fullscreen.
  if (!document.fullscreenElement && settings.display === "fullscreen") {
    settings.display = preFullscreenMode || "default";
    saveSettings();
    applyDisplay();
  }
});

const BASE_SPEED = 28;
function baseSpeed() {
  return BASE_SPEED + Math.random() * 4;
}

function difficulty() {
  const t = Math.min(1, elapsed / 600000);
  return Math.log1p(9 * t) / Math.log(10);
}

function spawnInterval() {
  const d = difficulty();
  const floor = (gameMode === "coop" || gameMode === "versus") ? 3000 : 5000;
  const base = 7500 - (7500 - floor) * d + Math.random() * 1000;
  return debug.fastSpawn ? base / 15 : base;
}
