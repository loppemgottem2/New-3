// =====================================================================
//  BOTS.JS — bot brains. Runs only on the host.
//
//  Every bot has:
//   * eyes: field of view + line-of-sight raycasts (can't see through walls)
//   * suspicion (0-100) of every other person
//   * fear: makes them run away from knives, bodies, gunshots
//  Innocents wander, collect gun parts, flee danger, grab dropped guns.
//  Armed bots (sheriff / revolver) hunt whoever they saw doing murder.
//  The murderer bot acts innocent, picks isolated victims, avoids
//  witnesses, stabs or throws its knife, then escapes.
// =====================================================================
import { CONFIG } from './config.js';
import { rand, clamp, angleDiff, turnToward, yawTo, forwardX, forwardZ, DEG } from './util.js';
import { moveCharacter, hasLOS, circleFree } from './physics.js';

const B = CONFIG.BOTS;
const P = CONFIG.PLAYER;
const W = CONFIG.WEAPONS;

const weaponOf = (c) => (!c.equipped ? 0 : c.hasKnife ? 1 : c.hasGun ? 2 : 0);

export function initBrain(c) {
  const skill = Math.random(); // 0 = clumsy, 1 = expert (re-rolled every round)
  return {
    state: 'wander',
    path: null, pi: 0, goal: null, repathT: 0,
    thinkT: rand(0, B.THINK_INTERVAL),
    waitT: rand(0, 3),
    susp: new Map(),
    seenAt: new Map(),      // id -> time last seen
    fear: 0, threat: null, threatId: null,
    targetId: null, reactT: 0, lastSeenT: 0, lastSeenPos: null,
    huntT: rand(B.MURDER_FIRST_DELAY[0], B.MURDER_FIRST_DELAY[1]),
    escapeT: 0, holsterT: 0, frustration: 0,
    lastPos: { x: c.x, z: c.z }, stuckT: 0, stuckCount: 0, jump: false,
    seenCorpses: new Set(),
    lookT: rand(1, 3), lookYaw: c.yaw,
    collector: Math.random() < 0.2 + 0.75 * skill,   // smarter bystanders care more about gun parts
    skill,
    // how well this bot reads suspicious behaviour: skilled = good, clumsy = poor,
    // but about 1 in 5 clumsy bots happens to read people just as well
    insight: skill > 0.5 ? skill : (Math.random() < 0.2 ? rand(0.55, 0.95) : skill),
    fireOk: false,
    scanT: 0, scanOff: 0,
    blockT: 0, blockCount: 0, blockCalm: 0,
    hideWait: 0,
    brave: Math.random() < B.BRAVERY,
    run: false,
  };
}

// ---------------------------------------------------------------------
//  Perception helpers
// ---------------------------------------------------------------------
function canSee(game, c, o, maxDist = B.VIEW_DISTANCE) {
  const dx = o.x - c.x, dz = o.z - c.z;
  const d = Math.hypot(dx, dz);
  if (d > maxDist) return false;
  if (d > B.CLOSE_SENSE) {
    const a = Math.abs(angleDiff(c.yaw, yawTo(dx, dz)));
    if (a > (B.FOV_DEG * DEG) / 2) return false;
  }
  return hasLOS(game.map, c.x, c.y + P.EYE, c.z, o.x, (o.y ?? 0) + 1.2, o.z);
}

function witnesses(game, murderer, victim) {
  let n = 0;
  for (const o of game.chars.values()) {
    if (!o.alive || o === murderer || o === victim) continue;
    const d = Math.hypot(o.x - murderer.x, o.z - murderer.z);
    if (d > 24) continue;
    if (hasLOS(game.map, o.x, o.y + P.EYE, o.z, murderer.x, murderer.y + 1.2, murderer.z)) n++;
  }
  return n;
}

// Add suspicion as seen by this bot: good readers pick up more (and more reliably),
// poor readers pick up less and misjudge (random noise). Never reaches full certainty
// (100 is only for actually seeing a knife / a murder).
function gainSusp(b, id, amount) {
  const noise = 1 + (Math.random() * 2 - 1) * 0.8 * (1 - b.insight);
  const cur = b.susp.get(id) || 0;
  if (cur >= 95) return;
  b.susp.set(id, Math.min(95, cur + amount * (0.3 + 0.9 * b.insight) * noise));
}

