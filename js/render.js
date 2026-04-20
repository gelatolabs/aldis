"use strict";

// Offscreen buffer for sprite lighting.
const litCanvas = document.createElement("canvas");
litCanvas.width = W;
litCanvas.height = H;
const litCtx = litCanvas.getContext("2d");

// Reused buffer for blurring the area behind the morse-chart glass panel.
const chartBlurCanvas = document.createElement("canvas");
const chartBlurCtx = chartBlurCanvas.getContext("2d");

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

const beamGlowCanvas = buildMaskCanvas(255, 248, 215, (along, perp) => {
  const bw = BEAM_NEAR_WIDTH + (BEAM_HALF_WIDTH - BEAM_NEAR_WIDTH) * (along / BEAM_LEN);
  const twoSigmaSq = 2 * (bw * 0.55) * (bw * 0.55);
  const perpFall = Math.exp(-(perp * perp) / twoSigmaSq);
  const r2 = along * along + perp * perp;
  const r0sq = 750 * 750;
  const alongFall = r0sq / (r0sq + r2);
  return perpFall * alongFall * 0.7;
});

const beamSpriteCanvas = buildMaskCanvas(255, 255, 255, (along, perp) => {
  const bw = BEAM_NEAR_WIDTH + (BEAM_HALF_WIDTH - BEAM_NEAR_WIDTH) * (along / BEAM_LEN);
  const sigma = bw * 0.8;
  // Super-gaussian (exponent 6) — flat top in the cone interior, rapid but
  // smooth falloff near the edges.
  const u = (perp * perp) / (sigma * sigma);
  return Math.exp(-(u * u * u));
});

// Render a morse string of dot and dash shapes.
function drawMorse(c, morse, x, y, size, color) {
  const dotR = size * 0.18;
  const dashW = size * 0.7;
  const dashH = size * 0.24;
  const gap = size * 0.25;
  c.save();
  c.fillStyle = color;
  let cx = x;
  let prev = null;
  for (const ch of morse) {
    if (ch === " ") { cx += size; prev = " "; continue; }
    if (prev === "." || prev === "-") cx += gap;
    if (ch === ".") {
      c.beginPath();
      c.arc(cx + dotR, y, dotR, 0, Math.PI * 2);
      c.fill();
      cx += dotR * 2;
    } else if (ch === "-") {
      c.fillRect(cx, y - dashH / 2, dashW, dashH);
      cx += dashW;
    }
    prev = ch;
  }
  c.restore();
  return cx - x;
}

function measureMorse(morse, size) {
  const dotR = size * 0.18;
  const dashW = size * 0.7;
  const gap = size * 0.25;
  let w = 0;
  let prev = null;
  for (const ch of morse) {
    if (ch === " ") { w += size; prev = " "; continue; }
    if (prev === "." || prev === "-") w += gap;
    if (ch === ".") w += dotR * 2;
    else if (ch === "-") w += dashW;
    prev = ch;
  }
  return w;
}

function render() {
  switch (currentScene) {
    case SCENE.splash:         drawSplash();          break;
    case SCENE.menu:           drawMenu();            break;
    case SCENE.settings:       drawSettings();        break;
    case SCENE.scores:         drawScoresScene();     break;
    case SCENE.credits:        drawCredits();         break;
    case SCENE.tutorial:       drawTutorial();        break;
    case SCENE.story:          drawStory();           break;
    case SCENE.storyText:      drawStoryText();       break;
    case SCENE.game:           drawGame();            break;
    case SCENE.highScoreEntry: drawHighScoreEntry();  break;
    case SCENE.leaderboard:    drawLeaderboardScene();break;
    case SCENE.matchmaking:    drawMatchmaking();     break;
    case SCENE.versusEnd:      drawVersusEnd();       break;
  }
  if (settings.postProcess) drawCrtOverlay();
}

// ---- CRT post-process ----
//
// Applied on top of every frame as a stack of cheap passes:
//   1. Bloom      — blurred copy of the current canvas composited with
//                   "lighter", so bright phosphors bleed into neighbours.
//   2. Chromatic  — a second blurred, hue-shifted copy offset sideways for
//      aberration   a faint RGB fringe.
//   3. Scanlines  — faint horizontal dark lines, every other row.
//   4. Phosphor   — animated grain (pre-rendered noise tiles cycled
//      grain        per-frame) to simulate granular phosphor texture.
//   5. Vignette   — radial darkening at the corners.
//   6. Flicker    — tiny time-varying brightness wobble.
const crtBuffer = document.createElement("canvas");
crtBuffer.width = W;
crtBuffer.height = H;
const crtBufferCtx = crtBuffer.getContext("2d");

// Faint horizontal scanline tile — single dark row every two rows.
const crtScanlines = document.createElement("canvas");
crtScanlines.width = 1;
crtScanlines.height = 2;
(function () {
  const c = crtScanlines.getContext("2d");
  c.fillStyle = "rgba(0,0,0,0.14)";
  c.fillRect(0, 0, 1, 1);
})();
let crtScanlinePattern = null;

// Noise tiles
const CRT_GRAIN_TILE_SIZE = 128;
const CRT_GRAIN_TILE_COUNT = 6;
const crtGrainTiles = [];
for (let f = 0; f < CRT_GRAIN_TILE_COUNT; f++) {
  const c = document.createElement("canvas");
  c.width = CRT_GRAIN_TILE_SIZE;
  c.height = CRT_GRAIN_TILE_SIZE;
  const cc = c.getContext("2d");
  const img = cc.createImageData(CRT_GRAIN_TILE_SIZE, CRT_GRAIN_TILE_SIZE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 128 + Math.floor((Math.random() - 0.5) * 140);
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  cc.putImageData(img, 0, 0);
  crtGrainTiles.push(c);
}
let crtGrainPatterns = null;

const crtVignette = document.createElement("canvas");
crtVignette.width = W;
crtVignette.height = H;
(function () {
  const c = crtVignette.getContext("2d");
  const cx = W / 2, cy = H / 2;
  const r = Math.hypot(cx, cy);
  const g = c.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 1.05);
  g.addColorStop(0,   "rgba(0,0,0,0)");
  g.addColorStop(0.7, "rgba(0,0,0,0.30)");
  g.addColorStop(1,   "rgba(0,0,0,0.85)");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
})();

