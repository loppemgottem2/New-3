// =====================================================================
//  BOTS.JS — bot brains for FIND THE THINGS. Runs only on the host.
//
//  PROP bots walk to some furniture during the hiding time, copy it
//  (turn into it) and then keep still. Clumsy ones fidget or panic and
//  run when a seeker comes close — moving furniture is a giveaway.
//
//  SEEKER bots wait blindfolded, then search the map. They shoot any
//  T-posing prop they see, grow suspicious of furniture that moves, and
//  now and then test a nearby piece of furniture with the knife or the
//  revolver (real furniture costs them health, so skilled seekers pick
//  better and stop guessing when they are low).
// =====================================================================
import { CONFIG } from './config.js?v=210';
import { rand, clamp, angleDiff, turnToward, yawTo, DEG } from './util.js?v=210';
import { moveCharacter, hasLOS, circleFree } from './physics.js?v=210';

const B = CONFIG.BOTS;
const P = CONFIG.PLAYER;
const W = CONFIG.WEAPONS;
const TM = CONFIG.TEAMS;

const weaponOf = (c) => {
  if (c.slot < 0) return 0;
  const it = c.hotbar[c.slot];
  return it === 'knife' && c.hasKnife ? 1 : it === 'revolver' && c.hasGun ? 2 : 0;
};
// put an item from the hotbar in hand (bots don't need the inventory screen)
function hold(c, item) {
  const k = c.hotbar.indexOf(item);
  if (k >= 0) c.slot = k;
}

export function initBrain(c) {
  const skill = Math.random(); // 0 = clumsy, 1 = expert (re-rolled every round)
  return {
    skill,
    state: 'wander',
    path: null, pi: 0, goal: null, repathT: 0,
    thinkT: rand(0, B.THINK_INTERVAL),
    waitT: rand(0, 2),
    lookT: 0, lookYaw: c.yaw,
    susp: new Map(),             // seekers: suspicion of each disguised prop player
    targetId: null,              // seekers: character being attacked
    targetProp: null,            // seekers: real prop being "tested"
    reactT: 0, shots: 0,
    hideProp: null,              // props: furniture we are walking to
    stuckT: 0, stuckCount: 0, lastPos: { x: c.x, z: c.z },
    blockT: 0, blockCount: 0, blockCalm: 0,
    scanT: 0, scanOff: 0,
    run: false, jump: false,
  };
}

function canSee(game, c, o, maxDist = B.VIEW_DISTANCE) {
  const dx = o.x - c.x, dz = o.z - c.z;
  const d = Math.hypot(dx, dz);
  if (d > maxDist) return false;
  if (d > B.CLOSE_SENSE) {
    const a = Math.abs(angleDiff(c.yaw, yawTo(dx, dz)));
    if (a > (B.FOV_DEG * DEG) / 2) return false;
  }
  return hasLOS(game.map, c.x, c.y + P.EYE, c.z, o.x, (o.y ?? 0) + 0.5, o.z);
}

function reactTime(b) {
  const base = B.REACTION_MAX * 1.3 + (B.REACTION_MIN * 0.75 - B.REACTION_MAX * 1.3) * b.skill;
  return base * rand(0.85, 1.15);
}

function setPath(game, c, b, gx, gz) {
  b.goal = { x: gx, z: gz };
  b.path = game.nav.findPath(c.x, c.z, gx, gz);
  b.pi = 0;
  b.repathT = 0.8;
  if (!b.path) b.goal = null;
}

export function updateBots(game, dt) {
  for (const c of game.chars.values()) {
    if (!c.isBot || !c.alive || !c.brain) continue;
    const b = c.brain;
    b.thinkT -= dt;
    if (b.thinkT <= 0) {
      b.thinkT = B.THINK_INTERVAL;
      if (c.team === 'seeker') thinkSeeker(game, c, b);
      else if (c.team === 'prop') thinkProp(game, c, b);
    }
    act(game, c, b, dt);
  }
}

