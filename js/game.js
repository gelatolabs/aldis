"use strict";

let last = performance.now();

function frame(now) {
  const dt = Math.min(50, now - last);
  last = now;
  sceneTime += dt;
  animTime += dt;

  if (currentScene === SCENE.splash && sceneTime >= SPLASH_TOTAL) {
    enterScene(SCENE.menu);
  }
  if (currentScene === SCENE.settings || currentScene === SCENE.game
      || currentScene === SCENE.highScoreEntry
      || currentScene === SCENE.tutorial
      || currentScene === SCENE.story) {
    if (lamp.beamTimer > 0) lamp.beamTimer -= dt;
    // Hold the beam at full intensity while the user is still pressing; the
    // decay above only takes effect once they release.
    if (lamp.held && lamp.beamKind) {
      const maxDur = lamp.beamKind === "dash" ? 220 : 80;
      if (lamp.beamTimer < maxDur) lamp.beamTimer = maxDur;
    }
    // Debug: keep the lamp pinned at full intensity regardless of input.
    if (debug.enabled && debug.lamp
        && (currentScene === SCENE.game || currentScene === SCENE.story)) {
      lamp.beamKind = "dash";
      lamp.beamTimer = 220;
    }
  }
  if (currentScene === SCENE.game || currentScene === SCENE.highScoreEntry
      || currentScene === SCENE.tutorial
      || (currentScene === SCENE.story && !story.gameOver)) {
    updatePressInput();
  }
  if (currentScene === SCENE.game && !gameOver) update(dt);
  if (currentScene === SCENE.game) updateTutorialFadeIn(dt);
  if (currentScene === SCENE.tutorial) updateTutorial(dt);
  if (currentScene === SCENE.story) updateStory(dt);
  if (currentScene === SCENE.storyText) updateStoryText(dt);
  if (currentScene === SCENE.highScoreEntry) updateNameEntry(dt);

  // Once the game ends and scores finish loading, branch to the right scene.
  if (currentScene === SCENE.game && gameOver && topScores !== null) {
    enterScene(qualifiesForTop10() ? SCENE.highScoreEntry : SCENE.leaderboard);
  }

  if (debug.enabled && currentScene !== SCENE.game
      && currentScene !== SCENE.story) hideDebugHud();
  if (debug.enabled) syncDebugHud();

  render();
  requestAnimationFrame(frame);
}

function update(dt) {
  elapsed += dt;
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnEnemy();
    spawnTimer = spawnInterval();
  }

  if (inputResetTimer > 0) {
    inputResetTimer -= dt;
    if (inputResetTimer <= 0) {
      inputMorse = "";
    }
  }
  if (lastLetterTimer > 0) {
    lastLetterTimer -= dt;
    if (lastLetterTimer <= 0) {
      lastLetterMorse = "";
    }
  }

  for (const e of enemies) {
    if (e.alive) {
      e.x += e.vx * (dt / 1000);
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.x < 40) {
        e.alive = false;
        if (!debug.invuln) {
          player.missed += 1;
          if (player.missed >= player.maxHealth) {
            gameOver = true;
            fetchTopScores();
          }
        }
      }
    } else if (e.deathAnim > 0) {
      e.deathAnim -= dt;
    }
  }
  enemies = enemies.filter(e => (e.alive) || (e.deathAnim && e.deathAnim > 0));

  updateRadar(dt);
  updateParticles(dt);
}

// For each enemy, figure out the angular range its bounding box subtends from
// the lamp. Used to decide whether the aim line swept across it this frame.
function enemyAngularRange(e) {
  const t = ENEMY_TYPES[e.typeKey];
  const hw = t.w / 2, hh = t.h / 2;
  let minA = Infinity, maxA = -Infinity;
  for (const ddx of [-hw, hw]) {
    for (const ddy of [-hh, hh]) {
      const a = Math.atan2((e.y + ddy) - lamp.y, (e.x + ddx) - lamp.x);
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
    }
  }
  return [minA, maxA];
}

