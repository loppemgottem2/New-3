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
import { CONFIG } from './config.js?v=1040';
import { rand, clamp, angleDiff, turnToward, yawTo, DEG } from './util.js?v=1040';
import { moveCharacter, hasLOS, circleFree } from './physics.js?v=1040';
import { propHeight } from './props.js?v=1040';

const B = CONFIG.BOTS;
const P = CONFIG.PLAYER;
const W = CONFIG.WEAPONS;
const TM = CONFIG.TEAMS;

const weaponOf = (c) => {
  if (c.slot < 0) return 0;
  const it = c.hotbar[c.slot];
  return it === 'knife' && c.hasKnife ? 1 : it === 'revolver' && c.hasGun ? 2 : it === 'crowbar' && c.hasCrowbar ? 3 : 0;
};
// put an item from the hotbar in hand (bots don't need the inventory screen)
function hold(c, item) {
  const k = c.hotbar.indexOf(item);
  if (k >= 0) c.slot = k;
}

export function initBrain(c) {
  const skill = 0.5;           // every bot plays at the same, medium skill
  return {
    skill,
    state: 'wander',
    path: null, pi: 0, goal: null, repathT: 0,
    thinkT: rand(0, B.THINK_INTERVAL),
    waitT: rand(0, 2),
    lookT: 0, lookYaw: c.yaw,
    susp: new Map(),             // seekers: suspicion of each disguised prop player
    notice: new Map(),           // seekers: how far along they are in noticing each T-posing person (1 = seen)
    g: c.team === 'seeker' && evo.on ? mutateGenome(GENOME, evo.sigma) : GENOME,   // how this seeker weighs its reasoning
    kills: 0,
    tested: new Set(),           // seekers: real furniture already tested this round (ids)
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

const VFOV_HALF = 32 * DEG;     // bots see 32 degrees below where they look
// how far (angle) something is from where the bot is looking, sideways and up/down combined
function viewAngle(c, o, h) {
  const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz) || 0.01;
  const yawE = Math.abs(angleDiff(c.yaw, yawTo(dx, dz)));
  const pitchE = Math.abs(Math.atan2((o.y || 0) + h - (c.y + P.EYE), d) - (c.pitch || 0));
  return Math.hypot(yawE, pitchE);
}
function canSee(game, c, o, maxDist = B.VIEW_DISTANCE) {
  const dx = o.x - c.x, dz = o.z - c.z;
  const d = Math.hypot(dx, dz);
  if (d > maxDist) return false;
  if (d > B.CLOSE_SENSE) {
    const a = Math.abs(angleDiff(c.yaw, yawTo(dx, dz)));
    if (a > (B.FOV_DEG * DEG) / 2) return false;
  }
  const mid = o.disguise ? Math.min(0.5, propHeight(o.disguise) * 0.5) : 0.5;
  // up / down view: looking straight ahead, something low and close (down by their feet) is out of view
  const top = (o.y ?? 0) + (o.team ? (o.disguise ? propHeight(o.disguise) : 1.8) : 0.3);
  if (Math.atan2(top - (c.y + P.EYE), Math.max(0.2, d)) < (c.pitch || 0) - VFOV_HALF) return false;
  if (!hasLOS(game.map, c.x, c.y + P.EYE, c.z, o.x, (o.y ?? 0) + mid, o.z)) return false;
  // people can also hide behind furniture (not for checking furniture itself)
  if (o.team) {
    const ex = c.x, ey = c.y + P.EYE, ez = c.z, lx = o.x - ex, ly = (o.y ?? 0) + (o.disguise ? mid : 1.1) - ey, lz = o.z - ez, ll = Math.hypot(lx, ly, lz) || 1;
    if (game.props.raycast(ex, ey, ez, lx / ll, ly / ll, lz / ll, ll - 0.4)) return false;
  }
  return true;
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

// A STILL prop (not moving and not turning, or anchored) only gets suspected sometimes: each seeker rolls
// once in a while whether it finds that piece of furniture suspicious. If not, it ignores it and walks around it.
const STILL_AFTER = 1.0;                 // seconds without moving / turning before a prop counts as still
const SUSPECT_STILL = (skill) => 0.2 + 0.25 * skill;   // chance a seeker finds a still prop suspicious
const REROLL = [8, 16];                  // seconds until a seeker makes up its mind again about the same prop
export function isStill(o) { return o.anchored || (o.stillT || 0) >= STILL_AFTER; }

export function updateBots(game, dt) {
  // how long every disguised prop has been perfectly still (no moving, no turning; anchored counts as still)
  for (const o of game.chars.values()) {
    if (o.team !== 'prop' || !o.alive) { o.stillT = 0; continue; }
    const turned = o._lastYaw !== undefined && Math.abs(angleDiff(o.yaw, o._lastYaw)) > 0.01;
    o._lastYaw = o.yaw;
    if (o.anchored || ((o.speed || 0) < 0.15 && !turned)) o.stillT = (o.stillT || 0) + dt; else o.stillT = 0;
  }
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
  const near = game.props.list.filter((p) => !p.removed && Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < range && p.top < 2.2);
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
    for (const o of game.props.list) { if (o.removed) continue; const d = Math.hypot(o.pos.x - c.x, o.pos.z - c.z); if (d < bd) { bd = d; p = o; } }
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
        b.state = 'flee'; b.climbTry = Math.random() < 0.5;
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
  if (b.hideRun === undefined) b.hideRun = Math.random() < 0.35;
  b.run = (game.phase === 'pre' && game.timeLeft < 12) || b.hideRun;
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
  const seenNow = new Set();
  for (const o of game.chars.values()) {
    if (!o.alive || o.team !== 'prop') continue;
    if (!canSee(game, c, o)) continue;
    const d = Math.hypot(o.x - c.x, o.z - c.z);
    if (!o.disguise) {
      // a T-posing person: obviously a prop, but it takes a moment to actually notice them. Longer the
      // farther away they are and the further from where the bot is looking (corner of the eye / heard behind)
      seenNow.add(o.id);
      if ((b.susp.get(o.id) || 0) < 100) {
        // quickest at a middle distance: up close they don't expect you right under their nose (and have to
        // look down), far away you're harder to make out
        const ang = viewAngle(c, o, 1.0);
        const need = (0.3 + 0.45 * (1 - b.skill)) * (1 + 3 / Math.max(1, d) + d / 16) * (1 + ang / (60 * DEG));
        const n = (b.notice.get(o.id) || 0) + I / need;
        b.notice.set(o.id, n);
        if (n >= 1) b.susp.set(o.id, 100);
        else if (n >= 0.35 && !b.path) { b.lookYaw = yawTo(o.x - c.x, o.z - c.z); b.lookT = 0.8; b.lookPitch = Math.atan2(o.y + 1.0 - (c.y + P.EYE), Math.max(0.3, d)); b.lookPitchT = 0.8; }   // "huh?" - turns to look
      }
    } else {
      let s = b.susp.get(o.id) || 0;
      if (!isStill(o)) s += B.MOVE_SUSPICION * I * (0.4 + b.skill) / ((1 + 2 / Math.max(1, d) + d / 20) * (1 + viewAngle(c, o, propHeight(o.disguise) * 0.5) / (60 * DEG)));   // furniture that moves or turns! (slower to catch right under their nose / out of the corner of the eye)
      else if (d < B.CHECK_RANGE && suspects(b, o)) s += B.STARE_SUSPICION * I * (0.2 + b.skill);   // "that chair wasn't there before…"
      b.susp.set(o.id, Math.min(100, s));
    }
    if ((b.susp.get(o.id) || 0) >= 100 && d < sd) { sd = d; spotted = o; }
  }
  for (const [id, v] of b.susp) if (v < 100) b.susp.set(id, Math.max(0, v - 2 * I));
  for (const [id, v] of b.notice) if (!seenNow.has(id)) b.notice.set(id, Math.max(0, v - 0.3 * I));   // out of sight: slowly forget

  if (spotted && b.targetId !== spotted.id) {
    markHot(game, spotted.x, spotted.z, 1);                    // a prop was found here: worth searching around later
    b.chaseRun = Math.random() < 0.45;                         // sometimes they sprint after you
    b.circled = 0; b.lastBearing = undefined; b.behindLimit = 1 + ((Math.random() * 3) | 0) + b.skill * 1.5;   // skilled ones are harder to shake
    // reacting takes longer if they first have to swing their aim round, and the farther away you are
    const ang = viewAngle(c, spotted, spotted.disguise ? propHeight(spotted.disguise) * 0.5 : 1.0);
    b.state = 'engage'; b.targetId = spotted.id; b.targetProp = null; b.shots = 0; b.settle = 0;
    b.reactT = reactTime(b) * (0.6 + Math.min(1.4, ang / (45 * DEG))) * (1 + 1.5 / Math.max(1, sd) + sd / 30);   // up close = a surprise, far = harder to make out
    return;
  }
  if (b.state === 'engage') {
    const t = game.chars.get(b.targetId);
    if (b.targetProp) return;                                  // finishing a furniture test
    if (t && !t.alive) markHot(game, t.x, t.z, 2);           // killed one here: there may be more
    if (!t || !t.alive || (b.susp.get(t.id) || 0) < 60) { b.state = 'wander'; b.targetId = null; }
    return;
  }

  // now and then, test a nearby piece of furniture
  // low health: skilled seekers stop guessing. Careless ones (low skill) keep testing furniture
  // and can end up killing themselves with the penalty.
  // "Can I afford to be wrong?" The lower their health, the more out of place something has to look
  // before they'll risk testing it (but now and then they still gamble, and can die from it)
  const hpLeft = c.hp / TM.WRONG_PROP_DAMAGE;                 // wrong guesses they can still survive
  const minOdd = hpLeft <= 2 ? 2.5 : hpLeft <= 4 ? 1.2 : 0;
  if (Math.random() < B.CHECK_CHANCE * b.g.checkMul) {
    const cands = [];
    for (const p of game.props.list) {
      if (p.removed || b.tested.has(p.id)) continue;                // never tests the same piece twice
      // fallen over / on its side / upside down: a player can't do that, so it must be real furniture
      const q = p.quat; if (1 - 2 * (q.x * q.x + q.z * q.z) < 0.9) continue;
      const d = Math.hypot(p.pos.x - c.x, p.pos.z - c.z);
      if (d < B.CHECK_RANGE && canSee(game, c, { x: p.pos.x, y: p.y, z: p.pos.z })) cands.push({ prop: p, w: oddness(game, p.type, p.pos.x, p.y, p.pos.z, p, b.g) });
    }
    for (const o of game.chars.values()) {
      if (!o.alive || o.team !== 'prop' || !o.disguise) continue;
      const odd = oddness(game, o.disguise, o.x, o.y, o.z, null, b.g);
      // a still prop it isn't suspicious of: leave it alone (unless it looks really out of place)
      if (isStill(o) && !suspects(b, o) && odd < 1.5) continue;
      const d = Math.hypot(o.x - c.x, o.z - c.z);
      if (d < B.CHECK_RANGE && canSee(game, c, o)) cands.push({ ch: o, w: odd });
    }
    // nothing here looks out of place: usually don't bother testing anything (sometimes they still do)
    const maxW = cands.reduce((m, k) => Math.max(m, k.w), 0);
    if (cands.length && maxW < b.g.boring && Math.random() < 0.75) cands.length = 0;
    if (cands.length && maxW < minOdd && Math.random() < 0.9) cands.length = 0;   // too risky for how hurt they are
    if (cands.length) {
      const pw = b.g.pick;
      let r = Math.random() * cands.reduce((s, k) => s + k.w ** pw, 0);   // the odder, the much likelier
      const pickd = cands.find((k) => (r -= k.w ** pw) <= 0) || cands[0];
      b.state = 'engage'; b.reactT = reactTime(b); b.shots = 0; b.settle = 0;
      if (pickd.ch) { b.targetId = pickd.ch.id; b.targetProp = null; b.susp.set(pickd.ch.id, 100); b.logicTarget = isStill(pickd.ch) ? pickd.ch.id : null; }
      else { b.targetId = null; b.targetProp = pickd.prop; b.tested.add(pickd.prop.id); }
      return;
    }
  }
  wanderThink(game, c, b);
}

// ---------------------------------------------------------------------
//  "Does that belong there?" Seekers reason about what they can see, like a person would, by asking a few
//  questions about a piece of furniture and adding up how suspicious it is:
//   - Is there another one of these right next to it / other furniture around it? (normal)  Is it all alone? (odd)
//   - What is it standing on? A beer or takeout belongs on a table, desk, counter or crate - not on a
//     mattress or a couch, and not just on the floor. A keyboard / computer / pen cup goes on a desk or table.
//   - Is it somewhere that makes sense? Chairs go by tables and desks, swivel chairs by desks, crates and
//     barrels with other storage, the doll by the beds...
//   - Is this a hallway / empty space? Plants, bins, lamps and boxes are fine there; a chair, desk,
//     table, couch or mattress standing in a corridor isn't.
//  Returns a suspicion value: ~0.1 (totally normal) ... ~6 (that really doesn't belong there)
// ---------------------------------------------------------------------
const ON_TOP = { bottle: ['table', 'desk', 'longcounter', 'shortcounter', 'crate', 'longcrate', 'barrel'],
  takeout: ['table', 'desk', 'longcounter', 'shortcounter', 'crate', 'longcrate'],
  keyboard: ['desk', 'table'], computer: ['desk', 'table'], pencup: ['desk', 'table'] };
const STORAGE = ['box', 'crate', 'longcrate', 'barrel'];
const BELONGS = {
  chair: [['table', 'desk'], 2.6], swivelchair: [['desk'], 2.6],
  box: [STORAGE, 6], crate: [STORAGE, 6], longcrate: [STORAGE, 6], barrel: [STORAGE, 6],
  mattress: [['mattress', 'bluecouch', 'greencouch', 'babydoll'], 6], babydoll: [['mattress', 'bluecouch', 'greencouch'], 4],
  whiteboard: [['desk', 'table'], 8], table: [['chair', 'swivelchair', 'bluecouch', 'greencouch'], 3], desk: [['chair', 'swivelchair', 'computer'], 3],
};
const HALLWAY_OK = new Set(['plant', 'trashcan', 'lamp', 'box', 'barrel', 'bottle', 'takeout']);
// "Do two of these right next to each other make sense?" Chairs round a table, crates stacked together,
// bottles on a table: yes. Two couches touching, two whiteboards, two lamps or bins side by side, two
// computers on one spot, two creepy dolls: no. [distance under which a pair looks wrong]
const BAD_PAIR = { bluecouch: 2.6, greencouch: 2.6, whiteboard: 3, lamp: 1.6, trashcan: 1.4, computer: 0.6, keyboard: 0.4,
  pencup: 0.4, babydoll: 6, plant: 1.0, mattress: 0.5, table: 0.4, desk: 0.3 };

// The seekers' "thinking weights": how much each question counts. Tuned by evolution: every round each bot
// seeker thought with a slightly varied copy, the one with the most logic finds (hitting a still / anchored prop
// it picked by reasoning) and fewest wrong-furniture hits became the default, until the seekers won a round
// (round 11). These are the winner's weights.
export const GENOME = {
  twinNear: 1.209,      // another one of the same kind nearby: looks normal (multiplier)
  alone: 0.75,         // nothing around it at all
  crowded: 0.339,       // plenty of furniture around it
  fits: 0.267,          // goes with what's around it (chairs by tables...)
  misfit: 2.896,        // doesn't go with anything around it
  hallway: 0.605,       // a chair / desk / couch... standing in an empty corridor
  onFloor: 4.734,       // a beer / takeout / keyboard on the floor
  wrongTop: 1.144,      // standing on something it doesn't belong on (a beer on a mattress)
  spacing: 1.135,       // much closer to a twin than the others of its kind in the room are to each other
  badPair: 6.666,       // a duplicate right next to it where that makes no sense
  pick: 3.043,          // how strongly they go for the oddest thing (1 = proportional, higher = only the oddest)
  boring: 1.201,        // if nothing looks odder than this, they usually don't test anything
  checkMul: 1.358,      // how often they consider testing something
};
export const evo = { on: false, sigma: 0.25 };      // (tests) every seeker gets a mutated copy of GENOME
function mutateGenome(g, sigma) {
  const o = {};
  for (const k in g) { const n = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random()); o[k] = g[k] * Math.exp(n * sigma); }
  return o;
}

function oddness(game, type, x, y, z, self = null, g = GENOME) {
  let same = 0, around = 0, near5 = 0, fits = !BELONGS[type], under = null, nearestTwin = Infinity;
  const want = BELONGS[type], ak = areaKey(x, z), roomTwins = [];
  for (const q of game.props.list) {
    if (q === self || q.removed) continue;
    const d = Math.hypot(q.pos.x - x, q.pos.z - z);
    if (q.type === type) {
      if (d < 4) same++;
      if (Math.abs(q.y - y) < 0.4) nearestTwin = Math.min(nearestTwin, d);
      if (areaKey(q.pos.x, q.pos.z) === ak) roomTwins.push(q);
    }
    if (d < 2.5) around++;
    if (d < 5) near5++;
    if (want && !fits && d < want[1] && want[0].includes(q.type)) fits = true;
    if (y > 0.25 && d < q.r + 0.1 && Math.abs(q.top - y) < 0.25) under = q;     // what it's standing on
  }
  // "What is it on?" for things that belong on top of something
  if (ON_TOP[type]) {
    if (y < 0.25) return g.onFloor * (around === 0 ? 1.3 : 1);                // a beer / takeout / keyboard on the floor
    if (under && !ON_TOP[type].includes(under.type)) return g.wrongTop;        // a beer on a mattress, a keyboard on a couch...
    if (BAD_PAIR[type] && nearestTwin < BAD_PAIR[type]) return g.badPair * 0.8;
    return same > 0 || around >= 2 ? 0.2 : 0.6;
  }
  let w = 1;
  w *= same > 0 ? g.twinNear : g.alone;         // "is there another one of these around?"
  w *= around >= 2 ? g.crowded : around === 0 ? g.alone : 1;
  w *= fits ? g.fits : g.misfit;                // "does it go with what's around it?"
  if (near5 <= 1 && !HALLWAY_OK.has(type)) w *= g.hallway;   // "a chair standing in the hallway?"
  // "Two of these right next to each other... does that make sense?"
  if (BAD_PAIR[type] && nearestTwin < BAD_PAIR[type]) w = Math.max(w, 1) * g.badPair;
  // "The tables in this room are all ~4 m apart, so why is this one 1.5 m from the next?" Compare how close it
  // is to its nearest twin with how the others of its kind in the room are spaced from each other.
  if (roomTwins.length >= 2 && nearestTwin < Infinity) {
    const gaps = roomTwins.map((q) => { let m = Infinity; for (const o of roomTwins) if (o !== q) m = Math.min(m, Math.hypot(o.pos.x - q.pos.x, o.pos.z - q.pos.z)); return m; })
      .filter((v) => v < Infinity).sort((p1, p2) => p1 - p2);
    const typical = gaps[gaps.length >> 1];
    if (typical && nearestTwin < typical * 0.6 && typical - nearestTwin > 0.5) w = Math.max(w, 1) * g.spacing;
  }
  return w;
}

// does this seeker find that still prop suspicious right now? (decided at random, re-decided now and then)
function suspects(b, o) {
  const now = performance.now() / 1000;
  if (!b.still) b.still = new Map();
  let r = b.still.get(o.id);
  if (!r || now > r.until) { r = { sus: Math.random() < SUSPECT_STILL(b.skill), until: now + rand(REROLL[0], REROLL[1]) }; b.still.set(o.id, r); }
  return r.sus;
}

// places worth searching: where props were found / killed (shared by every seeker bot, fades after ~90 s)
function markHot(game, x, z, w) {
  const hot = game._botHot || (game._botHot = []);
  hot.push({ x, z, w, t: game.timeLeft });
  if (hot.length > 24) hot.shift();
}
// a suspicious room to search: where props were recently found / killed (knocked-over furniture doesn't
// count: the seekers knock most of it over themselves)
function pickSuspiciousArea(game, c) {
  const cands = [];
  for (const h of game._botHot || []) {
    if (h.t - game.timeLeft > 90) continue;
    const d = Math.hypot(h.x - c.x, h.z - c.z);
    if (d < 60) cands.push({ x: h.x, z: h.z, w: h.w * 2 });
  }
  if (!cands.length) return null;
  let r = Math.random() * cands.reduce((a, k) => a + k.w, 0);
  return cands.find((k) => (r -= k.w) <= 0) || cands[0];
}

// map areas (about one room each) for keeping track of where the seekers have searched
const AREA = 16;
const areaKey = (x, z) => Math.floor(x / AREA) + ',' + Math.floor(z / AREA);

function wanderThink(game, c, b) {
  b.state = 'wander';
  if (game._botVisited && game._botVisitedRound !== game._roundNo) { game._botVisited.clear(); }
  game._botVisitedRound = game._roundNo;
  (game._botVisited || (game._botVisited = new Map())).set(areaKey(c.x, c.z), performance.now() / 1000);   // searched here
  // heading somewhere new: they run (mostly). Searching an area / inspecting furniture up close: they walk,
  // and they slow to a walk for the last few metres to look properly
  const goal = b.path && b.path[b.path.length - 1];
  const left = goal ? Math.hypot(goal.x - c.x, goal.z - c.z) : 0;
  b.run = !!b.path && !!b.wanderRun && left > 4;
  if (!b.path) {
    b.waitT -= B.THINK_INTERVAL;
    if (b.waitT <= 0) {
      // a suspicious room: keep searching around it for a while (longer stops, looking around)
      if (b.area && game.timeLeft > b.area.until) {
        const p = game.nav.randomPointNear(b.area.x, b.area.z, 1.5, 8);
        setPath(game, c, b, p.x, p.z);
        b.wanderRun = Math.random() < 0.15;                       // inspecting the area: mostly walking
        b.waitT = rand(2.5, 5.5);
        return;
      }
      b.area = null;
      if (Math.random() < 0.12 + 0.08 * b.skill) {            // only now and then (a little more likely than other spots)
        const a = pickSuspiciousArea(game, c);
        if (a) {
          b.area = { x: a.x, z: a.z, until: game.timeLeft - rand(6, 12) };
          const p = game.nav.randomPointNear(a.x, a.z, 1, 6);
          setPath(game, c, b, p.x, p.z);
          b.wanderRun = Math.random() < 0.85;                     // heading over there: run
          b.waitT = rand(3, 6);
          return;
        }
      }
      // Priority: cover every room. The map is split into areas; the seekers (all of them together) remember
      // when each area was last searched and head for the one nobody has checked for the longest (not too far
      // away), then search next to furniture there, where props like to hide.
      let p = null;
      const visited = game._botVisited || (game._botVisited = new Map()), now = performance.now() / 1000;
      if (Math.random() < 0.8) {
        let best = null, bestS = -Infinity;
        for (let k = 0; k < 14; k++) {
          const q = game.nav.randomPointNear(c.x, c.z, 8, 70);
          if (!q) continue;
          const age = Math.min(120, now - (visited.get(areaKey(q.x, q.z)) ?? -1e9));
          const sc = age - Math.hypot(q.x - c.x, q.z - c.z) * 0.6 + rand(0, 8);
          if (sc > bestS) { bestS = sc; best = q; }
        }
        if (best) {
          const ak = areaKey(best.x, best.z);
          const inArea = game.props.list.filter((q) => !q.removed && areaKey(q.pos.x, q.pos.z) === ak);
          let pick = null;
          if (inArea.length && Math.random() < 0.45 + 0.45 * b.skill) {
            // go and look at whatever looks most out of place there (real furniture or a disguised player)
            const odds = inArea.map((q) => ({ x: q.pos.x, z: q.pos.z, w: oddness(game, q.type, q.pos.x, q.y, q.pos.z, q, b.g) }));
            for (const o of game.chars.values()) if (o.alive && o.disguise && areaKey(o.x, o.z) === ak) odds.push({ x: o.x, z: o.z, w: oddness(game, o.disguise, o.x, o.y, o.z, null, b.g) });
            let rr = Math.random() * odds.reduce((a2, k) => a2 + k.w ** b.g.pick, 0);
            pick = odds.find((k) => (rr -= k.w ** b.g.pick) <= 0) || odds[0];
          }
          p = pick ? spotNear(game, { pos: { x: pick.x, z: pick.z }, r: 0.4 }) : best;
          visited.set(ak, now);                     // claimed: the other seekers go somewhere else
        }
      }
      if (!p && Math.random() < 0.45 + 0.45 * b.skill) {
        const near = game.props.list.filter((q) => { if (q.removed) return false; const d = Math.hypot(q.pos.x - c.x, q.pos.z - c.z); return d > 6 && d < 45; });
        if (near.length) { const q = near[(Math.random() * near.length) | 0]; p = spotNear(game, q); }
      }
      if (!p) p = game.nav.randomPointNear(c.x, c.z, 8, 40);
      setPath(game, c, b, p.x, p.z);
      // going to a new room / spot: run (usually); a short hop nearby: usually walk
      b.wanderRun = Math.random() < (Math.hypot(p.x - c.x, p.z - c.z) > 10 ? 0.85 : 0.3);
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
  const yaw0 = c.yaw, pitch0 = c.pitch;          // blindfolded seekers don't even look around
  const target = game.chars.get(b.targetId);
  const tp = b.targetProp;

  if (b.state === 'engage' && ((target && target.alive) || tp)) {
    // ----- seeker attacking a prop (player or real furniture) -----
    let realX = tp ? tp.pos.x : target.x, realZ = tp ? tp.pos.z : target.z;
    // aim at the middle of what they look like (a keyboard is only 3 cm tall, a chair is 1 m)
    let realY = tp ? tp.pos.y : target.y + (target.disguise ? propHeight(target.disguise) * 0.5 : 1.15);
    // ----- can it actually see the person right now? (walls and furniture both hide you) -----
    let sees = true;
    if (target && !tp) {
      b.seeT = (b.seeT || 0) - dt;
      if (b.seeT <= 0 || b.seesKey !== target.id) { b.seeT = 0.15; b.seesKey = target.id; b.sees = canSee(game, c, target, B.VIEW_DISTANCE * 1.2) || Math.hypot(target.x - c.x, target.z - c.z) < 1.2; }
      sees = b.sees;
      if (sees) { b.lastSeen = { x: target.x, y: target.y, z: target.z, vx: target.vx || 0, vz: target.vz || 0 }; b.lostT = 0; b.searchT = 0; b.guess = null; }
      else if (b.lastSeen) {
        // lost sight: head for where it last saw you (skilled bots guess a little further along your path)
        // and give up after a while, sooner the farther away you get
        if (!b.guess) {
          const ahead = 0.9 * b.skill;
          const gx = b.lastSeen.x + b.lastSeen.vx * ahead, gz = b.lastSeen.z + b.lastSeen.vz * ahead;
          b.guess = circleFree(game.map, gx, gz, P.RADIUS) ? { x: gx, z: gz } : { x: b.lastSeen.x, z: b.lastSeen.z };
          b.path = null;
        }
        const far = Math.hypot(target.x - c.x, target.z - c.z);
        b.lostT = (b.lostT || 0) + dt * (1 + far / 12);
        realX = b.guess.x; realZ = b.guess.z; realY = b.lastSeen.y + 1.1;
        const atGuess = Math.hypot(b.guess.x - c.x, b.guess.z - c.z) < 1.3;
        if (atGuess) b.searchT = (b.searchT || 0) + dt;
        if (b.lostT > 3 + 4 * b.skill || b.searchT > 1.2 + b.skill) {
          // lost you: forget it (it has to spot you all over again)
          b.susp.set(target.id, target.disguise ? 30 : 0); b.notice.set(target.id, 0.4);
          b.state = 'wander'; b.targetId = null; b.lastSeen = null; b.guess = null; b.path = null; b.waitT = 0;
          b.lookYaw = c.yaw + rand(-2, 2); b.lookT = rand(1, 2);
          moveCharacter(c, { mx: 0, mz: 0, run: false, jump: false }, dt, game.map);
          return;
        }
      }
    }
    // ----- running round them: circle them (or keep getting behind them) up close 1-3 times (random) and
    // they can lose you: "where did they go?" -----
    if (target && !tp && sees && b.behindLimit) {
      const bd = Math.hypot(target.x - c.x, target.z - c.z);
      const bearing = yawTo(target.x - c.x, target.z - c.z);
      if (bd < 7 && b.lastBearing !== undefined) {
        const off = Math.abs(angleDiff(c.yaw, bearing));
        // how far round them you went (counts double while you're off to the side / behind their aim)
        b.circled = (b.circled || 0) + Math.abs(angleDiff(b.lastBearing, bearing)) * (off > 40 * DEG ? 1.5 : 1) / (2 * Math.PI);
      }
      b.lastBearing = bd < 7 ? bearing : undefined;
      if ((b.circled || 0) >= b.behindLimit) {
        if (Math.random() < 0.7 - 0.4 * b.skill) {
          b.susp.set(target.id, target.disguise ? 30 : 0); b.notice.set(target.id, 0.2);
          b.state = 'wander'; b.targetId = null; b.lastSeen = null; b.guess = null; b.area = null; b.circled = 0;
          const p = game.nav.randomPointNear(c.x, c.z, 3, 10);
          setPath(game, c, b, p.x, p.z); b.waitT = rand(1, 3);
          b.lookYaw = c.yaw + rand(-1.5, 1.5); b.lookT = rand(0.8, 1.6);
          moveCharacter(c, { mx: 0, mz: 0, run: false, jump: false }, dt, game.map);
          return;
        }
        b.behindLimit = (b.circled || 0) + 1 + ((Math.random() * 2) | 0);    // kept track this time
      }
    }
    // Tracking: the bot aims at where it THINKS the target is. That point trails behind the real one,
    // catching up faster for skilled bots. Fast, jumpy, zig-zag movement leaves it behind -> misses.
    const key = tp ? 'p' + tp.id : 'c' + target.id;
    if (!b.trk || b.trk.key !== key) {
      const off = (1 - b.skill) * 0.8;
      b.trk = { key, x: realX + rand(-off, off), y: realY + rand(-off, off) * 0.5, z: realZ + rand(-off, off), vx: 0, vy: 0, vz: 0, jerk: 0 };
    }
    const tk = b.trk, follow = 1 - Math.exp(-(2.0 + 4.0 * b.skill) * dt);
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
    const visible = sees && hasLOS(game.map, c.x, c.y + P.EYE, c.z, realX, realY, realZ);
    // furniture in the way: don't waste a shot (and health) on it, move to get a clear line instead
    let blocked = false;
    if (target && !tp && visible) {
      const ex = c.x, ey = c.y + P.EYE, ez = c.z, lx = realX - ex, ly = realY - ey, lz = realZ - ez, ll = Math.hypot(lx, ly, lz) || 1;
      const ph = game.props.raycast(ex, ey, ez, lx / ll, ly / ll, lz / ll, ll - 0.4);
      blocked = !!ph;
    }
    faceYaw = yawTo(tx - c.x, tz - c.z);
    facePitch = Math.atan2(ty - (c.y + P.EYE), Math.hypot(tx - c.x, tz - c.z) || 0.01);
    // the bot's aim (crosshair) moves over to you: quick at first, slowing down as it closes in,
    // never snapping. Skilled bots move it faster.
    const maxTurn = (1.3 + 1.9 * b.skill) * Math.min(1, 0.55 + d / 8);      // rad/s at most (spinning round to follow someone right next to them is slower)
    const ease = 1 - Math.exp(-(2.2 + 2.8 * b.skill) * dt);
    const yErr = angleDiff(c.yaw, faceYaw), pErr = facePitch - c.pitch;
    c.yaw = turnToward(c.yaw, faceYaw, Math.min(maxTurn * dt, Math.abs(yErr) * ease + 0.02 * dt));
    c.pitch += clamp(pErr * ease * 0.6, -maxTurn * 0.5 * dt, maxTurn * 0.5 * dt);   // looking up / down is slower
    b.reactT -= dt;
    const err = Math.abs(angleDiff(c.yaw, faceYaw));
    // knife up close, revolver further away
    // ----- weapon choice -----
    // Bot seekers keep the revolver out, however close the prop is. Only if a bot already has the knife in
    // hand might it keep using it (more likely for skilled bots), and only pros sometimes pull the knife out
    // when a prop is right next to them. Pros chase with the knife; everyone else just walks in, or goes
    // back to the gun if the prop gets away.
    const pro = b.skill > 0.7;
    if (b.wKey !== key) {
      b.wKey = key; b.closeRolled = false;
      // already holding a melee weapon (knife or crowbar): maybe keep using it
      const held = weaponOf(c);
      // the revolver is the main weapon. A bot already holding a melee weapon might keep using it
      // (clumsy bots more than skilled ones, who prefer the gun)
      b.knife = (held === 1 || held === 3) && Math.random() < 0.15 + 0.3 * (1 - b.skill);
      b.melee = held === 3 ? 'crowbar' : held === 1 ? 'knife' : (Math.random() < 0.5 ? 'crowbar' : 'knife');
      // now and then they decide to throw the knife / crowbar at it instead
      b.throwPlan = Math.random() < (tp ? 0.06 : 0.12);
      if (b.throwPlan) { b.knife = true; b.melee = Math.random() < 0.5 ? 'crowbar' : 'knife'; }
      // aiming the revolver at something small takes longer (a keyboard is much harder to line up than a person)
      const size = tp ? propHeight(tp.type) : target.disguise ? propHeight(target.disguise) : 1.8;
      b.reactT = Math.max(b.reactT, 0) + clamp((0.9 - size) / 0.9, 0, 1) * (1.0 - 0.45 * b.skill) * rand(0.8, 1.2);
    }
    if (!b.knife && !b.closeRolled && d < W.KNIFE_RANGE * 1.2) {
      b.closeRolled = true;
      // a prop right next to them: now and then they go melee (skilled bots mostly stick to the gun),
      // and then it's the knife or the crowbar, 50/50
      if (Math.random() < 0.08 + 0.3 * (1 - b.skill)) { b.knife = true; b.melee = Math.random() < 0.5 ? 'crowbar' : 'knife'; }
    }
    if (b.knife && !pro && d > 6 && !b.throwPlan) b.knife = false;
    // (fall back to the other melee weapon if that one isn't in hand any more, e.g. it was thrown)
    if (b.melee === 'crowbar' && !c.hasCrowbar) b.melee = 'knife';
    if (b.melee !== 'crowbar' && !c.hasKnife) b.melee = c.hasCrowbar ? 'crowbar' : null;
    if (!b.melee) b.knife = false;
    const useKnife = b.knife;
    hold(c, useKnife ? b.melee : 'revolver');
    // the crosshair has to rest on you for a moment before they pull the trigger: longer up close (unexpected)
    // and far away (small target), quickest in between, and longer the faster you move (already near the crosshair = this is all the wait there is)
    const onTarget = err < (8 - 5 * b.skill) * DEG;
    b.settle = onTarget ? (b.settle || 0) + dt : Math.max(0, (b.settle || 0) - dt * 2);
    const settleNeed = (0.12 + 0.3 * (1 - b.skill)) * (1 + 2.5 / Math.max(1, d) + d / 20) * (target && !tp ? 1 + Math.min(1.5, (target.speed || 0) / 4) : 1) * (b.shots > 0 ? 0.5 : 1);
    if (visible && !blocked && b.reactT <= 0 && c.attackCd <= 0 && game.phase === 'play') {
      if (b.throwPlan && useKnife && weaponOf(c) === (b.melee === 'crowbar' ? 3 : 1) && d > 2.5 && d < 10 && err < 6 * DEG && b.settle >= settleNeed) {
        // throw it (then back to the revolver; they can pick it up again later)
        game.hostAction(c, 'throw'); b.shots++; b.throwPlan = false; b.knife = false;
      } else if (useKnife && weaponOf(c) === (b.melee === 'crowbar' ? 3 : 1) && err < 30 * DEG && d < W.KNIFE_RANGE * 0.95) {
        // a moving, dodging target is hard to stab: sometimes the swing just misses
        const miss = target && !tp ? Math.min(0.75, (target.speed || 0) * (0.09 - 0.04 * b.skill) + b.trk.jerk * 0.03 * (1.2 - 0.6 * b.skill)) : 0;
        if (Math.random() < miss) { c.attackCd = W.KNIFE_COOLDOWN; game.emit({ e: 'swing', id: c.id }); }
        else game.hostAction(c, 'attack');
        b.shots++;
      } else if (!useKnife && weaponOf(c) === 2 && err < (8 - 5 * b.skill) * DEG && d < 45 && b.settle >= settleNeed) {
        // shot spread grows at longer range, while the bot moves, the faster the target moves,
        // the more erratic it is, and now and then just by bad luck (less often for skilled bots)
        let spread = B.AIM_SPREAD_DEG * DEG * (2.0 - 1.6 * b.skill) * rand(0.8, 1.2) * (1 + d / 16) * (c.speed > 1 ? 1.6 - 0.4 * b.skill : 1);
        if (target && !tp) {
          const fast = Math.max(0, (target.speed || 0) - 3) / 3.6;                           // 0 at walking, 1 at full sprint, more when faster
          spread *= 1 + fast * fast * (1.6 - 0.6 * b.skill);                                  // mainly really fast targets
          spread *= 1 + Math.min(2.5, b.trk.jerk * 0.12) * (1 - 0.6 * b.skill);              // jumping / zig-zagging
        }
        if (Math.random() < 0.08 - 0.05 * b.skill) spread *= rand(1.6, 2.4);              // an occasional bad shot
        game.gunAttack(c, spread); b.shots++;
      }
      if (tp && b.shots > 0) { b.targetProp = null; b.state = 'wander'; }   // tested it once, move on
    }
    // positioning: get closer if far / no sight
    if (!sees && Math.hypot(realX - c.x, realZ - c.z) < 1.3) {
      // reached the last place it saw you: stand and look around
      b.path = null;
      b.lookT = (b.lookT || 0) - dt;
      if (b.lookT <= 0) { b.lookYaw = c.yaw + rand(-2.2, 2.2); b.lookT = rand(0.4, 0.8); }
      c.yaw = turnToward(c.yaw, b.lookYaw, 4 * dt);
    } else if (!visible || blocked || d > 14) {
      b.repathT -= dt;
      if (!b.path || b.repathT <= 0) setPath(game, c, b, realX, realZ);
      const v = followPath(game, c, b);
      mx = v.x; mz = v.z;
      b.run = (useKnife ? pro && d > 2.5 : d > 10) || (!!b.chaseRun && !tp && d > 3);
    } else if (useKnife && d > 1.2) {
      mx = dx / d; mz = dz / d; b.path = null;          // knife: pros run them down, everyone else walks in
      b.run = (pro || !!b.chaseRun) && d > 2.5;
    } else b.path = null;                               // gun: hold position and shoot
    // give up on a furniture test that takes too long
    b.engageT = tp ? (b.engageT || 0) + dt : 0;     // (only furniture tests time out; people are chased until lost)
    if (b.engageT > 8) { b.engageT = 0; b.state = 'wander'; b.targetProp = null; b.targetId = null; }
  } else {
    b.engageT = 0;
    const v = followPath(game, c, b);
    mx = v.x; mz = v.z;
    if (!b.path && !c.disguise && c.team === 'seeker') {
      // idle seeker: look around
      b.lookT -= dt;
      if (b.lookT <= 0) {
        b.lookYaw = c.yaw + rand(-1.6, 1.6) * (1 + b.skill * 0.8); b.lookT = rand(1, 3) * (1 - 0.6 * b.skill);
        // now and then they glance down at the floor around them (that's when they can catch small props down there)
        if (Math.random() < 0.25 + 0.2 * b.skill) { b.lookPitch = -rand(0.35, 0.8); b.lookPitchT = rand(0.8, 1.6); }
      }
      c.yaw = turnToward(c.yaw, b.lookYaw, 2.5 * dt);
      if ((b.lookPitchT = (b.lookPitchT || 0) - dt) > 0) c.pitch += clamp(b.lookPitch - c.pitch, -1.2 * dt, 1.2 * dt);   // glancing down / up, slowly
      else c.pitch *= 0.95;
    }
  }

  // ----- someone standing in the way -----
  // Bots don't weave around people. They stop and wait; only after being blocked
  // BLOCKS_BEFORE_DETOUR times do they walk around (or pick somewhere else to go).
  if (mx || mz) {
    let blocker = null;
    for (const o of game.chars.values()) {
      if (o === c || !o.alive || o === target || o.disguise) continue;   // disguised props are steered around below
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
      if (p.removed) continue;
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
    // disguised props (people pretending to be furniture) get walked around just like real furniture
    for (const o of game.chars.values()) {
      if (o === c || !o.alive || !o.disguise || o === target) continue;
      const dx = c.x - o.x, dz = c.z - o.z, d = Math.hypot(dx, dz), R = (o.shapeR || 0.4) + P.RADIUS + 0.5;
      if (d > R || d < 1e-3) continue;
      const k = (R - d) / R, ahead = -(dx * mx + dz * mz) / d;
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
  // startled props (fleeing) jump around a lot more
  if (c.onGround && b.state === 'flee' && !c.disguise && Math.random() < B.JUMPINESS * 3 * dt) b.jump = true;
  // prop bots on the move now and then just hold jump for a bit (bunny hops; against a wall it climbs it)
  if (c.team === 'prop' && !c.disguise && (b.state === 'hide' || b.state === 'flee') && (mx || mz)) {
    if (!(b.holdJumpT > 0) && Math.random() < dt * (b.state === 'flee' ? 0.5 : 0.12)) b.holdJumpT = rand(0.4, 1.6);
    // and hold run for a while at random
    if (!(b.holdRunT > 0) && Math.random() < dt * 0.15) b.holdRunT = rand(1, 4);
  }
  if (b.holdJumpT > 0) { b.holdJumpT -= dt; b.jump = true; }
  if (b.holdRunT > 0) { b.holdRunT -= dt; if (c.team === 'prop' && !c.disguise) b.run = true; }
  if (c.onGround && b.state === 'wander' && b.path && Math.random() < 0.04 * dt) b.jump = true;
  // prop bots on the move: wander in wavy / zig-zag lines instead of straight, and now and then climb a wall
  if (c.team === 'prop' && !c.disguise && (mx || mz) && (b.state === 'hide' || b.state === 'flee')) {
    if (b.zig === undefined) { b.zig = Math.random() < 0.7 ? rand(0.25, 0.75) : 0; b.zigF = rand(1.2, 3.2); b.zigP = rand(0, 6); }
    if (b.zig) {
      b.zigP += dt * b.zigF * (b.run ? 1.6 : 1);
      const w = Math.sin(b.zigP) * b.zig, px = -mz, pz = mx;
      const nx = mx + px * w, nz = mz + pz * w;
      if (circleFree(game.map, c.x + nx * 0.6, c.z + nz * 0.6, P.RADIUS)) { const l = Math.hypot(nx, nz) || 1; mx = nx / l; mz = nz / l; }
    }
    // climbing: running into a wall, keep jumping up it for a bit (fleeing props, or just for fun while hiding)
    if (!(b.climbT > 0) && ((b.state === 'flee' && b.climbTry && Math.random() < dt * 3) || Math.random() < dt * 0.04)) {
      // a wall close by? run into it and climb it (holding jump against the wall)
      const a0 = Math.random() * Math.PI * 2;
      search: for (const reach of [1.1, 2.0]) for (let k = 0; k < 8; k++) {
        const a = a0 + k * Math.PI / 4, dx = Math.sin(a), dz = Math.cos(a);
        if (!circleFree(game.map, c.x + dx * reach, c.z + dz * reach, P.RADIUS)) { b.climbT = rand(1.2, 2.8); b.climbDir = { x: dx, z: dz }; break search; }
      }
    }
  }
  if (b.climbT > 0) {
    b.climbT -= dt;
    mx = b.climbDir.x; mz = b.climbDir.z; b.jump = true;
    if (b.climbT <= 0) b.climbTry = Math.random() < 0.3;
  }
  if (frozen) { mx = 0; mz = 0; b.jump = false; c.yaw = yaw0; c.pitch = pitch0; }
  moveCharacter(c, { mx, mz, run: b.run, jump: b.jump, wallClimb: c.team === 'prop' }, dt, game.map);
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

export { oddness };   // (used by tests)
