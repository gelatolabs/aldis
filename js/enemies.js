"use strict";

const ENEMY_TYPES = {
  fodder: { label: "Fodder", w: 48, h: 48, wordList: WORDS_3_4,  speedMul: 1.0 },
  heavy:  { label: "Heavy",  w: 48, h: 48, wordList: WORDS_5_6,  speedMul: 0.7 },
  runner: { label: "Runner", w: 48, h: 48, wordList: WORDS_2, speedMul: 1.9 },
};

function pickTypeKey() {
  const d = difficulty();
  const p0 = { fodder: 1.00, heavy: 0.00, runner: 0.00 };
  const p1 = { fodder: 0.45, heavy: 0.30, runner: 0.25 };
  const keys = ["fodder", "heavy", "runner"];
  const weights = keys.map(k => p0[k] * (1 - d) + p1[k] * d);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < keys.length; i++) {
    r -= weights[i];
    if (r <= 0) return keys[i];
  }
  return keys[0];
}

function makeEnemySeed() { return Math.floor(Math.random() * 2_000_000_000); }

const POWERUP_CHANCE = 0.10;
const POWERUP_SPEED_MUL = 1.25;
const POWERUP_KINDS = ["clear", "freeze", "heal"];

function pickPowerupKind() {
  if (gameMode !== "survival" && gameMode !== "coop") return null;
  if (Math.random() >= POWERUP_CHANCE) return null;
  return POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)];
}

function spawnEnemy() {
  const powerup = pickPowerupKind();
  let typeKey, word;
  if (powerup) {
    typeKey = "fodder";
    const list = POWERUP_WORDS[powerup];
    word = list[Math.floor(Math.random() * list.length)];
  } else {
    typeKey = pickTypeKey();
    const t = ENEMY_TYPES[typeKey];
    word = t.wordList[Math.floor(Math.random() * t.wordList.length)];
  }
  const type = ENEMY_TYPES[typeKey];
  const margin = 80;
  const y = margin + Math.random() * (H - 2 * margin);
  const speedMul = type.speedMul * (powerup ? POWERUP_SPEED_MUL : 1);
  enemies.push({
    x: W + 40,
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
    seed: makeEnemySeed(),
    morse: "",
    morseTimer: 0,
    lastMorse: "",
    lastTimer: 0,
  });
}

function decayEnemyMorseTimers(dt) {
  for (const e of enemies) {
    if (e.morseTimer > 0) {
      e.morseTimer -= dt;
      if (e.morseTimer <= 0) e.morse = "";
    }
    if (e.lastTimer > 0) {
      e.lastTimer -= dt;
      if (e.lastTimer <= 0) e.lastMorse = "";
    }
  }
}

// ---- Procedural sprites ----
//
// Each enemy is described by a small "design" object generated from its seed.
// The design is a list of solid parts (ellipses / rounded rects / triangles),
// eyes, and limbs. Limbs swing with a phase tied to forward speed; the body
// bobs slightly. Parts are drawn with radial gradients whose highlight faces
// the lamp for a pseudo-3D effect. Enemies have a random hue with fixed S/L.

function makeRng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 4294967296);
  };
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if      (hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else             { r1 = c; b1 = x; }
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255),
          Math.round((g1 + m) * 255),
          Math.round((b1 + m) * 255)];
}

function hslHex(h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l);
  const h2 = v => v.toString(16).padStart(2, "0");
  return "#" + h2(r) + h2(g) + h2(b);
}

function generatePalette(rng) {
  const h = rng() * 360;
  return {
    body: hslHex(h, 55, 55),
    limb: hslHex(h, 55, 28),
  };
}

function adjustColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  if (amt >= 0) {
    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);
  } else {
    const t = 1 + amt;
    r = Math.round(r * t); g = Math.round(g * t); b = Math.round(b * t);
  }
  const h = v => v.toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

function generateEnemyDesign(typeKey, seed) {
  const rng = makeRng(seed);
  const palette = generatePalette(rng);
  if (typeKey === "heavy")  return designHeavy(rng, palette);
  if (typeKey === "runner") return designRunner(rng, palette);
  return designFodder(rng, palette);
}

