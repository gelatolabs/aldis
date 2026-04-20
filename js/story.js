"use strict";

// Ordered script for Story mode. Stage types:
//   { type: "text",     content: "..." }             — fullscreen text, click to continue
//   { type: "gameplay", words: ["we","come",...] }   — scripted enemy words
//   { type: "tutorial" }                             — skipped once the tutorial has been seen
const STORY_STAGES = [
  { type: "text", content:
    "The year is 30XX. The entities are approaching. "
    + "Armed with your trusty Aldis Combination Signal Lamp Radar Antenna 9000 "
    + "and English degree, you must fight them off by spelling out their "
    + "favorite words in morse code!" },
  { type: "tutorial" },
  { type: "gameplay", words: ["we", "come", "in", "peace"] },
  { type: "text", content: "Lorem ipsum" },
  { type: "gameplay", words: ["hello", "world"] },
  { type: "text", content: "The end" },
];

const STORY_FADE_MS    = 400;
const STORY_CHAR_MS    = 35;       // per-character reveal rate for text stages
const STORY_SPAWN_START_MS = 4000; // spawn interval on the first gameplay stage
const STORY_SPAWN_STEP_MS  = 500;  // how much faster each subsequent stage spawns
const STORY_SPAWN_MIN_MS   = 1000; // floor for the per-stage spawn interval
const STORY_POST_MS    = 1000;     // delay after last defeat before next stage

function storySpawnInterval() {
  let n = 0;
  for (let i = 0; i <= story.index; i++) {
    if (STORY_STAGES[i] && STORY_STAGES[i].type === "gameplay") n++;
  }
  return Math.max(STORY_SPAWN_MIN_MS, STORY_SPAWN_START_MS - (n - 1) * STORY_SPAWN_STEP_MS);
}

const story = {
  active: false,
  index: -1,
  stageSlots: [],      // [{word, defeated}]  — preserves script order
  stageQueue: [],      // remaining slot indices waiting to spawn
  spawnTimer: 0,       // ms until next spawn
  postStageTimer: 0,   // ms until auto-advance after last defeat
  postStageActive: false,
  textShown: 0,        // characters revealed so far (drives reveal + audio)
  textCharTimer: 0,    // ms until the next character reveals
  textLines: null,     // cached wrapped lines for the current text stage
  fadeAlpha: 0,        // 0 = visible, 1 = black
  transitioning: false,
  gameOver: false,
};

function enterStory() {
  if (typeof netDisconnect === "function") netDisconnect();
  gameMode = "story";
  story.active = true;
  story.index = -1;
  story.stageSlots = [];
  story.stageQueue = [];
  story.fadeAlpha = 1;
  story.transitioning = false;
  story.gameOver = false;
  advanceStory();
}

function advanceStory() {
  story.index += 1;
  beginStoryStage(story.index);
}

function beginStoryStage(i) {
  const stage =STORY_STAGES[i];
  if (!stage) { exitStory(); return; }

  if (stage.type === "tutorial") {
    if (tutorialSeen()) { advanceStory(); return; }
    enterTutorial(() => { story.fadeAlpha = 1; advanceStory(); });
    return;
  }

  if (stage.type === "text") {
    story.textShown = 0;
    story.textCharTimer = 0;
    story.textLines = null;  // recomputed on first draw
    story.fadeAlpha = 1;
    story.transitioning = false;
    primeAudio();
    enterScene(SCENE.storyText);
    return;
  }

  if (stage.type === "gameplay") {
    resetGame();
    story.stageSlots = stage.words.map(w => ({
      word: w.toUpperCase(),
      defeated: false,
    }));
    story.stageQueue = stage.words.map((_, idx) => idx);
    story.spawnTimer = 1200;  // short breather before the first spawn
    story.postStageTimer = 0;
    story.postStageActive = false;
    story.fadeAlpha = 1;
    story.transitioning = false;
    story.gameOver = false;
    enterScene(SCENE.story);
    return;
  }
}

function exitStory() {
  story.active = false;
  story.gameOver = false;
  story.fadeAlpha = 0;
  enterScene(SCENE.menu);
}

function retryStoryStage() {
  beginStoryStage(story.index);
}