// Watch one person's movement and update how suspicious they look.
function readBehaviour(game, c, b, o, I) {
  const sp = Math.hypot(o.vx || 0, o.vz || 0);
  if (sp < 0.8) return;
  // where is the crowd? (people far from it are outsiders)
  let sx = 0, sz = 0, n = 0;
  for (const v of game.chars.values()) { if (v.alive) { sx += v.x; sz += v.z; n++; } }
  const outsider = n > 2 && Math.hypot(o.x - sx / n, o.z - sz / n) > 14;
  for (const v of game.chars.values()) {
    if (v === o || v === c || !v.alive) continue;
    const dx = v.x - o.x, dz = v.z - o.z, dd = Math.hypot(dx, dz);
    if (dd > 5 || dd < 0.3) continue;
    const toward = ((o.vx || 0) * dx + (o.vz || 0) * dz) / (sp * dd);
    if (toward < 0.7) continue;
    // only "closing in" counts: the other person isn't walking along with them
    const vsp = Math.hypot(v.vx || 0, v.vz || 0);
    const together = vsp > 0.8 && ((o.vx || 0) * (v.vx || 0) + (o.vz || 0) * (v.vz || 0)) / (sp * vsp) > 0.8;
    if (together) continue;
    gainSusp(b, o.id, (5 - dd) * 3.4 * I * (dd < 1.6 ? 2.2 : 1) * (outsider ? 1.6 : 0.55));
  }
  // an outsider heading toward the group
  if (outsider) {
    const gx = sx / n - o.x, gz = sz / n - o.z, gd = Math.hypot(gx, gz) || 1;
    if (((o.vx || 0) * gx + (o.vz || 0) * gz) / (sp * gd) > 0.7) gainSusp(b, o.id, 2.5 * I);
  }
}

// reaction time: skilled bots react faster (with a little randomness)
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

function addSusp(b, id, v) {
  const cur = b.susp.get(id) || 0;
  b.susp.set(id, clamp(cur + v, 0, 100));
}

// ---------------------------------------------------------------------
//  Events from the game
// ---------------------------------------------------------------------
export function botsOnKill(game, victim, killer, cause) {
  for (const c of game.chars.values()) {
    if (!c.isBot || !c.alive || c === killer || c === victim) continue;
    const b = c.brain;
    if (!b) continue;
    const sawKiller = killer && killer.alive && canSee(game, c, killer, 34);
    const sawVictim = canSee(game, c, victim, 34);
    if (c.role === 'murderer') continue;
    if (sawKiller) {
      // shooting someone we already thought was the murderer is justified
      const justified = cause === 'gun' && (b.susp.get(victim.id) || 0) >= 70;
      if (!justified) {
        b.susp.set(killer.id, 100);
        b.threatId = killer.id; b.threat = { x: killer.x, z: killer.z };
        b.fear = 1;
        b.reactT = reactTime(b);
      }
    }
    if (sawVictim) {
      b.seenCorpses.add(victim.id);
      b.fear = Math.max(b.fear, 0.85);
      if (!b.threat) b.threat = { x: victim.x, z: victim.z };
    }
  }
  // murderer bot that got a kill: hide knife and get away
  if (killer && killer.isBot && killer.role === 'murderer' && killer.brain) {
    const b = killer.brain;
    b.targetId = null;
    b.state = 'escape';
    b.escapeT = rand(4, 7);
    b.holsterT = rand(0.5, 1.2);
    b.huntT = rand(B.MURDER_NEXT_DELAY[0], B.MURDER_NEXT_DELAY[1]);
    b.frustration = 0;
    const p = game.nav.fleePoint(killer.x, killer.z, victim.x, victim.z);
    setPath(game, killer, b, p.x, p.z);
  }
}

export function botsOnShot(game, shooter, hit) {
  for (const c of game.chars.values()) {
    if (!c.isBot || !c.alive || c === shooter || !c.brain) continue;
    const d = Math.hypot(c.x - shooter.x, c.z - shooter.z);
    if (d > 35) continue;
    const b = c.brain;
    if (c.role !== 'murderer') b.fear = Math.max(b.fear, 0.5);
    // turn toward the sound
    b.lookYaw = yawTo(shooter.x - c.x, shooter.z - c.z);
    b.lookT = 1.5;
    if (c.role !== 'murderer' && !b.threat) b.threat = { x: shooter.x, z: shooter.z };
  }
}

