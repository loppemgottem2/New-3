// Character movement, collisions against the grid map, and raycasts.
import { CONFIG } from './config.js?v=1030';
import { CELL, CEIL_H, WALL_H, ROOF_T } from './map.js?v=1030';
const ROOF_TOP = WALL_H + ROOF_T;      // top of the thick roof slab
const FIXTURE_H = 0.07;                // light fixtures hang this far below the ceiling
// Solid height of a cell for a body from feetY to feetY+H: the roof slab (CEIL_H..ROOF_TOP) over the
// building is solid for anyone up there (outside the rooms), but not for people inside below the ceiling.
function solidH(map, cx, cz, feetY, H) {
  const h = map.cellHeight(cx, cz);
  if (feetY + H > CEIL_H + 0.01 && map.roofedCell(cx, cz)) return Math.max(h, ROOF_TOP);
  return h;
}

const P = CONFIG.PLAYER;

// ---------------------------------------------------------------------
//  Collision footprint. A character's body is a set of circles in its own frame
//  ({x, z, r, y0, y1}: offset, radius, height band above the feet), turned with its yaw:
//  a normal person is one circle; a human prop also has its T-posed arms; a disguised prop
//  covers every part of its furniture (so a long crate is solid along its whole length).
// ---------------------------------------------------------------------
export function footWorld(ch, x = ch.x, z = ch.z, out = []) {
  out.length = 0;
  const foot = ch.foot;
  if (!foot) { out.push({ x, z, r: ch.shapeR || P.RADIUS, y0: 0, y1: ch.shapeH || P.HEIGHT }); return out; }
  const c = Math.cos(ch.yaw || 0), s = Math.sin(ch.yaw || 0);
  for (const f of foot) out.push({ x: x + f.x * c + f.z * s, z: z - f.x * s + f.z * c, r: f.r, y0: f.y0, y1: f.y1 });
  return out;
}
const _fw = [], _fw2 = [];
// push the whole footprint out of the walls (every circle at its own height band)
export function resolveFoot(map, pos, ch) {
  if (!ch.foot) { resolveWalls(map, pos, ch.shapeR || P.RADIUS, ch.y, ch.shapeH || P.HEIGHT); return; }
  const tmp = { x: 0, z: 0 };
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const f of footWorld(ch, pos.x, pos.z, _fw)) {
      tmp.x = f.x; tmp.z = f.z;
      resolveWalls(map, tmp, f.r, ch.y + f.y0, Math.max(0.05, f.y1 - f.y0));
      if (tmp.x !== f.x || tmp.z !== f.z) { pos.x += tmp.x - f.x; pos.z += tmp.z - f.z; moved = true; }
    }
    if (!moved) break;
  }
}
// how far (and which way) a must move to stop overlapping b (footprint against footprint)
export function footOverlap(a, ax, az, b, bx, bz) {
  let best = 0, nx = 0, nz = 0;
  for (const fa of footWorld(a, ax, az, _fw)) for (const fb of footWorld(b, bx, bz, _fw2)) {
    if (a.y + fa.y1 <= b.y + fb.y0 + 0.05 || b.y + fb.y1 <= a.y + fa.y0 + 0.05) continue;   // different heights
    let dx = fa.x - fb.x, dz = fa.z - fb.z, d = Math.hypot(dx, dz);
    const pen = fa.r + fb.r - d;
    if (pen <= best) continue;
    if (d < 1e-4) { dx = ax - bx || 1e-3; dz = az - bz; d = Math.hypot(dx, dz); }
    best = pen; nx = dx / d; nz = dz / d;
  }
  return best > 0 ? { pen: best, nx, nz } : null;
}

