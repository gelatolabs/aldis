"use strict";

// Debug HUD overlay for survival mode. Toggled with `.

const debug = {
  enabled: false,
  invuln: false,
  lamp: false,
  freezeDiff: false,
};

const debugHud      = document.getElementById("debug-hud");
const dbgDiff       = document.getElementById("dbg-diff");
const dbgScore      = document.getElementById("dbg-score");
const dbgEnd        = document.getElementById("dbg-end");
const dbgInvuln     = document.getElementById("dbg-invuln");
const dbgLamp       = document.getElementById("dbg-lamp");
const dbgFreezeDiff = document.getElementById("dbg-freeze-diff");

function debugHudHasFocus() {
  return !!document.activeElement && debugHud.contains(document.activeElement);
}

function showDebugHud() {
  debug.enabled = true;
  debugHud.classList.add("show");
  syncDebugHud();
}

function hideDebugHud() {
  debug.enabled = false;
  debugHud.classList.remove("show");
  if (debugHudHasFocus()) document.activeElement.blur();
}

function debugSceneAllowed() {
  if (netInMatch()) return false;
  return currentScene === SCENE.game || currentScene === SCENE.story;
}

function toggleDebugHud() {
  if (debug.enabled) hideDebugHud();
  else if (debugSceneAllowed()) showDebugHud();
}

function syncDebugHud() {
  if (!debug.enabled) return;
  const inStory = currentScene === SCENE.story;
  // Difficulty + score are survival-only.
  dbgDiff.parentElement.style.display  = inStory ? "none" : "";
  dbgScore.parentElement.style.display = inStory ? "none" : "";
  dbgFreezeDiff.style.display          = inStory ? "none" : "";
  dbgEnd.textContent = inStory ? "Clear stage" : "End game";
  if (!inStory) {
    if (document.activeElement !== dbgDiff) {
      dbgDiff.value = (Math.min(1, elapsed / 720000)).toFixed(2);
    }
    if (document.activeElement !== dbgScore) {
      dbgScore.value = String(score);
    }
  }
  dbgInvuln.classList.toggle("on", debug.invuln);
  dbgLamp.classList.toggle("on", debug.lamp);
  dbgFreezeDiff.classList.toggle("on", debug.freezeDiff);
}

dbgDiff.addEventListener("change", () => {
  const d = Math.max(0, Math.min(1, parseFloat(dbgDiff.value) || 0));
  elapsed = d * 720000;
  dbgDiff.value = d.toFixed(2);
});

dbgScore.addEventListener("change", () => {
  score = Math.max(0, Math.floor(parseFloat(dbgScore.value) || 0));
  dbgScore.value = String(score);
});

dbgEnd.addEventListener("click", () => {
  if (currentScene === SCENE.game) {
    if (gameOver) return;
    player.missed = player.maxHealth;
    gameOver = true;
    fetchTopScores();
  } else if (currentScene === SCENE.story) {
    if (story.gameOver) return;
    for (const e of enemies) { e.alive = false; e.deathAnim = 0; }
    for (const s of story.stageSlots) s.defeated = true;
    story.postStageActive = true;
    story.postStageTimer = 0;
    story.transitioning = true;
  }
  dbgEnd.blur();
});

dbgInvuln.addEventListener("click", () => {
  debug.invuln = !debug.invuln;
  syncDebugHud();
  dbgInvuln.blur();
});

dbgLamp.addEventListener("click", () => {
  debug.lamp = !debug.lamp;
  syncDebugHud();
  dbgLamp.blur();
});

dbgFreezeDiff.addEventListener("click", () => {
  debug.freezeDiff = !debug.freezeDiff;
  syncDebugHud();
  dbgFreezeDiff.blur();
});

window.addEventListener("keydown", (e) => {
  if (e.code !== "Backquote" || e.repeat) return;
  // If the focused element is something other than our HUD inputs, leave it
  // alone (nothing else in the page accepts focus, but be safe).
  if (document.activeElement
      && document.activeElement !== document.body
      && !debugHud.contains(document.activeElement)) return;
  e.preventDefault();
  toggleDebugHud();
});
