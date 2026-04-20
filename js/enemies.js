"use strict";

const ENEMY_TYPES = {
  fodder: { label: "Fodder", w: 48, h: 48, wordList: WORDS_3_4,  speedMul: 1.0 },
  heavy:  { label: "Heavy",  w: 48, h: 48, wordList: WORDS_5_6,  speedMul: 0.7 },
  runner: { label: "Runner", w: 48, h: 48, wordList: WORDS_2, speedMul: 1.9 },
};

function pickTypeKey() {
  const d = difficulty();
  const p0 = { fodder: 0.90, heavy: 0.05, runner: 0.05 };
  const p1 = { fodder: 0.35, heavy: 0.35, runner: 0.30 };
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

function spawnEnemy() {
  const typeKey = pickTypeKey();
  const type = ENEMY_TYPES[typeKey];
  const word = type.wordList[Math.floor(Math.random() * type.wordList.length)];
  const margin = 80;
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
  return seedOff + (animTime / 1000) * 2 * Math.PI * speed / STRIDE_PX;
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

// ---- Death explosion ----

let particles = [];

function spawnEnemyExplosion(e) {
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
