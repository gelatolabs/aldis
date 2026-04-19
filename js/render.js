"use strict";

// Offscreen buffer for sprite lighting.
const litCanvas = document.createElement("canvas");
litCanvas.width = W;
litCanvas.height = H;
const litCtx = litCanvas.getContext("2d");

// Beam light profile, computed per-pixel once at startup. Two caches:
//   beamGlowCanvas:   warm colour, perpendicular gaussian × inverse-square
//                     along-axis — used as an additive backdrop reveal.
//   beamSpriteCanvas: alpha-only, flatter super-gaussian with NO along-axis
//                     falloff — used as a destination-in mask for sprites so
//                     a sprite sitting in the middle of the beam is fully
//                     opaque, only fading near the cone's perpendicular edge.
const MASK_HALF_H = BEAM_HALF_WIDTH * 3;

function buildMaskCanvas(colorR, colorG, colorB, intensityFn) {
  const c = document.createElement("canvas");
  c.width = BEAM_LEN;
  c.height = MASK_HALF_H * 2;
  const cc = c.getContext("2d");
  const img = cc.createImageData(c.width, c.height);
  const data = img.data;
  for (let along = 0; along < c.width; along++) {
    for (let y = 0; y < c.height; y++) {
      const perp = y - MASK_HALF_H;
      const intensity = intensityFn(along, perp);
      const a = Math.min(255, Math.round(intensity * 255));
      const idx = (y * c.width + along) * 4;
      data[idx]     = colorR;
      data[idx + 1] = colorG;
      data[idx + 2] = colorB;
      data[idx + 3] = a;
    }
  }
  cc.putImageData(img, 0, 0);
  return c;
}

const beamGlowCanvas = buildMaskCanvas(255, 245, 200, (along, perp) => {
  const bw = BEAM_NEAR_WIDTH + (BEAM_HALF_WIDTH - BEAM_NEAR_WIDTH) * (along / BEAM_LEN);
  const twoSigmaSq = 2 * (bw * 0.55) * (bw * 0.55);
  const perpFall = Math.exp(-(perp * perp) / twoSigmaSq);
  const r2 = along * along + perp * perp;
  const r0sq = 600 * 600;
  const alongFall = r0sq / (r0sq + r2);
  return perpFall * alongFall;
});

const beamSpriteCanvas = buildMaskCanvas(255, 255, 255, (along, perp) => {
  const bw = BEAM_NEAR_WIDTH + (BEAM_HALF_WIDTH - BEAM_NEAR_WIDTH) * (along / BEAM_LEN);
  const sigma = bw * 0.8;
  // Super-gaussian (exponent 6) — flat top in the cone interior, rapid but
  // smooth falloff near the edges.
  const u = (perp * perp) / (sigma * sigma);
  return Math.exp(-(u * u * u));
});

function render() {
  switch (currentScene) {
    case SCENE.splash:   drawSplash();   break;
    case SCENE.menu:     drawMenu();     break;
    case SCENE.settings: drawSettings(); break;
    case SCENE.credits:  drawCredits();  break;
    case SCENE.game:     drawGame();     break;
  }
}

// Radar-style radial grid — dim green concentric rings and spoke lines,
// centered at (cx, cy).
function drawRadarGrid(cx, cy) {
  const maxR = Math.hypot(
    Math.max(cx, W - cx),
    Math.max(cy, H - cy)
  );
  ctx.save();
  ctx.strokeStyle = "rgba(40,160,70,0.18)";
  ctx.lineWidth = 1;
  for (let r = 80; r <= maxR; r += 80) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(80,220,110,0.35)";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBackdrop(cx, cy) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  drawRadarGrid(cx, cy);
}

function drawGame() {
  drawBackdrop(lamp.x, lamp.y);

  drawBeamLight();    // illuminates backdrop and sprites within the cone
  drawEnemyWords();   // words revealed by radar or partial illumination
  drawDeathAnims();
  drawRadarDots();
  drawAlertDots();    // red flashing warning on enemies near the left edge
  drawAimLine();
  drawBeam();         // bright core wedge (lamp is drawn on top of its base)
  drawLamp();
  drawInputBuffer();
  drawMorseChart();
  drawHUD();
  drawHealth();
  if (gameOver) drawGameOver();
}

