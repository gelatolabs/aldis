"use strict";

let last = performance.now();

// Freeze timers when the window loses focus.
windowFocused = document.hasFocus();
window.addEventListener("blur", () => { windowFocused = false; });
window.addEventListener("focus", () => {
  windowFocused = true;
  last = performance.now();
});

// When a backgrounded tab returns to focus during a multiplayer match, ask
// the host for an immediate state snapshot so we don't render whatever stale
// positions our throttled rAF left behind.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (!netInMatch()) return;
  if (net.isHost) netSendSnapshot(true);
  else netSend({ type: "syncReq" });
});

// Backup tick to keep multiplayer simulation moving while the tab is hidden.
setInterval(() => {
  if (!document.hidden) return;
  if (!netInMatch()) return;
  if (currentScene !== SCENE.game) return;
  if (gameOver) return;

  const now = performance.now();
  const dt = Math.min(1100, now - last);
  last = now;
  elapsed += dt;
  if (lamp.beamTimer > 0) lamp.beamTimer -= dt;

  if (gameMode === "coop")        updateCoop(dt);
  else if (gameMode === "versus") updateVersus(dt);

  if (net.isHost) netSendSnapshot(true);
}, 200);


function frame(now) {
  let dt = Math.min(50, now - last);
  last = now;
  if (!windowFocused && !netInMatch()) dt = 0;
  sceneTime += dt;
  animTime += dt;
  if (freezeTimer <= 0) enemyAnimTime += dt;

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
  if (currentScene === SCENE.game && gameOver) {
    const ready = gameMode === "coop"
      ? topCoopScores !== null
      : topScores !== null;
    if (ready) {
      enterScene(qualifiesForTop10() ? SCENE.highScoreEntry : SCENE.leaderboard);
    }
  }
  if (currentScene === SCENE.highScoreEntry && gameMode === "coop") {
    tickCoopSubmission();
  }

  if (debug.enabled && (netInMatch()
      || (currentScene !== SCENE.game && currentScene !== SCENE.story))) {
    hideDebugHud();
  }
  if (debug.enabled) syncDebugHud();

  render();
  requestAnimationFrame(frame);
}

function update(dt) {
  if (!debug.freezeDiff) elapsed += dt;

  if (typeof musicSetDifficulty === "function") musicSetDifficulty(difficulty());

  if (gameMode === "coop") {
    updateCoop(dt);
  } else if (gameMode === "versus") {
    updateVersus(dt);
  } else {
    updateSurvival(dt);
  }

  updateRadar(dt);
  updateParticles(dt);
  decayEnemyMorseTimers(dt);

  if (netInMatch()) {
    netSendInputTick();
    netTickPing();
    if (net.isHost) netSendSnapshot();
  }
}

function updateSurvival(dt) {
  if (freezeTimer > 0) freezeTimer = Math.max(0, freezeTimer - dt);
  const frozen = freezeTimer > 0;
  if (!frozen) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnEnemy();
      spawnTimer = spawnInterval();
    }
  }
  for (const e of enemies) {
    if (e.alive) {
      if (!frozen) e.x += e.vx * (dt / 1000);
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.x < 40) {
        e.alive = false;
        if (!debug.invuln && !e.powerup) {
          player.missed += 1;
          playDamage();
          if (typeof musicOnDamage === "function") musicOnDamage();
          if (player.missed >= player.maxHealth) {
            gameOver = true;
            if (typeof musicOnDeath === "function") musicOnDeath();
            fetchTopScores();
          }
        }
      }
    } else if (e.deathAnim > 0) {
      e.deathAnim -= dt;
    }
  }
  enemies = enemies.filter(e => (e.alive) || (e.deathAnim && e.deathAnim > 0));
}