// ---------------------------------------------------------------------
//  Walls: push a circle (x,z,r) out of every cell that is taller than
//  the character can step onto.
// ---------------------------------------------------------------------
export function resolveWalls(map, pos, r, feetY, H = P.HEIGHT) {
  const maxH = feetY + 0.02; // no auto step-up: anything higher than your feet blocks you
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    const cx0 = Math.floor((pos.x - r) / CELL), cx1 = Math.floor((pos.x + r) / CELL);
    const cz0 = Math.floor((pos.z - r) / CELL), cz1 = Math.floor((pos.z + r) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (solidH(map, cx, cz, feetY, H) <= maxH) continue;
        const minX = cx * CELL, maxX = minX + CELL, minZ = cz * CELL, maxZ = minZ + CELL;
        const nx = Math.max(minX, Math.min(pos.x, maxX));
        const nz = Math.max(minZ, Math.min(pos.z, maxZ));
        let dx = pos.x - nx, dz = pos.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = r - d;
          pos.x += (dx / d) * push; pos.z += (dz / d) * push;
        } else {
          // center inside the cell: push out along the smallest axis
          const l = pos.x - minX, rr = maxX - pos.x, t = pos.z - minZ, b = maxZ - pos.z;
          const m = Math.min(l, rr, t, b);
          if (m === l) pos.x = minX - r; else if (m === rr) pos.x = maxX + r;
          else if (m === t) pos.z = minZ - r; else pos.z = maxZ + r;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// Highest surface (floor / solid furniture) under a circle that is at most `maxY` high.
export function groundHeightCells(map, x, z, r, maxY) {
  let g = 0;
  const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL);
  const cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    let h = map.cellHeight(cx, cz);
    if (maxY >= ROOF_TOP - 0.01 && map.roofedCell(cx, cz)) h = ROOF_TOP;     // standing on top of the roof
    if (h > g && h <= maxY) {
      const nx = Math.max(cx * CELL, Math.min(x, cx * CELL + CELL));
      const nz = Math.max(cz * CELL, Math.min(z, cz * CELL + CELL));
      if ((x - nx) ** 2 + (z - nz) ** 2 < r * r) g = h;
    }
  }
  return g;
}

// Same, but also counts the tops of physics props (you can stand on boxes, tables, tipped-over crates...)
export function groundHeight(map, x, z, r, maxY) {
  const g = groundHeightCells(map, x, z, r, maxY);
  return map.propSys ? Math.max(g, map.propSys.topAt(x, z, r, maxY)) : g;
}

// True if a circle at (x,z) does not overlap any blocking cell (used by bot path smoothing)
export function circleFree(map, x, z, r) {
  const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL);
  const cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    if (map.cellHeight(cx, cz) <= P.STEP_HEIGHT) continue;
    const nx = Math.max(cx * CELL, Math.min(x, cx * CELL + CELL));
    const nz = Math.max(cz * CELL, Math.min(z, cz * CELL + CELL));
    if ((x - nx) ** 2 + (z - nz) ** 2 < r * r) return false;
  }
  return true;
}

// ---------------------------------------------------------------------
//  Full movement step for a character (players AND bots use this).
//  input: { mx, mz } world-space wish direction (length 0..1), run, jump
//
//  Quake/Source-style: ground friction + acceleration toward the wish
//  direction, weak friction right after landing and strong air control
//  so you keep (and can build) momentum by jumping and strafing.
// ---------------------------------------------------------------------
function accelerate(ch, wx, wz, wishSpeed, accel, dt) {
  const cur = ch.vx * wx + ch.vz * wz;
  const add = wishSpeed - cur;
  if (add <= 0) return;
  const a = Math.min(accel * dt * Math.max(wishSpeed, 1), add);
  ch.vx += a * wx; ch.vz += a * wz;
}

