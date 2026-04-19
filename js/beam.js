"use strict";

function beamEndpoint(len = 1600) {
  const dx = Math.cos(lamp.angle);
  const dy = Math.sin(lamp.angle);
  return { x: lamp.x + dx * len, y: lamp.y + dy * len };
}

// Find the closest enemy whose bounding box intersects the lamp's beam ray.
function enemyHitByBeam() {
  const dx = Math.cos(lamp.angle);
  const dy = Math.sin(lamp.angle);
  const ox = lamp.x, oy = lamp.y;
  let best = null;
  let bestT = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const t = ENEMY_TYPES[e.typeKey];
    const hw = t.w / 2 + 4, hh = t.h / 2 + 4;
    const minX = e.x - hw, maxX = e.x + hw;
    const minY = e.y - hh, maxY = e.y + hh;
    let tmin = 0, tmax = Infinity;
    for (const [o, d, lo, hi] of [[ox, dx, minX, maxX], [oy, dy, minY, maxY]]) {
      if (Math.abs(d) < 1e-6) {
        if (o < lo || o > hi) { tmin = Infinity; break; }
      } else {
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) { tmin = Infinity; break; }
      }
    }
    if (tmin !== Infinity && tmin >= 0 && tmin < bestT) {
      bestT = tmin;
      best = e;
    }
  }
  return { enemy: best, t: bestT };
}