function spawnStoryEnemy(slotIdx) {
  const word = story.stageSlots[slotIdx].word;
  const typeKey = word.length >= 5 ? "heavy" : "fodder";
  const type = ENEMY_TYPES[typeKey];
  const margin = 100;
  const y = margin + Math.random() * (H - 2 * margin);
  enemies.push({
    x: W + 40,
    y,
    vx: -baseSpeed() * type.speedMul,
    word,
    typeKey,
    typed: 0,
    alive: true,
    hitFlash: 0,
    deathAnim: 0,
    radarActive: false,
    radarFade: 0,
    radarX: 0,
    radarY: 0,
    storySlot: slotIdx,
    seed: makeEnemySeed(),
    morse: "",
    morseTimer: 0,
    lastMorse: "",
    lastTimer: 0,
  });
}

function updateStory(dt) {
  if (story.gameOver) { updateStoryFade(dt); return; }

  for (const e of enemies) {
    if (e.alive) {
      e.x += e.vx * (dt / 1000);
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.x < 40) {
        e.alive = false;
        e.escaped = true;
        if (!debug.invuln) story.gameOver = true;
      }
    } else {
      if (!e.escaped && typeof e.storySlot === "number"
          && !story.stageSlots[e.storySlot].defeated) {
        story.stageSlots[e.storySlot].defeated = true;
      }
      if (e.deathAnim > 0) e.deathAnim -= dt;
    }
  }
  enemies = enemies.filter(e => e.alive || (e.deathAnim && e.deathAnim > 0));

  updateRadar(dt);
  updateParticles(dt);
  decayEnemyMorseTimers(dt);

  if (story.gameOver) { updateStoryFade(dt); return; }

  if (story.stageQueue.length > 0) {
    story.spawnTimer -= dt;
    if (story.spawnTimer <= 0) {
      const idx = story.stageQueue.shift();
      spawnStoryEnemy(idx);
      story.spawnTimer = storySpawnInterval();
    }
  }

  const alive = enemies.some(e => e.alive);
  const allDefeated = story.stageSlots.every(s => s.defeated);
  if (allDefeated && !alive) {
    if (!story.postStageActive) {
      story.postStageActive = true;
      story.postStageTimer = STORY_POST_MS;
    }
    story.postStageTimer -= dt;
    if (story.postStageTimer <= 0) story.transitioning = true;
  }

  updateStoryFade(dt);
}

// Extra pause (ms) after revealing a punctuation character, on top of the
// normal per-character delay.
function charPauseAfter(ch) {
  if (ch === "." || ch === "!" || ch === "?") return 200;
  if (ch === "," || ch === ";" || ch === ":") return 100;
  return 0;
}

// True when the alphanumeric char at `idx` is part of a word followed by `!`.
function charInExclamatoryWord(text, idx) {
  let end = idx;
  while (end < text.length && /[A-Za-z0-9]/.test(text[end])) end++;
  return text[end] === "!";
}

function updateStoryText(dt) {
  // Wait until audio is ready so the first letter appears in sync with its sound.
  if (!audioReady()) { updateStoryFade(dt); return; }
  const stage = STORY_STAGES[story.index];
  if (stage && stage.type === "text") {
    story.textCharTimer -= dt;
    while (story.textCharTimer <= 0 && story.textShown < stage.content.length) {
      const ch = stage.content[story.textShown];
      const pitchMul = charInExclamatoryWord(stage.content, story.textShown) ? 1.18 : 1;
      playAnimalese(ch, pitchMul);
      story.textShown += 1;
      story.textCharTimer += STORY_CHAR_MS + charPauseAfter(ch);
    }
  }
  updateStoryFade(dt);
}

function updateStoryFade(dt) {
  if (story.transitioning) {
    story.fadeAlpha = Math.min(1, story.fadeAlpha + dt / STORY_FADE_MS);
    if (story.fadeAlpha >= 1) {
      story.transitioning = false;
      advanceStory();
    }
  } else if (story.fadeAlpha > 0) {
    story.fadeAlpha = Math.max(0, story.fadeAlpha - dt / STORY_FADE_MS);
  }
}