function designFodder(rng, palette) {
  // Humanoid: oval body, optional head, 2 legs, optional 2 wavy arms.
  const bodyW = 18 + rng() * 8;
  const bodyH = 22 + rng() * 8;
  const cy = -2;
  const parts = [];
  parts.push({ kind: "ellipse", cx: 0, cy, rx: bodyW / 2, ry: bodyH / 2,
               color: palette.body, z: 0.5 });
  let head = null;
  if (rng() < 0.5) {
    const hr = 5 + rng() * 3;
    head = { cx: rng() * 2 - 1, cy: cy - bodyH / 2 - hr * 0.6,
             rx: hr, ry: hr * (0.85 + rng() * 0.3) };
    parts.push({ kind: "ellipse", cx: head.cx, cy: head.cy,
                 rx: head.rx, ry: head.ry,
                 color: palette.body, z: 0.35 });
  }
  const eyeCount = rng() < 0.5 ? 1 : 2;
  const eyes = [];
  const eyeAnchorX = head ? head.cx : 0;
  const eyeAnchorY = head ? head.cy + head.ry * 0.05 : cy - bodyH * 0.15;
  const eyeR    = head ? Math.min(2.2, head.rx * 0.35) : 2;
  const eyeSpan = head ? head.rx * 0.55 : 2.5 + rng() * 2.5;
  if (eyeCount === 1) {
    eyes.push({ cx: eyeAnchorX, cy: eyeAnchorY, r: eyeR + 0.3 });
  } else {
    eyes.push({ cx: eyeAnchorX - eyeSpan, cy: eyeAnchorY, r: eyeR });
    eyes.push({ cx: eyeAnchorX + eyeSpan, cy: eyeAnchorY, r: eyeR });
  }
  const legY = cy + bodyH / 2 - 2;
  const legSpread = bodyW / 2 * 0.55;
  const legLen = 9 + rng() * 4;
  const legs = [
    { ax: -legSpread, ay: legY, len: legLen, color: palette.limb, phase: 0,        thick: 3 },
    { ax:  legSpread, ay: legY, len: legLen, color: palette.limb, phase: Math.PI,  thick: 3 },
  ];
  const arms = [];
  if (rng() < 0.5) {
    const armY = cy - bodyH * 0.05;
    const armLen = 9 + rng() * 4;
    // Angled up-and-out, wavy. Right arm phase opposite so they alternate.
    arms.push({ ax: -bodyW / 2 + 1, ay: armY, len: armLen,
                color: palette.limb, phase: Math.PI, thick: 2.5,
                swingAmp: 1.5, dirX: -0.55, dirY: -0.83, wavy: true });
    arms.push({ ax:  bodyW / 2 - 1, ay: armY, len: armLen,
                color: palette.limb, phase: 0,       thick: 2.5,
                swingAmp: 1.5, dirX:  0.55, dirY: -0.83, wavy: true });
  }
  return { parts, eyes, legs, arms, palette, bobAmp: 1.2, strideAmp: 3 };
}

function designHeavy(rng, palette) {
  // Tank: wide rounded rect body with optional head, optional stub arms, 3
  // thick legs.
  const bodyW = 30 + rng() * 8;
  const bodyH = 22 + rng() * 6;
  const cy = -1;
  const parts = [];
  parts.push({ kind: "rect", cx: 0, cy, rx: bodyW / 2, ry: bodyH / 2,
               color: palette.body, z: 0.5, rounded: 5 });
  let turret = null;
  if (rng() < 0.5) {
    const tw = 6 + rng() * 4;
    turret = { cx: rng() * 4 - 2, cy: cy - bodyH / 2 - tw * 0.5,
               rx: tw, ry: tw * (0.8 + rng() * 0.25) };
    parts.push({ kind: "ellipse", cx: turret.cx, cy: turret.cy,
                 rx: turret.rx, ry: turret.ry,
                 color: palette.body, z: 0.3 });
  }
  if (rng() < 0.5) {
    const br = 4 + rng() * 2;
    parts.push({ kind: "ellipse", cx: -bodyW / 2 + 2, cy: cy + 2,
                 rx: br, ry: br, color: palette.body, z: 0.6 });
    parts.push({ kind: "ellipse", cx:  bodyW / 2 - 2, cy: cy + 2,
                 rx: br, ry: br, color: palette.body, z: 0.6 });
  }
  const eyeCount = 1 + Math.floor(rng() * 3);
  const eyes = [];
  const eyeAnchorX = turret ? turret.cx : 0;
  const eyeAnchorY = turret ? turret.cy + turret.ry * 0.05 : cy - bodyH * 0.2;
  const eyeR  = turret ? Math.min(2.0, turret.rx * 0.32) : 1.8;
  const eyeSp = turret ? turret.rx * 0.4 : 5;
  for (let i = 0; i < eyeCount; i++) {
    const ex = (i - (eyeCount - 1) / 2) * eyeSp;
    eyes.push({ cx: eyeAnchorX + ex, cy: eyeAnchorY, r: eyeR });
  }
  // 3 legs (left, center, right) in a tripod-cycle.
  const legY = cy + bodyH / 2 - 1;
  const legSpread = bodyW / 2 * 0.65;
  const legLen = 7 + rng() * 3;
  const legs = [
    { ax: -legSpread, ay: legY, len: legLen, color: palette.limb,
      phase: 0,                    thick: 5 },
    { ax: 0,          ay: legY, len: legLen, color: palette.limb,
      phase: 2 * Math.PI / 3,      thick: 5 },
    { ax:  legSpread, ay: legY, len: legLen, color: palette.limb,
      phase: 4 * Math.PI / 3,      thick: 5 },
  ];
  return { parts, eyes, legs, arms: [], palette, bobAmp: 0.6, strideAmp: 2 };
}

