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

  // Music lifecycle. Gameplay scenes get music; pause (settings) keeps it
  // running. Story text, menu, leaderboard, matchmaking all stop it.
  const isGameplay = s === SCENE.game || s === SCENE.story;
  if (isGameplay && typeof musicStart === "function") {
    const seed = netInMatch() ? (net.seed | 0) : Math.floor(Math.random() * 2_000_000_000);
    musicStart(seed);
  } else if (s !== SCENE.settings && typeof musicStop === "function") {
    musicStop();
  }
}

// ----- Buttons -----

function startPendingGame() {
  if (pendingStart === "story") {
    enterStory();
  } else if (pendingStart === "coop" || pendingStart === "versus") {
    enterMatchmaking(pendingStart);
  } else if (tutorialSeen()) {
    gameMode = "survival";
    resetGame();
    enterScene(SCENE.game);
  } else {
    enterTutorial();
  }
}

function beginFromMenu(mode) {
  pendingStart = mode;
  if (optionsSeen()) startPendingGame();
  else enterScene(SCENE.settings);
}

function enterMatchmaking(mode) {
  net.onMatch = () => {
    gameMode = mode;
    resetGame();
    enterScene(SCENE.game);
  };
  net.onPeerLeft = (reason) => {
    // High-score entry is the one place we want to gracefully degrade rather
    // than dump the player back to the menu — we treat the missing peer as
    // having skipped so the local player can still submit.
    if (currentScene === SCENE.highScoreEntry && gameMode === "coop") {
      if (!coopPeerSubmitted) {
        recordPeerCoopSkip();
      }
      return;
    }
    // The match is already over on these scenes — let the player keep admiring
    // the win/lose or leaderboard screen instead of yanking them back to the
    // menu when the other side disconnects.
    if (currentScene === SCENE.versusEnd
        || currentScene === SCENE.leaderboard) {
      return;
    }
    if (currentScene === SCENE.game) {
      setMenuNotice(reason || "Partner disconnected");
      enterScene(SCENE.menu);
    }
  };
  net.onPeerMessage = handlePeerMessage;
  netStartMatchmaking(mode);
  enterScene(SCENE.matchmaking);
}

