"use strict";

// Ordered script for Story mode. Stage types:
//   { type: "text",     content: "..." }             — fullscreen text, click to continue
//   { type: "gameplay", words: ["we","come",...] }   — scripted enemy words
//   { type: "tutorial" }                             — skipped once the tutorial has been seen
const STORY_STAGES = [
  { type: "text", content: "The year is 30XX.  You are Nuke Dukem Jr. and Earth is under attack by a species known as \"The Entities\".  After waging a massive thermonuclear war, modern electronics have been deemed useless.  Humans must resort to a more primitive weapon: a big ol' lamp.  It has been discovered that the Entities possess a weakness and sending specific morse codes initiates a self-destruct sequence.  Your English degree has finally come in handy and you have been recruited by the military for your impeccable spelling skills.  Armed with your trusty Aldis Combination Signal Lamp Radar Antenna 9000, your story begins..." },
  { type: "text", content: "\\cChapter 1: The Beginning\\nYou awaken to the sound of the invasion alarm blaring in your office.  A pounding headache feels as though it is bouncing around in your skull like a ping pong ball.  It is a potent reminder of your excessive partying last night.  The discovery of the morse code weakness has rekindled the human spirit and was cause for a celebration.  However, a fresh batch of invading forces is approaching and there is still much work to be done." },
  { type: "tutorial" },
  { type: "gameplay", words: ["boop", "password", "changeme"] },
  { type: "text", content: "\\cChapter 2: The Passwords\\nA brief lull settles over the battlefield as you sip your terrible cold brew and scan the kill logs.  Honestly, for a species capable of interstellar space travel, the Entities' self-destruct passwords are embarrassing.  \"CHANGEME\"?  Their IT department must be asleep at the wheel.  You chuckle, finish your brew, and brace for the next wave." },
  { type: "gameplay", words: ["bleep", "hello", "ow", "who", "is", "you"] },
  { type: "text", content: "\\cChapter 3: The Noise\\nWeird batch of codes.  It's almost like they're trying to say something.  Probably just the hungover part of your brain inventing meaning from noise.  Either way, orders are orders.  You tap out the codes as instructed and the Entities oblige by exploding." },
  { type: "gameplay", words: ["ouch", "please", "no", "stop", "that", "hurts"] },
  { type: "text", content: "\\cChapter 4: The Lunch Break\\nAre they... never mind.  It has arrived!  The second best time of the day - LUNCH!  After blasting away a few more entities, you have just enough time to radio in an order to the best sushi restaurant in town.  Nothing builds an appetite better than a smoke-filled sky of burning Entities!" },
  { type: "gameplay", words: ["tuna", "roll", "miso", "soup", "french", "fries", "extra", "wasabi"] },
  { type: "text", content: "\\cChapter 5: Luigi\\nWhat a coincidence, that's exactly what you ordered!  The cosmos must be hungry too.  The sushi arrives and — of course — they forgot your french fries.  Your coworker Ned wanders over to mooch a tuna roll and asks if you've seen his pet iguana Luigi.  You shrug and glance back at the monitor.  Back to work." },
  { type: "gameplay", words: ["we", "hear", "you", "nuke", "dukem", "jr", "are", "you", "missing", "an", "iguana"] },
  { type: "text", content: "\\cChapter 6: Friend or Foe?\\nThat was definitely no coincidence - the Entities are attempting to communicate with you!  Could it be a trick or are they attempting to surrender?  You somehow feel as if the signals will reveal their true intentions..." },
  { type: "gameplay", words: ["omg", "please", "send", "us", "more", "yummy", "delicious", "french", "fries", "human"] },
  { type: "text", content: "\\cChapter 7: French Fried\\nAfter clearly identifying themselves as the fry thieves you begin to wonder if they are attempting to obtain a source of energy?  An idea pops into your head and you quickly place an order for one million french fries.  The salty goodness should send them into a feeding frenzy and concentrate them in a small area.  This is your chance to wipe them all out!" },
  { type: "gameplay", words: makeL7Frenzy },
  { type: "text", content: "\\cChapter 8: Aftermath\\nAfter the smoke clears, all of the Entities have been defeated and Earth proclaims VICTORY!!  Is there anything a fresh batch of french fries can't solve?" },
  { type: "gameplay", words: ["so", "long", "and", "thanks", "for", "all", "the", "fries"] },
];

const STORY_FADE_MS  = 400;
const STORY_CHAR_MS  = 35;   // per-character reveal rate for text stages
const STORY_SPAWN_MS = 8000; // spawn interval for gameplay stages
const STORY_POST_MS  = 1000; // delay after last defeat before next stage

function storySpawnInterval() {
  return STORY_SPAWN_MS;
}