export function moveCharacter(ch, input, dt, map) {
  let wl = Math.hypot(input.mx, input.mz);
  const moving = wl > 0.01;
  const wx = moving ? input.mx / wl : 0, wz = moving ? input.mz / wl : 0;
  wl = Math.min(1, wl);

  // Stamina
  let run = !!input.run && moving && !ch.exhausted;
  if (run) ch.stamina = Math.max(0, ch.stamina - P.STAMINA_DRAIN * dt);
  else ch.stamina = Math.min(P.STAMINA_MAX, ch.stamina + P.STAMINA_REGEN * dt);
  if (ch.stamina <= 0) ch.exhausted = true;
  if (ch.exhausted && ch.stamina >= P.STAMINA_RECOVER_AT) ch.exhausted = false;
  if (ch.exhausted) run = false;
  ch.running = run;
  const wishSpeed = (run ? P.RUN_SPEED : P.WALK_SPEED) * wl;

  ch.airT = ch.onGround ? 0 : (ch.airT || 0) + dt;
  ch.groundT = ch.onGround ? (ch.groundT || 0) + dt : 0;
  ch.landed = 0;

  if (ch.onGround) {
    // friction (reduced for a moment after landing -> chain jumps keep speed)
    const sp = Math.hypot(ch.vx, ch.vz);
    if (sp > 0) {
      const fr = ch.groundT < P.LAND_GRACE ? P.FRICTION * 0.15 : P.FRICTION;
      const drop = Math.max(sp, P.STOP_SPEED) * fr * dt;
      const ns = Math.max(0, sp - drop);
      ch.vx *= ns / sp; ch.vz *= ns / sp;
    }
    if (moving) accelerate(ch, wx, wz, wishSpeed, P.GROUND_ACCEL, dt);
  } else if (moving) {
    // air strafing: you can steer and slowly gain speed
    accelerate(ch, wx, wz, Math.min(wishSpeed, P.AIR_WISH_CAP), P.AIR_ACCEL, dt);
  }

  // jump buffer: a press shortly before landing still jumps the moment you touch down
  ch.jumpBuf = input.jump ? 0.15 : Math.max(0, (ch.jumpBuf || 0) - dt);
  // props can climb walls: pushing into a wall in the air, each jump kicks you higher (up to a limit)
  if (ch.wallJumpT > 0) ch.wallJumpT -= dt;
  // pushing into furniture or another player works like a wall too (climbT is set by those collisions)
  if (ch.climbT > 0) ch.climbT -= dt;
  const touching = ch.onWall || ch.climbT > 0;
  const wallJump = input.wallClimb && touching && !ch.onGround && moving && !(ch.wallJumpT > 0);   // no height limit: climb until the ceiling / wall top stops you
  if (ch.jumpBuf > 0 && (ch.onGround || wallJump)) {
    if (!ch.onGround) ch.wallJumpT = 0.3;
    ch.jumpBuf = 0;
    ch.vy = ch.onGround ? P.JUMP_SPEED : P.JUMP_SPEED * 0.85; ch.onGround = false; ch.jumped = true;
    // small forward boost when jumping while running (momentum)
    const sp = Math.hypot(ch.vx, ch.vz);
    if (sp > 1 && run) { const k = Math.min(P.MAX_SPEED, sp + P.JUMP_BOOST) / sp; ch.vx *= k; ch.vz *= k; }
  }
  // speed cap
  const hs = Math.hypot(ch.vx, ch.vz);
  if (hs > P.MAX_SPEED) { ch.vx *= P.MAX_SPEED / hs; ch.vz *= P.MAX_SPEED / hs; }
  ch.vy -= P.GRAVITY * dt;
  if (ch.vy < -40) ch.vy = -40;

  // Horizontal, in small sub-steps so we never tunnel through walls
  // disguised props collide with their furniture's size (shapeR / shapeH), people with the normal body
  const r = ch.shapeR || P.RADIUS;
  const H = ch.shapeH || P.HEIGHT;
  const travel = Math.hypot(ch.vx, ch.vz) * dt;
  const n = Math.max(1, Math.ceil(travel / 0.2));
  const pos = { x: ch.x, z: ch.z };
  for (let i = 0; i < n; i++) {
    pos.x += (ch.vx * dt) / n; pos.z += (ch.vz * dt) / n;
    resolveFoot(map, pos, ch);
  }
  // touching a wall while pushing into it (used for props sticking to / climbing walls)
  if (dt > 0 && moving) {
    const bx = ch.vx * dt - (pos.x - ch.x), bz = ch.vz * dt - (pos.z - ch.z);    // the part of the move the wall blocked
    ch.onWall = Math.hypot(bx, bz) > 0.002 && (bx * wx + bz * wz) > 0;
  } else ch.onWall = false;
  // Kill the part of the velocity that went into a wall (so you slide along it)
  if (dt > 0) {
    const realVx = (pos.x - ch.x) / dt, realVz = (pos.z - ch.z) / dt;
    if (Math.abs(realVx) < Math.abs(ch.vx) - 0.3) ch.vx = realVx;
    if (Math.abs(realVz) < Math.abs(ch.vz) - 0.3) ch.vz = realVz;
  }
  ch.x = pos.x; ch.z = pos.z;

  // Vertical
  const prevY = ch.y;
  const wasGround = ch.onGround;
  // friction against the wall: a prop pushing into a wall slides down slowly instead of falling
  if (input.wallClimb && (ch.onWall || ch.climbT > 0) && !ch.onGround && ch.vy < -P.WALL_SLIDE) ch.vy = -P.WALL_SLIDE;
  ch.y += ch.vy * dt;
  // auto step-up onto ledges only when walking or falling, never while rising in a jump
  // (so jumping into a table bumps/pushes it instead of snapping you up on top)
  // Step-up: only a tiny one (WALK_STEP, e.g. onto a mattress) while walking/running on the
  // ground. In the air you only land on surfaces your feet were already above, so to get
  // onto a table or crate you must jump.
  const g = groundHeight(map, ch.x, ch.z, r * 0.85, prevY + (wasGround ? P.WALK_STEP : 0.02));
  if (ch.y <= g) {
    if (!ch.onGround && ch.vy < -4) ch.landed = -ch.vy;
    ch.y = g; ch.vy = 0; ch.onGround = true;
  } else if (ch.onGround && ch.vy <= 0 && ch.y - g < 0.05) {
    ch.y = g; ch.vy = 0; // walk down small steps smoothly
  } else {
    ch.onGround = false;
  }
  // Ceiling
  // invisible thick ceiling over the open outdoor areas, level with the top of the roof
  if (map.isOutdoor(ch.x, ch.z) && ch.y + H > ROOF_TOP) { ch.y = ROOF_TOP - H; if (ch.vy > 0) ch.vy = 0; }
  // ceiling (and the light fixtures hanging from it) for anyone inside a room
  if (prevY + H <= CEIL_H + 0.05 && !map.isOutdoor(ch.x, ch.z)) {
    const top = map.underLight(ch.x, ch.z, r * 0.7) ? CEIL_H - FIXTURE_H : CEIL_H;
    if (ch.y + H > top) { ch.y = top - H; if (ch.vy > 0) ch.vy = 0; }
  }
  if (ch.y < -5) { ch.y = 0; } // safety
  ch.speed = Math.hypot(ch.vx, ch.vz);
}