// ---------------------------------------------------------------------
//  PROP bots
// ---------------------------------------------------------------------
function chooseHideProp(game, c, b) {
  const range = B.HIDE_RANGE * (0.35 + 0.65 * b.skill);
  const near = game.props.list.filter((p) => Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < range && p.top < 2.2);
  if (!near.length) return null;
  // skilled props like spots with several pieces of furniture (easier to blend in)
  let best = null, bs = -Infinity;
  for (let k = 0; k < 6; k++) {
    const p = near[(Math.random() * near.length) | 0];
    let crowd = 0;
    for (const o of game.props.list) if (o !== p && Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) < 4) crowd++;
    const taken = [...game.chars.values()].some((o) => o !== c && o.team === 'prop' && o.alive && Math.hypot(o.x - p.pos.x, o.z - p.pos.z) < 1.5);
    const sc = crowd * b.skill + Math.random() * 2 - (taken ? 5 : 0);
    if (sc > bs) { bs = sc; best = p; }
  }
  return best;
}

// a free spot right next to a prop, to stand on
function spotNear(game, p) {
  for (let k = 0; k < 10; k++) {
    const a = Math.random() * Math.PI * 2, r = p.r + rand(0.45, 0.9);
    const x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
    if (circleFree(game.map, x, z, P.RADIUS + 0.1)) return { x, z };
  }
  return { x: p.pos.x, z: p.pos.z };
}

function disguiseNear(game, c, b) {
  // copy the furniture we came for (skilled) or whatever is closest
  let p = b.hideProp;
  if (!p || Math.random() > 0.4 + 0.6 * b.skill || Math.hypot(p.pos.x - c.x, p.pos.z - c.z) > TM.DISGUISE_RANGE) {
    let bd = Infinity;
    for (const o of game.props.list) { const d = Math.hypot(o.pos.x - c.x, o.pos.z - c.z); if (d < bd) { bd = d; p = o; } }
    if (bd > TM.DISGUISE_RANGE) p = null;
  }
  if (p) game.hostAction(c, 'disguise', p.id);
  // turn like a real piece of furniture (skilled props copy its rotation)
  if (p && b.skill > 0.5) {
    const e = 2 * Math.atan2(p.quat.y, p.quat.w);
    c.yaw = e;
  }
}

function thinkProp(game, c, b) {
  if (game.phase !== 'pre' && game.phase !== 'play') { b.path = null; return; }
  b.run = false;
  // nearest visible seeker
  let threat = null, td = Infinity;
  for (const o of game.chars.values()) {
    if (!o.alive || o.team !== 'seeker') continue;
    const d = Math.hypot(o.x - c.x, o.z - c.z);
    if (d < td && hasLOS(game.map, c.x, c.y + 1, c.z, o.x, o.y + P.EYE, o.z)) { td = d; threat = o; }
  }

  if (b.state === 'flee') {
    b.run = true;
    if (!b.path) { b.state = 'hide'; b.hideProp = chooseHideProp(game, c, b); if (b.hideProp) { const s = spotNear(game, b.hideProp); setPath(game, c, b, s.x, s.z); } }
    return;
  }
  if (b.state === 'hidden') {
    if (!c.disguise && c.morphCd <= 0) disguiseNear(game, c, b);
    if (game.phase === 'play' && threat) {
      // clumsy props panic when a seeker gets close (and moving furniture gets noticed)
      const panic = td < B.PANIC_RANGE * (1.6 - b.skill) && Math.random() < (1 - b.skill) * 0.25;
      if (panic) {
        b.state = 'flee';
        const p = game.nav.randomPointNear(c.x, c.z, 10, 26);
        setPath(game, c, b, p.x, p.z);
      }
    } else if (game.phase === 'play' && Math.random() < (1 - b.skill) * 0.006) {
      // fidget: shuffle a little bit
      const p = game.nav.randomPointNear(c.x, c.z, 1, 3, 6);
      setPath(game, c, b, p.x, p.z);
      b.state = 'hide';
    }
    return;
  }
  // walking to a hiding spot
  b.state = 'hide';
  if (!b.hideProp) {
    b.hideProp = chooseHideProp(game, c, b);
    if (b.hideProp) { const s = spotNear(game, b.hideProp); setPath(game, c, b, s.x, s.z); }
    else { const p = game.nav.randomPointNear(c.x, c.z, 4, 20); setPath(game, c, b, p.x, p.z); }
  }
  b.run = game.phase === 'pre' && game.timeLeft < 12;
  const late = game.phase === 'play' || game.timeLeft < 3;
  if (!b.path || (late && b.hideProp && Math.hypot(b.hideProp.pos.x - c.x, b.hideProp.pos.z - c.z) < TM.DISGUISE_RANGE)) {
    b.path = null;
    disguiseNear(game, c, b);
    b.state = 'hidden';
  }
}