function drawCrtOverlay() {
  // Bloom
  crtBufferCtx.clearRect(0, 0, W, H);
  crtBufferCtx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.3;
  ctx.filter = "blur(3px)";
  ctx.drawImage(crtBuffer, 0, 0);
  ctx.filter = "none";
  ctx.restore();

  // Chromatic aberration
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.18;
  ctx.filter = "blur(2px) hue-rotate(20deg)";
  ctx.drawImage(crtBuffer, 2, 0);
  ctx.filter = "none";
  ctx.restore();

  // Faint horizontal scanlines
  if (!crtScanlinePattern) {
    crtScanlinePattern = ctx.createPattern(crtScanlines, "repeat");
  }
  ctx.save();
  ctx.fillStyle = crtScanlinePattern;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Phosphor grain
  if (!crtGrainPatterns) {
    crtGrainPatterns = crtGrainTiles.map(t => ctx.createPattern(t, "repeat"));
  }
  const grainIdx = Math.floor(animTime / 55) % crtGrainPatterns.length;
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = crtGrainPatterns[grainIdx];
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Vignette
  ctx.drawImage(crtVignette, 0, 0);

  // Flicker
  const flicker = 0.04 + Math.sin(animTime * 0.006) * 0.05
                       + Math.sin(animTime * 0.04)  * 0.03;
  if (flicker > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = "rgba(255,255,255," + flicker.toFixed(3) + ")";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

function isMouseOver(r) {
  return mouseCanvasX >= r.x && mouseCanvasX <= r.x + r.w
      && mouseCanvasY >= r.y && mouseCanvasY <= r.y + r.h;
}

// Radar-style radial grid — dim green concentric rings and spoke lines,
// centered at (cx, cy).
function drawRadarGrid(cx, cy) {
  const maxR = Math.hypot(
    Math.max(cx, W - cx),
    Math.max(cy, H - cy)
  );
  ctx.save();
  ctx.strokeStyle = "#071d0d";
  ctx.lineWidth = 1;
  for (let r = 80; r <= maxR; r += 80) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
    const cosA = Math.cos(a), sinA = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + cosA * maxR, cy + sinA * maxR);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBackdrop(cx, cy) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  drawRadarGrid(cx, cy);
}

function drawGame() {
  drawBackdrop(lamp.x, lamp.y);

  drawAimLine();       // dashed reference line
  if (peerLamp.active) drawPeerAimLine();
  drawBeamLight();     // illuminates backdrop and sprites within the cone
  if (peerLamp.active) drawPeerBeamLight();
  drawEnemyWords();    // words revealed by radar or partial illumination
  drawDeathAnims();    // enemy death explosions
  drawRadarDots();     // green dots on enemies revealed by radar
  drawAlertDots();     // red flashing dots on enemies near the left edge
  drawLamp();          // player sprite
  if (peerLamp.active) drawPeerLamp();
  drawInputBuffer();   // morse input over enemies
  drawMorseChart();    // alphabet reference
  drawHUD();           // game UI
  drawHealth();        // health bar
  if (peerLamp.active && gameMode === "versus") drawPeerHealth();
  drawFreezeOverlay(); // blue ice powerup overlay
  if (gameOver) drawGameOver();
  if (currentScene === SCENE.game) drawTutorialFade();
}

function drawFreezeOverlay() {
  if (freezeTimer <= 0) return;
  ctx.save();
  const pulse = 0.10 + 0.04 * Math.sin(animTime * 0.005);
  ctx.fillStyle = "rgba(140,200,255," + pulse.toFixed(3) + ")";
  ctx.globalCompositeOperation = "lighter";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
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
  ctx.fillText("ALDIS", W / 2 + 3, 155);

  {
    const morse = ".- .-.. -.. .. ...";
    const size = 18;
    const w = measureMorse(morse, size);
    drawMorse(ctx, morse, W / 2 - w / 2, 180, size, "#7a9");
  }

  drawButtons();

  // Disconnect/notice banner.
  if (menuNotice && performance.now() < menuNoticeUntil) {
    const remaining = menuNoticeUntil - performance.now();
    const alpha = Math.min(1, remaining / 500);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.fillStyle = "#e0b0b0";
    ctx.font = "16px 'Libertinus Mono', monospace";
    ctx.fillText(menuNotice, W / 2, 220);
    ctx.restore();
  }

  ctx.textAlign = "left";
}

// ---- Settings ----

function drawSettings() {
  drawBackdrop(lamp.x, lamp.y);

  // Title — "Options" by default, "Paused" while mid-game.
  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 36px 'Libertinus Mono', monospace";
  ctx.fillText(paused ? "PAUSED" : "OPTIONS", W / 2, 60);

  // Display row
  ctx.textAlign = "left";
  ctx.fillStyle = "#cfd";
  ctx.font = "14px 'Libertinus Mono', monospace";
  ctx.fillText("DISPLAY", 240, DISPLAY_ROW_Y - 14);
  ctx.fillText("POST-PROCESSING", POST_START_X, DISPLAY_ROW_Y - 14);
  drawSegmentedButtons(displayButtons(), btn => settings.display === btn.key);
  drawSegmentedButtons(postProcessButtons(), btn => settings.postProcess === btn.key);

  // Calibration subheading
  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 22px 'Libertinus Mono', monospace";
  ctx.fillText("CALIBRATION", W / 2, 284);

  ctx.fillStyle = "#9ab";
  ctx.font = "13px 'Libertinus Mono', monospace";
  ctx.fillText("scroll to preview", W / 2, 306);
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
    "- To use an encoder, bind it to scroll (clockwise = down).",
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
  const startY = H - 180;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], startX, startY + i * 18);
  }
}

