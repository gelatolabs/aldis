"use strict";

const ENEMY_TYPES = {
  fodder: { label: "Fodder", w: 48, h: 48, wordList: WORDS_3_4,  speedMul: 1.0, sprite: "fodder" },
  heavy:  { label: "Heavy",  w: 48, h: 48, wordList: WORDS_5_6,  speedMul: 1.0, sprite: "heavy"  },
  runner: { label: "Runner", w: 48, h: 48, wordList: WORDS_FAST, speedMul: 1.9, sprite: "runner" },
};

const sprites = {};
for (const key of ["fodder", "heavy", "runner"]) {
  const img = new Image();
  img.src = "assets/" + key + ".png";
  sprites[key] = img;
}

// Cache a recolored copy of each sprite: uses the sprite's alpha channel
// to paint a single color inside the sprite's shape. Used for black
// silhouette shadows and the yellow hit-flash tint.
function getTinted(img, color, cacheKey) {
  if (!img.complete || img.naturalWidth === 0) return null;
  if (img[cacheKey]) return img[cacheKey];
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cc = c.getContext("2d");
  cc.drawImage(img, 0, 0);
  cc.globalCompositeOperation = "source-in";
  cc.fillStyle = color;
  cc.fillRect(0, 0, c.width, c.height);
  img[cacheKey] = c;
  return c;
}
function getSilhouette(img) { return getTinted(img, "#000",    "_silhouette"); }
function getHitTint(img)    { return getTinted(img, "#fff7aa", "_hitTint"); }

const lampImg = new Image();
lampImg.src = "assets/lamp.png";

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
  });
}