// ---------------------------------------------------------------------
//  Main update (every frame on the host)
// ---------------------------------------------------------------------
export function updateBots(game, dt) {
  const active = game.phase === 'play' || game.phase === 'pre';
  for (const c of game.chars.values()) {
    if (!c.isBot || !c.alive || !c.brain) continue;
    const b = c.brain;
    b.thinkT -= dt;
    if (b.thinkT <= 0) {
      b.thinkT = B.THINK_INTERVAL;
      if (active) perceive(game, c, b);
      if (c.role === 'murderer' && game.phase === 'play') thinkMurderer(game, c, b);
      else thinkInnocent(game, c, b, active);
    }
    act(game, c, b, dt);
  }
}

function perceive(game, c, b) {
  const I = B.THINK_INTERVAL;
  const now = game.time;
  for (const o of game.chars.values()) {
    if (o === c || !o.alive) continue;
    if (!canSee(game, c, o)) continue;
    b.seenAt.set(o.id, now);
    if (c.role !== 'murderer' && weaponOf(o) === 1) {
      // someone has a knife out!
      if ((b.susp.get(o.id) || 0) < 100) b.reactT = reactTime(b);
      b.susp.set(o.id, 100);
      b.threatId = o.id;
      b.threat = { x: o.x, z: o.z };
      b.fear = 1;
    }
    if (b.threatId === o.id) b.threat = { x: o.x, z: o.z };
    // gun holders judge body language: walking straight at someone (worse the closer),
    // and being an outsider who isn't part of the group but heads toward people
    if (c.hasGun && c.role !== 'murderer') readBehaviour(game, c, b, o, I);
  }
  // dead bodies
  if (c.role !== 'murderer') {
    for (const k of game.corpses) {
      if (b.seenCorpses.has(k.id)) continue;
      if (!canSee(game, c, { x: k.x, y: k.y - 0.9, z: k.z }, 26)) continue;
      b.seenCorpses.add(k.id);
      b.fear = Math.max(b.fear, 0.8);
      if (!b.threat) b.threat = { x: k.x, z: k.z };
      const fresh = game.time - k.t < 20;
      // people standing next to a fresh body look suspicious
      if (fresh) {
        for (const o of game.chars.values()) {
          if (o === c || !o.alive) continue;
          // skilled gun holders weigh "who was near the body" more heavily
          const weight = c.hasGun ? 0.6 + 0.8 * b.skill : 1;
          if (Math.hypot(o.x - k.x, o.z - k.z) < 5 && b.seenAt.get(o.id) === now) addSusp(b, o.id, B.CORPSE_SUSPICION * weight);
        }
      }
    }
  }
  // anyone hanging around near bodies keeps looking worse to a gun holder
  if (c.hasGun && c.role !== 'murderer') {
    for (const k of game.corpses) {
      if (game.time - k.t > 45 || !b.seenCorpses.has(k.id)) continue;
      for (const o of game.chars.values()) {
        if (o === c || !o.alive || b.seenAt.get(o.id) !== now) continue;
        const d = Math.hypot(o.x - k.x, o.z - k.z);
        if (d < 4) gainSusp(b, o.id, (4 - d) * 4 * I);
      }
    }
  }
  // decay
  for (const [id, v] of b.susp) {
    if (v >= 100) continue;
    b.susp.set(id, Math.max(0, v - B.SUSPICION_DECAY * I));
  }
  const t = game.chars.get(b.threatId);
  if (b.threatId != null && (!t || !t.alive)) { b.threatId = null; }
  const recentlySeen = b.threatId != null && now - (b.seenAt.get(b.threatId) || -99) < 5;
  if (!recentlySeen) b.fear = Math.max(0, b.fear - 0.12 * I);
  if (b.fear <= 0.05) b.threat = null;
}