function drawSegmentedButtons(btns, isSelected) {
  for (const btn of btns) {
    const selected = isSelected(btn);
    const hovered = isMouseOver(btn);
    let fill, stroke;
    if (selected) {
      fill = hovered ? "#3a7a4c" : "#2a5a3a";
      stroke = hovered ? "#afffbf" : "#7fff9f";
    } else {
      fill = hovered ? "#1e3a2c" : "#15251c";
      stroke = hovered ? "#6acc8e" : "#4a9a6e";
    }
    ctx.fillStyle = fill;
    ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = (selected || hovered) ? 2 : 1;
    ctx.strokeRect(btn.x + 0.5, btn.y + 0.5, btn.w, btn.h);

    ctx.fillStyle = "#cfd";
    ctx.font = "15px 'Libertinus Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }
}

function drawSlider(s) {
  const hovered = sliderHit(s, mouseCanvasX, mouseCanvasY) || dragSlider === s;
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
  ctx.strokeStyle = hovered ? "#6a9ac0" : "#334";
  ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);

  // Fill
  const t = (settings[s.key] - s.min) / (s.max - s.min);
  ctx.fillStyle = hovered ? "#7fd0a8" : "#4a8";
  ctx.fillRect(s.x, s.y, s.w * t, s.h);

  // Thumb
  const tx = s.x + s.w * t;
  const tw = hovered ? 10 : 8;
  ctx.fillStyle = hovered ? "#fff" : "#cfd";
  ctx.fillRect(tx - tw / 2, s.y - 6, tw, s.h + 12);
  ctx.strokeStyle = "#000";
  ctx.strokeRect(tx - tw / 2 + 0.5, s.y - 6 + 0.5, tw, s.h + 12);
}

// ---- Credits ----

function drawScoresScene() {
  drawBackdrop(W / 2, H / 2);

  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 42px 'Libertinus Mono', monospace";
  ctx.fillText("HIGH SCORES", W / 2, 90);

  const boxW = 420, boxH = 410, boxY = 130;
  const gap = 24;
  const leftX  = W / 2 - boxW - gap / 2;
  const rightX = W / 2 + gap / 2;
  drawScoreboardBox("SURVIVAL", leftX,  boxY, boxW, boxH, topScores,     false);
  drawScoreboardBox("CO-OP",    rightX, boxY, boxW, boxH, topCoopScores, true);

  ctx.textAlign = "left";
  drawButtons();
}

// One scoreboard panel — used for both columns of the menu Scores screen and
// for the post-game leaderboard scene.
function drawScoreboardBox(title, boxX, boxY, boxW, boxH, list, wide) {
  ctx.fillStyle = "rgba(30,50,60,0.35)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = "#4a7a9a";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW, boxH);

  ctx.fillStyle = "#cfd";
  ctx.font = "bold 22px 'Libertinus Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText(title, boxX + boxW / 2, boxY + 32);

  ctx.font = (wide ? "16px" : "18px") + " 'Libertinus Mono', monospace";
  if (!list) {
    ctx.fillStyle = "#9ab";
    ctx.fillText("loading…", boxX + boxW / 2, boxY + boxH / 2);
    return;
  }
  if (list.length === 0) {
    ctx.fillStyle = "#9ab";
    ctx.fillText("no scores yet", boxX + boxW / 2, boxY + boxH / 2);
    return;
  }
  ctx.textAlign = "left";
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const y = boxY + 70 + i * 30;
    ctx.fillStyle = "#9ab";
    ctx.fillText(String(i + 1).padStart(2, " ") + ".", boxX + 22, y);
    ctx.fillStyle = "#cfd";
    ctx.fillText(row.name, boxX + 70, y);
    ctx.textAlign = "right";
    ctx.fillText(String(row.score), boxX + boxW - 22, y);
    ctx.textAlign = "left";
  }
}

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
    ctx.save();
    if (btn.disabled) ctx.globalAlpha = 0.35;
    const hovered = !btn.disabled && isMouseOver(btn);
    const danger = btn.variant === "danger";
    ctx.fillStyle = danger
      ? (hovered ? "#332626" : "#261c1c")
      : (hovered ? "#1e2e42" : "#15202e");
    ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
    ctx.strokeStyle = danger
      ? (hovered ? "#c89090" : "#8a6060")
      : (hovered ? "#7fbfff" : "#4a7a9a");
    ctx.lineWidth = hovered ? 2 : 1;
    ctx.strokeRect(btn.x + 0.5, btn.y + 0.5, btn.w, btn.h);

    ctx.fillStyle = danger ? "#e0b0b0" : "#b0d0e8";
    ctx.font = "bold 20px 'Libertinus Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.restore();
  }
}