// Level 7 "airstrike" wave: 50 feeding-frenzy entities packed near the top of
// the screen, then a single bomb near the bottom. Typing the bomb's word
// detonates its clear-powerup and wipes the whole cluster at once. Regenerated
// on every stage entry so retries reroll the word assignments and positions.
function makeL7Frenzy() {
  const pool = ["yum", "om", "nom", "french", "fries", "eat", "mmm", "wow", "good", "delicious", "thanks"];
  const slots = [];
  for (let i = 0; i < 50; i++) {
    slots.push({
      word: pool[Math.floor(Math.random() * pool.length)],
      y: 80 + Math.random() * 100,
      delay: i === 0 ? 400 : 60 + Math.random() * 40,
    });
  }
  slots.push({ word: "airstrike", y: 520, delay: 2000, powerup: "clear" });
  return slots;
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
    const words = typeof stage.words === "function" ? stage.words() : stage.words;
    story.stageSlots = words.map(w => {
      const cfg = typeof w === "string" ? { word: w } : w;
      return {
        word: cfg.word.toUpperCase(),
        defeated: false,
        x: cfg.x,
        y: cfg.y,
        powerup: cfg.powerup || null,
        delay: cfg.delay,
      };
    });
    story.stageQueue = words.map((_, idx) => idx);
    const firstSlot = story.stageSlots[0];
    story.spawnTimer = (firstSlot && firstSlot.delay != null) ? firstSlot.delay : 1200;
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
  const slot = story.stageSlots[slotIdx];
  const word = slot.word;
  const powerup = slot.powerup;
  const typeKey = powerup ? "fodder" : (word.length >= 5 ? "heavy" : "fodder");
  const type = ENEMY_TYPES[typeKey];
  const margin = 100;
  const y = slot.y != null ? slot.y : margin + Math.random() * (H - 2 * margin);
  const x = slot.x != null ? slot.x : W + 40;
  const speedMul = type.speedMul * (powerup ? POWERUP_SPEED_MUL : 1) * 0.5;
  enemies.push({
    x,
    y,
    vx: -baseSpeed() * speedMul,
    word,
    typeKey,
    powerup: powerup || null,
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
        if (!debug.invuln) {
          playDamage();
          if (typeof musicOnDamage === "function") musicOnDamage();
          if (typeof musicOnDeath === "function") musicOnDeath();
          story.gameOver = true;
        }
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
      const nextIdx = story.stageQueue[0];
      const nextSlot = nextIdx != null ? story.stageSlots[nextIdx] : null;
      story.spawnTimer = (nextSlot && nextSlot.delay != null)
        ? nextSlot.delay
        : storySpawnInterval();
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
// normal per-character delay. "Jr." is an exception.
function charPauseAfter(text, idx) {
  const ch = text[idx];
  if (ch === "!" || ch === "?") return 200;
  if (ch === "," || ch === ";" || ch === ":") return 100;
  if (ch === ".") {
    if (idx >= 2 && text[idx - 2] === "J" && text[idx - 1] === "r") return 0;
    return 200;
  }
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
      const idx = story.textShown;
      const ch = stage.content[idx];
      // Skip \n and \c.
      if (ch === "\\" && stage.content[idx + 1] === "n") {
        story.textShown += 2;
        continue;
      }
      const atLineStart = idx === 0
        || (stage.content[idx - 2] === "\\" && stage.content[idx - 1] === "n");
      if (ch === "\\" && stage.content[idx + 1] === "c" && atLineStart) {
        story.textShown += 2;
        continue;
      }
      const pitchMul = charInExclamatoryWord(stage.content, idx) ? 1.18 : 1;
      playAnimalese(ch, pitchMul);
      story.textCharTimer += STORY_CHAR_MS + charPauseAfter(stage.content, idx);
      story.textShown += 1;
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

// Wrap story text into visual lines.
//   \n — line break
//   \c — center line
// Each returned entry carries a `consumed` count so the reveal engine can
// advance `textShown` over the invisible markers without misaligning.
function wrapText(text, maxW) {
  const result = [];
  const segments = text.split("\\n");
  for (let si = 0; si < segments.length; si++) {
    const segText = segments[si];
    const hasNewline = si < segments.length - 1;
    let center = false;
    let body = segText;
    if (body.startsWith("\\c")) {
      center = true;
      body = body.slice(2);
    }
    const words = body.split(" ");
    const visLines = [];
    let line = "";
    for (const w of words) {
      const trial = line ? line + " " + w : w;
      if (ctx.measureText(trial).width > maxW && line) {
        visLines.push(line);
        line = w;
      } else {
        line = trial;
      }
    }
    if (line || visLines.length === 0) visLines.push(line);
    for (let li = 0; li < visLines.length; li++) {
      const t = visLines[li];
      const isLast = li === visLines.length - 1;
      const first = li === 0;
      let consumed = t.length;
      if (first && center) consumed += 2;  // stripped \c prefix
      if (!isLast) consumed += 1;          // wrapText consumed a space
      else if (hasNewline) consumed += 2;  // the \n between segments
      result.push({
        text: t,
        center,
        preInvisible: first && center ? 2 : 0,
        consumed,
      });
    }
  }
  return result;
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
    const startY = (H - totalH) / 2 - 24;

    let drawn = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const remain = shown - drawn;
      if (remain <= 0) break;
      const visibleCount = Math.max(0, Math.min(line.text.length,
                                                remain - line.preInvisible));
      if (visibleCount > 0) {
        const visible = line.text.slice(0, visibleCount);
        const y = startY + lineH * (i + 1) - 8;
        if (line.center) {
          ctx.textAlign = "center";
          ctx.fillText(visible, W / 2, y);
        } else {
          ctx.textAlign = "left";
          ctx.fillText(visible, blockX, y);
        }
      }
      drawn += line.consumed;
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
  const leftX = 32;
  const maxX = W - 32;
  const lineH = 34;
  const spaceW = ctx.measureText(" ").width;

  const lines = [[]];
  let x = leftX;
  for (let i = 0; i < story.stageSlots.length; i++) {
    const s = story.stageSlots[i];
    const text = s.defeated ? s.word : "_".repeat(s.word.length);
    const w = ctx.measureText(text).width;
    if (lines[lines.length - 1].length > 0 && x + w > maxX) {
      lines.push([]);
      x = leftX;
    }
    lines[lines.length - 1].push({ slot: s, text, x });
    x += w + spaceW;
  }

  const bottomY = H - 36;
  for (let li = 0; li < lines.length; li++) {
    const y = bottomY - (lines.length - 1 - li) * lineH;
    for (const item of lines[li]) {
      ctx.fillStyle = item.slot.defeated
        ? "rgba(220,240,220,0.55)"
        : "rgba(150,170,170,0.28)";
      ctx.fillText(item.text, item.x, y);
    }
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
