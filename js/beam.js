"use strict";

function beamEndpoint(len = 1600) {
  const dx = Math.cos(lamp.angle);
  const dy = Math.sin(lamp.angle);
  return { x: lamp.x + dx * len, y: lamp.y + dy * len };
}

// All alive enemies whose bounding box (with a small buffer) the lamp's beam
// ray crosses. Used by inputs and the input-buffer renderer.
function enemiesHitByBeam() {
  const dx = Math.cos(lamp.angle);
  const dy = Math.sin(lamp.angle);
  const ox = lamp.x, oy = lamp.y;
  const hits = [];
  for (const e of enemies) {
    if (!e.alive) continue;
    const t = ENEMY_TYPES[e.typeKey];
    const hw = t.w / 2 + 4, hh = t.h / 2 + 4;
    const minX = e.x - hw, maxX = e.x + hw;
    const minY = e.y - hh, maxY = e.y + hh;
    let tmin = 0, tmax = Infinity;
    let hit = true;
    for (const [o, d, lo, hi] of [[ox, dx, minX, maxX], [oy, dy, minY, maxY]]) {
      if (Math.abs(d) < 1e-6) {
        if (o < lo || o > hi) { hit = false; break; }
      } else {
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) { hit = false; break; }
      }
    }
    if (hit && tmin >= 0) hits.push(e);
  }
  return hits;
}