function designRunner(rng, palette) {
  // Quadruped: short, wide rounded rect body with optional front head, 0-2
  // fins, 4 legs.
  const bodyW = 30 + rng() * 6;
  const bodyH = 12 + rng() * 4;
  const cy = -1;
  const parts = [];
  parts.push({ kind: "rect", cx: 0, cy, rx: bodyW / 2, ry: bodyH / 2,
               color: palette.body, z: 0.5, rounded: 4 });
  let head = null;
  if (rng() < 0.5) {
    head = { cx: -bodyW / 2 + 4, cy: cy + 1,
             rx: 5 + rng() * 2, ry: bodyH / 2 * 0.85 };
    parts.push({ kind: "ellipse", cx: head.cx, cy: head.cy,
                 rx: head.rx, ry: head.ry,
                 color: palette.body, z: 0.35 });
  }
  const finCount = Math.floor(rng() * 3);
  const finBaseX = bodyW * 0.18;
  for (let i = 0; i < finCount; i++) {
    const fx = finCount === 1
      ? finBaseX + (rng() - 0.5) * 4
      : finBaseX + (i === 0 ? -bodyW * 0.14 : bodyW * 0.14);
    const fh = 4 + rng() * 3;
    parts.push({ kind: "triangle",
                 cx: fx, cy: cy - bodyH / 2 - fh / 2,
                 w: 5 + rng() * 2, h: fh, color: palette.body, z: 0.25 });
  }
  const eyes = [];
  const eyeAnchorX = head ? head.cx : -bodyW / 2 + 6;
  const eyeAnchorY = head ? head.cy : cy - 1;
  const eyeR  = head ? Math.min(1.8, head.rx * 0.32) : 1.8;
  const eyeSp = head ? head.rx * 0.45 : 2.5;
  const eyeCount = rng() < 0.5 ? 1 : 2;
  if (eyeCount === 1) {
    eyes.push({ cx: eyeAnchorX, cy: eyeAnchorY, r: eyeR + 0.2 });
  } else {
    eyes.push({ cx: eyeAnchorX - eyeSp, cy: eyeAnchorY, r: eyeR });
    eyes.push({ cx: eyeAnchorX + eyeSp, cy: eyeAnchorY, r: eyeR });
  }
  // Four legs paired in a trot pattern.
  const legY = cy + bodyH / 2 - 1;
  const legLen = 8 + rng() * 2;
  const xFront = -bodyW / 2 + 4;
  const xBack  =  bodyW / 2 - 4;
  const xMid1  =  xFront / 3;
  const xMid2  =  xBack  / 3;
  const legs = [
    { ax: xFront, ay: legY, len: legLen, color: palette.limb,
      phase: 0,            thick: 3 },
    { ax: xMid1,  ay: legY, len: legLen, color: palette.limb,
      phase: Math.PI,      thick: 3 },
    { ax: xMid2,  ay: legY, len: legLen, color: palette.limb,
      phase: Math.PI,      thick: 3 },
    { ax: xBack,  ay: legY, len: legLen, color: palette.limb,
      phase: 0,            thick: 3 },
  ];
  return { parts, eyes, legs, arms: [], palette, bobAmp: 0.5, strideAmp: 2.5 };
}

// ---- Per-frame rendering ----

const STRIDE_PX = 30;

function enemyDesign(e) {
  if (!e.design) e.design = generateEnemyDesign(e.typeKey, e.seed || 1);
  return e.design;
}

function enemyWalkPhase(e) {
  const speed = Math.abs(e.vx);
  const seedOff = ((e.seed || 0) % 997) / 997 * Math.PI * 2;
  return seedOff + (enemyAnimTime / 1000) * 2 * Math.PI * speed / STRIDE_PX;
}

function shadedFill(c, cx, cy, rx, ry, color, L, z) {
  const base = adjustColor(color, -z * 0.18);
  const hi   = adjustColor(base,   0.18);
  const sh   = adjustColor(base,  -0.28);
  const r = Math.max(rx, ry);
  const gx = cx + L.x * rx * 0.55;
  const gy = cy + L.y * ry * 0.55;
  const grad = c.createRadialGradient(gx, gy, 0, gx, gy, r * 1.7);
  grad.addColorStop(0,    hi);
  grad.addColorStop(0.45, base);
  grad.addColorStop(1,    sh);
  return grad;
}