function drawHealth() {
  const remaining = player.maxHealth - player.missed;
  const frac = Math.max(0, remaining / player.maxHealth);
  const barW = 14;
  const barH = gameMode === "coop" ? 320 : 200;
  // Place the bar on the same edge as the local lamp so the right-side
  // versus player's HP shows on the right.
  const x = lamp.x < W / 2 ? 18 : W - 18 - barW;
  const y = H / 2 - barH / 2;

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

// Procedural lamp sprite: top-down radar antenna with signal lamp protruding
// the dish. Stationary base with pivoting dish+lamp. Lens at local +22 aligns
// with beamLensPos.
function drawLamp() {
  // Stationary base
  ctx.save();
  ctx.translate(lamp.x, lamp.y);
  ctx.fillStyle = "#2a3038";
  ctx.fillRect(-13, -13, 26, 26);
  ctx.fillStyle = "#404a55";
  ctx.fillRect(-13, -13, 26, 2);
  ctx.strokeStyle = "#1a1f24";
  ctx.lineWidth = 1;
  ctx.strokeRect(-12.5, -12.5, 26, 26);
  ctx.fillStyle = "#5a6470";
  for (const [bx, by] of [[-9, -9], [9, -9], [-9, 9], [9, 9]]) {
    ctx.beginPath();
    ctx.arc(bx, by, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mounting hub
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#1c2128";
  ctx.fill();
  ctx.strokeStyle = "#4a5260";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Rotating arm
  ctx.save();
  ctx.translate(lamp.x, lamp.y);
  ctx.rotate(lamp.angle);

  // Pivot collar
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#3a424c";
  ctx.fill();
  ctx.strokeStyle = "#5a6470";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Yoke arm
  ctx.fillStyle = "#3a424c";
  ctx.fillRect(0, -3.5, 8, 7);
  ctx.fillStyle = "#525c68";
  ctx.fillRect(0, -3.5, 8, 1);

  // Dish — back half-ellipse with concave rim
  ctx.beginPath();
  ctx.ellipse(15, 0, 13, 24, 0, Math.PI / 2, 3 * Math.PI / 2, false);
  ctx.quadraticCurveTo(8, 0, 15, 24);
  ctx.closePath();
  // Radial gradient with off-centre highlight
  const dishGrad = ctx.createRadialGradient(4, -6, 2, 9, 4, 28);
  dishGrad.addColorStop(0,    "#8c98a6");
  dishGrad.addColorStop(0.35, "#586270");
  dishGrad.addColorStop(0.85, "#3a4350");
  dishGrad.addColorStop(1,    "#262d36");
  ctx.fillStyle = dishGrad;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "#7a8693";
  ctx.beginPath();
  ctx.ellipse(15, 0, 13, 24, 0, Math.PI / 2, 3 * Math.PI / 2, false);
  ctx.quadraticCurveTo(8, 0, 15, 24);
  ctx.stroke();
  // Subtle dark stripe along inner concave rim
  ctx.strokeStyle = "rgba(15, 20, 28, 0.55)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(15, -22);
  ctx.quadraticCurveTo(9.5, 0, 15, 22);
  ctx.stroke();

  // Concentric mesh rings on the dish surface
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(120, 134, 150, 0.4)";
  for (const k of [0.45, 0.75]) {
    ctx.beginPath();
    ctx.ellipse(15, 0, 13 * k, 24 * k, 0,
                Math.PI / 2, 3 * Math.PI / 2, false);
    ctx.stroke();
  }

  // Support struts from the dish to the lens
  ctx.strokeStyle = "#5a6470";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(14, -20);
  ctx.lineTo(27, -6);
  ctx.moveTo(14,  20);
  ctx.lineTo(27,  6);
  ctx.stroke();
  ctx.lineCap = "butt";

  // Signal lamp body
  ctx.beginPath();
  pathRoundedRect(ctx, 13, -7, 15, 14, 3);
  const bodyGrad = ctx.createLinearGradient(0, -7, 0, 7);
  bodyGrad.addColorStop(0,    "#7a8493");
  bodyGrad.addColorStop(0.45, "#586270");
  bodyGrad.addColorStop(1,    "#3c4654");
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#222831";
  ctx.stroke();

  // Lens collar
  ctx.beginPath();
  ctx.arc(28, 0, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#2a3038";
  ctx.fill();
  ctx.strokeStyle = "#5a6470";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Lens — lights up with beam
  const bi = beamIntensity();
  if (bi > 0) {
    ctx.beginPath();
    ctx.arc(28, 0, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#946e2c";
    ctx.fill();
    const a = 0.35 + bi * 0.65;
    const lensG = ctx.createRadialGradient(28, 0, 0, 28, 0, 9);
    lensG.addColorStop(0,    `rgba(255, 252, 225, ${a})`);
    lensG.addColorStop(0.5,  `rgba(255, 225, 140, ${a * 0.55})`);
    lensG.addColorStop(1,    "rgba(255, 200, 80, 0)");
    ctx.fillStyle = lensG;
    ctx.beginPath();
    ctx.arc(28, 0, 9, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(28, 0, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#3c4654";
    ctx.fill();
  }

  ctx.restore();
}

function drawAimLine() {
  const end = beamEndpoint(1600);
  const sx = lamp.x + Math.cos(lamp.angle) * 28;
  const sy = lamp.y + Math.sin(lamp.angle) * 28;
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

function drawPeerAimLine() {
  const cos = Math.cos(peerLamp.angle);
  const sin = Math.sin(peerLamp.angle);
  const sx = peerLamp.x + cos * 28;
  const sy = peerLamp.y + sin * 28;
  const ex = peerLamp.x + cos * 1600;
  const ey = peerLamp.y + sin * 1600;
  ctx.save();
  ctx.strokeStyle = "rgba(180,200,220,0.18)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.restore();
}

// Same beam pipeline as drawBeamLight, but driven by peerLamp state. Co-op:
// both beams illuminate the shared enemies. Versus: only the local beam
// illuminates enemies (the peer's beam light passes "through" the same scene
// since enemies are the same objects, which is fine).
function drawPeerBeamLight() {
  const bi = peerBeamIntensity();
  if (bi <= 0) return;
  const cos = Math.cos(peerLamp.angle);
  const sin = Math.sin(peerLamp.angle);
  const sx = peerLamp.x + cos * 28;
  const sy = peerLamp.y + sin * 28;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(peerLamp.angle);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = bi;
  ctx.drawImage(beamGlowCanvas, 0, -MASK_HALF_H);
  ctx.restore();

  // Sprite lighting from the peer's beam, mirroring drawBeamLight's pipeline.
  litCtx.clearRect(0, 0, W, H);
  for (const e of enemies) {
    if (!e.alive) continue;
    drawEnemySprite(litCtx, e);
  }
  litCtx.save();
  litCtx.translate(sx, sy);
  litCtx.rotate(peerLamp.angle);
  litCtx.globalCompositeOperation = "destination-in";
  litCtx.drawImage(beamSpriteCanvas, 0, -MASK_HALF_H);
  litCtx.restore();
  ctx.save();
  ctx.globalAlpha = bi;
  ctx.drawImage(litCanvas, 0, 0);
  ctx.restore();
}

function peerBeamIntensity() {
  if (peerLamp.beamTimer <= 0) return 0;
  const maxDur = peerLamp.beamKind === "dash" ? 220 : 80;
  return Math.max(0, peerLamp.beamTimer / maxDur);
}

// Variant of drawLamp anchored at peerLamp's position/angle, in a slightly
// cooler colour palette so the two players' lamps are easy to tell apart.
function drawPeerLamp() {
  ctx.save();
  ctx.translate(peerLamp.x, peerLamp.y);
  ctx.fillStyle = "#2a3340";
  ctx.fillRect(-13, -13, 26, 26);
  ctx.fillStyle = "#3f4c5a";
  ctx.fillRect(-13, -13, 26, 2);
  ctx.strokeStyle = "#1a1f24";
  ctx.lineWidth = 1;
  ctx.strokeRect(-12.5, -12.5, 26, 26);
  ctx.fillStyle = "#5a6d80";
  for (const [bx, by] of [[-9, -9], [9, -9], [-9, 9], [9, 9]]) {
    ctx.beginPath();
    ctx.arc(bx, by, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#1c2530";
  ctx.fill();
  ctx.strokeStyle = "#4a586a";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.translate(peerLamp.x, peerLamp.y);
  ctx.rotate(peerLamp.angle);

  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#3a4860";
  ctx.fill();
  ctx.strokeStyle = "#5a6d80";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#3a4860";
  ctx.fillRect(0, -3.5, 8, 7);
  ctx.fillStyle = "#52647c";
  ctx.fillRect(0, -3.5, 8, 1);

  ctx.beginPath();
  ctx.ellipse(15, 0, 13, 24, 0, Math.PI / 2, 3 * Math.PI / 2, false);
  ctx.quadraticCurveTo(8, 0, 15, 24);
  ctx.closePath();
  const dishGrad = ctx.createRadialGradient(4, -6, 2, 9, 4, 28);
  dishGrad.addColorStop(0,    "#8c9eb8");
  dishGrad.addColorStop(0.35, "#586a82");
  dishGrad.addColorStop(0.85, "#3a4658");
  dishGrad.addColorStop(1,    "#262d40");
  ctx.fillStyle = dishGrad;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "#7a8cae";
  ctx.beginPath();
  ctx.ellipse(15, 0, 13, 24, 0, Math.PI / 2, 3 * Math.PI / 2, false);
  ctx.quadraticCurveTo(8, 0, 15, 24);
  ctx.stroke();
  ctx.strokeStyle = "rgba(15, 20, 28, 0.55)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(15, -22);
  ctx.quadraticCurveTo(9.5, 0, 15, 22);
  ctx.stroke();

  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(120, 140, 170, 0.4)";
  for (const k of [0.45, 0.75]) {
    ctx.beginPath();
    ctx.ellipse(15, 0, 13 * k, 24 * k, 0,
                Math.PI / 2, 3 * Math.PI / 2, false);
    ctx.stroke();
  }

  ctx.strokeStyle = "#5a6d80";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(13, -17);
  ctx.lineTo(24, -6);
  ctx.moveTo(13,  17);
  ctx.lineTo(24,  6);
  ctx.stroke();
  ctx.lineCap = "butt";

  ctx.beginPath();
  pathRoundedRect(ctx, 13, -7, 15, 14, 3);
  const bodyGrad = ctx.createLinearGradient(0, -7, 0, 7);
  bodyGrad.addColorStop(0,    "#7a8aa8");
  bodyGrad.addColorStop(0.45, "#586a82");
  bodyGrad.addColorStop(1,    "#3c4658");
  ctx.fillStyle = bodyGrad;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#222831";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(28, 0, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#2a3340";
  ctx.fill();
  ctx.strokeStyle = "#5a6d80";
  ctx.lineWidth = 1;
  ctx.stroke();

  const bi = peerBeamIntensity();
  if (bi > 0) {
    ctx.beginPath();
    ctx.arc(28, 0, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#5a8eb0";
    ctx.fill();
    const a = 0.35 + bi * 0.65;
    const lensG = ctx.createRadialGradient(28, 0, 0, 28, 0, 9);
    lensG.addColorStop(0,    `rgba(220, 240, 255, ${a})`);
    lensG.addColorStop(0.5,  `rgba(160, 210, 255, ${a * 0.55})`);
    lensG.addColorStop(1,    "rgba(120, 180, 255, 0)");
    ctx.fillStyle = lensG;
    ctx.beginPath();
    ctx.arc(28, 0, 9, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(28, 0, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#3c4658";
    ctx.fill();
  }

  ctx.restore();
}

function drawPeerHealth() {
  // Mirror image of drawHealth — anchored to whichever edge the peer's lamp
  // sits on so the bars match the players' sides.
  const remaining = peerPlayer.maxHealth - peerPlayer.missed;
  const frac = Math.max(0, remaining / peerPlayer.maxHealth);
  const barW = 14;
  const barH = 200;
  const x = peerLamp.x < W / 2 ? 18 : W - 18 - barW;
  const y = H / 2 - barH / 2;

  ctx.fillStyle = "#9bd";
  ctx.font = "11px 'Libertinus Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText("HP", x + barW / 2 + 1, y - 8);
  ctx.textAlign = "left";

  ctx.fillStyle = "#1a0f14";
  ctx.fillRect(x, y, barW, barH);
  const fillH = barH * frac;
  const grad = ctx.createLinearGradient(0, y + barH - fillH, 0, y + barH);
  grad.addColorStop(0, "#8088ff");
  grad.addColorStop(1, "#3344dd");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y + barH - fillH, barW, fillH);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  for (let i = 1; i < peerPlayer.maxHealth; i++) {
    const ty = y + (barH * i) / peerPlayer.maxHealth;
    ctx.beginPath();
    ctx.moveTo(x, ty + 0.5);
    ctx.lineTo(x + barW, ty + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = "#556";
  ctx.strokeRect(x + 0.5, y + 0.5, barW, barH);
}

// ---- Matchmaking scene ----

function drawMatchmaking() {
  drawBackdrop(W / 2, H / 2);

  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 36px 'Libertinus Mono', monospace";
  const modeLabel = net.mode === "versus" ? "VERSUS" : "CO-OP";
  ctx.fillText(modeLabel, W / 2, 180);

  // Spinner
  const cx = W / 2, cy = H / 2;
  const r = 38;
  const t = animTime / 1000;
  const headOuter = t * 2.1;
  ctx.save();
  ctx.lineCap = "round";

  // Faint background ring.
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(120, 255, 160, 0.12)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Trail: short arc segments fading toward the tail.
  const segments = 14;
  const segLen = 0.10;
  for (let i = 0; i < segments; i++) {
    const a = headOuter - i * segLen;
    const f = 1 - i / segments;
    ctx.strokeStyle = `rgba(160, 255, 180, ${0.85 * f * f})`;
    ctx.lineWidth = 4 * (0.55 + 0.45 * f);
    ctx.beginPath();
    ctx.arc(cx, cy, r, a - segLen, a);
    ctx.stroke();
  }

  // Bright glow at the head.
  const hx = cx + Math.cos(headOuter) * r;
  const hy = cy + Math.sin(headOuter) * r;
  const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 12);
  glow.addColorStop(0, "rgba(220, 255, 220, 0.95)");
  glow.addColorStop(1, "rgba(120, 255, 160, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(hx, hy, 12, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Status line.
  const dotPhase = (Math.floor(t * 1.8) % 3) + 1;
  const status = net.status || "Waiting";
  ctx.font = "20px 'Libertinus Mono', monospace";
  ctx.fillStyle = "#9eb";
  ctx.fillText(status + ".".repeat(dotPhase), cx, cy + 80);

  drawButtons();
  ctx.textAlign = "left";
}

// ---- Versus end ----

function drawVersusEnd() {
  drawBackdrop(W / 2, H / 2);
  ctx.textAlign = "center";
  ctx.font = "bold 64px 'Libertinus Mono', monospace";
  ctx.fillStyle = versusWon ? "#7cff7c" : "#ff7c7c";
  ctx.fillText(versusWon ? "YOU WIN!" : "YOU LOSE!", W / 2, H / 2 - 10);
  drawButtons();
  ctx.textAlign = "left";
}

// Per-enemy illumination. Returns the *best* cone coverage across the
// enemy's center and four corners, so an enemy with only its edge poking
// into the beam still reports as lit. 0 = dark, 1 = full light at center.
// `angle` defaults to the local lamp's; pass peerLamp.angle to evaluate the
// peer's beam in multiplayer.
function enemyIllumination(e, lensX, lensY, angle) {
  const a = angle == null ? lamp.angle : angle;
  const ax = Math.cos(a);
  const ay = Math.sin(a);
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
    x: lamp.x + Math.cos(lamp.angle) * 28,
    y: lamp.y + Math.sin(lamp.angle) * 28,
  };
}

// Beam rendering uses the pre-computed per-pixel masks. Rotating +
// translating them to the lens does all the work — every pixel already carries
// its physically motivated intensity.
function drawBeamLight() {
  const bi = beamIntensity();
  if (bi <= 0) return;
  const { x: sx, y: sy } = beamLensPos();

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
  const SHADOW_OFFSET = 8;
  const alpha = 0.85 * bi;

  // Stage 1: draw silhouettes offset away from the lamp on the offscreen
  // canvas. The procedural sprite is rendered solid black at the offset.
  litCtx.clearRect(0, 0, W, H);
  for (const e of enemies) {
    if (!e.alive) continue;
    const dx = e.x - lamp.x;
    const dy = e.y - lamp.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) continue;
    const nx = dx / d;
    const ny = dy / d;
    drawEnemySilhouette(litCtx, e, "#000",
                        nx * SHADOW_OFFSET, ny * SHADOW_OFFSET);
  }

  // Stage 2: punch out every sprite's footprint so the shadow never occupies
  // pixels the sprite will paint over.
  litCtx.save();
  litCtx.globalCompositeOperation = "destination-out";
  for (const e of enemies) {
    if (!e.alive) continue;
    drawEnemySilhouette(litCtx, e, "#000", 0, 0);
  }
  litCtx.restore();

  // Stage 3: composite onto the main canvas. The litCanvas is cleared again
  // immediately afterward in drawBeamLight for the sprite lighting pass.
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(litCanvas, 0, 0);
  ctx.restore();
}

function peerLensPos() {
  return {
    x: peerLamp.x + Math.cos(peerLamp.angle) * 28,
    y: peerLamp.y + Math.sin(peerLamp.angle) * 28,
  };
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
  if (peerLamp.active) {
    const pbi = peerBeamIntensity();
    if (pbi > 0) {
      const { x: px, y: py } = peerLensPos();
      a = Math.max(a, enemyIllumination(e, px, py, peerLamp.angle) * pbi * 1.6);
    }
  }
  return Math.min(1, a);
}

const ALERT_THRESHOLD_X = 260;

function drawEnemyWords() {
  ctx.font = "bold 22px 'Libertinus Mono', monospace";
  const bi = beamIntensity();
  const lens = bi > 0 ? beamLensPos() : null;
  for (const e of enemies) {
    const a = enemyWordAlpha(e);
    if (a <= 0.02) continue;
    const illum = lens ? enemyIllumination(e, lens.x, lens.y) * bi : 0;
    // If the enemy isn't actively tracked and isn't lit, freeze the word
    // where the radar dot froze (unless close enough for red alert dot).
    const inAlertRange = e.x <= ALERT_THRESHOLD_X;
    const useFrozen = !inAlertRange && !e.radarActive && illum <= 0.02;
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
  drawParticles(ctx);
  for (const e of enemies) {
    if (e.alive || !e.deathAnim) continue;
    const t = e.deathAnim / 400;

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
    if (inLocalAlertZone(e)) continue;
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
  for (const e of enemies) {
    if (!e.alive) continue;
    if (!inLocalAlertZone(e)) continue;
    const p = alertDanger(e);
    // Flash rate ramps up as the enemy closes in (≈0.5 Hz → ≈1.2 Hz).
    const rate = 0.5 + p * 0.7;
    const phase = (elapsed / 1000) * rate;
    if (Math.floor(phase) % 2 !== 0) continue;
    alertPing(e.x, e.y, 0.75 + 0.25 * p, !!e.powerup);
  }
}

// In versus the right-side player's "alert zone" is mirrored — enemies at
// the right edge are the threat to them.
function localAlertEdge() {
  const isRight = gameMode === "versus" && net.role !== net.topRole;
  return {
    isRight,
    escape:    isRight ? W - 40                  : 40,
    threshold: isRight ? W - ALERT_THRESHOLD_X   : ALERT_THRESHOLD_X,
  };
}

function inLocalAlertZone(e) {
  const { isRight, threshold } = localAlertEdge();
  return isRight ? e.x >= threshold : e.x <= threshold;
}

function alertDanger(e) {
  const { escape, threshold } = localAlertEdge();
  const span = Math.abs(threshold - escape);
  const dist = Math.abs(e.x - escape);
  return Math.max(0, Math.min(1, 1 - dist / span));
}

function alertPing(x, y, alpha, blue) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const outer = ctx.createRadialGradient(x, y, 0, x, y, 30);
  if (blue) {
    outer.addColorStop(0,   `rgba(140,190,255,${0.9 * alpha})`);
    outer.addColorStop(0.3, `rgba(70,140,245,${0.5 * alpha})`);
    outer.addColorStop(1,   "rgba(40,100,220,0)");
  } else {
    outer.addColorStop(0,   `rgba(255,120,120,${0.9 * alpha})`);
    outer.addColorStop(0.3, `rgba(255,60,60,${0.5 * alpha})`);
    outer.addColorStop(1,   "rgba(255,0,0,0)");
  }
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(x, y, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = blue ? `rgba(230,240,255,${alpha})`
                       : `rgba(255,230,230,${alpha})`;
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
  // Same freeze/fade logic as drawEnemyWords.
  const size = 22;
  const bi = beamIntensity();
  const lens = bi > 0 ? beamLensPos() : null;
  for (const e of enemies) {
    const display = e.morse || e.lastMorse;
    if (!display) continue;
    const alpha = e.alive ? enemyWordAlpha(e)
                          : (e.deathAnim > 0 ? 1 : 0);
    if (alpha <= 0.02) continue;
    const illum = lens ? enemyIllumination(e, lens.x, lens.y) * bi : 0;
    const inAlertRange = e.x <= ALERT_THRESHOLD_X;
    const useFrozen = e.alive && !inAlertRange
                   && !e.radarActive && illum <= 0.02;
    const anchorX = useFrozen ? e.radarX : e.x;
    const anchorY = useFrozen ? e.radarY : e.y;
    const t = ENEMY_TYPES[e.typeKey];
    const sy = anchorY - t.h / 2;
    const w = measureMorse(display, size);
    ctx.save();
    ctx.globalAlpha = alpha;
    drawMorse(ctx, display, anchorX - w / 2, sy - 46, size,
              "rgba(255,220,120,0.95)");
    ctx.restore();
  }
}

function drawHUD() {
  ctx.textAlign = "left";
  const showPause = !netInMatch();
  if (showPause) {
    ctx.font = "13px 'Libertinus Mono', monospace";
    ctx.fillStyle = "#9ab";
    ctx.fillText("Press P to pause", 16, 22);
  }
  ctx.font = "bold 20px 'Libertinus Mono', monospace";
  ctx.fillStyle = "#cfd";
  ctx.fillText("SCORE: " + score, 16, showPause ? 46 : 28);

  if (netInMatch()) {
    ctx.font = "13px 'Libertinus Mono', monospace";
    ctx.fillStyle = "#9ab";
    const label = netPingMs + "ms" + (net.isHost ? " - HOST" : "");
    ctx.fillText(label, 16, H - 16);
  }
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

  // Refraction: snapshot the area behind the panel into a small buffer (with
  // a margin so the blur can sample slightly outside the panel) and stamp it
  // back through a blur filter, clipped to the panel rect.
  const m = 4;
  const bw = boxW + m * 2, bh = boxH + m * 2;
  if (chartBlurCanvas.width !== bw)  chartBlurCanvas.width  = bw;
  if (chartBlurCanvas.height !== bh) chartBlurCanvas.height = bh;
  chartBlurCtx.clearRect(0, 0, bw, bh);
  chartBlurCtx.drawImage(canvas, boxX - m, boxY - m, bw, bh, 0, 0, bw, bh);

  ctx.save();
  ctx.beginPath();
  ctx.rect(boxX, boxY, boxW, boxH);
  ctx.clip();
  ctx.filter = "blur(0.9px)";
  ctx.drawImage(chartBlurCanvas, boxX - m, boxY - m);
  ctx.filter = "none";
  ctx.restore();

  // Dark tint to keep the letters readable against the refracted background.
  ctx.fillStyle = "rgba(0,8,18,0.3)";
  ctx.fillRect(boxX, boxY, boxW, boxH);

  // Faint diagonal sheen — almost invisible until something behind it lights
  // up the area.
  const sheen = ctx.createLinearGradient(
    boxX, boxY, boxX + boxW, boxY + boxH);
  sheen.addColorStop(0,    "rgba(255,255,255,0.10)");
  sheen.addColorStop(0.5,  "rgba(255,255,255,0.02)");
  sheen.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(boxX, boxY, boxW, boxH);

  // Thin 1-pixel highlight along the top edge — the only "always-on" specular.
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(boxX + 0.5, boxY + 0.5);
  ctx.lineTo(boxX + boxW - 0.5, boxY + 0.5);
  ctx.stroke();

  // Outer border
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = "#4a6a8a";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW, boxH);
  ctx.globalAlpha = 1;

  // Morse alphabet
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
    drawMorse(ctx, MORSE[ch], x + 24, y - 7, 18, "#8ab0d4");
  }
  ctx.restore();
}

// Simple loading overlay shown after death while the leaderboard loads.
function drawGameOver() {
  ctx.fillStyle = "rgba(0,0,0,0.82)";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 48px 'Libertinus Mono', monospace";
  ctx.fillText("SIGNAL LOST", W / 2, H / 2 - 30);
  ctx.fillStyle = "#ccd";
  ctx.font = "20px 'Libertinus Mono', monospace";
  ctx.fillText("Score: " + score, W / 2, H / 2 + 5);
  ctx.fillStyle = "#9ab";
  ctx.font = "16px 'Libertinus Mono', monospace";
  ctx.fillText("loading scores…", W / 2, H / 2 + 40);
  ctx.textAlign = "left";
}

// Reference panel on the left of the entry scene: all 26 letters paired
// with their morse codes, so the player can look up a letter while typing.
function drawAlphabetPanel() {
  const panelX = 60, panelY = 150, panelW = 260, panelH = 410;
  ctx.fillStyle = "rgba(30,50,60,0.35)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "#4a7a9a";
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelW, panelH);

  ctx.fillStyle = "#cfd";
  ctx.font = "bold 18px 'Libertinus Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText("ALPHABET", panelX + panelW / 2, panelY + 28);

  const rows = 13;
  const cellH = 26;
  const colX = [panelX + 42, panelX + 155];
  ctx.font = "15px 'Libertinus Mono', monospace";
  ctx.textAlign = "left";
  for (let i = 0; i < MORSE_ORDER.length; i++) {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = colX[col];
    const y = panelY + 54 + row * cellH + 10;
    const ch = MORSE_ORDER[i];
    ctx.fillStyle = "#bfe0ff";
    ctx.fillText(ch, x, y);
    drawMorse(ctx, MORSE[ch], x + 20, y - 5, 13, "#8ab0d4");
  }
}

function drawHighScoreEntry() {
  drawBackdrop(W / 2, H / 2);

  // Header
  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 40px 'Libertinus Mono', monospace";
  ctx.fillText("SIGNAL LOST", W / 2, 60);
  ctx.fillStyle = "#ccd";
  ctx.font = "20px 'Libertinus Mono', monospace";
  const scoreLine = gameMode === "coop" ? "Total: " + score : "Score: " + score;
  ctx.fillText(scoreLine, W / 2, 92);

  let nhsY = 128;
  if (gameMode === "coop") {
    ctx.font = "16px 'Libertinus Mono', monospace";
    ctx.fillStyle = "#9ab";
    ctx.fillText("You: " + coopOwnScore + "    Them: " + coopPeerScore,
                 W / 2, 116);
    nhsY = 146;
  }

  ctx.fillStyle = "#ffd34a";
  ctx.font = "bold 22px 'Libertinus Mono', monospace";
  ctx.fillText("NEW HIGH SCORE", W / 2, nhsY);

  drawAlphabetPanel();

  if (gameMode === "coop") {
    drawHighScoreEntryCoop();
  } else {
    drawHighScoreEntrySolo();
  }

  drawButtons();
  ctx.textAlign = "left";
}

function drawHighScoreEntrySolo() {
  const panelCX = 770;
  const boxSize = 60, boxGap = 14;
  const totalBoxW = boxSize * 3 + boxGap * 2;
  const startX = panelCX - totalBoxW / 2;
  const boxY = 240;

  ctx.fillStyle = "#9ab";
  ctx.font = "14px 'Libertinus Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillText("enter your initials in morse", startX, 215);
  drawInitialsBoxes(startX, boxY, boxSize, boxGap, entryName, !nameSubmitted);

  const morse = inputMorse || lastLetterMorse;
  if (morse) {
    const size = 22;
    const w = measureMorse(morse, size);
    drawMorse(ctx, morse, panelCX - w / 2, boxY + boxSize + 22, size,
              "rgba(255,220,120,0.95)");
  }
}

function drawHighScoreEntryCoop() {
  // Two stacked rows: "YOU" (interactive) on top, "PARTNER" below.
  const panelCX = 770;
  const boxSize = 56, boxGap = 12;
  const totalBoxW = boxSize * 3 + boxGap * 2;
  const startX = panelCX - totalBoxW / 2;
  const youY = 200;
  const partY = 400;

  ctx.font = "14px 'Libertinus Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = "#9ab";
  ctx.fillText("YOU — enter your initials", startX, youY - 10);
  drawInitialsBoxes(startX, youY, boxSize, boxGap, coopOwnName, !coopOwnSubmitted);

  // Morse buffer under YOU boxes.
  if (!coopOwnSubmitted) {
    const morse = inputMorse || lastLetterMorse;
    if (morse) {
      const size = 20;
      const w = measureMorse(morse, size);
      drawMorse(ctx, morse, panelCX - w / 2, youY + boxSize + 18, size,
                "rgba(255,220,120,0.95)");
    }
  }

  ctx.font = "14px 'Libertinus Mono', monospace";
  ctx.fillStyle = "#9ab";
  ctx.fillText("PARTNER", startX, partY - 10);
  const partnerName = coopPeerSubmitted ? (coopPeerName || "___") : "";
  drawInitialsBoxes(startX, partY, boxSize, boxGap, partnerName, false, true);

  // Countdown if the timer is running.
  const secs = coopSecondPlayerSecondsLeft();
  if (secs !== null && secs > 0) {
    ctx.font = "16px 'Libertinus Mono', monospace";
    ctx.fillStyle = secs < 10 ? "#ff8866" : "#9ab";
    ctx.textAlign = "center";
    ctx.fillText(
      "auto-submit in " + Math.ceil(secs) + "s",
      panelCX, partY + boxSize + 30);
    ctx.textAlign = "left";
  }
}

function drawInitialsBoxes(startX, boxY, boxSize, boxGap, name, highlightCurrent, peerStyle) {
  ctx.textAlign = "center";
  for (let i = 0; i < 3; i++) {
    const x = startX + i * (boxSize + boxGap);
    const current = highlightCurrent && i === name.length && name.length < 3;
    ctx.fillStyle = "rgba(20,30,40,0.85)";
    ctx.fillRect(x, boxY, boxSize, boxSize);
    ctx.strokeStyle = current ? "#ffd34a" : (peerStyle ? "#3a5a7a" : "#4a7a9a");
    ctx.lineWidth = current ? 2 : 1;
    ctx.strokeRect(x + 0.5, boxY + 0.5, boxSize, boxSize);
    if (i < name.length) {
      const ch = name[i];
      ctx.fillStyle = peerStyle ? "#9bd" : "#cfd";
      ctx.font = "bold 32px 'Libertinus Mono', monospace";
      const m = ctx.measureText(ch);
      const asc = m.actualBoundingBoxAscent;
      const dsc = m.actualBoundingBoxDescent;
      const letterY = boxY + boxSize / 2 + (asc - dsc) / 2;
      ctx.fillText(ch, x + boxSize / 2, letterY);
    }
  }
  ctx.textAlign = "left";
}

function drawLeaderboardScene() {
  drawBackdrop(W / 2, H / 2);

  ctx.textAlign = "center";
  ctx.fillStyle = "#cfd";
  ctx.font = "bold 40px 'Libertinus Mono', monospace";
  ctx.fillText("SIGNAL LOST", W / 2, 60);
  ctx.fillStyle = "#ccd";
  ctx.font = "20px 'Libertinus Mono', monospace";
  const headLine = gameMode === "coop" ? "Total: " + score : "Score: " + score;
  ctx.fillText(headLine, W / 2, 92);

  let boxY = 130;
  if (gameMode === "coop") {
    ctx.font = "16px 'Libertinus Mono', monospace";
    ctx.fillStyle = "#9ab";
    ctx.fillText("You: " + coopOwnScore + "    Them: " + coopPeerScore,
                 W / 2, 116);
    boxY = 148;
  }

  const list = gameMode === "coop" ? topCoopScores : topScores;
  const title = gameMode === "coop" ? "CO-OP HIGH SCORES" : "HIGH SCORES";
  const boxX = W / 2 - 240, boxW = 480;
  const boxH = H - boxY - 90;
  drawScoreboardBox(title, boxX, boxY, boxW, boxH, list, gameMode === "coop");

  ctx.textAlign = "left";
  drawButtons();
}