function updateCoop(dt) {
  if (freezeTimer > 0) freezeTimer = Math.max(0, freezeTimer - dt);
  const frozen = freezeTimer > 0;
  // Host spawns; peer waits for "spawn" messages.
  if (net.isHost && !frozen) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnCoopEnemy();
      spawnTimer = spawnInterval();
    }
  }

  for (const e of enemies) {
    if (e.alive) {
      if (!frozen) e.x += e.vx * (dt / 1000);
      if (e.hitFlash > 0) e.hitFlash -= dt;
      // Only the host applies misses → broadcast → both clients react.
      if (net.isHost && e.x < 40) {
        e.alive = false;
        if (!debug.invuln && !e.powerup) {
          player.missed += 1;
          playDamage();
          if (typeof musicOnDamage === "function") musicOnDamage();
          netSend({ type: "miss", id: e.id, missed: player.missed });
          if (player.missed >= player.maxHealth) {
            gameOver = true;
            if (typeof musicOnDeath === "function") musicOnDeath();
            netSend({ type: "gameOver" });
            fetchTopCoopScores();
          }
        }
      }
    } else if (e.deathAnim > 0) {
      e.deathAnim -= dt;
    }
  }
  enemies = enemies.filter(e => (e.alive) || (e.deathAnim && e.deathAnim > 0));
}

function updateVersus(dt) {
  // Host seeds the two starting enemies once.
  if (net.isHost && !versusSeeded) {
    spawnVersusInitial();
    versusSeeded = true;
  }

  for (const e of enemies) {
    if (e.alive) {
      e.x += e.vx * (dt / 1000);
      if (e.hitFlash > 0) e.hitFlash -= dt;
      // An enemy reaching my edge costs me a life. Only the player on that side
      // reports it.
      const myIsLeft = (net.role === net.topRole);
      const myEdgeHit = myIsLeft ? e.x < 40 : e.x > W - 40;
      if (myEdgeHit) {
        e.alive = false;
        if (!debug.invuln) {
          player.missed += 1;
          playDamage();
          if (typeof musicOnDamage === "function") musicOnDamage();
          netSend({ type: "hpHit", role: net.role, missed: player.missed,
                    y: e.y });
          if (net.isHost) {
            spawnVersusReplacement(e.y, net.role);
          }
          if (player.missed >= player.maxHealth) {
            versusWon = false;
            if (typeof musicOnDeath === "function") musicOnDeath();
            netSend({ type: "versusEnd", loserRole: net.role });
            enterScene(SCENE.versusEnd);
          }
        }
      }
    } else if (e.deathAnim > 0) {
      e.deathAnim -= dt;
    }
  }
  enemies = enemies.filter(e => (e.alive) || (e.deathAnim && e.deathAnim > 0));
}

// ---- Powerups ----
//
// Applied locally on both clients when a powerup is collected. Each client
// mutates its own state so the effect is consistent without needing a
// dedicated network message.

const POWERUP_FREEZE_MS = 12000;

function applyPowerupEffect(kind) {
  if (kind === "freeze") {
    freezeTimer = POWERUP_FREEZE_MS;
  } else if (kind === "clear") {
    for (const e of enemies) {
      if (!e.alive || e.powerup) continue;
      e.alive = false;
      e.deathAnim = 400;
      spawnEnemyExplosion(e);
    }
  } else if (kind === "heal") {
    player.missed = Math.max(0, player.missed - 1);
    if (gameMode === "coop") peerPlayer.missed = player.missed;
  }
}

// ---- Spawning helpers (multiplayer) ----

function spawnCoopEnemy() {
  // Reuse the survival generator and just attach an id + broadcast.
  const before = enemies.length;
  spawnEnemy();
  const e = enemies[enemies.length - 1];
  if (!e || enemies.length === before) return;
  e.id = nextEnemyId++;
  netSend({
    type: "spawn",
    id: e.id, typeKey: e.typeKey, word: e.word,
    x: e.x, y: e.y, vx: e.vx, seed: e.seed,
    powerup: e.powerup || null,
  });
}

function spawnVersusInitial() {
  // Two enemies: upper one moving left toward player 0, lower one moving
  // right toward player 1.
  const speed = BASE_SPEED + 6;
  const wordsList = ENEMY_TYPES.fodder.wordList;
  const w1 = wordsList[Math.floor(Math.random() * wordsList.length)];
  const w2 = wordsList[Math.floor(Math.random() * wordsList.length)];
  const id1 = nextEnemyId++;
  const id2 = nextEnemyId++;
  pushVersusEnemy(id1, "fodder", w1, W / 2, H * 0.35, -speed);
  pushVersusEnemy(id2, "fodder", w2, W / 2, H * 0.65,  speed);
  netSend({ type: "spawn", id: id1, typeKey: "fodder", word: w1,
            x: W / 2, y: H * 0.35, vx: -speed, seed: makeEnemySeed() });
  netSend({ type: "spawn", id: id2, typeKey: "fodder", word: w2,
            x: W / 2, y: H * 0.65, vx:  speed, seed: makeEnemySeed() });
}