// ---------------------------------------------------------------------
//  SEEKER bots
// ---------------------------------------------------------------------
function thinkSeeker(game, c, b) {
  if (game.phase !== 'play') { b.path = null; b.state = 'wander'; return; }
  const I = B.THINK_INTERVAL;
  // look for props
  let spotted = null, sd = Infinity;
  for (const o of game.chars.values()) {
    if (!o.alive || o.team !== 'prop') continue;
    if (!canSee(game, c, o)) continue;
    const d = Math.hypot(o.x - c.x, o.z - c.z);
    if (!o.disguise) {
      // a T-posing person: obviously a prop
      b.susp.set(o.id, 100);
    } else {
      let s = b.susp.get(o.id) || 0;
      if (o.speed > 0.4) s += B.MOVE_SUSPICION * I * (0.4 + b.skill);              // furniture that moves!
      else if (d < B.CHECK_RANGE) s += B.STARE_SUSPICION * I * (0.2 + b.skill);   // "that chair wasn't there before…"
      b.susp.set(o.id, Math.min(100, s));
    }
    if ((b.susp.get(o.id) || 0) >= 100 && d < sd) { sd = d; spotted = o; }
  }
  for (const [id, v] of b.susp) if (v < 100) b.susp.set(id, Math.max(0, v - 2 * I));

  if (spotted && b.targetId !== spotted.id) {
    b.state = 'engage'; b.targetId = spotted.id; b.targetProp = null; b.reactT = reactTime(b); b.shots = 0;
    return;
  }
  if (b.state === 'engage') {
    const t = game.chars.get(b.targetId);
    if (b.targetProp) return;                                  // finishing a furniture test
    if (!t || !t.alive || (b.susp.get(t.id) || 0) < 60) { b.state = 'wander'; b.targetId = null; c.slot = -1; }
    return;
  }

  // now and then, test a nearby piece of furniture
  const careful = c.hp <= TM.WRONG_PROP_DAMAGE * (1 + 4 * b.skill);   // low health: stop guessing
  if (!careful && Math.random() < B.CHECK_CHANCE) {
    const cands = [];
    for (const p of game.props.list) {
      const d = Math.hypot(p.pos.x - c.x, p.pos.z - c.z);
      if (d < B.CHECK_RANGE && canSee(game, c, { x: p.pos.x, y: p.y, z: p.pos.z })) cands.push({ prop: p, w: 1 });
    }
    for (const o of game.chars.values()) {
      if (!o.alive || o.team !== 'prop' || !o.disguise) continue;
      const d = Math.hypot(o.x - c.x, o.z - c.z);
      if (d < B.CHECK_RANGE && canSee(game, c, o)) cands.push({ ch: o, w: 1 + 6 * b.skill * b.skill });
    }
    if (cands.length) {
      let r = Math.random() * cands.reduce((s, k) => s + k.w, 0);
      const pickd = cands.find((k) => (r -= k.w) <= 0) || cands[0];
      b.state = 'engage'; b.reactT = reactTime(b); b.shots = 0;
      if (pickd.ch) { b.targetId = pickd.ch.id; b.targetProp = null; b.susp.set(pickd.ch.id, 100); }
      else { b.targetId = null; b.targetProp = pickd.prop; }
      return;
    }
  }
  wanderThink(game, c, b);
}

function wanderThink(game, c, b) {
  b.run = false;
  b.state = 'wander';
  if (!b.path) {
    b.waitT -= B.THINK_INTERVAL;
    if (b.waitT <= 0) {
      // seekers search where props like to hide: next to furniture. Then stop and look around a while.
      let p = null;
      if (Math.random() < 0.45 + 0.45 * b.skill) {
        const near = game.props.list.filter((q) => { const d = Math.hypot(q.pos.x - c.x, q.pos.z - c.z); return d > 6 && d < 45; });
        if (near.length) { const q = near[(Math.random() * near.length) | 0]; p = spotNear(game, q); }
      }
      if (!p) p = game.nav.randomPointNear(c.x, c.z, 8, 40);
      setPath(game, c, b, p.x, p.z);
      b.waitT = rand(1.5, 4.5);
    }
  }
}