function currentButtons() {
  const cx = W / 2;
  if (currentScene === SCENE.menu) {
    // 4x2 buttons:
    //   Story    Survival
    //   Co-op    Versus
    //   Scores   Options
    //   Tutorial Credits
    const bw = 220, bh = 54, gap = 24;
    const top = 250;
    const xL = cx - bw - gap / 2;
    const xR = cx + gap / 2;
    const rowY = (i) => top + i * (bh + gap);
    return [
      { label: "STORY",    x: xL, y: rowY(0), w: bw, h: bh,
        action: () => beginFromMenu("story") },
      { label: "SURVIVAL", x: xR, y: rowY(0), w: bw, h: bh,
        action: () => beginFromMenu("survival") },
      { label: "CO-OP",    x: xL, y: rowY(1), w: bw, h: bh,
        action: () => beginFromMenu("coop") },
      { label: "VERSUS",   x: xR, y: rowY(1), w: bw, h: bh,
        action: () => beginFromMenu("versus") },
      { label: "SCORES",   x: xL, y: rowY(2), w: bw, h: bh,
        action: () => { fetchTopScores(); fetchTopCoopScores(); enterScene(SCENE.scores); } },
      { label: "OPTIONS",  x: xR, y: rowY(2), w: bw, h: bh,
        action: () => { pendingStart = null; enterScene(SCENE.settings); } },
      { label: "TUTORIAL", x: xL, y: rowY(3), w: bw, h: bh,
        action: () => enterTutorial(() => enterScene(SCENE.menu)) },
      { label: "CREDITS",  x: xR, y: rowY(3), w: bw, h: bh,
        action: () => enterScene(SCENE.credits) },
    ];
  }
  if (currentScene === SCENE.settings) {
    if (paused) {
      return [
        { label: "QUIT", variant: "danger",
          x: cx - 160, y: 560, w: 140, h: 44,
          action: () => { paused = false; netDisconnect(); enterScene(SCENE.menu); } },
        { label: "RESUME",
          x: cx +  20, y: 560, w: 140, h: 44,
          action: () => { paused = false; enterScene(pausedFrom); } },
      ];
    }
    if (!pendingStart) {
      return [
        { label: "BACK", variant: "danger",
          x: cx - 60, y: 560, w: 140, h: 44,
          action: () => enterScene(SCENE.menu) },
      ];
    }
    return [
      { label: "BACK", variant: "danger",
        x: cx - 160, y: 560, w: 140, h: 44,
        action: () => enterScene(SCENE.menu) },
      { label: "START",
        x: cx +  20, y: 560, w: 140, h: 44,
        action: () => { markOptionsSeen(); startPendingGame(); } },
    ];
  }
  if (currentScene === SCENE.credits || currentScene === SCENE.scores
      || currentScene === SCENE.leaderboard) {
    return [
      { label: "MENU", x: cx - 60, y: H - 70, w: 120, h: 40,
        action: () => { netDisconnect(); enterScene(SCENE.menu); } },
    ];
  }
  if (currentScene === SCENE.matchmaking) {
    return [
      { label: "CANCEL", variant: "danger",
        x: cx - 60, y: H - 90, w: 120, h: 44,
        action: () => { netCancelMatchmaking(); enterScene(SCENE.menu); } },
    ];
  }
  if (currentScene === SCENE.versusEnd) {
    return [
      { label: "MENU", x: cx - 60, y: H / 2 + 40, w: 120, h: 44,
        action: () => { netDisconnect(); enterScene(SCENE.menu); } },
    ];
  }
  if (currentScene === SCENE.story && story.gameOver) {
    return [
      { label: "QUIT", variant: "danger",
        x: cx - 160, y: H / 2 + 50, w: 140, h: 44,
        action: () => exitStory() },
      { label: "RETRY",
        x: cx +  20, y: H / 2 + 50, w: 140, h: 44,
        action: () => retryStoryStage() },
    ];
  }
  if (currentScene === SCENE.highScoreEntry) {
    if (gameMode === "coop") {
      const panelCX = 770;
      const boxSize = 56, boxGap = 12;
      const totalBoxW = boxSize * 3 + boxGap * 2;
      const startX = panelCX - totalBoxW / 2;
      const youY = 200;
      return [
        { label: "<",
          x: startX + totalBoxW + boxGap, y: youY, w: boxSize, h: boxSize,
          disabled: coopOwnSubmitted || coopOwnName.length === 0,
          action: () => { if (coopOwnName.length > 0)
            coopOwnName = coopOwnName.slice(0, -1); } },
        { label: "SUBMIT",
          x: panelCX - 100, y: youY + boxSize + 36, w: 200, h: 44,
          disabled: coopOwnSubmitted || coopOwnName.length !== 3,
          action: submitCoopOwnName },
        { label: "SKIP", variant: "danger",
          x: cx - 60, y: H - 70, w: 120, h: 40,
          disabled: coopOwnSubmitted,
          action: skipCoopOwnName },
      ];
    }
    const panelCX = 770;
    const boxSize = 60, boxGap = 14;
    const totalBoxW = boxSize * 3 + boxGap * 2;
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
      { label: "SKIP", variant: "danger",
        x: cx - 60, y: H - 70, w: 120, h: 40,
        action: () => enterScene(SCENE.leaderboard) },
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
const DISPLAY_BTN_W = 110;
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

// Post-processing segmented toggle on the right of the display row.
const POST_BTN_W = 80;
const POST_BTN_GAP = 8;
const POST_START_X = W - 240 - POST_BTN_W * 2 - POST_BTN_GAP;

function postProcessButtons() {
  const options = [
    { key: true,  label: "On"  },
    { key: false, label: "Off" },
  ];
  return options.map((opt, i) => ({
    key: opt.key,
    label: opt.label,
    x: POST_START_X + i * (POST_BTN_W + POST_BTN_GAP),
    y: DISPLAY_ROW_Y,
    w: POST_BTN_W,
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