// Host-only. Spawns a fresh enemy from mid-screen heading back toward the
// player whose edge just took the hit.
function spawnVersusReplacement(y, towardRole) {
  const wordsList = ENEMY_TYPES.fodder.wordList;
  const w = wordsList[Math.floor(Math.random() * wordsList.length)];
  const id = nextEnemyId++;
  const speed = BASE_SPEED + 6;
  const targetIsLeft = (towardRole === net.topRole);
  const vx = targetIsLeft ? -speed : speed;
  pushVersusEnemy(id, "fodder", w, W / 2, y, vx);
  netSend({ type: "spawn", id, typeKey: "fodder", word: w,
            x: W / 2, y, vx, seed: makeEnemySeed() });
}

function pushVersusEnemy(id, typeKey, word, x, y, vx) {
  enemies.push({
    id, x, y, vx, word, typeKey,
    typed: 0, alive: true, hitFlash: 0, deathAnim: 0,
    radarActive: false, radarFade: 0, radarX: 0, radarY: 0,
    seed: makeEnemySeed(),
    morse: "", morseTimer: 0, lastMorse: "", lastTimer: 0,
  });
}

// ---- Multiplayer setup ----
//
// Configures the local lamp position + aim range, the peer lamp's resting
// position, and per-mode HP. Called from resetGame() once gameMode is set.
let versusSeeded = false;

function setupForMode() {
  versusSeeded = false;
  nextEnemyId = 1;
  peerLamp.beamTimer = 0;
  peerLamp.beamKind = null;
  peerLamp.held = false;
  peerLamp.aim = 0;

  if (gameMode === "coop") {
    const yTop = H * 0.32, yBot = H * 0.68;
    const myIsTop = (net.role === net.topRole);
    lamp.x = 70;
    lamp.y = myIsTop ? yTop : yBot;
    lampAimMid = 0;
    lampAimSpan = Math.PI / 2;
    peerLamp.active = true;
    peerLamp.x = 70;
    peerLamp.y = myIsTop ? yBot : yTop;
    peerLamp.angle = 0;
    player.maxHealth = 10;
    peerPlayer.maxHealth = 10;
    peerPlayer.missed = 0;
    return;
  }

  if (gameMode === "versus") {
    lamp.y = H / 2;
    peerLamp.y = H / 2;
    // The server picks `topRole` randomly per match — the role it names is
    // the one seated on the left (mirror of co-op's top-vs-bottom usage).
    const myIsLeft = (net.role === net.topRole);
    if (myIsLeft) {
      lamp.x = 70;
      lampAimMid = 0;
      peerLamp.x = W - 70;
      peerLamp.angle = Math.PI;
    } else {
      lamp.x = W - 70;
      lampAimMid = Math.PI;
      peerLamp.x = 70;
      peerLamp.angle = 0;
    }
    lampAimSpan = Math.PI / 2;
    peerLamp.active = true;
    player.maxHealth = 3;
    peerPlayer.maxHealth = 3;
    peerPlayer.missed = 0;
    return;
  }

  // survival/story/fallback
  lamp.x = 70;
  lamp.y = H / 2;
  lampAimMid = 0;
  lampAimSpan = Math.PI / 2;
  peerLamp.active = false;
  player.maxHealth = 10;
}

// ---- Ping ----
//
// Each client echoes a "ping" back as "pong" with the original timestamp so
// the sender can compute round-trip time. Sent from update() once per second
// while in a match; the most recent RTT is drawn in the HUD.

let netPingMs = 0;
let lastPingSendAt = 0;

function netTickPing() {
  if (!netInMatch()) return;
  const now = performance.now();
  if (now - lastPingSendAt < 1000) return;
  lastPingSendAt = now;
  netSend({ type: "ping", t: now });
}

// ---- Peer message dispatcher ----

function handlePeerMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "input":
      // Peer sends absolute angle so we don't have to know their aim mapping.
      peerLamp.angle     = +msg.angle || 0;
      peerLamp.beamTimer = Math.max(0, +msg.beamTimer || 0);
      peerLamp.beamKind  = msg.beamKind || null;
      peerLamp.held      = !!msg.held;
      break;

    case "spawn": {
      // Peer applies host-authoritative spawns verbatim.
      const powerup = (msg.powerup === "clear" || msg.powerup === "freeze"
                    || msg.powerup === "heal") ? msg.powerup : null;
      const e = {
        id: msg.id | 0,
        x: +msg.x, y: +msg.y, vx: +msg.vx,
        word: String(msg.word || ""),
        typeKey: msg.typeKey === "heavy" || msg.typeKey === "runner" ? msg.typeKey : "fodder",
        powerup,
        typed: 0, alive: true, hitFlash: 0, deathAnim: 0,
        radarActive: false, radarFade: 0, radarX: 0, radarY: 0,
        seed: msg.seed | 0,
        morse: "", morseTimer: 0, lastMorse: "", lastTimer: 0,
      };
      enemies.push(e);
      if (e.id >= nextEnemyId) nextEnemyId = e.id + 1;
      break;
    }

    case "kill": {
      const e = enemies.find(x => x.id === (msg.id | 0));
      if (!e || !e.alive) break;
      const pts = +msg.points || 0;
      if (gameMode === "coop") {
        e.alive = false;
        e.deathAnim = 400;
        if (pts > 0) {
          e.deathPoints = pts;
          score += pts;
          coopPeerScore += pts;
        }
        spawnEnemyExplosion(e);
        if (e.powerup) {
          playPowerupKill(e.powerup);
          if (e.powerup === "heal" && typeof msg.missed === "number") {
            // Trust the killer's post-heal value.
            player.missed = Math.max(0, msg.missed | 0);
            peerPlayer.missed = player.missed;
          } else {
            applyPowerupEffect(e.powerup);
          }
        } else {
          playExplosion(e.typeKey);
        }
      } else if (gameMode === "versus" && msg.replaceWith) {
        // Bounce: same enemy gets a new word + reversed velocity.
        e.word = String(msg.replaceWith.word || e.word);
        e.vx   = +msg.replaceWith.vx;
        e.x    = +msg.replaceWith.x;
        e.y    = +msg.replaceWith.y;
        e.typed = 0;
        e.morse = ""; e.morseTimer = 0;
        e.lastMorse = ""; e.lastTimer = 0;
        e.hitFlash = 160;
        playBounce();
      }
      break;
    }

    case "miss": {
      // Co-op: host has decided this enemy escaped. Sync our missed counter.
      const e = enemies.find(x => x.id === (msg.id | 0));
      if (e) { e.alive = false; }
      if (typeof msg.missed === "number") {
        player.missed = Math.max(player.missed, msg.missed | 0);
        peerPlayer.missed = player.missed;  // shared HP
      }
      playDamage();
      break;
    }

    case "hpHit": {
      // Versus: peer took damage on their edge.
      const peerRole = msg.role | 0;
      if (peerRole !== net.role) {
        peerPlayer.missed = Math.max(peerPlayer.missed, msg.missed | 0);
      }
      // Host is responsible for spawning the bounce-back replacement.
      if (net.isHost && peerRole !== net.role) {
        spawnVersusReplacement(+msg.y || H / 2, peerRole);
      }
      break;
    }

    case "gameOver":
      // Co-op: host says game ended. Mirror state and load the leaderboard.
      gameOver = true;
      fetchTopCoopScores();
      break;

    case "versusEnd":
      // Peer reported their own death → we won.
      versusWon = ((msg.loserRole | 0) !== net.role);
      enterScene(SCENE.versusEnd);
      break;

    case "name":
      recordPeerCoopName(msg.role | 0, msg.name);
      break;
    case "skip":
      recordPeerCoopSkip();
      break;
    case "coopScores":
      // Host relays the authoritative leaderboard after its POST response
      // so the peer doesn't have to race a GET against write propagation.
      if (Array.isArray(msg.scores)) {
        topCoopScores = msg.scores;
        coopFinalFetchPending = false;  // cancel fallback GET
      }
      break;

    case "snapshot": {
      // Authoritative position update from the host. Applies cleanly even
      // when our rAF is paused (background tab) because ws messages still
      // fire — the next render cycle then has correct positions to draw.
      if (Array.isArray(msg.enemies)) {
        for (const row of msg.enemies) {
          if (!Array.isArray(row) || row.length < 3) continue;
          const id = row[0] | 0;
          const e = enemies.find(en => en.id === id);
          if (e && e.alive) {
            e.x = +row[1];
            e.y = +row[2];
          }
        }
      }
      if (gameMode === "coop") {
        if (typeof msg.missed === "number") {
          // Host is authoritative for missed.
          player.missed = msg.missed | 0;
          peerPlayer.missed = player.missed;
        }
        if (typeof msg.score === "number") {
          // Don't shrink — local kills we haven't broadcast yet might be
          // counted in our value but not the host's snapshot.
          score = Math.max(score, msg.score | 0);
        }
      }
      break;
    }

    case "syncReq":
      // Peer just refocused (or otherwise wants a fresh state); push one now.
      if (net.isHost) netSendSnapshot(true);
      break;

    case "ping":
      netSend({ type: "pong", t: +msg.t || 0 });
      break;
    case "pong":
      netPingMs = Math.max(0, Math.round(performance.now() - (+msg.t || 0)));
      break;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Tick the wire: send lamp state to peer. Called once per frame from update.