// ---------------------------------------------------------------------
//  Moving + aiming (every frame)
// ---------------------------------------------------------------------
function act(game, c, b, dt) {
  let mx = 0, mz = 0;
  let faceYaw = null, facePitch = 0;
  const frozen = c.team === 'seeker' && game.phase === 'pre';
  const target = game.chars.get(b.targetId);
  const tp = b.targetProp;

  if (b.state === 'engage' && ((target && target.alive) || tp)) {
    // ----- seeker attacking a prop (player or real furniture) -----
    const realX = tp ? tp.pos.x : target.x, realZ = tp ? tp.pos.z : target.z;
    const realY = tp ? tp.pos.y : target.y + (target.disguise ? 0.35 : 1.15);
    // Tracking: the bot aims at where it THINKS the target is. That point trails behind the real one,
    // catching up faster for skilled bots. Fast, jumpy, zig-zag movement leaves it behind -> misses.
    const key = tp ? 'p' + tp.id : 'c' + target.id;
    if (!b.trk || b.trk.key !== key) {
      const off = (1 - b.skill) * 0.8;
      b.trk = { key, x: realX + rand(-off, off), y: realY + rand(-off, off) * 0.5, z: realZ + rand(-off, off), vx: 0, vy: 0, vz: 0, jerk: 0 };
    }
    const tk = b.trk, follow = 1 - Math.exp(-(0.8 + 3.0 * b.skill) * dt);
    tk.x += (realX - tk.x) * follow; tk.y += (realY - tk.y) * follow; tk.z += (realZ - tk.z) * follow;
    if (target && !tp) {
      // how unpredictable the target is: sudden changes of speed / direction / jumping
      const ch = Math.hypot((target.vx || 0) - tk.vx, (target.vy || 0) - tk.vy, (target.vz || 0) - tk.vz);
      tk.jerk = tk.jerk * Math.exp(-dt * 1.5) + ch;
      tk.vx = target.vx || 0; tk.vy = target.vy || 0; tk.vz = target.vz || 0;
    }
    const tx = tk.x, ty = tk.y, tz = tk.z;
    const dx = realX - c.x, dz = realZ - c.z;
    const d = Math.hypot(dx, dz) || 0.01;
    const visible = hasLOS(game.map, c.x, c.y + P.EYE, c.z, realX, realY, realZ);
    // furniture in the way: don't waste a shot (and health) on it, move to get a clear line instead
    let blocked = false;
    if (target && !tp && visible) {
      const ex = c.x, ey = c.y + P.EYE, ez = c.z, lx = realX - ex, ly = realY - ey, lz = realZ - ez, ll = Math.hypot(lx, ly, lz) || 1;
      const ph = game.props.raycast(ex, ey, ez, lx / ll, ly / ll, lz / ll, ll - 0.4);
      blocked = !!ph;
    }
    faceYaw = yawTo(tx - c.x, tz - c.z);
    facePitch = Math.atan2(ty - (c.y + P.EYE), Math.hypot(tx - c.x, tz - c.z) || 0.01);
    const turn = B.TURN_SPEED * (0.55 + 0.9 * b.skill);
    c.yaw = turnToward(c.yaw, faceYaw, turn * dt);
    c.pitch += clamp(facePitch - c.pitch, -turn * dt, turn * dt);
    b.reactT -= dt;
    const err = Math.abs(angleDiff(c.yaw, faceYaw));
    // knife up close, revolver further away
    const useKnife = d < W.KNIFE_RANGE * 0.9 && c.hasKnife;
    hold(c, useKnife ? 'knife' : 'revolver');
    if (visible && !blocked && b.reactT <= 0 && c.attackCd <= 0 && game.phase === 'play') {
      if (useKnife && weaponOf(c) === 1 && err < 30 * DEG) {
        // a moving, dodging target is hard to stab: sometimes the swing just misses
        const miss = target && !tp ? Math.min(0.75, (target.speed || 0) * (0.09 - 0.04 * b.skill) + b.trk.jerk * 0.03 * (1.2 - 0.6 * b.skill)) : 0;
        if (Math.random() < miss) { c.attackCd = W.KNIFE_COOLDOWN; game.emit({ e: 'swing', id: c.id }); }
        else game.hostAction(c, 'attack');
        b.shots++;
      } else if (!useKnife && weaponOf(c) === 2 && err < (8 - 5 * b.skill) * DEG && d < 45) {
        // shot spread grows at longer range, while the bot moves, the faster the target moves,
        // the more erratic it is, and now and then just by bad luck (less often for skilled bots)
        let spread = B.AIM_SPREAD_DEG * DEG * (2.0 - 1.6 * b.skill) * rand(0.8, 1.2) * (1 + d / 25) * (c.speed > 1 ? 1.6 - 0.4 * b.skill : 1);
        if (target && !tp) {
          spread *= 1 + (target.speed || 0) * (0.45 - 0.2 * b.skill);                      // moving target
          spread *= 1 + Math.min(6, b.trk.jerk * 0.35) * (1.2 - 0.85 * b.skill);              // jumping / zig-zagging
        }
        if (Math.random() < 0.2 - 0.12 * b.skill) spread *= rand(2, 3.5);                 // a bad shot
        game.gunAttack(c, spread); b.shots++;
      }
      if (tp && b.shots > 0) { b.targetProp = null; b.state = 'wander'; c.slot = -1; }   // tested it, move on
    }
    // positioning: get closer if far / no sight
    if (!visible || blocked || d > 14) {
      b.repathT -= dt;
      if (!b.path || b.repathT <= 0) setPath(game, c, b, realX, realZ);
      const v = followPath(game, c, b);
      mx = v.x; mz = v.z;
      b.run = d > 10;
    } else if (d > 1.4 && (d < 5 || b.skill < 0.5)) {
      mx = dx / d; mz = dz / d; b.path = null;          // walk in for a stab
    } else b.path = null;
    // give up on a furniture test that takes too long
    b.engageT = (b.engageT || 0) + dt;
    if (b.engageT > 8) { b.engageT = 0; b.state = 'wander'; b.targetProp = null; b.targetId = null; c.slot = -1; }
  } else {
    b.engageT = 0;
    const v = followPath(game, c, b);
    mx = v.x; mz = v.z;
    if (!b.path && !c.disguise && c.team === 'seeker') {
      // idle seeker: look around
      b.lookT -= dt;
      if (b.lookT <= 0) { b.lookYaw = c.yaw + rand(-1.6, 1.6) * (1 + b.skill * 0.8); b.lookT = rand(1, 3) * (1 - 0.6 * b.skill); }
      c.yaw = turnToward(c.yaw, b.lookYaw, 2.5 * dt);
      c.pitch *= 0.95;
    }
  }

  // ----- someone standing in the way -----
  // Bots don't weave around people. They stop and wait; only after being blocked
  // BLOCKS_BEFORE_DETOUR times do they walk around (or pick somewhere else to go).
  if (mx || mz) {
    let blocker = null;
    for (const o of game.chars.values()) {
      if (o === c || !o.alive || o === target) continue;
      const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz);
      if (d > 1.05 || d < 1e-3 || Math.abs(o.y - c.y) > 1.2) continue;
      if ((dx * mx + dz * mz) / d > 0.6) { blocker = o; break; }
    }
    if (blocker) {
      mx = 0; mz = 0;                       // stand still
      b.blockT += dt; b.blockCalm = 0;
      if (b.blockT > B.BLOCK_WAIT) { b.blockT = 0; b.blockCount++; }
      if (b.blockCount >= B.BLOCKS_BEFORE_DETOUR) {
        b.blockCount = 0;
        // step around them: a waypoint to the free side, then carry on
        const dx = blocker.x - c.x, dz = blocker.z - c.z, d = Math.hypot(dx, dz) || 1;
        let side = null;
        for (const sgn of [1, -1]) {
          const sx = c.x + (dx / d) * 0.4 + (-dz / d) * 1.6 * sgn, sz = c.z + (dz / d) * 0.4 + (dx / d) * 1.6 * sgn;
          if (circleFree(game.map, sx, sz, P.RADIUS + 0.1)) { side = { x: sx, z: sz }; break; }
        }
        if (side && b.path) b.path.splice(b.pi, 0, side);
        else if (side) { b.path = [side]; b.pi = 0; }
        else { b.path = null; b.goal = null; b.waitT = 0; } // nowhere to go: pick a new destination
      }
    } else {
      b.blockT = 0;
      b.blockCalm += dt;
      if (b.blockCalm > 6) b.blockCount = 0;
    }
  }
  if (mx || mz) {
    let ax = 0, az = 0;
    // furniture: steer around tall props, hop over / onto low ones
    for (const p of game.props.list) {
      const dx = c.x - p.x, dz = c.z - p.z;
      const d = Math.hypot(dx, dz), R = p.r + P.RADIUS + 0.5;
      if (d > R || d < 1e-3) continue;
      if (c.y >= p.y + p.h - 0.2) continue; // already on top
      const ahead = -(dx * mx + dz * mz) / d;
      if (p.y + p.h - c.y <= 1.0 && ahead > 0.7 && d < p.r + 0.75 && c.onGround && Math.random() < 0.5) { b.jump = true; continue; }
      const k = (R - d) / R;
      ax += (dx / d) * k * 1.2; az += (dz / d) * k * 1.2;
      if (ahead > 0.5) { ax += -mz * 0.7 * k; az += mx * 0.7 * k; }
    }
    mx += ax; mz += az;
    const l = Math.hypot(mx, mz);
    if (l > 1e-3) { mx /= l; mz /= l; }
    // wall feeler: if heading into a wall, rotate the direction until clear
    if (!circleFree(game.map, c.x + mx * 0.55, c.z + mz * 0.55, P.RADIUS)) {
      for (const a of [0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = mx * ca - mz * sa, nz = mx * sa + mz * ca;
        if (circleFree(game.map, c.x + nx * 0.55, c.z + nz * 0.55, P.RADIUS)) { mx = nx; mz = nz; break; }
      }
    }
    // face where we walk (unless aiming)
    if (b.state !== 'engage') {
      // alert gun holders glance left/right while walking
      if (c.team === 'seeker' && b.skill > 0.5) {
        b.scanT -= dt;
        if (b.scanT <= -rand(0.8, 2.5) * (1.4 - b.skill)) { b.scanT = rand(0.4, 0.8); b.scanOff = rand(0.7, 1.3) * (Math.random() < 0.5 ? -1 : 1); }
      }
      c.yaw = turnToward(c.yaw, yawTo(mx, mz) + (b.scanT > 0 ? b.scanOff : 0), 7 * dt);
      c.pitch *= 0.9;
    }
  }

  // jump up to people standing on boxes / tables, and hop around when running scared
  if (target && target.alive && b.state === 'engage') {
    const dd = Math.hypot(target.x - c.x, target.z - c.z);
    if (target.y - c.y > 0.3 && dd < 2.6 && c.onGround) b.jump = true;
  }
  if (c.onGround && b.run && b.state === 'flee' && !c.disguise && Math.random() < B.JUMPINESS * dt) b.jump = true;
  if (c.onGround && b.state === 'wander' && b.path && Math.random() < 0.04 * dt) b.jump = true;
  if (frozen) { mx = 0; mz = 0; b.jump = false; }
  moveCharacter(c, { mx, mz, run: b.run, jump: b.jump }, dt, game.map);
  b.jump = false;

  // ----- stuck detection -----
  b.stuckT += dt;
  if (b.stuckT > 1.0) {
    const moved = Math.hypot(c.x - b.lastPos.x, c.z - b.lastPos.z);
    const wanted = Math.hypot(mx, mz) > 0.1;
    if (wanted && moved < 0.35) {
      b.stuckCount++;
      b.jump = true;
      if (b.goal) setPath(game, c, b, b.goal.x, b.goal.z);
      if (b.stuckCount > 2) { b.path = null; b.goal = null; b.stuckCount = 0; b.waitT = 0; }
    } else b.stuckCount = 0;
    b.lastPos.x = c.x; b.lastPos.z = c.z;
    b.stuckT = 0;
  }
}

// Returns a unit-ish direction toward the next waypoint (or 0 when done)
function followPath(game, c, b) {
  if (!b.path) return { x: 0, z: 0 };
  let wp = b.path[b.pi];
  while (wp && Math.hypot(wp.x - c.x, wp.z - c.z) < (b.pi === b.path.length - 1 ? 0.45 : 0.8)) {
    b.pi++;
    wp = b.path[b.pi];
  }
  if (!wp) { b.path = null; return { x: 0, z: 0 }; }
  const dx = wp.x - c.x, dz = wp.z - c.z;
  const d = Math.hypot(dx, dz) || 1;
  // slow down for the final waypoint
  const k = b.pi === b.path.length - 1 ? Math.min(1, d / 0.8 + 0.3) : 1;
  return { x: (dx / d) * k, z: (dz / d) * k };
}

