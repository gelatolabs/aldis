"use strict";

const TUTORIAL_KEY = "aldis_tutorial_done";

const TUTORIAL_STEPS = {
  dot:    "Tap your mouse button or spacebar\nand release quickly for a DOT",
  dash:   "Hold your mouse button or spacebar\nin for a DASH",
  aim:    "Scroll up and down\nto locate a target",
  target: "Aim at the target and signal the word shown\n(Refer to the morse alphabet!)",
  done:   "That's it! Good luck out there!",
};

const tutorial = {
  step: "dot",
  enemy: null,
  aimHoldTimer: 0,
  doneTimer: 0,
  fadeAlpha: 0,     // black-overlay alpha, used for fade-out and fade-in
  exiting: false,
  fadingIn: false,
  onExit: null,     // optional callback invoked in place of the default
                    // "enter game" behavior once the fade-to-black finishes
};

function tutorialSeen() {
  try { return localStorage.getItem(TUTORIAL_KEY) === "1"; }
  catch (e) { return false; }
}

function markTutorialSeen() {
  try { localStorage.setItem(TUTORIAL_KEY, "1"); } catch (e) { /* ignore */ }
}

function tutorialScrollLocked() {
  return currentScene === SCENE.tutorial
      && (tutorial.step === "dot" || tutorial.step === "dash");
}

function enterTutorial(onExit) {
  resetGame();
  tutorial.step = "dot";
  tutorial.enemy = null;
  tutorial.aimHoldTimer = 0;
  tutorial.doneTimer = 0;
  tutorial.fadeAlpha = 0;
  tutorial.exiting = false;
  tutorial.fadingIn = false;
  tutorial.onExit = onExit || null;
  enterScene(SCENE.tutorial);
}

function spawnTutorialEnemy() {
  const e = {
    x: W + 40,
    y: 120,
    vx: -10,
    word: "ZAP",
    typeKey: "fodder",
    typed: 0,
    alive: true,
    hitFlash: 0,
    deathAnim: 0,
    radarActive: false,
    radarFade: 0,
    radarX: 0,
    radarY: 0,
    seed: makeEnemySeed(),
    morse: "",
    morseTimer: 0,
    lastMorse: "",
    lastTimer: 0,
  };
  enemies.push(e);
  tutorial.enemy = e;
}

function tutorialOnSignal(kind) {
  if (tutorial.step === "dot" && kind === "dot") {
    tutorial.step = "dash";
  } else if (tutorial.step === "dash" && kind === "dash") {
    tutorial.step = "aim";
    spawnTutorialEnemy();
  }
}

function updateTutorial(dt) {
  for (const e of enemies) {
    if (e.alive) {
      e.x += e.vx * (dt / 1000);
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.x < 40) e.x = W + 40;
    } else if (e.deathAnim > 0) {
      e.deathAnim -= dt;
    }
  }
  enemies = enemies.filter(e => e.alive || (e.deathAnim && e.deathAnim > 0));

  updateRadar(dt);
  updateParticles(dt);
  decayEnemyMorseTimers(dt);

  if (tutorial.step === "aim" && tutorial.enemy && tutorial.enemy.alive) {
    if (tutorial.enemy.radarActive) {
      tutorial.aimHoldTimer += dt;
      if (tutorial.aimHoldTimer >= 1000) tutorial.step = "target";
    } else {
      tutorial.aimHoldTimer = 0;
    }
  }
  if (tutorial.step === "target" && tutorial.enemy && !tutorial.enemy.alive) {
    tutorial.step = "done";
    tutorial.doneTimer = 0;
  }
  if (tutorial.step === "done" && !tutorial.exiting) {
    tutorial.doneTimer += dt;
    if (tutorial.doneTimer >= 4000) tutorial.exiting = true;
  }
  if (tutorial.exiting) {
    tutorial.fadeAlpha = Math.min(1, tutorial.fadeAlpha + dt / 500);
    if (tutorial.fadeAlpha >= 1) {
      markTutorialSeen();
      tutorial.exiting = false;
      if (tutorial.onExit) {
        const cb = tutorial.onExit;
        tutorial.onExit = null;
        tutorial.fadeAlpha = 0;
        cb();
      } else {
        resetGame();
        tutorial.fadingIn = true;
        enterScene(SCENE.game);
      }
    }
  }
}

function updateTutorialFadeIn(dt) {
  if (!tutorial.fadingIn) return;
  tutorial.fadeAlpha = Math.max(0, tutorial.fadeAlpha - dt / 500);
  if (tutorial.fadeAlpha <= 0) tutorial.fadingIn = false;
}

function drawTutorialOverlay() {
  ctx.save();
  const lines = TUTORIAL_STEPS[tutorial.step].split("\n");
  ctx.textAlign = "center";
  ctx.font = "bold 28px 'Libertinus Mono', monospace";
  const lineH = 36;
  const totalH = lineH * lines.length;
  const baseY = H - 60 - totalH;
  let maxW = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  const padX = 24, padY = 16;
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(W / 2 - maxW / 2 - padX,
               baseY - padY + 4,
               maxW + padX * 2,
               totalH + padY * 2);
  ctx.fillStyle = "#ffd34a";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], W / 2, baseY + lineH * (i + 1) - 8);
  }
  ctx.restore();
}

function drawTutorialFade() {
  if (tutorial.fadeAlpha <= 0) return;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0," + tutorial.fadeAlpha + ")";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawTutorial() {
  drawGame();
  drawTutorialOverlay();
  drawTutorialFade();
}