// Most suspicious person this bot can currently see
function bestTarget(game, c, b, minSusp) {
  let best = null, bs = minSusp - 0.001;
  for (const [id, v] of b.susp) {
    if (v < bs) continue;
    const o = game.chars.get(id);
    if (!o || !o.alive || o === c) continue;
    if (game.time - (b.seenAt.get(id) || -99) > 4) continue;
    best = o; bs = v;
  }
  return best;
}

function thinkInnocent(game, c, b, active) {
  const nav = game.nav;
  // ---- armed: fight ----
  if (active && c.hasGun && game.phase === 'play') {
    const t = bestTarget(game, c, b, B.DRAW_SUSPICION);
    if (t) {
      if (b.targetId !== t.id) { b.reactT = reactTime(b); b.fireOk = false; }
      b.targetId = t.id;
      // decide to pull the trigger: certain (saw a knife / a murder) -> yes.
      // Otherwise a chance that grows with suspicion; good readers commit far more often,
      // clumsy ones rarely (and when they do, it's often the wrong person)
      const sus = b.susp.get(t.id) || 0;
      if (sus >= 100) b.fireOk = true;
      else if (!b.fireOk && Math.random() < clamp((sus - 55) / 35, 0, 1) * (0.08 + 0.7 * b.insight) * B.THINK_INTERVAL) b.fireOk = true;
      b.state = 'engage';
      if (!c.equipped) game.hostAction(c, 'equip');
      return;
    }
    if (b.state === 'engage') {
      // lost sight: go to where we last saw them
      const o = game.chars.get(b.targetId);
      if (o && o.alive && ((b.susp.get(o.id) || 0) >= B.SHOOT_SUSPICION || b.fireOk)) {
        b.state = 'hunt';
        setPath(game, c, b, o.x, o.z);
      } else { b.state = 'wander'; b.targetId = null; }
    }
    if (b.state === 'hunt') {
      if (!b.path) { b.state = 'wander'; b.holsterT = 6; }
      return;
    }
    if (c.equipped && b.state !== 'engage') {
      b.holsterT -= B.THINK_INTERVAL;
      if (b.holsterT <= 0) { game.hostAction(c, 'equip'); b.holsterT = rand(3, 6); }
    }
  }

  // ---- scared: run away ----
  if (active && b.fear > 0.3 && b.threat) {
    const farFromThreat = Math.hypot(c.x - b.threat.x, c.z - b.threat.z) > 22;
    if (b.state !== 'flee' || !b.path || (farFromThreat && b.fear < 0.6)) {
      if (!(farFromThreat && b.state === 'flee' && b.path)) {
        const p = nav.fleePoint(c.x, c.z, b.threat.x, b.threat.z);
        setPath(game, c, b, p.x, p.z);
        b.state = 'flee';
      }
    }
    b.run = true;
    return;
  }

  // ---- brave: pick up a dropped gun ----
  if (active && !c.hasGun && c.role !== 'murderer' && b.brave) {
    for (const it of game.items.values()) {
      if (it.type !== 'gun' || it.flying) continue;
      const d = Math.hypot(it.x - c.x, it.z - c.z);
      if (d < 35) {
        if (b.state !== 'getgun' || !b.path) { setPath(game, c, b, it.x, it.z); b.state = 'getgun'; }
        b.run = d > 6;
        return;
      }
    }
  }
  if (b.state === 'getgun') b.state = 'wander';

  // ---- collect gun parts ----
  if (active && b.collector && game.craftedBy == null && !c.hasGun && c.role !== 'murderer') {
    const set = game.partsCollected.get(c.id);
    let best = -1, bd = 12 + 34 * b.skill;   // smart bots will cross the map for parts
    game.partSpots.forEach((s, k) => {
      if (set && set.has(k)) return;
      const d = Math.hypot(s.x - c.x, s.z - c.z);
      if (d < bd) { bd = d; best = k; }
    });
    if (best >= 0) {
      const s = game.partSpots[best];
      if (b.state !== 'collect' || !b.goal || Math.hypot(b.goal.x - s.x, b.goal.z - s.z) > 0.5 || !b.path) {
        setPath(game, c, b, s.x, s.z);
        b.state = 'collect';
      }
      b.run = b.skill > 0.6 && c.stamina > 30;   // smart bots hurry to the parts
      return;
    }
  }
  if (b.state === 'collect') b.state = 'wander';

  // ---- personal space: smart bystanders (and especially gun holders) don't let anyone get too close ----
  if (active && c.role !== 'murderer') {
    const armed = c.hasGun;
    const wantSpace = armed ? b.skill > 0.35 : b.skill > 0.55;
    if (wantSpace) {
      const R = armed ? 2.6 + 2.2 * b.skill : 1.8 + 1.2 * b.skill;
      let near = null, nd = R;
      for (const o of game.chars.values()) {
        if (o === c || !o.alive) continue;
        const d = Math.hypot(o.x - c.x, o.z - c.z);
        if (d < nd) { nd = d; near = o; }
      }
      if (near && b.state !== 'space') {
        // step back to a spot well away from them (but not off into nowhere)
        let best = null, bs = -Infinity;
        for (let k = 0; k < 10; k++) {
          const p = game.nav.randomPointNear(c.x, c.z, 2.5, 7, 6);
          const s2 = Math.hypot(p.x - near.x, p.z - near.z) - Math.hypot(p.x - c.x, p.z - c.z) * 0.3;
          if (s2 > bs) { bs = s2; best = p; }
        }
        if (best) { setPath(game, c, b, best.x, best.z); b.state = 'space'; b.run = false; return; }
      }
      if (b.state === 'space' && b.path) return;
      if (b.state === 'space') b.state = 'wander';
    }
  }

  wanderThink(game, c, b);
}

