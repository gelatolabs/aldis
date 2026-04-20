"use strict";

// Reverse of MORSE: morse code → letter, used to decode the name-entry
// buffer into characters.
const MORSE_TO_CHAR = {};
for (const [c, m] of Object.entries(MORSE)) MORSE_TO_CHAR[m] = c;

// null = not yet loaded, [] = loaded (possibly empty)
let topScores = null;
let scoresLoading = false;
let topCoopScores = null;
let coopScoresLoading = false;
let entryName = "";
let nameSubmitted = false;
let submitInFlight = false;

// Co-op high-score-entry state. Both players enter their own initials. Once
// the first player submits, we wait up to 30s for the second; auto-submitted
// as "___" if they don't.
let coopOwnName = "";
let coopOwnSubmitted = false;
let coopPeerName = null;           // null until peer sends it; "" while skipped
let coopPeerSubmitted = false;
let coopFirstSubmitterRole = -1;
let coopSecondPlayerDeadline = 0;  // performance.now() ms; 0 means not running
const COOP_SECOND_PLAYER_TIMEOUT_MS = 30_000;
let coopFinalSubmitted = false;
// Set on the non-host client while it waits for the host to relay the final
// leaderboard via "coopScores". Cancels the fallback GET if the relay
// arrives in time.
let coopFinalFetchPending = false;

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

const LOCAL_KEY_COOP = "aldis_scores_coop";

function loadLocalCoopScores() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY_COOP);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function saveLocalCoopScores(list) {
  try { localStorage.setItem(LOCAL_KEY_COOP, JSON.stringify(list)); }
  catch (e) { /* ignore */ }
}