let lastInputTickAt = 0;
function netSendInputTick() {
  // Throttle to ~30 Hz.
  const now = performance.now();
  if (now - lastInputTickAt < 33) return;
  lastInputTickAt = now;
  netSend({
    type: "input",
    angle: lamp.angle,
    beamTimer: lamp.beamTimer,
    beamKind: lamp.beamKind,
    held: lamp.held,
  });
}

// Periodic authoritative snapshot from host → peer. Browsers throttle rAF in
// hidden tabs but keep delivering WebSocket messages, so applying snapshots on
// receipt keeps a backgrounded peer in sync. When the peer refocuses, the next
// rAF cycle simply renders state that's already current.
let lastSnapshotAt = 0;
function netSendSnapshot(force) {
  if (!net.isHost || !netInMatch()) return;
  if (gameMode !== "coop" && gameMode !== "versus") return;
  const now = performance.now();
  if (!force && now - lastSnapshotAt < 250) return;
  lastSnapshotAt = now;

  // Position-only snapshot. Direction (vx) is intentionally NOT sent here —
  // it changes only via "spawn" (initial direction) and "kill" (versus
  // bounce) events. Including vx in the snapshot caused a race in versus:
  // an in-flight snapshot from the host could overwrite the peer's just-
  // reflected vx in the brief window before the kill message reached the
  // host, making the bounce appear not to happen.
  const live = [];
  for (const e of enemies) {
    if (e.alive) live.push([e.id, Math.round(e.x), Math.round(e.y)]);
  }
  netSend({
    type: "snapshot",
    enemies: live,
    missed: player.missed,
    score,
    spawnTimer: Math.round(spawnTimer),
  });
}

// For each enemy, figure out the angular range its bounding box subtends from
// the given lamp position. Used to decide whether the aim line swept across
// it this frame. The four corner angles are unwrapped onto a contiguous
// segment around the enemy's centre direction so right-side versus lamps
// (whose enemies sit near atan2's ±π discontinuity) don't get a full-circle
// range.
function enemyAngularRange(e, lampX, lampY) {
  const lx = lampX == null ? lamp.x : lampX;
  const ly = lampY == null ? lamp.y : lampY;
  const t = ENEMY_TYPES[e.typeKey];
  const hw = t.w / 2, hh = t.h / 2;
  const refAngle = Math.atan2(e.y - ly, e.x - lx);
  let minA = Infinity, maxA = -Infinity;
  for (const ddx of [-hw, hw]) {
    for (const ddy of [-hh, hh]) {
      const raw = Math.atan2((e.y + ddy) - ly, (e.x + ddx) - lx);
      const a = unwrapAngle(raw, refAngle);
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
    }
  }
  return [minA, maxA];
}