// Where should a calm bot walk to next?
//  - smart gun holders: open spots where they can see lots of people
//  - smart bystanders: close to the main group of people (safety in numbers)
//  - everyone else: anywhere
function pickWanderGoal(game, c, b) {
  const nav = game.nav;
  if (c.role !== 'murderer' && c.hasGun && b.skill > 0.45 && Math.random() < b.skill) {
    let best = null, bs = -Infinity;
    for (let k = 0; k < 10; k++) {
      const p = nav.randomPointNear(c.x, c.z, 5, 30, 6);
      let seen = 0;
      for (const o of game.chars.values()) {
        if (o === c || !o.alive) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d < 3.5) { seen -= 1; continue; }            // not right on top of people
        if (d < 30 && hasLOS(game.map, p.x, 1.6, p.z, o.x, o.y + 1.2, o.z)) seen++;
      }
      const open = game.map.isOutdoor(p.x, p.z) ? 1.5 : 0;
      const sc = seen * 3 + open - Math.hypot(p.x - c.x, p.z - c.z) * 0.05;
      if (sc > bs) { bs = sc; best = p; }
    }
    if (best) return best;
  }
  if (c.role !== 'murderer' && b.skill > 0.4 && Math.random() < b.skill) {
    let sx = 0, sz = 0, n = 0;
    for (const o of game.chars.values()) { if (o === c || !o.alive) continue; sx += o.x; sz += o.z; n++; }
    if (n >= 2) {
      // centre of the biggest crowd: average of people near the overall centre
      const cx = sx / n, cz = sz / n;
      let gx = 0, gz = 0, m = 0;
      for (const o of game.chars.values()) { if (o === c || !o.alive) continue; if (Math.hypot(o.x - cx, o.z - cz) < 25) { gx += o.x; gz += o.z; m++; } }
      if (m) { const p = nav.randomPointNear(gx / m, gz / m, 3, 9, 15); return p; }
    }
  }
  return nav.randomPointNear(c.x, c.z, 8, 40);
}

function wanderThink(game, c, b) {
  b.run = false;
  if (b.state !== 'wander' && b.state !== 'idle') b.state = 'wander';
  if (!b.path) {
    b.waitT -= B.THINK_INTERVAL;
    if (b.waitT <= 0) {
      const p = pickWanderGoal(game, c, b);
      setPath(game, c, b, p.x, p.z);
      b.waitT = rand(0.5, 4) * (1.2 - 0.6 * b.skill);
    }
  }
}