function pathRoundedRect(c, x, y, w, h, r) {
  r = Math.min(r, Math.min(w, h) / 2);
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function drawPart(c, ox, oy, p, L, fillOverride) {
  const cx = ox + p.cx, cy = oy + p.cy;
  if (p.kind === "ellipse") {
    c.beginPath();
    c.ellipse(cx, cy, p.rx, p.ry, 0, 0, Math.PI * 2);
    c.fillStyle = fillOverride || shadedFill(c, cx, cy, p.rx, p.ry, p.color, L, p.z);
    c.fill();
  } else if (p.kind === "rect") {
    c.beginPath();
    pathRoundedRect(c, cx - p.rx, cy - p.ry, p.rx * 2, p.ry * 2, p.rounded || 0);
    c.fillStyle = fillOverride || shadedFill(c, cx, cy, p.rx, p.ry, p.color, L, p.z);
    c.fill();
  } else if (p.kind === "triangle") {
    c.beginPath();
    c.moveTo(cx, cy - p.h / 2);
    c.lineTo(cx + p.w / 2, cy + p.h / 2);
    c.lineTo(cx - p.w / 2, cy + p.h / 2);
    c.closePath();
    c.fillStyle = fillOverride || shadedFill(c, cx, cy, p.w / 2, p.h / 2, p.color, L, p.z);
    c.fill();
  }
}

function drawLimb(c, ox, oy, limb, phase, ampMul, fillOverride, restPose) {
  const dirX = limb.dirX || 0;
  const dirY = limb.dirY != null ? limb.dirY : 1;
  const p = phase + (limb.phase || 0);
  const swingMag = limb.swingAmp != null ? limb.swingAmp : ampMul;
  const swing = restPose ? 0 : Math.cos(p) * swingMag;
  const lift  = restPose ? 0 : Math.max(0, Math.sin(p)) * (ampMul * 0.9);
  const ax = ox + limb.ax;
  const ay = oy + limb.ay;
  // Perpendicular to rest direction (rotated 90°).
  const px = -dirY, py = dirX;
  const len = limb.len - lift;
  const fx = ax + dirX * len + px * swing;
  const fy = ay + dirY * len + py * swing;
  c.save();
  c.strokeStyle = fillOverride || limb.color;
  c.lineWidth = limb.thick || 3;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.beginPath();
  if (limb.wavy) {
    // Polyline along the limb with a sinusoidal perpendicular wobble.
    // In rest pose the wave is static; otherwise it travels along the limb.
    const segments = 8;
    const waveAmp = 2.2;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const baseX = ax + (fx - ax) * t;
      const baseY = ay + (fy - ay) * t;
      const phaseShift = restPose ? 0 : phase * 1.5;
      const wave = Math.sin(t * Math.PI * 2 + phaseShift) * waveAmp * t;
      const x = baseX + px * wave;
      const y = baseY + py * wave;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
  } else {
    c.moveTo(ax, ay);
    c.lineTo(fx, fy);
  }
  c.stroke();
  c.restore();
}

function drawEnemySprite(c, e) {
  if (e.powerup) { drawPowerupSprite(c, e); return; }
  const d = enemyDesign(e);
  const sx = e.x, sy = e.y;
  const phase = enemyWalkPhase(e);
  const bob = Math.sin(phase * 2) * d.bobAmp;
  const oy = sy + bob;

  let lx = lamp.x - sx, ly = lamp.y - sy;
  const llen = Math.hypot(lx, ly) || 1;
  const L = { x: lx / llen, y: ly / llen };

  // Legs follow body bob so the silhouette stays cohesive (no body/leg gap).
  for (const leg of d.legs) drawLimb(c, sx, oy, leg, phase, d.strideAmp);

  const partsSorted = d.parts.slice().sort((a, b) => b.z - a.z);
  for (const p of partsSorted) drawPart(c, sx, oy, p, L);

  // Pupils look in the direction of movement.
  const lookSign = e.vx < 0 ? -1 : 1;
  for (const eye of d.eyes) {
    const ex = sx + eye.cx, ey = oy + eye.cy;
    c.fillStyle = "#fff";
    c.beginPath();
    c.arc(ex, ey, eye.r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#111";
    c.beginPath();
    c.arc(ex + lookSign * eye.r * 0.4, ey,
          eye.r * 0.55, 0, Math.PI * 2);
    c.fill();
  }

  for (const arm of d.arms) drawLimb(c, sx, oy, arm, phase, d.strideAmp);

  if (e.hitFlash > 0) {
    c.save();
    c.globalAlpha = Math.min(0.65, e.hitFlash / 200);
    const tint = "#fff7aa";
    for (const leg of d.legs) drawLimb(c, sx, oy, leg, phase, d.strideAmp, tint);
    for (const p of partsSorted) drawPart(c, sx, oy, p, L, tint);
    for (const arm of d.arms) drawLimb(c, sx, oy, arm, phase, d.strideAmp, tint);
    c.restore();
  }
}

// Silhouette pass mirrors the live sprite pose. Body and limbs share the same
// `oy` (with bob) so the projected shadow is one cohesive animated shape with
// no gaps between body and legs.
function drawEnemySilhouette(c, e, color, dx, dy) {
  if (e.powerup) { drawPowerupSilhouette(c, e, color, dx, dy); return; }
  const d = enemyDesign(e);
  const sx = e.x + (dx || 0), sy = e.y + (dy || 0);
  const phase = enemyWalkPhase(e);
  const bob = Math.sin(phase * 2) * d.bobAmp;
  const oy = sy + bob;
  for (const leg of d.legs) drawLimb(c, sx, oy, leg, phase, d.strideAmp, color);
  const partsSorted = d.parts.slice().sort((a, b) => b.z - a.z);
  for (const p of partsSorted) drawPart(c, sx, oy, p, null, color);
  for (const arm of d.arms) drawLimb(c, sx, oy, arm, phase, d.strideAmp, color);
}

// ---- Powerup sprites ----

function bombBob(e) {
  const t = enemyAnimTime * 0.004;
  return Math.sin(t + (e.seed & 0xff) * 0.1) * 1.8;
}

function heartScale(e) {
  const t = enemyAnimTime * 0.008;
  // Two-beat waveform so it reads as a pulse rather than a sine bob.
  const phase = (t + (e.seed & 0xff) * 0.1) % (Math.PI * 2);
  const beat = Math.max(0, Math.sin(phase)) + 0.6 * Math.max(0, Math.sin(phase * 2));
  return 1 + beat * 0.08;
}

// Heart outline with two cubic Beziers.
function tracePath(c, points) {
  c.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i === 0) c.moveTo(p[0], p[1]);
    else if (p[0] === "bez") c.bezierCurveTo(p[1], p[2], p[3], p[4], p[5], p[6]);
    else c.lineTo(p[0], p[1]);
  }
  c.closePath();
}