// Returns `a` shifted by ±2π so it lies within (ref - π, ref + π].
function unwrapAngle(a, ref) {
  let d = a - ref;
  while (d >  Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return ref + d;
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
  const lensFwd = 28;
  const bx = lamp.x + ax * lensFwd;
  const by = lamp.y + ay * lensFwd;
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
  // Decay first so any sweep below cleanly resets the timer for newly-pinged
  // enemies even if neither lamp's sweep hits them this frame.
  for (const e of enemies) {
    if (!e.alive) continue;
    e.radarActive = false;
    if (e.radarFade > 0) e.radarFade = Math.max(0, e.radarFade - dt);
  }

  applyRadarSweep(prevLampAngle, lamp.angle, lamp.x, lamp.y, lamp);
  prevLampAngle = lamp.angle;

  if (peerLamp.active && gameMode === "coop") {
    applyRadarSweep(prevPeerLampAngle, peerLamp.angle,
                    peerLamp.x, peerLamp.y, peerLamp);
    prevPeerLampAngle = peerLamp.angle;
  }
}

// Per-lamp sweep: marks any enemy whose angular footprint this lamp swept
// across or is currently illuminating, and refreshes the radar fade timer.
function applyRadarSweep(fromAngle, toAngle, lx, ly, lampObj) {
  for (const e of enemies) {
    if (!e.alive) continue;
    // Skip enemies sitting essentially on top of the lamp — their angular
    // footprint is degenerate and we don't want to ping them.
    if (Math.hypot(e.x - lx, e.y - ly) < 20) continue;
    const [eLo, eHi] = enemyAngularRange(e, lx, ly);
    // Bring the lamp angles into the same continuous frame as the enemy
    // range so wrap-around doesn't break the comparison for lamps facing the
    // ±π direction (right-side versus player).
    const ref = (eLo + eHi) / 2;
    const fromAdj = unwrapAngle(fromAngle, ref);
    const toAdj   = unwrapAngle(toAngle,   ref);
    const lo = Math.min(fromAdj, toAdj);
    const hi = Math.max(fromAdj, toAdj);
    const swept = !(eHi < lo || eLo > hi);
    const under = eHi >= toAdj && eLo <= toAdj;
    if (swept) {
      e.radarX = e.x;
      e.radarY = e.y;
      if (under) e.radarActive = true;
      e.radarFade = RADAR_FADE_MS;
    }
    if (enemyInBeamOf(e, lampObj)) {
      e.radarX = e.x;
      e.radarY = e.y;
      e.radarFade = RADAR_FADE_MS;
    }
  }
}

// Same envelope test as enemyInBeam but parameterised on the lamp object so
// we can re-use it for the peer's beam in co-op.
function enemyInBeamOf(e, l) {
  if (l.beamTimer <= 0) return false;
  const ax = Math.cos(l.angle);
  const ay = Math.sin(l.angle);
  const lensFwd = 28;
  const bx = l.x + ax * lensFwd;
  const by = l.y + ay * lensFwd;
  const dx = e.x - bx;
  const dy = e.y - by;
  const along = dx * ax + dy * ay;
  if (along < 0 || along > BEAM_LEN) return false;
  const perp = Math.abs(-dx * ay + dy * ax);
  const bw = BEAM_NEAR_WIDTH + (BEAM_HALF_WIDTH - BEAM_NEAR_WIDTH) * (along / BEAM_LEN);
  const t = ENEMY_TYPES[e.typeKey];
  return perp <= bw + Math.max(t.w, t.h) / 2;
}

function updateNameEntry(dt) {
  if (inputResetTimer > 0) {
    inputResetTimer -= dt;
    if (inputResetTimer <= 0) {
      if (inNameEntry()) {
        const letter = MORSE_TO_CHAR[inputMorse];
        if (letter) {
          if (gameMode === "coop" && coopOwnName.length < 3) {
            coopOwnName += letter;
          } else if (gameMode !== "coop" && entryName.length < 3) {
            entryName += letter;
          }
        }
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
  coopOwnScore = 0;
  coopPeerScore = 0;
  resetNameEntry();
  player.missed = 0;
  peerPlayer.missed = 0;
  inputMorse = "";
  inputResetTimer = 0;
  lastLetterMorse = "";
  lastLetterTimer = 0;
  spawnTimer = 3000;
  freezeTimer = 0;
  enemyAnimTime = 0;
  elapsed = 0;
  gameOver = false;
  versusWon = false;
  setupForMode();
  setAim(0);
  lamp.beamTimer = 0;
  lamp.held = false;
  prevLampAngle = lamp.angle;
  prevPeerLampAngle = peerLamp.angle;
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