function thinkMurderer(game, c, b) {
  const I = B.THINK_INTERVAL;
  b.run = false;
  // knife was thrown: go get it
  if (!c.hasKnife) {
    let knife = null;
    for (const it of game.items.values()) if (it.type === 'knife' && !it.flying) knife = it;
    if (knife) {
      if (b.state !== 'retrieve' || !b.path) { setPath(game, c, b, knife.x, knife.z); b.state = 'retrieve'; }
      b.run = true;
    }
    return;
  }
  // danger: someone is pointing a gun at me
  for (const o of game.chars.values()) {
    if (o === c || !o.alive || weaponOf(o) !== 2) continue;
    const d = Math.hypot(o.x - c.x, o.z - c.z);
    if (d > 26) continue;
    const facing = Math.abs(angleDiff(o.yaw, yawTo(c.x - o.x, c.z - o.z))) < 25 * DEG;
    if (facing && hasLOS(game.map, o.x, o.y + P.EYE, o.z, c.x, c.y + 1.2, c.z)) {
      if (c.equipped && d > 4) game.hostAction(c, 'equip'); // hide the knife, act innocent
      if (b.state !== 'evade' || !b.path) {
        const p = game.nav.fleePoint(c.x, c.z, o.x, o.z);
        setPath(game, c, b, p.x, p.z);
        b.state = 'evade';
      }
      b.run = true;
      b.targetId = null;
      return;
    }
  }
  if (b.state === 'evade' && b.path) { b.run = true; return; }

  if (b.state === 'escape') {
    b.escapeT -= I;
    b.holsterT -= I;
    if (b.holsterT <= 0 && c.equipped) game.hostAction(c, 'equip');
    b.run = b.escapeT > 2;
    if (b.escapeT > 0 && b.path) return;
    b.state = 'wander';
  }

  // hiding: went somewhere out of sight, wait there, then start hunting again
  if (b.state === 'hide') {
    if (c.equipped) game.hostAction(c, 'equip');
    b.run = b.skill > 0.5 && !!b.path;
    if (b.path) return;
    b.hideWait -= I;
    if (b.hideWait > 0) return;
    b.state = 'wander';
    b.huntT = rand(3, 8);
  }

  b.huntT -= I;
  let t = game.chars.get(b.targetId);
  if (t && !t.alive) { t = null; b.targetId = null; }
  if (!t && b.huntT <= 0) {
    // choose a victim: close, alone, not armed
    let best = null, bs = Infinity;
    for (const o of game.chars.values()) {
      if (o === c || !o.alive) continue;
      const d = Math.hypot(o.x - c.x, o.z - c.z);
      const wit = witnesses(game, c, o);
      const armed = weaponOf(o) === 2 ? 40 : 0;
      const s2 = d + wit * 18 + armed + rand(0, 10);
      if (s2 < bs) { bs = s2; best = o; }
    }
    if (best) { t = best; b.targetId = best.id; b.state = 'stalk'; b.frustration = 0; }
  }
  if (!t) {
    if (c.equipped) game.hostAction(c, 'equip');
    wanderThink(game, c, b);
    return;
  }

  let d = Math.hypot(t.x - c.x, t.z - c.z);
  // someone else is much closer (and not armed)? switch to them mid-chase
  for (const o of game.chars.values()) {
    if (o === c || o === t || !o.alive || weaponOf(o) === 2) continue;
    const od = Math.hypot(o.x - c.x, o.z - c.z);
    // smarter murderers notice the better opportunity much more often
    if (od < 9 && od < d * 0.55 && Math.random() < b.skill * b.skill * 0.6 && hasLOS(game.map, c.x, c.y + P.EYE, c.z, o.x, o.y + 1.2, o.z)) {
      t = o; d = od; b.targetId = o.id; b.frustration *= 0.5;
      break;
    }
  }
  const wit = witnesses(game, c, t);
  const lateGame = clamp(1 - game.timeLeft / CONFIG.ROUND.TIME_LIMIT, 0, 1);
  b.frustration += I * 0.02;
  const bold = lateGame * 0.7 + b.frustration > 0.75;
  const seeT = hasLOS(game.map, c.x, c.y + P.EYE, c.z, t.x, t.y + 1.2, t.z);

  // sometimes give up completely and go hide behind a wall / somewhere far, then try again later
  // giving up / hiding happens more for clumsy murderers (x1.6) than skilled ones (x0.3)
  const nerves = 1.6 - 1.3 * b.skill;
  const giveUp = (b.frustration > 0.9 && Math.random() < 0.25 * nerves * I) || (wit >= 2 && d > 4 && Math.random() < 0.35 * nerves * I) || Math.random() < 0.02 * nerves * I;
  if (giveUp) {
    const spot = hideSpot(game, c, t);
    setPath(game, c, b, spot.x, spot.z);
    b.state = 'hide'; b.targetId = null; b.frustration = 0; b.hideWait = rand(2, 7);
    if (c.equipped) game.hostAction(c, 'equip');
    return;
  }

  // sprinting: skilled murderers run until completely out of stamina, clumsy ones ease off early
  const canSprint = b.skill > 0.7 || c.stamina > (1 - b.skill) * 70;
  const throwChance = b.skill < 0.45 ? 0 : B.THROW_CHANCE * (0.4 + b.skill) * I;
  if (d < 7.5 && seeT && (wit === 0 || bold)) {
    b.state = 'attack';
    // rush them, and only pull the knife out when right next to them.
    // Clumsy murderers sometimes slip into walking by mistake.
    if (b.walkSlip > 0) b.walkSlip -= I;
    else if (Math.random() < (1 - b.skill) * 0.12 * I) b.walkSlip = rand(0.6, 1.6);
    if (d < 2.6 && !c.equipped) game.hostAction(c, 'equip');
    b.run = canSprint && !(b.walkSlip > 0);
    if (d > 4.5 && d < 13 && t.running && Math.random() < throwChance) { b.wantThrow = true; if (!c.equipped) game.hostAction(c, 'equip'); }
  } else if (b.state === 'attack' && d < 14 && seeT) {
    b.run = canSprint; // keep chasing
    if (d > 5 && d < 13 && Math.random() < throwChance) { b.wantThrow = true; if (!c.equipped) game.hostAction(c, 'equip'); }
  } else {
    b.state = 'stalk';
    if (c.equipped && wit > 0) game.hostAction(c, 'equip');
    b.run = d > 18 && canSprint;
    b.repathT -= I;
    if (!b.path || b.repathT <= 0) setPath(game, c, b, t.x, t.z);
  }
  // give up on a target that's taking too long
  if (b.frustration > 1.2 && wit > 1) { b.targetId = null; b.huntT = rand(2, 6); b.frustration = 0; }
}