function traceHeart(c, sx, sy, r) {
  const w     = r * 1.05;       // half-width at the widest point
  const topY  = sy - r * 0.85;  // vertical centre of each lobe
  const cleft = sy - r * 0.2;   // V between the lobes
  const botY  = sy + r * 1.55;  // tip
  c.beginPath();
  c.moveTo(sx, cleft);
  // Left lobe: up and outward, then down to the left flank.
  c.bezierCurveTo(sx - w * 0.18, topY - r * 0.4,
                  sx - w,        topY - r * 0.55,
                  sx - w,        topY);
  // Left flank down to the tip.
  c.bezierCurveTo(sx - w,        topY + r * 0.55,
                  sx - w * 0.3,  botY - r * 0.35,
                  sx,            botY);
  // Right flank back up.
  c.bezierCurveTo(sx + w * 0.3,  botY - r * 0.35,
                  sx + w,        topY + r * 0.55,
                  sx + w,        topY);
  // Right lobe back to the cleft.
  c.bezierCurveTo(sx + w,        topY - r * 0.55,
                  sx + w * 0.18, topY - r * 0.4,
                  sx,            cleft);
  c.closePath();
}

function traceCube(c, sx, sy, s, d) {
  // Assembles all six visible edges of a cube (front face + top + right)
  // into a single path. `d` is the depth offset.
  const L = sx - s, R = sx + s, T = sy - s, B = sy + s;
  c.beginPath();
  // Outer silhouette: front-bottom-left → along front → right edge → down-back
  // right → back-bottom → etc. Trace the six outer edges.
  c.moveTo(L,     B);
  c.lineTo(R,     B);
  c.lineTo(R + d, B - d);
  c.lineTo(R + d, T - d);
  c.lineTo(L + d, T - d);
  c.lineTo(L,     T);
  c.closePath();
}