// Cheap cone inclusion test — returns true if the enemy sits within the
// beam's widening axis envelope (with a sprite-size buffer) while the beam
// is on. Used to keep the radar dot anchored to the enemy's position while
// it's being lit, so turning the lamp off leaves the dot where the sprite
// was rather than where the aim last swept it.
function enemyInBeam(e) {
  if (lamp.beamTimer <= 0) return false;
  const ax = Math.cos(lamp.angle);
  const ay = Math.sin(lamp.angle);
  const back = 20;  // matches LAMP_BACK_OFFSET in render.js
  const bx = lamp.x - ax * back;
  const by = lamp.y - ay * back;
  const dx = e.x - bx;
  const dy = e.y - by;
  const along = dx * ax + dy * ay;
  if (along < 0 || along > BEAM_LEN) return false;
  const perp = Math.abs(-dx * ay + dy * ax);
  const bw = BEAM_NEAR_WIDTH + (BEAM_HALF_WIDTH - BEAM_NEAR_WIDTH) * (along / BEAM_LEN);
  const t = ENEMY_TYPES[e.typeKey];
  return perp <= bw + Math.max(t.w, t.h) / 2;
}

function updateRadar(dt) {
  const from = prevLampAngle;
  const to = lamp.angle;
  prevLampAngle = to;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  for (const e of enemies) {
    if (!e.alive || e.x - lamp.x < 20) {
      // Skip: dead, or so close the angular range wraps around ±π.
      if (e.radarFade > 0) e.radarFade = Math.max(0, e.radarFade - dt);
      e.radarActive = false;
      continue;
    }
    const [eLo, eHi] = enemyAngularRange(e);
    const swept = !(eHi < lo || eLo > hi);
    const under = eHi >= to && eLo <= to;

    if (swept) {
      // Capture ping position now; while actively tracked it updates each
      // frame, so the dot follows the enemy. Once contact is lost the stored
      // position stays put and the dot fades there.
      e.radarX = e.x;
      e.radarY = e.y;
      e.radarActive = under;
      e.radarFade = RADAR_FADE_MS;
    } else {
      e.radarActive = false;
      if (e.radarFade > 0) e.radarFade = Math.max(0, e.radarFade - dt);
    }

    // Illumination keeps the radar position current. When the beam later
    // turns off, the dot appears at the enemy's then-position instead of
    // reverting to wherever the aim last swept.
    if (enemyInBeam(e)) {
      e.radarX = e.x;
      e.radarY = e.y;
      e.radarFade = RADAR_FADE_MS;
    }
  }
}

function updateNameEntry(dt) {
  if (inputResetTimer > 0) {
    inputResetTimer -= dt;
    if (inputResetTimer <= 0) {
      if (inNameEntry()) {
        const letter = MORSE_TO_CHAR[inputMorse];
        if (letter && entryName.length < 3) entryName += letter;
      }
      inputMorse = "";
    }
  }
  if (lastLetterTimer > 0) {
    lastLetterTimer -= dt;
    if (lastLetterTimer <= 0) lastLetterMorse = "";
  }
}

function resetGame() {
  enemies = [];
  clearParticles();
  score = 0;
  resetNameEntry();
  player.missed = 0;
  inputMorse = "";
  inputResetTimer = 0;
  lastLetterMorse = "";
  lastLetterTimer = 0;
  spawnTimer = 3000;
  elapsed = 0;
  gameOver = false;
  setAim(0);
  lamp.beamTimer = 0;
  lamp.held = false;
  prevLampAngle = lamp.angle;
}

// Dev helper: force a game-over from the browser console, e.g. `endGame()`
// or `endGame(12345)` to set a specific score first.
window.endGame = function (atScore) {
  if (currentScene !== SCENE.game) return "not in game";
  if (typeof atScore === "number") score = atScore;
  player.missed = player.maxHealth;
  gameOver = true;
  fetchTopScores();
  return "ended with score " + score;
};

// Kick off the loop only after the font is ready, so the first rendered
// frame already has Libertinus Mono glyphs (avoids an FOUT on the canvas).
function startLoop() { requestAnimationFrame(frame); }
if (document.fonts && document.fonts.load) {
  Promise.all([
    document.fonts.load("14px 'Libertinus Mono'"),
    document.fonts.load("bold 14px 'Libertinus Mono'"),
  ]).catch(() => {}).finally(startLoop);
} else {
  startLoop();
}