// ---- Splash ----

function drawSplash() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const a = splashAlpha();
  if (a <= 0 || !logoImg.complete || logoImg.naturalWidth === 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  const maxW = W * 0.5, maxH = H * 0.5;
  const scale = Math.min(maxW / logoImg.naturalWidth, maxH / logoImg.naturalHeight, 1);
  const dw = logoImg.naturalWidth * scale;
  const dh = logoImg.naturalHeight * scale;
  ctx.drawImage(logoImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// ---- Menu ----

function drawMenu() {
  drawBackdrop(W / 2, H / 2);

  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 72px 'Libertinus Mono', monospace";
  ctx.fillText("ALDIS", W / 2, 180);

  ctx.fillStyle = "#7a9";
  ctx.font = "16px 'Libertinus Mono', monospace";
  ctx.fillText(".- .-.. -.. .. ...", W / 2, 220);

  drawButtons();

  ctx.textAlign = "left";
}

// ---- Settings ----

function drawSettings() {
  drawBackdrop(lamp.x, lamp.y);

  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 36px 'Libertinus Mono', monospace";
  ctx.fillText("OPTIONS", W / 2, 110);

  ctx.fillStyle = "#9ab";
  ctx.font = "13px 'Libertinus Mono', monospace";
  ctx.fillText("scroll to preview", W / 2, 138);
  ctx.textAlign = "left";

  for (const s of sliders) drawSlider(s);

  // Lamp preview — lamp body + grey aim line, no beam / no enemies
  drawAimLine();
  drawLamp();

  drawButtons();

  // Helper text at bottom
  const lines = [
    "- A smooth mouse wheel, rotary encoder (knob), or trackpad is recommended",
    "  and generally doesn't need acceleration.",
    "- Acceleration is advised for regular notched mouse scroll wheels.",
    "- To use an encoder, bind it to scroll down (clockwise) and up (counter-clockwise).",
  ];
  ctx.fillStyle = "#7a9";
  ctx.font = "13px 'Libertinus Mono', monospace";
  ctx.textAlign = "left";
  let maxW = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  const startX = (W - maxW) / 2;
  const startY = H - 160;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], startX, startY + i * 18);
  }
}

function drawSlider(s) {
  ctx.fillStyle = "#cfd";
  ctx.font = "14px 'Libertinus Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillText(s.label, s.x, s.y - 10);
  ctx.textAlign = "right";
  ctx.fillStyle = "#9ab";
  ctx.fillText(s.format(settings[s.key]), s.x + s.w, s.y - 10);
  ctx.textAlign = "left";

  // Track
  ctx.fillStyle = "#18202a";
  ctx.fillRect(s.x, s.y, s.w, s.h);
  ctx.strokeStyle = "#334";
  ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);

  // Fill
  const t = (settings[s.key] - s.min) / (s.max - s.min);
  ctx.fillStyle = "#4a8";
  ctx.fillRect(s.x, s.y, s.w * t, s.h);

  // Thumb
  const tx = s.x + s.w * t;
  ctx.fillStyle = "#cfd";
  ctx.fillRect(tx - 4, s.y - 6, 8, s.h + 12);
  ctx.strokeStyle = "#000";
  ctx.strokeRect(tx - 4 + 0.5, s.y - 6 + 0.5, 8, s.h + 12);
}

// ---- Credits ----

function drawCredits() {
  drawBackdrop(W / 2, H / 2);

  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 42px 'Libertinus Mono', monospace";
  ctx.fillText("CREDITS", W / 2, 120);

  ctx.font = "18px 'Libertinus Mono', monospace";
  ctx.fillStyle = "#bcd";
  let y = 200;
  for (const line of CREDITS_LINES) {
    ctx.fillText(line, W / 2, y);
    y += 28;
  }

  ctx.textAlign = "left";
  drawButtons();
}

// ---- Buttons ----