function drawBombSprite(c, sx, sy, bob) {
  const r = 14;
  const y = sy + (bob || 0);
  c.save();
  // Fuse string.
  c.strokeStyle = "#8a6a3c";
  c.lineWidth = 2;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(sx + 4, y - r + 2);
  c.quadraticCurveTo(sx + 10, y - r - 6, sx + 12, y - r - 10);
  c.stroke();
  // Body: dark sphere with highlight. Drawn before the spark so the glow sits on top.
  const g = c.createRadialGradient(sx - r * 0.4, y - r * 0.4, 1,
                                   sx, y, r);
  g.addColorStop(0, "#4a4a4a");
  g.addColorStop(0.5, "#222");
  g.addColorStop(1, "#0a0a0a");
  c.fillStyle = g;
  c.beginPath();
  c.arc(sx, y, r, 0, Math.PI * 2);
  c.fill();
  // Animated spark. The outer glow and inner core share the same center.
  const spark = (Math.sin(enemyAnimTime * 0.03) + 1) * 0.5;
  c.fillStyle = "rgba(255,220,120," + (0.6 + 0.4 * spark).toFixed(3) + ")";
  c.beginPath();
  c.arc(sx + 12, y - r - 10, 2.2 + spark * 1.2, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "rgba(255,160,60,0.9)";
  c.beginPath();
  c.arc(sx + 12, y - r - 10, 1.2, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function drawIceCubeSprite(c, sx, sy, seed) {
  const s = 12;
  const d = 6;   // depth of the 3D projection
  const rng = makeRng(seed || 1);
  c.save();

  // Front face.
  const frontG = c.createLinearGradient(sx - s, sy - s, sx + s, sy + s);
  frontG.addColorStop(0.00, "rgba(160,200,230,0.95)");
  frontG.addColorStop(0.40, "rgba(110,170,210,0.92)");
  frontG.addColorStop(0.75, "rgba(70,135,180,0.92)");
  frontG.addColorStop(1.00, "rgba(40,95,145,0.92)");
  c.fillStyle = frontG;
  c.fillRect(sx - s, sy - s, s * 2, s * 2);

  // Cloudy blobs.
  c.save();
  c.globalCompositeOperation = "lighter";
  c.beginPath();
  c.rect(sx - s, sy - s, s * 2, s * 2);
  c.clip();
  for (let i = 0; i < 3; i++) {
    const cx = sx - s + rng() * (s * 2);
    const cy = sy - s + rng() * (s * 2);
    const cr = 3.5 + rng() * 3.5;
    const rg = c.createRadialGradient(cx, cy, 0, cx, cy, cr);
    rg.addColorStop(0, "rgba(255,255,255,0.28)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = rg;
    c.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
  }
  c.restore();

  // Top face.
  const topG = c.createLinearGradient(sx - s, sy - s, sx + s, sy - s - d);
  topG.addColorStop(0, "rgba(180,215,235,0.96)");
  topG.addColorStop(1, "rgba(135,190,220,0.94)");
  c.fillStyle = topG;
  c.beginPath();
  c.moveTo(sx - s,     sy - s);
  c.lineTo(sx - s + d, sy - s - d);
  c.lineTo(sx + s + d, sy - s - d);
  c.lineTo(sx + s,     sy - s);
  c.closePath();
  c.fill();

  // Right face.
  const rightG = c.createLinearGradient(sx + s, sy - s, sx + s + d, sy + s);
  rightG.addColorStop(0, "rgba(90,150,190,0.92)");
  rightG.addColorStop(1, "rgba(45,105,155,0.92)");
  c.fillStyle = rightG;
  c.beginPath();
  c.moveTo(sx + s,     sy - s);
  c.lineTo(sx + s + d, sy - s - d);
  c.lineTo(sx + s + d, sy + s - d);
  c.lineTo(sx + s,     sy + s);
  c.closePath();
  c.fill();

  // Cracks.
  c.save();
  c.beginPath();
  c.rect(sx - s, sy - s, s * 2, s * 2);
  c.clip();
  c.strokeStyle = "rgba(240,250,255,0.85)";
  c.lineWidth = 0.8;
  c.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    const x0 = sx - s + rng() * (s * 2);
    const y0 = sy - s + rng() * (s * 2);
    const ang = rng() * Math.PI * 2;
    const len = 3 + rng() * 4;
    const x1 = x0 + Math.cos(ang) * len;
    const y1 = y0 + Math.sin(ang) * len;
    const x2 = x1 + Math.cos(ang + (rng() - 0.5) * 1.4) * (len * 0.7);
    const y2 = y1 + Math.sin(ang + (rng() - 0.5) * 1.4) * (len * 0.7);
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }
  // Frost speckle.
  c.fillStyle = "rgba(255,255,255,0.85)";
  for (let i = 0; i < 6; i++) {
    const fx = sx - s + rng() * (s * 2);
    const fy = sy - s + rng() * (s * 2);
    c.fillRect(fx, fy, 1, 1);
  }
  c.restore();

  // Seams between faces.
  c.lineWidth = 1;
  c.strokeStyle = "rgba(30,70,110,0.8)";
  c.beginPath();
  c.moveTo(sx - s, sy - s);
  c.lineTo(sx + s, sy - s);
  c.moveTo(sx + s, sy - s);
  c.lineTo(sx + s, sy + s);
  c.stroke();

  // Outer silhouette.
  c.lineWidth = 1.4;
  c.strokeStyle = "rgba(25,65,100,0.95)";
  traceCube(c, sx, sy, s, d);
  c.stroke();

  // Specular glint.
  const glintX = sx - s * 0.55, glintY = sy - s * 0.55;
  const glintG = c.createRadialGradient(glintX, glintY, 0, glintX, glintY, 3.2);
  glintG.addColorStop(0, "rgba(255,255,255,0.8)");
  glintG.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = glintG;
  c.fillRect(glintX - 4, glintY - 4, 8, 8);
  c.fillStyle = "rgba(255,255,255,0.85)";
  c.beginPath();
  c.arc(glintX, glintY, 0.8, 0, Math.PI * 2);
  c.fill();

  c.restore();
}

function drawHeartSprite(c, sx, sy, scale) {
  const r = 8 * (scale || 1);
  c.save();
  const g = c.createRadialGradient(sx - 3, sy - 4, 1, sx, sy, r * 2.2);
  g.addColorStop(0, "#ff9aa8");
  g.addColorStop(0.6, "#e03040");
  g.addColorStop(1, "#801018");
  c.fillStyle = g;
  c.strokeStyle = "#400810";
  c.lineWidth = 1.5;
  c.lineJoin = "round";
  traceHeart(c, sx, sy, r);
  c.fill();
  c.stroke();
  // Highlight on the upper-left lobe.
  c.fillStyle = "rgba(255,200,210,0.55)";
  c.beginPath();
  c.ellipse(sx - r * 0.55, sy - r * 0.15, r * 0.35, r * 0.22,
            -0.4, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function drawPowerupSprite(c, e) {
  if (e.powerup === "clear") {
    const bob = bombBob(e);
    drawBombSprite(c, e.x, e.y, bob);
    if (e.hitFlash > 0) powerupHitFlash(c, e, bob);
  } else if (e.powerup === "freeze") {
    drawIceCubeSprite(c, e.x, e.y, e.seed);
    if (e.hitFlash > 0) powerupHitFlash(c, e, 0);
  } else if (e.powerup === "heal") {
    const scale = heartScale(e);
    drawHeartSprite(c, e.x, e.y, scale);
    if (e.hitFlash > 0) powerupHitFlash(c, e, 0);
  }
}

function powerupHitFlash(c, e, bob) {
  c.save();
  c.globalAlpha = Math.min(0.65, e.hitFlash / 200);
  c.fillStyle = "#fff7aa";
  if (e.powerup === "heal") {
    const scale = heartScale(e);
    traceHeart(c, e.x, e.y, 8 * scale + 2);
    c.fill();
  } else if (e.powerup === "freeze") {
    traceCube(c, e.x, e.y, 14, 6);
    c.fill();
  } else {
    c.beginPath();
    c.arc(e.x, e.y + bob, 16, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

function drawPowerupSilhouette(c, e, color, dx, dy) {
  const sx = e.x + (dx || 0), sy = e.y + (dy || 0);
  c.save();
  c.fillStyle = color;
  if (e.powerup === "clear") {
    const bob = bombBob(e);
    c.beginPath();
    c.arc(sx, sy + bob, 14, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(sx + 4, sy - 14 + bob + 2);
    c.quadraticCurveTo(sx + 10, sy - 14 + bob - 6,
                       sx + 12, sy - 14 + bob - 10);
    c.stroke();
  } else if (e.powerup === "freeze") {
    traceCube(c, sx, sy, 12, 6);
    c.fill();
  } else if (e.powerup === "heal") {
    const scale = heartScale(e);
    traceHeart(c, sx, sy, 8 * scale);
    c.fill();
  }
  c.restore();
}

// ---- Death explosion ----

let particles = [];

function spawnEnemyExplosion(e) {
  if (e.powerup) { spawnPowerupExplosion(e); return; }
  const d = enemyDesign(e);
  const sx = e.x, sy = e.y;
  const phase = enemyWalkPhase(e);
  const bob = Math.sin(phase * 2) * d.bobAmp;
  const oy = sy + bob;

  // Freeze lighting direction at the moment of detonation so chunks stay
  // shaded consistently as they tumble.
  let lx = lamp.x - sx, ly = lamp.y - sy;
  const llen = Math.hypot(lx, ly) || 1;
  const L = { x: lx / llen, y: ly / llen };

  function pushChunk(cx, cy, draw, opts) {
    const dx = cx - sx, dy = cy - sy;
    const dist = Math.hypot(dx, dy) || 1;
    const jitterX = (Math.random() - 0.5) * 0.7;
    const jitterY = (Math.random() - 0.5) * 0.7;
    const dirX = dx / dist + jitterX;
    const dirY = dy / dist + jitterY;
    const speed = (opts && opts.speed) != null
      ? opts.speed : 80 + Math.random() * 90;
    particles.push({
      x: cx, y: cy,
      vx: dirX * speed + (e.vx || 0) * 0.25,
      vy: dirY * speed - 40,
      gravity: 220,
      drag: 0.5,
      rot: 0,
      rotV: (Math.random() - 0.5) * ((opts && opts.spin) || 8),
      life: 0,
      maxLife: 650 + Math.random() * 500,
      draw,
    });
  }

  // Torso splits along its axes into four equal quadrant shards. Limbs and eyes
  // fly off whole. It's a bit disturbing.
  for (const p of d.parts) {
    const cx = sx + p.cx, cy = oy + p.cy;
    const halfW = p.rx || (p.w ? p.w / 2 : 4);
    const halfH = p.ry || (p.h ? p.h / 2 : 4);
    const quadOffsets = [
      [-halfW / 2, -halfH / 2],
      [ halfW / 2, -halfH / 2],
      [-halfW / 2,  halfH / 2],
      [ halfW / 2,  halfH / 2],
    ];
    for (const [qx, qy] of quadOffsets) {
      const fx = cx + qx, fy = cy + qy;
      const partLocal = Object.assign({}, p, { cx: 0, cy: 0 });
      pushChunk(fx, fy, (c) => {
        c.save();
        // Clip to the quadrant rect (centered on the chunk origin).
        c.beginPath();
        c.rect(-halfW / 2 - 0.5, -halfH / 2 - 0.5, halfW + 1, halfH + 1);
        c.clip();
        // Draw the whole part offset so its centre sits where it would have
        // sat relative to this quadrant. The clip exposes only this quarter.
        drawPart(c, -qx, -qy, partLocal, L);
        c.restore();
      }, { spin: 8 });
    }
  }

  for (const limb of [...d.legs, ...d.arms]) {
    const dirX = limb.dirX || 0;
    const dirY = limb.dirY != null ? limb.dirY : 1;
    const ax = sx + limb.ax;
    const ay = oy + limb.ay;
    const mx = ax + dirX * limb.len * 0.5;
    const my = ay + dirY * limb.len * 0.5;
    const segLen = limb.len;
    const thick = limb.thick || 3;
    const color = limb.color;
    pushChunk(mx, my, (c) => {
      c.strokeStyle = color;
      c.lineWidth = thick;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(-segLen / 2, 0);
      c.lineTo( segLen / 2, 0);
      c.stroke();
    }, { spin: 12 });
  }

  for (const eye of d.eyes) {
    const cx = sx + eye.cx, cy = oy + eye.cy;
    const r = eye.r;
    pushChunk(cx, cy, (c) => {
      c.fillStyle = "#fff";
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#111";
      c.beginPath();
      c.arc(0, 0, r * 0.55, 0, Math.PI * 2);
      c.fill();
    }, { speed: 110 + Math.random() * 90, spin: 16 });
  }
}

// Powerup enemies shatter into polygonal shards in their palette.
const POWERUP_PALETTES = {
  clear:  ["#151515", "#333333", "#ff7a28", "#ffb060", "#ffe090"],
  freeze: ["#eaf6ff", "#ffffff", "#a8dcf8", "#78c0e8", "#b8e0f0"],
  heal:   ["#ff5d7d", "#ff93a6", "#ffc0cf", "#d0304a", "#ffffff"],
};

function spawnPowerupExplosion(e) {
  const palette = POWERUP_PALETTES[e.powerup] || POWERUP_PALETTES.clear;
  const sx = e.x, sy = e.y;
  const count = 24;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 95 + Math.random() * 140;
    const size = 4 + Math.random() * 5;
    const sides = 3 + Math.floor(Math.random() * 3);  // 3–5
    const color = palette[Math.floor(Math.random() * palette.length)];
    const rot = Math.random() * Math.PI * 2;
    particles.push({
      x: sx, y: sy,
      vx: Math.cos(angle) * speed + (e.vx || 0) * 0.25,
      vy: Math.sin(angle) * speed - 60,
      gravity: 220,
      drag: 0.5,
      rot,
      rotV: (Math.random() - 0.5) * 14,
      life: 0,
      maxLife: 700 + Math.random() * 500,
      draw: (c) => {
        c.fillStyle = color;
        c.beginPath();
        for (let k = 0; k < sides; k++) {
          const a = (k / sides) * Math.PI * 2;
          const px = Math.cos(a) * size;
          const py = Math.sin(a) * size;
          if (k === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.closePath();
        c.fill();
      },
    });
  }
}

function updateParticles(dt) {
  if (particles.length === 0) return;
  const sec = dt / 1000;
  for (const p of particles) {
    p.life += dt;
    p.x += p.vx * sec;
    p.y += p.vy * sec;
    p.vy += p.gravity * sec;
    const damp = Math.exp(-p.drag * sec);
    p.vx *= damp;
    p.vy *= damp;
    p.rot += p.rotV * sec;
  }
  particles = particles.filter(p => p.life < p.maxLife);
}

function drawParticles(c) {
  if (particles.length === 0) return;
  for (const p of particles) {
    const t = 1 - p.life / p.maxLife;
    c.save();
    c.globalAlpha = Math.max(0, t);
    c.translate(p.x, p.y);
    c.rotate(p.rot);
    p.draw(c);
    c.restore();
  }
}

function clearParticles() { particles.length = 0; }