function fetchTopCoopScores() {
  if (coopScoresLoading) return;
  coopScoresLoading = true;
  if (USE_LOCAL_SCORES) {
    topCoopScores = loadLocalCoopScores();
    coopScoresLoading = false;
    return;
  }
  fetch("/api/scores-coop")
    .then(r => r.ok ? r.json() : [])
    .catch(() => [])
    .then(data => {
      topCoopScores = Array.isArray(data) ? data : [];
      coopScoresLoading = false;
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
  topCoopScores = null;
  coopScoresLoading = false;
  coopOwnName = "";
  coopOwnSubmitted = false;
  coopPeerName = null;
  coopPeerSubmitted = false;
  coopFirstSubmitterRole = -1;
  coopSecondPlayerDeadline = 0;
  coopFinalSubmitted = false;
  coopFinalFetchPending = false;
}

function qualifiesForTop10() {
  if (gameMode === "coop") {
    if (!topCoopScores) return false;
    if (score <= 0) return false;
    if (topCoopScores.length < 10) return true;
    return score > topCoopScores[topCoopScores.length - 1].score;
  }
  if (!topScores) return false;
  if (score <= 0) return false;
  if (topScores.length < 10) return true;
  return score > topScores[topScores.length - 1].score;
}

// True if we're on the high-score-entry scene and the local player hasn't
// finished their initials yet — the input layer uses this to route presses
// into the name buffer instead of the gameplay buffer.
function inNameEntry() {
  if (currentScene !== SCENE.highScoreEntry) return false;
  if (gameMode === "coop") {
    return !coopOwnSubmitted && coopOwnName.length < 3;
  }
  return !nameSubmitted && entryName.length < 3;
}

// ---- Co-op name submission ----
//
// When a co-op game ends in a top-10 score, both players enter their initials
// independently. The first to submit starts a 30-second clock; if the second
// hasn't submitted by then we auto-submit "___". The host is normally the
// authoritative submitter (so the entry isn't POSTed twice) but if the peer has
// already disconnected, whichever player is left POSTs the combined entry to
// /api/scores-coop themselves.

function submitCoopOwnName() {
  if (coopOwnSubmitted) return;
  if (coopOwnName.length !== 3) return;
  coopOwnSubmitted = true;
  if (typeof netSend === "function" && netInMatch()) {
    netSend({ type: "name", role: net.role, name: coopOwnName });
  }
  noteCoopFirstSubmitter(net.role);
  maybeFinalizeCoop();
}

function skipCoopOwnName() {
  if (coopOwnSubmitted) return;
  coopOwnSubmitted = true;
  coopOwnName = "___";
  if (typeof netSend === "function" && netInMatch()) {
    netSend({ type: "skip", role: net.role });
  }
  maybeFinalizeCoop();
}

function recordPeerCoopName(peerRole, peerName) {
  // Sanitise on receipt so a malicious peer can't poison our local copy.
  let v = String(peerName == null ? "___" : peerName).toUpperCase();
  v = v.replace(/[^A-Z_]/g, "_").slice(0, 3);
  while (v.length < 3) v += "_";
  coopPeerName = v;
  coopPeerSubmitted = true;
  noteCoopFirstSubmitter(peerRole);
  maybeFinalizeCoop();
}

function recordPeerCoopSkip() {
  coopPeerName = "___";
  coopPeerSubmitted = true;
  maybeFinalizeCoop();
}

function noteCoopFirstSubmitter(role) {
  if (coopFirstSubmitterRole !== -1) return;
  coopFirstSubmitterRole = role;
  coopSecondPlayerDeadline = performance.now() + COOP_SECOND_PLAYER_TIMEOUT_MS;
}

function coopSecondPlayerSecondsLeft() {
  if (coopSecondPlayerDeadline === 0) return null;
  if (coopOwnSubmitted && coopPeerSubmitted) return null;
  return Math.max(0, (coopSecondPlayerDeadline - performance.now()) / 1000);
}

function tickCoopSubmission() {
  if (currentScene !== SCENE.highScoreEntry) return;
  if (gameMode !== "coop") return;
  if (coopFinalSubmitted) return;
  // Auto-fill missing names once the timer expires.
  if (coopSecondPlayerDeadline > 0 && performance.now() >= coopSecondPlayerDeadline) {
    if (!coopOwnSubmitted) {
      coopOwnSubmitted = true;
      coopOwnName = "___";
    }
    if (!coopPeerSubmitted) {
      coopPeerSubmitted = true;
      coopPeerName = "___";
    }
    maybeFinalizeCoop();
  }
}

function maybeFinalizeCoop() {
  if (coopFinalSubmitted) return;
  if (!coopOwnSubmitted || !coopPeerSubmitted) return;
  const ownName  = coopOwnName  || "___";
  const peerName = coopPeerName || "___";
  // Player that scored the most points listed first, ties broken by submission
  // order.
  let firstName, secondName;
  if (coopOwnScore > coopPeerScore) {
    firstName = ownName; secondName = peerName;
  } else if (coopPeerScore > coopOwnScore) {
    firstName = peerName; secondName = ownName;
  } else if (coopFirstSubmitterRole === net.role) {
    firstName = ownName; secondName = peerName;
  } else {
    firstName = peerName; secondName = ownName;
  }
  coopFinalSubmitted = true;

  // Normally only the host POSTs (so we don't get duplicate entries). But if
  // the peer has already disconnected, submit ourselves regardless of role so
  // the local player isn't stranded.
  const peerGone = !netInMatch();
  if (!net.isHost && !peerGone) {
    coopFinalFetchPending = true;
    setTimeout(() => {
      if (coopFinalFetchPending) {
        coopFinalFetchPending = false;
        fetchTopCoopScores();
      }
    }, 3000);
    enterScene(SCENE.leaderboard);
    return;
  }
  submitTopCoopScore(firstName, secondName);
}

function submitTopCoopScore(name1, name2) {
  if (USE_LOCAL_SCORES) {
    const list = loadLocalCoopScores();
    list.push({ name: name1 + "+" + name2, score, at: Date.now() });
    list.sort((a, b) => b.score - a.score);
    const top = list.slice(0, 10);
    saveLocalCoopScores(top);
    topCoopScores = top;
    enterScene(SCENE.leaderboard);
    return;
  }
  fetch("/api/scores-coop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name1, name2, score }),
  })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(data => {
      if (Array.isArray(data)) {
        topCoopScores = data;
        if (typeof netSend === "function" && netInMatch()) {
          netSend({ type: "coopScores", scores: data });
        }
      }
      enterScene(SCENE.leaderboard);
    });
}