function drawButtons() {
  for (const btn of currentButtons()) {
    ctx.fillStyle = "#15202e";
    ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
    ctx.strokeStyle = "#4a7a9a";
    ctx.lineWidth = 1;
    ctx.strokeRect(btn.x + 0.5, btn.y + 0.5, btn.w, btn.h);

    ctx.fillStyle = "#cfd";
    ctx.font = "bold 20px 'Libertinus Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }
}

function drawHealth() {
  const remaining = player.maxHealth - player.missed;
  const frac = Math.max(0, remaining / player.maxHealth);
  const barW = 14;
  const barH = 200;
  const x = 18;
  const y = lamp.y - barH / 2;

  ctx.fillStyle = "#9bd";
  ctx.font = "11px 'Libertinus Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText("HP", x + barW / 2 + 1, y - 8);
  ctx.textAlign = "left";

  ctx.fillStyle = "#1a0f14";
  ctx.fillRect(x, y, barW, barH);
  const fillH = barH * frac;
  const grad = ctx.createLinearGradient(0, y + barH - fillH, 0, y + barH);
  grad.addColorStop(0, "#ff8866");
  grad.addColorStop(1, "#ff3355");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y + barH - fillH, barW, fillH);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  for (let i = 1; i < player.maxHealth; i++) {
    const ty = y + (barH * i) / player.maxHealth;
    ctx.beginPath();
    ctx.moveTo(x, ty + 0.5);
    ctx.lineTo(x + barW, ty + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = "#556";
  ctx.strokeRect(x + 0.5, y + 0.5, barW, barH);
}

function drawLamp() {
  if (!lampImg.complete || lampImg.naturalWidth === 0) return;
  const w = lampImg.naturalWidth;
  const h = lampImg.naturalHeight;
  ctx.save();
  ctx.translate(lamp.x, lamp.y);
  ctx.rotate(lamp.angle);
  ctx.drawImage(lampImg, -w / 2, -h / 2);
  ctx.restore();
}

function drawAimLine() {
  const end = beamEndpoint(1600);
  const sx = lamp.x + Math.cos(lamp.angle) * 22;
  const sy = lamp.y + Math.sin(lamp.angle) * 22;
  ctx.save();
  ctx.strokeStyle = "rgba(200,200,210,0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.restore();
}

// The bright core of the beam — a slim wedge that narrows at the lens and
// widens slightly over distance. Drawn before the lamp so the lamp sprite
// hides the base.
function drawBeam() {
  if (lamp.beamTimer <= 0) return;
  const maxDur = lamp.beamKind === "dash" ? 220 : 80;
  const t = Math.max(0, lamp.beamTimer / maxDur);
  const end = beamEndpoint(1800);
  const { x: lensX, y: lensY } = beamLensPos();

  const nearHW = lamp.beamKind === "dash" ? 2 : 1.2;
  const farHW  = lamp.beamKind === "dash" ? 18 : 10;
  const px = -Math.sin(lamp.angle);
  const py =  Math.cos(lamp.angle);

  ctx.save();
  ctx.globalAlpha = t;
  const grad = ctx.createLinearGradient(lensX, lensY, end.x, end.y);
  grad.addColorStop(0, "rgba(255,245,160,0.95)");
  grad.addColorStop(1, "rgba(255,245,160,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(lensX + px * nearHW, lensY + py * nearHW);
  ctx.lineTo(end.x + px * farHW,  end.y + py * farHW);
  ctx.lineTo(end.x - px * farHW,  end.y - py * farHW);
  ctx.lineTo(lensX - px * nearHW, lensY - py * nearHW);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Per-enemy illumination. Returns the *best* cone coverage across the
// enemy's center and four corners, so an enemy with only its edge poking
// into the beam still reports as lit. 0 = dark, 1 = full light at center.
function enemyIllumination(e, lensX, lensY) {
  const ax = Math.cos(lamp.angle);
  const ay = Math.sin(lamp.angle);
  const t = ENEMY_TYPES[e.typeKey];
  const hw = t.w / 2, hh = t.h / 2;
  const pts = [
    e.x, e.y,
    e.x - hw, e.y - hh,
    e.x + hw, e.y - hh,
    e.x - hw, e.y + hh,
    e.x + hw, e.y + hh,
  ];
  let best = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i] - lensX, dy = pts[i + 1] - lensY;
    const along = dx * ax + dy * ay;
    if (along < 0 || along > BEAM_LEN) continue;
    const perp = Math.abs(-dx * ay + dy * ax);
    const halfWidth = BEAM_NEAR_WIDTH
      + (BEAM_HALF_WIDTH - BEAM_NEAR_WIDTH) * (along / BEAM_LEN);
    if (perp >= halfWidth) continue;
    const perpN = perp / halfWidth;
    const perpFall = (1 - perpN) * (1 - perpN);
    const alongFall = 1 - 0.4 * (along / BEAM_LEN);
    const v = perpFall * alongFall;
    if (v > best) best = v;
  }
  return best;
}

function beamIntensity() {
  if (lamp.beamTimer <= 0) return 0;
  const maxDur = lamp.beamKind === "dash" ? 220 : 80;
  return Math.max(0, lamp.beamTimer / maxDur);
}

function beamLensPos() {
  return {
    x: lamp.x + Math.cos(lamp.angle) * 22,
    y: lamp.y + Math.sin(lamp.angle) * 22,
  };
}

// Origin used for the beam cone: the back of the lamp sprite, so the cone
// converges behind the lamp and emerges through it with a bit of width.
const LAMP_BACK_OFFSET = 20;
function beamBackPos() {
  return {
    x: lamp.x - Math.cos(lamp.angle) * LAMP_BACK_OFFSET,
    y: lamp.y - Math.sin(lamp.angle) * LAMP_BACK_OFFSET,
  };
}

// Beam rendering uses the pre-computed per-pixel masks. Rotating +
// translating them to the back of the lamp does all the work — every pixel
// already carries its physically motivated intensity.
function drawBeamLight() {
  const bi = beamIntensity();
  if (bi <= 0) return;
  const { x: sx, y: sy } = beamBackPos();

  // Ambient glow: warm-coloured RGBA, additively blended.
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(lamp.angle);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = bi;
  ctx.drawImage(beamGlowCanvas, 0, -MASK_HALF_H);
  ctx.restore();

  drawShadows(bi);

  // Sprites lit by the beam: draw them onto litCanvas, then multiply by the
  // sprite mask's alpha via destination-in. The sprite mask is flat in the
  // cone interior so lit sprites are fully opaque until the cone edge.
  litCtx.clearRect(0, 0, W, H);
  for (const e of enemies) {
    if (!e.alive) continue;
    drawEnemySprite(litCtx, e);
  }
  litCtx.save();
  litCtx.translate(sx, sy);
  litCtx.rotate(lamp.angle);
  litCtx.globalCompositeOperation = "destination-in";
  litCtx.drawImage(beamSpriteCanvas, 0, -MASK_HALF_H);
  litCtx.restore();

  ctx.save();
  ctx.globalAlpha = bi;
  ctx.drawImage(litCanvas, 0, 0);
  ctx.restore();
}

// Project each sprite's silhouette in the direction away from the lamp to
// fake a cast shadow. Shadows are built on the offscreen canvas first so we
// can erase the portion that would fall behind a sprite — otherwise the
// shadow shows through the partially-transparent edge of the sprite.
function drawShadows(bi) {
  const SHADOW_OFFSET = 10;
  const alpha = 0.85 * bi;

  // Stage 1: draw all shadows on the offscreen canvas.
  litCtx.clearRect(0, 0, W, H);
  for (const e of enemies) {
    if (!e.alive) continue;
    const t = ENEMY_TYPES[e.typeKey];
    const img = sprites[t.sprite];
    const silh = getSilhouette(img);
    if (!silh) continue;
    const dx = e.x - lamp.x;
    const dy = e.y - lamp.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) continue;
    const nx = dx / d;
    const ny = dy / d;
    const ox = e.x + nx * SHADOW_OFFSET - t.w / 2;
    const oy = e.y + ny * SHADOW_OFFSET - t.h / 2;
    litCtx.drawImage(silh, ox, oy, t.w, t.h);
  }

  // Stage 2: punch out every sprite's footprint so the shadow never occupies
  // pixels the sprite will paint over.
  litCtx.save();
  litCtx.globalCompositeOperation = "destination-out";
  for (const e of enemies) {
    if (!e.alive) continue;
    const t = ENEMY_TYPES[e.typeKey];
    const img = sprites[t.sprite];
    const silh = getSilhouette(img);
    if (!silh) continue;
    litCtx.drawImage(silh, e.x - t.w / 2, e.y - t.h / 2, t.w, t.h);
  }
  litCtx.restore();

  // Stage 3: composite onto the main canvas. The litCanvas is cleared again
  // immediately afterward in drawBeamLight for the sprite lighting pass.
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(litCanvas, 0, 0);
  ctx.restore();
}

function drawEnemySprite(c, e) {
  const t = ENEMY_TYPES[e.typeKey];
  const img = sprites[t.sprite];
  const sx = e.x - t.w / 2, sy = e.y - t.h / 2;
  if (img && img.complete && img.naturalWidth > 0) {
    c.drawImage(img, sx, sy, t.w, t.h);
  } else {
    c.fillStyle = "#888";
    c.fillRect(sx, sy, t.w, t.h);
  }
  if (e.hitFlash > 0) {
    const tint = img && img.complete ? getHitTint(img) : null;
    if (tint) {
      c.save();
      c.globalAlpha = Math.min(0.6, e.hitFlash / 200);
      c.drawImage(tint, sx, sy, t.w, t.h);
      c.restore();
    }
  }
}

function enemyWordAlpha(e) {
  if (!e.alive) return 0;
  let a = 0;
  if (e.radarActive) a = Math.max(a, 1);
  else if (e.radarFade > 0) a = Math.max(a, e.radarFade / RADAR_FADE_MS);
  const bi = beamIntensity();
  if (bi > 0) {
    const { x: lx, y: ly } = beamLensPos();
    a = Math.max(a, enemyIllumination(e, lx, ly) * bi * 1.6);
  }
  return Math.min(1, a);
}

function drawEnemyWords() {
  ctx.font = "bold 22px 'Libertinus Mono', monospace";
  const bi = beamIntensity();
  const lens = bi > 0 ? beamLensPos() : null;
  for (const e of enemies) {
    const a = enemyWordAlpha(e);
    if (a <= 0.02) continue;
    const illum = lens ? enemyIllumination(e, lens.x, lens.y) * bi : 0;
    // If the enemy isn't actively tracked and isn't lit, freeze the word
    // where the radar dot froze.
    const useFrozen = !e.radarActive && illum <= 0.02;
    const anchorX = useFrozen ? e.radarX : e.x;
    const anchorY = useFrozen ? e.radarY : e.y;
    const t = ENEMY_TYPES[e.typeKey];
    const sy = anchorY - t.h / 2;
    const totalW = ctx.measureText(e.word).width;
    const startX = anchorX - totalW / 2;
    const y = sy - 10;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(startX - 6, y - 20, totalW + 12, 26);
    let cx = startX;
    ctx.textAlign = "left";
    for (let i = 0; i < e.word.length; i++) {
      const ch = e.word[i];
      if (i < e.typed) ctx.fillStyle = "#7cff7c";
      else if (i === e.typed) ctx.fillStyle = "#ffd34a";
      else ctx.fillStyle = "#dddddd";
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width;
    }
    ctx.restore();
  }
}

function drawDeathAnims() {
  for (const e of enemies) {
    if (e.alive || !e.deathAnim) continue;
    const t = e.deathAnim / 400;
    ctx.save();
    ctx.globalAlpha = t;
    ctx.fillStyle = "#ffcc55";
    ctx.beginPath();
    ctx.arc(e.x, e.y, 50 * (1 - t) + 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (e.deathPoints) {
      const ty = ENEMY_TYPES[e.typeKey];
      ctx.save();
      ctx.globalAlpha = t;
      ctx.font = "bold 22px 'Libertinus Mono', monospace";
      ctx.textAlign = "center";
      // Float upward slightly over the anim
      const y = e.y - ty.h / 2 - 10 - (1 - t) * 20;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      const label = "+" + e.deathPoints;
      const w = ctx.measureText(label).width;
      ctx.fillRect(e.x - w / 2 - 6, y - 20, w + 12, 26);
      ctx.fillStyle = "#7cff7c";
      ctx.fillText(label, e.x, y);
      ctx.restore();
    }
  }
}

function drawRadarDots() {
  // Hide when the lamp is lit.
  if (beamIntensity() > 0) return;
  for (const e of enemies) {
    if (!e.alive) continue;
    // Enemies close enough to get the red alert dot shouldn't also show a
    // green dot.
    if (e.x <= 260) continue;
    let a = 0;
    if (e.radarActive) a = 1;
    else if (e.radarFade > 0) a = e.radarFade / RADAR_FADE_MS;
    if (a <= 0.01) continue;
    radarPing(e.radarX, e.radarY, a);
  }
}

function drawAlertDots() {
  // Hide when the lamp is lit.
  if (beamIntensity() > 0) return;
  const ALERT_THRESHOLD = 260;
  const ESCAPE_X = 40;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e.x > ALERT_THRESHOLD) continue;
    const p = Math.max(0, Math.min(1,
      1 - (e.x - ESCAPE_X) / (ALERT_THRESHOLD - ESCAPE_X)));
    // Flash rate ramps up as the enemy closes in (≈0.5 Hz → ≈1.2 Hz).
    const rate = 0.5 + p * 0.7;
    const phase = (elapsed / 1000) * rate;
    if (Math.floor(phase) % 2 !== 0) continue;
    alertPing(e.x, e.y, 0.75 + 0.25 * p);
  }
}

