"use strict";

// Reverse of MORSE: morse code → letter, used to decode the name-entry
// buffer into characters.
const MORSE_TO_CHAR = {};
for (const [c, m] of Object.entries(MORSE)) MORSE_TO_CHAR[m] = c;

// null = not yet loaded, [] = loaded (possibly empty)
let topScores = null;
let scoresLoading = false;
let entryName = "";
let nameSubmitted = false;
let submitInFlight = false;

// When the game is opened from a file:// URL, use localStorage for an
// offline leaderboard instead of the API.
const USE_LOCAL_SCORES = (typeof location === "undefined")
  || location.protocol === "file:";
const LOCAL_KEY = "aldis_scores";

function loadLocalScores() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function saveLocalScores(list) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch (e) { /* quota or privacy mode — ignore */ }
}

function fetchTopScores() {
  if (scoresLoading) return;
  scoresLoading = true;
  if (USE_LOCAL_SCORES) {
    topScores = loadLocalScores();
    scoresLoading = false;
    return;
  }
  fetch("/api/scores")
    .then(r => r.ok ? r.json() : [])
    .catch(() => [])
    .then(data => {
      topScores = Array.isArray(data) ? data : [];
      scoresLoading = false;
    });
}

function submitTopScore() {
  if (submitInFlight || nameSubmitted) return;
  if (entryName.length !== 3) return;
  submitInFlight = true;
  if (USE_LOCAL_SCORES) {
    const list = loadLocalScores();
    list.push({ name: entryName, score, at: Date.now() });
    list.sort((a, b) => b.score - a.score);
    const top = list.slice(0, 10);
    saveLocalScores(top);
    topScores = top;
    nameSubmitted = true;
    submitInFlight = false;
    return;
  }
  fetch("/api/scores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: entryName, score }),
  })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(data => {
      if (Array.isArray(data)) topScores = data;
      nameSubmitted = true;
      submitInFlight = false;
    });
}

function resetNameEntry() {
  entryName = "";
  nameSubmitted = false;
  submitInFlight = false;
  topScores = null;
  scoresLoading = false;
}

function qualifiesForTop10() {
  if (!topScores) return false;
  if (score <= 0) return false;
  if (topScores.length < 10) return true;
  return score > topScores[topScores.length - 1].score;
}

function inNameEntry() {
  return currentScene === SCENE.highScoreEntry
      && !nameSubmitted
      && entryName.length < 3;
}