// Keep a character out of props (per-part hitboxes). `amount` 0..1 = how much of the
// overlap to fix this frame (soft for humans so the host can push the prop).
export function pushOutOfProps(ch, map, amount = 1, push = false) {
  map.propSys?.collideChar(ch, amount, push);
}

// Push overlapping characters apart (soft). `movable(c)` says who may be moved.
export function separateCharacters(list, map, movable) {
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b.alive) continue;
      if (Math.abs(b.x - a.x) > 6 || Math.abs(b.z - a.z) > 6) continue;
      // footprints against footprints (arms, long furniture), only where their heights overlap
      const o = footOverlap(a, a.x, a.z, b, b.x, b.z);
      if (!o) continue;
      const push = o.pen * 0.5;
      const ma = movable(a), mb = movable(b);
      const fa = ma && mb ? 1 : ma ? 2 : 0, fb = ma && mb ? 1 : mb ? 2 : 0;
      a.x += o.nx * push * fa; a.z += o.nz * push * fa;
      b.x -= o.nx * push * fb; b.z -= o.nz * push * fb;
    }
  }
  for (const c of list) if (c.alive && movable(c)) {
    const p = { x: c.x, z: c.z }; resolveFoot(map, p, c); c.x = p.x; c.z = p.z;
  }
}

// ---------------------------------------------------------------------
//  Raycast through the grid (3D ray, 2D grid DDA with heights).
//  Returns distance to the first solid hit, or maxDist.
// ---------------------------------------------------------------------
export function raycastMap(map, ox, oy, oz, dx, dy, dz, maxDist) {
  let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx), adz = Math.abs(dz);
  const tDX = adx > 1e-9 ? CELL / adx : Infinity;
  const tDZ = adz > 1e-9 ? CELL / adz : Infinity;
  let tMX = adx > 1e-9 ? (dx > 0 ? (cx + 1) * CELL - ox : ox - cx * CELL) / adx : Infinity;
  let tMZ = adz > 1e-9 ? (dz > 0 ? (cz + 1) * CELL - oz : oz - cz * CELL) / adz : Infinity;
  const tFloor = dy < -1e-9 ? -oy / dy : Infinity;
  let t = 0;
  for (let guard = 0; guard < 512 && t < maxDist; guard++) {
    if (!map.inBounds(cx, cz)) return oy + dy * t > WALL_H ? maxDist : t;
    const tNext = Math.min(tMX, tMZ);
    const tEnd = Math.min(tNext, maxDist);
    const h = map.cellHeight(cx, cz);
    if (h > 0) {
      const y0 = oy + dy * t, y1 = oy + dy * tEnd;
      if (y0 < h) return t;
      if (y1 < h) return (h - oy) / dy;
    }
    if (dy > 0 && !map.isOutdoorCell(cx, cz) && oy + dy * t < CEIL_H) {
      const y1 = oy + dy * tEnd;
      // light fixtures hang below the ceiling
      const tf = (CEIL_H - FIXTURE_H - oy) / dy;
      if (tf >= t && tf <= tEnd && map.underLight(ox + dx * tf, oz + dz * tf)) return tf;
      if (y1 > CEIL_H) return Math.max(t, (CEIL_H - oy) / dy);
    }
    // the thick roof slab, from outside / above
    if (map.roofedCell(cx, cz)) {
      const y0 = oy + dy * t, y1 = oy + dy * tEnd;
      if (y0 >= CEIL_H && y0 <= ROOF_TOP && (y0 >= CEIL_H + 0.001 || dy <= 0)) return t;
      if (y0 > ROOF_TOP && y1 <= ROOF_TOP) return (ROOF_TOP - oy) / dy;
    }
    if (tFloor <= tEnd) return tFloor;
    t = tNext;
    if (tMX < tMZ) { tMX += tDX; cx += stepX; } else { tMZ += tDZ; cz += stepZ; }
  }
  return Math.min(t, maxDist);
}