function alertPing(x, y, alpha) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const outer = ctx.createRadialGradient(x, y, 0, x, y, 30);
  outer.addColorStop(0,    `rgba(255,120,120,${0.9 * alpha})`);
  outer.addColorStop(0.3,  `rgba(255,60,60,${0.5 * alpha})`);
  outer.addColorStop(1,    "rgba(255,0,0,0)");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(x, y, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255,230,230,${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function radarPing(x, y, alpha) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const outer = ctx.createRadialGradient(x, y, 0, x, y, 28);
  outer.addColorStop(0,    `rgba(160,255,160,${0.85 * alpha})`);
  outer.addColorStop(0.25, `rgba(60,220,100,${0.45 * alpha})`);
  outer.addColorStop(1,    "rgba(0,200,80,0)");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(x, y, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(220,255,220,${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawInputBuffer() {
  const display = inputMorse || lastLetterMorse;
  if (!display) return;
  const target = enemies.find(e => e.alive && e.radarActive)
              || enemies.find(e => e.deathAnim > 0);
  if (!target) return;
  const t = ENEMY_TYPES[target.typeKey];
  const sy = target.y - t.h / 2;
  ctx.font = "bold 24px 'Libertinus Mono', monospace";
  ctx.fillStyle = "rgba(255,220,120,0.95)";
  ctx.textAlign = "center";
  ctx.fillText(display, target.x, sy - 42);
  ctx.textAlign = "left";
}

function drawHUD() {
  ctx.font = "bold 20px 'Libertinus Mono', monospace";
  ctx.fillStyle = "#cfd";
  ctx.textAlign = "left";
  ctx.fillText("SCORE: " + score, 16, 28);
}

function drawMorseChart() {
  const cols = 4;
  const rows = Math.ceil(MORSE_ORDER.length / cols);
  const cellW = 108, cellH = 32;
  const padX = 18, padY = 14;
  const boxW = cellW * cols + padX * 2;
  const boxH = cellH * rows + padY * 2;
  const boxX = Math.floor((W - boxW) / 2);
  const boxY = Math.floor((H - boxH) / 2);

  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "#000";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = "#4a6a8a";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW, boxH);

  ctx.globalAlpha = 0.6;
  ctx.font = "bold 20px 'Libertinus Mono', monospace";
  for (let i = 0; i < MORSE_ORDER.length; i++) {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = boxX + padX + col * cellW;
    const y = boxY + padY + row * cellH + 24;
    const ch = MORSE_ORDER[i];
    ctx.fillStyle = "#bfe0ff";
    ctx.fillText(ch, x, y);
    ctx.fillStyle = "#8ab0d4";
    ctx.fillText(MORSE[ch], x + 24, y);
  }
  ctx.restore();
}

function drawGameOver() {
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#cfd";
  ctx.textAlign = "center";
  ctx.font = "bold 56px 'Libertinus Mono', monospace";
  ctx.fillText("SIGNAL LOST", W / 2, H / 2 - 20);
  ctx.fillStyle = "#ccd";
  ctx.font = "20px 'Libertinus Mono', monospace";
  ctx.fillText(`Score: ${score}`, W / 2, H / 2 + 20);
  ctx.fillText(`Click to return to menu`, W / 2, H / 2 + 50);
  ctx.textAlign = "left";
}