function storyTextFullyPrinted() {
  const stage = STORY_STAGES[story.index];
  if (!stage || stage.type !== "text") return false;
  return story.textShown >= stage.content.length;
}

function storyTextClickAdvance() {
  if (currentScene !== SCENE.storyText) return;
  if (story.transitioning) return;
  // First click while still typing skips the animation. Next click advances.
  if (!storyTextFullyPrinted()) {
    const stage = STORY_STAGES[story.index];
    if (stage && stage.type === "text") {
      story.textShown = stage.content.length;
      story.textCharTimer = 0;
    }
    return;
  }
  story.transitioning = true;
}

// ---- Rendering ----

function drawStoryFade() {
  if (story.fadeAlpha <= 0) return;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0," + story.fadeAlpha + ")";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function wrapText(text, maxW) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const trial = line ? line + " " + w : w;
    if (ctx.measureText(trial).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawStoryText() {
  drawBackdrop(W / 2, H / 2);

  const stage =STORY_STAGES[story.index];
  if (stage && stage.type === "text") {
    ctx.save();
    ctx.textAlign = "left";
    ctx.fillStyle = "#cfd";
    ctx.font = "24px 'Libertinus Mono', monospace";

    const blockW = W * 0.7;
    const blockX = (W - blockW) / 2;
    if (!story.textLines) story.textLines = wrapText(stage.content, blockW);
    const lines = story.textLines;

    const shown = story.textShown;
    const lineH = 36;
    const totalH = lineH * lines.length;
    const startY = (H - totalH) / 2;

    let drawn = 0;
    for (let i = 0; i < lines.length; i++) {
      const remain = shown - drawn;
      if (remain <= 0) break;
      const visible = lines[i].slice(0, remain);
      ctx.fillText(visible, blockX, startY + lineH * (i + 1) - 8);
      // +1 accounts for the space that wrapText consumed at each line break
      drawn += lines[i].length + 1;
    }

    if (storyTextFullyPrinted() && !story.transitioning) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#7a9";
      ctx.font = "16px 'Libertinus Mono', monospace";
      ctx.fillText("Click to continue", W / 2, H - 48);
    }
    ctx.restore();
  }

  drawStoryFade();
}

function drawStorySentence() {
  if (story.stageSlots.length === 0) return;
  ctx.save();
  ctx.textAlign = "left";
  ctx.font = "bold 28px 'Libertinus Mono', monospace";
  let x = 32;
  const y = H - 36;
  for (let i = 0; i < story.stageSlots.length; i++) {
    const s = story.stageSlots[i];
    const text = s.defeated ? s.word : "_".repeat(s.word.length);
    ctx.fillStyle = s.defeated
      ? "rgba(220,240,220,0.55)"
      : "rgba(150,170,170,0.28)";
    ctx.fillText(text, x, y);
    x += ctx.measureText(text + " ").width;
  }
  ctx.restore();
}

function drawStoryGameOverDialog() {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(0, 0, W, H);

  const pw = 620, ph = 200;
  const px = (W - pw) / 2, py = (H - ph) / 2 - 20;
  ctx.fillStyle = "rgba(28,22,26,0.95)";
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = "#8a6060";
  ctx.lineWidth = 2;
  ctx.strokeRect(px + 0.5, py + 0.5, pw, ph);

  ctx.textAlign = "center";
  ctx.fillStyle = "#e0b0b0";
  ctx.font = "bold 24px 'Libertinus Mono', monospace";
  ctx.fillText("All your base are belong to entity", W / 2, py + 80);
  ctx.restore();
}

function drawStory() {
  drawBackdrop(lamp.x, lamp.y);
  drawAimLine();
  drawBeamLight();
  drawEnemyWords();
  drawDeathAnims();
  drawRadarDots();
  drawAlertDots();
  drawLamp();
  drawInputBuffer();
  drawMorseChart();
  drawStorySentence();
  ctx.textAlign = "left";
  ctx.font = "13px 'Libertinus Mono', monospace";
  ctx.fillStyle = "#9ab";
  ctx.fillText("Press P to pause", 16, 22);
  if (story.gameOver) {
    drawStoryGameOverDialog();
    drawButtons();
  }
  drawStoryFade();
}