// Line of sight between two points
export function hasLOS(map, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-3) return true;
  return raycastMap(map, ax, ay, az, dx / d, dy / d, dz / d, d) >= d - 0.05;
}

// Ray vs a list of capsules [ax,ay,az,bx,by,bz,r] (per-body-part hitboxes). Returns distance or -1.
export function rayVsCapsules(ox, oy, oz, dx, dy, dz, caps, pad = 0, offX = 0, offY = 0, offZ = 0) {
  let best = -1;
  for (const c of caps) {
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, c[0] + offX, c[1] + offY, c[2] + offZ, c[3] + offX, c[4] + offY, c[5] + offZ, c[6] + pad);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}
// which capsule a ray hits first: { t, i } (or null)
export function rayCapsuleIndex(ox, oy, oz, dx, dy, dz, caps, maxT = Infinity) {
  let best = null;
  caps.forEach((c, i) => {
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, c[0], c[1], c[2], c[3], c[4], c[5], c[6]);
    if (t >= 0 && t < maxT && (!best || t < best.t)) best = { t, i };
  });
  return best;
}

// standard ray-vs-capsule test (segment a-b, radius r); ray direction must be normalized
function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const sx = bx - ax, sy = by - ay, sz = bz - az;
  const oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = sx * sx + sy * sy + sz * sz;
  const sphere = (cx, cy, cz) => {
    const px = ox - cx, py = oy - cy, pz = oz - cz;
    const b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - r * r;
    const h = b * b - c;
    if (h < 0) return -1;
    const t = -b - Math.sqrt(h);
    return t >= 0 ? t : -1;
  };
  if (baba < 1e-9) return sphere(ax, ay, az);
  const bard = sx * dx + sy * dy + sz * dz, baoa = sx * oax + sy * oay + sz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz, oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard, B = baba * rdoa - baoa * bard, C = baba * oaoa - baoa * baoa - r * r * baba;
  if (Math.abs(A) > 1e-9) {
    const h = B * B - A * C;
    if (h < 0) return -1;
    const t = (-B - Math.sqrt(h)) / A, y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0) return t;
  }
  // ends of the capsule
  const t1 = sphere(ax, ay, az), t2 = sphere(bx, by, bz);
  if (t1 < 0) return t2;
  if (t2 < 0) return t1;
  return Math.min(t1, t2);
}

// Ray vs character cylinder. Returns distance or -1.
export function rayVsCharacter(ox, oy, oz, dx, dy, dz, ch, radius = 0.36) {
  const px = ox - ch.x, pz = oz - ch.z;
  const a = dx * dx + dz * dz;
  let t0 = -Infinity, t1 = Infinity;
  if (a > 1e-9) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    t0 = (-b - s) / (2 * a); t1 = (-b + s) / (2 * a);
  } else if (px * px + pz * pz > radius * radius) return -1;
  const y0 = ch.y, y1 = ch.y + P.HEIGHT;
  if (Math.abs(dy) > 1e-9) {
    let ta = (y0 - oy) / dy, tb = (y1 - oy) / dy;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  } else if (oy < y0 || oy > y1) return -1;
  if (t0 > t1 || t1 < 0) return -1;
  return Math.max(0, t0);
}