// A spot 10-30 m away that the victim can't see (behind a wall), preferring nearer ones
function hideSpot(game, c, t) {
  let best = null, bd = Infinity;
  for (let k = 0; k < 24; k++) {
    const p = game.nav.randomPointNear(c.x, c.z, 10, 30, 6);
    if (hasLOS(game.map, t.x, t.y + P.EYE, t.z, p.x, 1.2, p.z)) continue;
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best || game.nav.fleePoint(c.x, c.z, t.x, t.z);
}

// ---------------------------------------------------------------------
//  Acting: steering, aiming, attacking (every frame)
// ---------------------------------------------------------------------
function act(game, c, b, dt) {
  let mx = 0, mz = 0;
  let faceYaw = null, facePitch = 0;
  const target = game.chars.get(b.targetId);

  if (b.state === 'engage' && target && target.alive) {
    // ----- armed bot aiming -----
    const dx = target.x - c.x, dz = target.z - c.z;
    const d = Math.hypot(dx, dz);
    const visible = hasLOS(game.map, c.x, c.y + P.EYE, c.z, target.x, target.y + 1.2, target.z);
    faceYaw = yawTo(dx, dz);
    facePitch = Math.atan2(target.y + 1.15 - (c.y + P.EYE), d);
    const turn = B.TURN_SPEED * (0.55 + 0.9 * b.skill);
    c.yaw = turnToward(c.yaw, faceYaw, turn * dt);
    c.pitch += clamp(facePitch - c.pitch, -turn * dt, turn * dt);
    b.reactT -= dt;
    const err = Math.abs(angleDiff(c.yaw, faceYaw));
    const susp = b.susp.get(target.id) || 0;
    if (visible && b.reactT <= 0 && err < (8 - 5 * b.skill) * DEG && (b.fireOk || susp >= 100) && c.attackCd <= 0 && d < 45 &&
        weaponOf(c) === 2 && game.phase === 'play') {
      // aim quality depends on skill (random per bot), distance and moving while shooting
      const spread = B.AIM_SPREAD_DEG * DEG * (2.0 - 1.6 * b.skill) * rand(0.8, 1.2) * (1 + d / 25) * (c.speed > 1 ? 1.6 - 0.4 * b.skill : 1);
      game.gunAttack(c, spread);
    }
    // positioning: get closer if far / no sight, back off from a knife
    if (!visible || d > 16) {
      b.repathT -= dt;
      if (!b.path || b.repathT <= 0) setPath(game, c, b, target.x, target.z);
      const v = followPath(game, c, b);
      mx = v.x; mz = v.z;
      b.run = d > 20;
    } else if (d < 5 && weaponOf(target) === 1 && b.skill > 0.55) {
      mx = -dx / d; mz = -dz / d; b.run = true; // skilled: back-pedal while shooting
      b.path = null;
    } else {
      b.path = null;
    }
    c.yaw = c.yaw; // keep aim, don't face movement
  } else if (b.state === 'attack' && target && target.alive) {
    // ----- murderer lunging -----
    const dx = target.x - c.x, dz = target.z - c.z;
    const d = Math.hypot(dx, dz);
    faceYaw = yawTo(dx, dz);
    if (d < 1.45) { mx = 0; mz = 0; b.path = null; }  // right next to them: stop, turn and stab (no circling)
    else if (game.nav.clearLine(c.x, c.z, target.x, target.z)) { mx = dx / d; mz = dz / d; b.path = null; }
    else {
      b.repathT -= dt;
      if (!b.path || b.repathT <= 0) setPath(game, c, b, target.x, target.z);
      const v = followPath(game, c, b); mx = v.x; mz = v.z;
    }
    c.yaw = turnToward(c.yaw, faceYaw, (d < 2.5 ? 14 : 9) * dt);
    c.pitch = Math.atan2(target.y + 1.1 - (c.y + P.EYE), d) * 0.6;
    if (b.wantThrow && weaponOf(c) === 1 && c.attackCd <= 0 && Math.abs(angleDiff(c.yaw, faceYaw)) < 4 * DEG) {
      b.wantThrow = false;
      c.pitch = Math.atan2(target.y + 1.1 - (c.y + P.EYE), d) + d * 0.004;
      game.hostAction(c, 'throw');
      b.state = 'retrieve';
    } else if (d < W.KNIFE_RANGE * 0.85 && c.attackCd <= 0 && Math.abs(angleDiff(c.yaw, faceYaw)) < 40 * DEG) {
      game.hostAction(c, 'attack');
    }
  } else {
    const v = followPath(game, c, b);
    mx = v.x; mz = v.z;
    if (!b.path) {
      // idle: look around
      b.lookT -= dt;
      const alert = c.hasGun && c.role !== 'murderer' ? b.skill : b.skill * 0.5;
      if (b.lookT <= 0) { b.lookYaw = c.yaw + rand(-1.6, 1.6) * (1 + alert * 0.8); b.lookT = rand(1, 3) * (1 - 0.7 * alert); }
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
    if (b.state !== 'engage' && b.state !== 'attack') {
      // alert gun holders glance left/right while walking
      if (c.hasGun && c.role !== 'murderer' && b.skill > 0.5) {
        b.scanT -= dt;
        if (b.scanT <= -rand(0.8, 2.5) * (1.4 - b.skill)) { b.scanT = rand(0.4, 0.8); b.scanOff = rand(0.7, 1.3) * (Math.random() < 0.5 ? -1 : 1); }
      }
      c.yaw = turnToward(c.yaw, yawTo(mx, mz) + (b.scanT > 0 ? b.scanOff : 0), 7 * dt);
      c.pitch *= 0.9;
    }
  }

  // jump up to people standing on boxes / tables, and hop around when running scared
  if (target && target.alive && (b.state === 'attack' || b.state === 'engage')) {
    const dd = Math.hypot(target.x - c.x, target.z - c.z);
    if (target.y - c.y > 0.3 && dd < 2.6 && c.onGround) b.jump = true;
  }
  if (c.onGround && b.run && (b.state === 'flee' || b.state === 'evade' || b.state === 'escape') && Math.random() < B.JUMPINESS * dt) b.jump = true;
  if (c.onGround && b.state === 'wander' && b.path && Math.random() < 0.04 * dt) b.jump = true;
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

export { forwardX, forwardZ };
