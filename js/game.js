// =====================================================================
//  GAME.JS — one match. Runs in 3 modes:
//    'offline' : you + bots, no network
//    'host'    : you run the server (authoritative) + bots, others join
//    'client'  : you joined someone else's server
//
//  The HOST decides everything important (roles, hits, deaths, pickups,
//  rounds). Clients only send their own movement and button presses.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js';
import { CONFIG } from './config.js';
import { clamp, shuffle, pick, dirFromAngles, forwardX, forwardZ, turnToward, textColor, wrapAngle, DEG, rand } from './util.js';
import { moveCharacter, separateCharacters, raycastMap, rayVsCharacter, hasLOS, groundHeight, pushOutOfProps } from './physics.js';
import { CharacterModel, ViewModel, makeKnifeMesh, makeGunMesh, randomLook, sanitizeLook } from './character.js';
import { PropSystem } from './props.js';
import { Ragdoll } from './ragdoll.js';
import { Audio } from './audio.js';
import { initBrain, updateBots, botsOnKill, botsOnShot } from './bots.js';

const P = CONFIG.PLAYER;
const W = CONFIG.WEAPONS;
const r2 = (v) => Math.round(v * 100) / 100;
const FLASH_GEO = new THREE.SphereGeometry(0.12, 8, 6);

// Flags packed into snapshots
const F_ALIVE = 1, F_KNIFE = 2, F_GUN = 4, F_GROUND = 8, F_RUN = 16;

export function newChar(id, nick, isBot, look) {
  return {
    id, nick, isBot, cid: null, look: sanitizeLook(look),
    bname: '', color: 0x888888,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    onGround: true, speed: 0, running: false, stamina: P.STAMINA_MAX, exhausted: false,
    alive: false, spectator: true,
    role: 'none', hasKnife: false, hasGun: false, equipped: false, gunBanned: false,
    attackCd: 0,
    // render state (smoothed)
    rx: 0, ry: 0, rz: 0, ryaw: 0, rpitch: 0, rspeed: 0, rground: true,
    weaponVis: 0, model: null, stepAcc: 0,
    brain: null,
  };
}

export const weaponOf = (c) => (!c.equipped ? 0 : c.hasKnife ? 1 : c.hasGun ? 2 : 0);

export class Game {
  constructor(o) {
    this.o = o;
    this.mode = o.mode;
    this.isHost = o.mode !== 'client';
    this.net = o.net || null;
    this.scene = o.scene;
    this.camera = o.camera;
    this.map = o.map;
    this.nav = o.nav;
    this.T = o.textures;
    this.ui = o.ui;
    this.serverLabel = o.serverLabel || 'Offline';
    this.code = o.code || null;

    this.chars = new Map();
    this.localId = null;
    this.items = new Map();       // id -> {id,type:'gun'|'knife',x,y,z,vx,vy,vz,flying,owner}
    this.itemMeshes = new Map();
    this.partSpots = [];          // positions of the 5 parts this round
    this.myParts = new Set();     // indices I collected
    this.partsVisible = false;
    this.partMeshes = [];
    this.ragdolls = new Map();    // char id -> Ragdoll
    this.tracers = [];
    this.phase = 'waiting';
    this.timeLeft = 0;
    this.myRole = 'none';
    this.deathT = 0;
    this.specId = null;
    this.lastLocalShot = 0;
    this.localGunCd = 0;
    this.time = 0;
    this.ended = false;
    this.scoreOpen = false;

    // host-only
    this.nextId = 1;
    this.nextItem = 1;
    this.partsCollected = new Map(); // charId -> Set
    this.craftedBy = null;
    this.corpses = [];
    this.snapT = 0;
    this.sendT = 0;
    this.cidToId = new Map();
    this.botNames = shuffle(CONFIG.BOTS.NAMES.slice());

    this.settings = o.settings || {};
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.viewModel = new ViewModel(this.camera, this.T);
    this.props = new PropSystem(this.map, this.root, this.T, this.isHost);
    this.camDist = this.settings.camDist || 0;
    this.trails = new Map();     // flying knife wind trails
    this.propSndT = 0;
    this.camera.rotation.order = 'YXZ';

    if (this.net) {
      if (this.isHost) {
        this._onMsg = (cid, m) => this.hostOnMessage(cid, m);
        this._onLeave = (cid) => this.hostOnLeave(cid);
        this.net.on('message', this._onMsg);
        this.net.on('leave', this._onLeave);
      } else {
        this._onMsg = (m) => this.clientOnMessage(m);
        this._onClose = (why) => this.exit(why === 'timeout' ? 'Lost connection to the server.' : 'The host closed the server.');
        this.net.on('message', this._onMsg);
        this.net.on('close', this._onClose);
      }
    }

    if (this.isHost) {
      const me = this.addChar(newChar(this.nextId++, o.myName, false, o.myLook));
      this.localId = me.id;
      this.ensureBots();
      this.phase = 'waiting';
      this.timeLeft = 2;
    } else {
      this.applyWelcome(o.welcome);
    }
  }

  get me() { return this.chars.get(this.localId); }

  // ---------------------------------------------------------------
  //  Characters
  // ---------------------------------------------------------------
  addChar(c) {
    c.model = new CharacterModel(this.T, c.look);
    c.model.setColor(c.color);
    c.model.addTo(this.root);
    c.model.setVisible(false);
    this.chars.set(c.id, c);
    if (c.isBot && this.isHost) c.brain = initBrain(c);
    return c;
  }

  removeChar(id) {
    const c = this.chars.get(id);
    if (!c) return;
    c.model.removeFrom(this.root);
    const rd = this.ragdolls.get(id);
    if (rd) { rd.dispose(); this.ragdolls.delete(id); }
    c.model.dispose();
    this.chars.delete(id);
  }

  roster() {
    return [...this.chars.values()].map((c) => ({ id: c.id, nick: c.nick, bname: c.bname, color: c.color, bot: c.isBot ? 1 : 0, ap: c.look }));
  }

  // ---------------------------------------------------------------
  //  HOST: bots, rounds, events
  // ---------------------------------------------------------------
  humans() { return [...this.chars.values()].filter((c) => !c.isBot); }
  bots() { return [...this.chars.values()].filter((c) => c.isBot); }

  ensureBots() {
    const S = CONFIG.SERVER;
    const humans = this.humans().length;
    const want = clamp(S.FILL_WITH_BOTS_TO - humans, 0, Math.max(0, S.MAX_PLAYERS - humans));
    let bots = this.bots();
    while (bots.length > want) { const b = bots.pop(); this.removeChar(b.id); }
    while (bots.length < want) {
      const name = this.botNames[this.nextId % this.botNames.length];
      const b = this.addChar(newChar(this.nextId++, name, true, randomLook()));
      bots.push(b);
    }
  }

  // Send an event to everyone (null) or to a list of character ids.
  emit(ev, toIds = null) {
    if (toIds === null) {
      if (this.net) this.net.broadcast({ t: 'ev', e: ev });
      this.applyEvent(ev);
      return;
    }
    for (const id of toIds) {
      const c = this.chars.get(id);
      if (!c) continue;
      if (id === this.localId) this.applyEvent(ev);
      else if (c.cid != null && this.net) this.net.send(c.cid, { t: 'ev', e: ev });
    }
  }

  partsEventFor(c) {
    const have = [...(this.partsCollected.get(c.id) || [])];
    return { e: 'parts', spots: this.craftedBy == null ? this.partSpots.map((p) => [r2(p.x), r2(p.y), r2(p.z)]) : null, have };
  }
  sendPartsToAll() {
    for (const c of this.humans()) this.emit(this.partsEventFor(c), [c.id]);
  }

  startRound() {
    this.ensureBots();
    const all = [...this.chars.values()];
    if (all.length < 2) { this.phase = 'waiting'; this.timeLeft = 2; return; }
    this.emit({ e: 'reset' });
    this.items.clear();
    this.corpses = [];
    this.craftedBy = null;
    this.props.reset();
    this.partsCollected.clear();

    // gun parts
    const spots = shuffle(this.map.partSpots.slice()).slice(0, CONFIG.GUNPARTS.COUNT);
    this.partSpots = spots.map((s) => ({ x: s.x, y: groundHeight(this.map, s.x, s.z, 0.1, 9), z: s.z }));

    // identities
    const ids = shuffle(CONFIG.IDENTITIES.slice());
    all.forEach((c, i) => { const [n, col] = ids[i % ids.length]; c.bname = n; c.color = col; c.model.setColor(col); });

    // roles
    const order = shuffle(all.slice());
    const murderer = order[0], sheriff = order[1];
    const spawns = shuffle(this.map.spawns.slice());
    all.forEach((c, i) => {
      c.role = c === murderer ? 'murderer' : c === sheriff ? 'sheriff' : 'innocent';
      c.hasKnife = c === murderer;
      c.hasGun = c === sheriff;
      c.equipped = false;
      c.gunBanned = false;
      c.attackCd = 0;
      c.alive = true; c.spectator = false;
      const s = spawns[i % spawns.length];
      const off = Math.floor(i / spawns.length) * 0.8;
      c.x = s.x + off; c.z = s.z; c.y = 0; c.vx = c.vy = c.vz = 0;
      c.yaw = Math.random() * Math.PI * 2; c.pitch = 0;
      c.stamina = P.STAMINA_MAX; c.exhausted = false;
      c.rx = c.x; c.ry = c.y; c.rz = c.z; c.ryaw = c.yaw;
      if (c.isBot) c.brain = initBrain(c);
      this.partsCollected.set(c.id, new Set());
    });

    this.emit({ e: 'roster', list: this.roster() });
    for (const c of all) {
      if (c.isBot) continue;
      this.emit({ e: 'spawn', x: r2(c.x), y: r2(c.y), z: r2(c.z), yaw: r2(c.yaw) }, [c.id]);
      this.emit({ e: 'role', role: c.role }, [c.id]);
      this.emit(this.partsEventFor(c), [c.id]);
    }
    this.phase = 'pre';
    this.timeLeft = CONFIG.ROUND.PRE_TIME;
    this.emit({ e: 'phase', phase: 'pre', tl: this.timeLeft });
  }

  endRound(winner, reason = '') {
    if (this.phase !== 'play' && this.phase !== 'pre') return;
    const m = [...this.chars.values()].find((c) => c.role === 'murderer');
    this.phase = 'post';
    this.timeLeft = CONFIG.ROUND.POST_TIME;
    this.emit({
      e: 'phase', phase: 'post', tl: this.timeLeft, winner, reason,
      murderer: m ? { bname: m.bname, color: m.color, nick: m.nick } : null,
    });
  }

  hostTick(dt) {
    this.timeLeft -= dt;
    if (this.phase === 'waiting' && this.timeLeft <= 0) this.startRound();
    else if (this.phase === 'pre' && this.timeLeft <= 0) {
      this.phase = 'play';
      this.timeLeft = CONFIG.ROUND.TIME_LIMIT;
      this.emit({ e: 'phase', phase: 'play', tl: this.timeLeft });
    } else if (this.phase === 'play') {
      const all = [...this.chars.values()];
      const m = all.find((c) => c.role === 'murderer');
      const innocentsAlive = all.filter((c) => c.alive && c.role !== 'murderer').length;
      if (!m || !m.alive) this.endRound('bystanders', m ? '' : 'The murderer left the game.');
      else if (innocentsAlive === 0) this.endRound('murderer');
      else if (this.timeLeft <= 0) this.endRound('bystanders', 'The murderer ran out of time.');
    } else if (this.phase === 'post' && this.timeLeft <= 0) {
      this.startRound();
    }

    for (const c of this.chars.values()) {
      if (c.attackCd > 0) c.attackCd -= dt;
      // live knife slash: keep checking for a short moment after the swing
      if (c.slashT > 0) {
        c.slashT -= dt;
        if (c.alive && weaponOf(c) === 1 && this.phase === 'play') this.knifeHitCheck(c); else c.slashT = 0;
      }
    }

    // Bots think + move
    updateBots(this, dt);
    // Bots get pushed by everyone (humans control their own position)
    separateCharacters([...this.chars.values()], this.map, (c) => c.isBot);
    this.props.step(dt, [...this.chars.values()]);
    // prop impact sounds (throttled)
    this.propSndT -= dt;
    for (const e of this.props.events) {
      if (this.propSndT > 0) break;
      this.propSndT = 0.06;
      this.emit({ e: 'prop', p: [r2(e.p.x), r2(e.p.y + 0.3), r2(e.p.z)], s: e.p.def.sound, v: r2(Math.min(1, e.s / 8)) });
    }
    this.props.events.length = 0;

    this.hostItems(dt);
    this.hostPickups();

    // Snapshots
    this.snapT -= dt;
    if (this.net && this.snapT <= 0) {
      this.snapT = 1 / CONFIG.NET.SNAPSHOT_RATE;
      this.sendSnapshots();
    }
  }

  sendSnapshots() {
    const cs = [];
    for (const c of this.chars.values()) {
      let f = 0;
      if (c.alive) f |= F_ALIVE;
      const w = weaponOf(c);
      if (w === 1) f |= F_KNIFE;
      if (w === 2) f |= F_GUN;
      if (c.onGround) f |= F_GROUND;
      if (c.running) f |= F_RUN;
      cs.push([c.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yaw), r2(c.pitch), f, r2(c.speed)]);
    }
    const it = [...this.items.values()].map((i) => [i.id, i.type === 'gun' ? 0 : 1, r2(i.x), r2(i.y), r2(i.z), i.flying ? 1 : 0]);
    const pr = this.props.snapshot(1 / CONFIG.NET.SNAPSHOT_RATE);
    for (const c of this.humans()) {
      if (c.cid == null) continue;
      this.net.send(c.cid, {
        t: 'snap', ph: this.phase, tl: r2(this.timeLeft), c: cs, it, pr,
        me: { k: c.hasKnife ? 1 : 0, g: c.hasGun ? 1 : 0, eq: c.equipped ? 1 : 0, cd: r2(Math.max(0, c.attackCd)), al: c.alive ? 1 : 0 },
      });
    }
  }

  // ----- host: networking -----
  hostOnMessage(cid, m) {
    if (m.t === 'info') {
      const h = this.humans().length;
      this.net.send(cid, { t: 'info', name: this.serverLabel, humans: h, total: this.chars.size, max: CONFIG.SERVER.MAX_HUMANS, phase: this.phase, ver: CONFIG.VERSION });
      return;
    }
    if (m.t === 'hello') {
      if (this.cidToId.has(cid)) return;
      if (this.humans().length >= CONFIG.SERVER.MAX_HUMANS) { this.net.send(cid, { t: 'reject', reason: 'Server is full' }); return; }
      const nick = String(m.name || 'Player').slice(0, 20);
      const c = this.addChar(newChar(this.nextId++, nick, false, m.ap));
      c.cid = cid;
      this.cidToId.set(cid, c.id);
      // the new player spectates until next round; a bot leaves at round end
      c.bname = '???'; c.color = 0x777777;
      this.net.send(cid, {
        t: 'welcome', id: c.id, roster: this.roster(), phase: this.phase, tl: r2(this.timeLeft),
        server: this.serverLabel, code: this.code, props: this.props.fullState(),
      });
      this.emit({ e: 'roster', list: this.roster() });
      this.emit({ e: 'msg', text: `${nick} joined the server`, color: '#9ad' });
      if (this.phase === 'waiting') this.timeLeft = Math.min(this.timeLeft, 2);
      return;
    }
    const id = this.cidToId.get(cid);
    const c = this.chars.get(id);
    if (!c) return;
    if (m.t === 'in') {
      if (!c.alive || !Array.isArray(m.p)) return;
      const [x, y, z] = m.p;
      if (![x, y, z].every(Number.isFinite)) return;
      // basic sanity: ignore teleports (except right after spawn)
      if (Math.hypot(x - c.x, z - c.z) > 12 && performance.now() - (c.spawnAt || 0) > 1500) return;
      c.x = x; c.y = y; c.z = z;
      if (Array.isArray(m.v)) { c.vx = +m.v[0] || 0; c.vy = +m.v[1] || 0; c.vz = +m.v[2] || 0; }
      c.yaw = +m.yw || 0; c.pitch = clamp(+m.pt || 0, -1.6, 1.6);
      c.onGround = !!m.g; c.running = !!m.r; c.speed = +m.s || 0;
    } else if (m.t === 'act') {
      if (Number.isFinite(m.yw)) c.yaw = m.yw;
      if (Number.isFinite(m.pt)) c.pitch = clamp(m.pt, -1.6, 1.6);
      this.hostAction(c, m.a);
    } else if (m.t === 'chat') {
      const text = String(m.m || '').slice(0, 120);
      if (text) this.emit({ e: 'chat', from: c.nick, color: c.color, text });
    }
  }

  hostOnLeave(cid) {
    const id = this.cidToId.get(cid);
    this.cidToId.delete(cid);
    const c = this.chars.get(id);
    if (!c) return;
    const wasMurderer = c.role === 'murderer' && c.alive;
    if (c.hasGun && c.alive) this.dropGun(c);
    this.removeChar(id);
    this.emit({ e: 'roster', list: this.roster() });
    this.emit({ e: 'msg', text: `${c.nick} left the server`, color: '#9ad' });
    if (wasMurderer) this.endRound('bystanders', 'The murderer left the game.');
  }

  // ----- host: actions (from local input, clients, or bots) -----
  hostAction(c, a) {
    if (!c || !c.alive) return;
    if (a === 'suicide') { this.kill(c, null, 'suicide', { x: Math.random() - 0.5, y: 0, z: Math.random() - 0.5 }); return; }
    if (a === 'equip') {
      if (c.hasKnife || c.hasGun) c.equipped = !c.equipped;
      return;
    }
    if (a === 'attack') {
      const w = weaponOf(c);
      if (w === 0) { if (c.hasKnife || c.hasGun) c.equipped = true; return; }
      if (this.phase !== 'play' || c.attackCd > 0) return;
      if (w === 1) this.knifeAttack(c);
      else this.gunAttack(c);
      return;
    }
    if (a === 'throw') {
      if (weaponOf(c) !== 1 || this.phase !== 'play' || c.attackCd > 0) return;
      c.attackCd = W.KNIFE_THROW_COOLDOWN;
      c.hasKnife = false; c.equipped = false;
      const d = dirFromAngles(c.yaw, c.pitch + 0.03);
      const id = this.nextItem++;
      this.items.set(id, {
        id, type: 'knife', flying: true, owner: c.id,
        x: c.x + d.x * 0.5, y: c.y + P.EYE - 0.1, z: c.z + d.z * 0.5,
        vx: d.x * W.KNIFE_THROW_SPEED + c.vx * 0.5, vy: d.y * W.KNIFE_THROW_SPEED + 1, vz: d.z * W.KNIFE_THROW_SPEED + c.vz * 0.5,
      });
      this.emit({ e: 'throw', id: c.id });
    }
  }

  // A stab is a slash that stays "live" for a short moment (KNIFE_SLASH_WINDOW):
  // if you swing a bit early and turn onto someone right after, it still hits.
  knifeAttack(c) {
    c.attackCd = W.KNIFE_COOLDOWN;
    c.slashT = W.KNIFE_SLASH_WINDOW;
    this.emit({ e: 'swing', id: c.id });
    this.knifeHitCheck(c);
  }

  knifeHitCheck(c) {
    const fx = forwardX(c.yaw), fz = forwardZ(c.yaw);
    const cosA = Math.cos(W.KNIFE_ANGLE_DEG * DEG);
    let best = null, bd = Infinity;
    for (const o of this.chars.values()) {
      if (o === c || !o.alive) continue;
      const dx = o.x - c.x, dz = o.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > W.KNIFE_RANGE + P.RADIUS || Math.abs(o.y - c.y) > 1.3) continue;
      if (d > 0.4 && (dx * fx + dz * fz) / d < cosA) continue;
      if (!hasLOS(this.map, c.x, c.y + 1.3, c.z, o.x, o.y + 1.1, o.z)) continue;
      if (d < bd) { bd = d; best = o; }
    }
    if (best) {
      c.slashT = 0;
      const d = Math.hypot(best.x - c.x, best.z - c.z) || 1;
      this.kill(best, c, 'knife', { x: ((best.x - c.x) / d) * 3, y: 0.5, z: ((best.z - c.z) / d) * 3 });
    }
  }

  gunAttack(c, spread = 0) {
    c.attackCd = W.GUN_COOLDOWN;
    const yaw = c.yaw + (Math.random() - 0.5) * spread, pitch = c.pitch + (Math.random() - 0.5) * spread;
    const d = dirFromAngles(yaw, pitch);
    const ox = c.x, oy = c.y + P.EYE, oz = c.z;
    const wall = raycastMap(this.map, ox, oy, oz, d.x, d.y, d.z, W.GUN_RANGE);
    let hit = null, ht = wall;
    for (const o of this.chars.values()) {
      if (o === c || !o.alive) continue;
      const t = rayVsCharacter(ox, oy, oz, d.x, d.y, d.z, o);
      if (t >= 0 && t < ht) { ht = t; hit = o; }
    }
    // furniture blocks bullets (and gets knocked around)
    const ph = this.props.raycast(ox, oy, oz, d.x, d.y, d.z, ht);
    if (ph) {
      hit = null; ht = ph.t;
      this.props.impulseAt(ph.prop, ph.point, new THREE.Vector3(d.x * 7, d.y * 7 + 1, d.z * 7));
    }
    this.emit({ e: 'shot', id: c.id, f: [r2(ox), r2(oy - 0.15), r2(oz)], t: [r2(ox + d.x * ht), r2(oy + d.y * ht), r2(oz + d.z * ht)] });
    botsOnShot(this, c, hit);
    if (hit) {
      this.kill(hit, c, 'gun', { x: d.x * 7, y: d.y * 7 + 1, z: d.z * 7 });
      // shooting an innocent bystander costs the shooter's life (and the gun drops)
      if (W.SHERIFF_DIES_ON_INNOCENT_KILL && c.role !== 'murderer' && hit.role !== 'murderer' && c.alive) {
        this.emit({ e: 'msg', text: 'You shot a bystander', color: '#f55', big: 1 }, [c.id]);
        this.kill(c, null, 'penalty', { x: -d.x * 1.5, y: 0.5, z: -d.z * 1.5 });
      }
    }
  }

  dropGun(c) {
    if (!c.hasGun) return;
    c.hasGun = false; c.equipped = false;
    const id = this.nextItem++;
    const fx = forwardX(c.yaw), fz = forwardZ(c.yaw);
    let x = c.x + fx * 0.6, z = c.z + fz * 0.6;
    if (this.map.heightAt(x, z) > P.STEP_HEIGHT) { x = c.x; z = c.z; }
    this.items.set(id, { id, type: 'gun', x, y: groundHeight(this.map, x, z, 0.1, c.y + 0.5) + 0.05, z, flying: false });
    if (this.craftedBy === c.id) {
      this.craftedBy = null;
      this.sendPartsToAll();
    }
  }

  kill(target, killer, cause, impulse) {
    if (!target.alive) return;
    target.alive = false;
    if (target.hasGun) this.dropGun(target);
    target.equipped = false;
    this.corpses.push({ id: target.id, x: target.x, y: target.y, z: target.z, t: this.time });
    this.emit({
      e: 'death', id: target.id, cause,
      i: [r2(impulse.x), r2(impulse.y), r2(impulse.z)],
      v: [r2(target.vx), r2(target.vy), r2(target.vz)],
      p: [r2(target.x), r2(target.y), r2(target.z)],
    });
    botsOnKill(this, target, killer, cause);
  }

  hostItems(dt) {
    for (const it of this.items.values()) {
      if (!it.flying) continue;
      const steps = 3;
      for (let s = 0; s < steps && it.flying; s++) {
        const h = dt / steps;
        it.vy -= 9 * h;
        const sp = Math.hypot(it.vx, it.vy, it.vz) || 1;
        const dx = it.vx / sp, dy = it.vy / sp, dz = it.vz / sp;
        const len = sp * h;
        const wall = raycastMap(this.map, it.x, it.y, it.z, dx, dy, dz, len);
        // characters
        let hit = null, ht = wall;
        for (const o of this.chars.values()) {
          if (!o.alive || o.id === it.owner) continue;
          const t = rayVsCharacter(it.x, it.y, it.z, dx, dy, dz, o, 0.4);
          if (t >= 0 && t <= ht) { ht = t; hit = o; }
        }
        const ph = this.props.raycast(it.x, it.y, it.z, dx, dy, dz, ht);
        if (ph) {
          hit = null;
          this.props.impulseAt(ph.prop, ph.point, new THREE.Vector3(dx * 3, dy * 3, dz * 3));
          it.x += dx * Math.max(0, ph.t - 0.1); it.y += dy * Math.max(0, ph.t - 0.1); it.z += dz * Math.max(0, ph.t - 0.1);
          it.flying = false;
          it.y = groundHeight(this.map, it.x, it.z, 0.1, it.y + 0.3) + 0.05;
          this.emit({ e: 'clink', p: [r2(it.x), r2(it.y), r2(it.z)] });
          break;
        }
        if (hit) {
          const owner = this.chars.get(it.owner);
          this.kill(hit, owner || null, 'knife', { x: dx * 5, y: 1, z: dz * 5 });
          it.flying = false;
          it.x = hit.x; it.z = hit.z; it.y = groundHeight(this.map, it.x, it.z, 0.1, hit.y + 0.5) + 0.05;
          break;
        }
        if (wall < len) {
          it.x += dx * Math.max(0, wall - 0.15); it.y += dy * Math.max(0, wall - 0.15); it.z += dz * Math.max(0, wall - 0.15);
          it.flying = false;
          it.y = groundHeight(this.map, it.x, it.z, 0.1, it.y + 0.3) + 0.05;
          this.emit({ e: 'clink', p: [r2(it.x), r2(it.y), r2(it.z)] });
          break;
        }
        it.x += dx * len; it.y += dy * len; it.z += dz * len;
      }
    }
  }

  hostPickups() {
    if (this.phase !== 'play' && this.phase !== 'pre') return;
    for (const c of this.chars.values()) {
      if (!c.alive) continue;
      // items
      for (const it of this.items.values()) {
        if (it.flying) continue;
        const d = Math.hypot(it.x - c.x, it.z - c.z);
        if (Math.abs(it.y - c.y) > 1.5) continue;
        if (it.type === 'gun' && d < W.GUN_PICKUP_RADIUS && c.role !== 'murderer' && !c.hasGun) {
          this.items.delete(it.id);
          c.hasGun = true; c.equipped = true;
          this.emit({ e: 'msg', text: 'You picked up the revolver — you are the Sheriff now!', color: '#6af', snd: 'gun', big: 1 }, [c.id]);
          break;
        }
        if (it.type === 'knife' && d < W.KNIFE_PICKUP_RADIUS && c.role === 'murderer' && !c.hasKnife) {
          this.items.delete(it.id);
          c.hasKnife = true;
          this.emit({ e: 'msg', text: 'You picked your knife back up.', color: '#f66', snd: 'pickup' }, [c.id]);
          break;
        }
      }
      // gun parts (only one crafted revolver can exist at a time)
      if (this.craftedBy != null || c.role === 'murderer' || c.hasGun) continue;
      const set = this.partsCollected.get(c.id) || new Set();
      this.partsCollected.set(c.id, set);
      for (let k = 0; k < this.partSpots.length; k++) {
        if (set.has(k)) continue;
        const s = this.partSpots[k];
        if (Math.hypot(s.x - c.x, s.z - c.z) < CONFIG.GUNPARTS.PICKUP_RADIUS && Math.abs(s.y - c.y) < 1.2) {
          set.add(k);
          if (set.size >= CONFIG.GUNPARTS.COUNT) {
            c.hasGun = true; c.equipped = true;
            this.craftedBy = c.id;
            set.clear();
            this.emit({ e: 'msg', text: 'You built a revolver — you are the Sheriff now!', color: '#6af', snd: 'gun', big: 1 }, [c.id]);
            for (const o of this.humans()) if (o.id !== c.id) this.emit({ e: 'msg', text: 'Someone built a revolver. The gun parts vanished.', color: '#ccc' }, [o.id]);
            this.sendPartsToAll();
          } else if (!c.isBot) {
            this.emit(this.partsEventFor(c), [c.id]);
            this.emit({ e: 'msg', text: `Gun part ${set.size}/${CONFIG.GUNPARTS.COUNT}`, color: '#fd6', snd: 'pickup' }, [c.id]);
          }
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------
  //  CLIENT: handling messages from the host
  // ---------------------------------------------------------------
  applyWelcome(w) {
    this.localId = w.id;
    this.serverLabel = w.server || this.serverLabel;
    this.code = w.code || null;
    this.syncRoster(w.roster);
    this.phase = w.phase; this.timeLeft = w.tl;
    if (w.props) this.props.applyState(w.props);
  }

  syncRoster(list) {
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      let c = this.chars.get(r.id);
      if (!c) {
        c = newChar(r.id, r.nick, !!r.bot, r.ap);
        this.addChar(c);
      }
      c.nick = r.nick; c.bname = r.bname; c.isBot = !!r.bot;
      if (c.color !== r.color) { c.color = r.color; c.model.setColor(r.color); }
    }
    for (const id of [...this.chars.keys()]) if (!seen.has(id)) this.removeChar(id);
  }

  clientOnMessage(m) {
    if (m.t === 'snap') {
      this.phase = m.ph; this.timeLeft = m.tl;
      for (const s of m.c) {
        const c = this.chars.get(s[0]);
        if (!c) continue;
        const f = s[6];
        c.weaponVis = f & F_KNIFE ? 1 : f & F_GUN ? 2 : 0;
        if (c.id === this.localId) {
          if (m.me) {
            c.hasKnife = !!m.me.k; c.hasGun = !!m.me.g; c.equipped = !!m.me.eq;
            if (!m.me.al && c.alive) { c.alive = false; } // safety
          }
          continue;
        }
        const wasAlive = c.alive;
        c.alive = !!(f & F_ALIVE);
        c.x = s[1]; c.y = s[2]; c.z = s[3]; c.yaw = s[4]; c.pitch = s[5];
        c.onGround = !!(f & F_GROUND); c.running = !!(f & F_RUN); c.speed = s[7];
        if (c.alive && !wasAlive) { c.rx = c.x; c.ry = c.y; c.rz = c.z; c.ryaw = c.yaw; }
      }
      // items
      const seen = new Set();
      for (const [id, type, x, y, z, fl] of m.it) {
        seen.add(id);
        let it = this.items.get(id);
        if (!it) { it = { id, type: type === 0 ? 'gun' : 'knife', x, y, z }; this.items.set(id, it); }
        it.x = x; it.y = y; it.z = z; it.flying = !!fl;
      }
      for (const id of [...this.items.keys()]) if (!seen.has(id)) this.items.delete(id);
      if (m.pr) this.props.applyState(m.pr);
      return;
    }
    if (m.t === 'ev') { this.applyEvent(m.e); return; }
    if (m.t === 'kick') { this.exit(m.reason || 'Kicked from server.'); }
  }

  // ---------------------------------------------------------------
  //  EVENTS (run on host AND clients) — mostly visuals + local state
  // ---------------------------------------------------------------
  applyEvent(ev) {
    const ui = this.ui;
    switch (ev.e) {
      case 'reset':
        for (const rd of this.ragdolls.values()) rd.dispose();
        this.ragdolls.clear();
        for (const t of this.tracers) { this.root.remove(t.mesh); this.root.remove(t.flash); }
        this.tracers = [];
        if (!this.isHost) this.items.clear();
        this.myParts.clear();
        this.specId = null;
        this.myRole = 'none';
        break;
      case 'roster':
        if (!this.isHost) this.syncRoster(ev.list);
        ui.refreshScoreboard?.();
        break;
      case 'spawn': {
        const me = this.me;
        if (!me) break;
        me.x = ev.x; me.y = ev.y; me.z = ev.z; me.yaw = ev.yaw; me.pitch = 0;
        me.vx = me.vy = me.vz = 0; me.alive = true; me.spectator = false;
        me.stamina = P.STAMINA_MAX; me.exhausted = false; me.spawnAt = performance.now();
        this.deathT = 0;
        break;
      }
      case 'role': {
        this.myRole = ev.role;
        const me = this.me;
        if (me) me.role = ev.role;
        const R = {
          murderer: ['You are the Murderer', 'Kill everyone. Don\'t get caught.', '#e33'],
          sheriff: ['You are the Sheriff', 'You have a revolver. Find the murderer and shoot them — but never an innocent.', '#4af'],
          innocent: ['You are a Bystander', '', '#4af'],
        }[ev.role];
        if (R) ui.bigMessage(R[0], R[1], R[2], 4.5);
        Audio.roundStart(ev.role === 'murderer');
        break;
      }
      case 'parts':
        this.partSpots = ev.spots ? ev.spots.map(([x, y, z]) => ({ x, y, z })) : [];
        this.myParts = new Set(ev.have || []);
        this.partsVisible = !!ev.spots;
        this.rebuildPartMeshes();
        break;
      case 'phase':
        this.phase = ev.phase; this.timeLeft = ev.tl;
        if (ev.phase === 'play') ui.toast('The round has started', '#ddd');
        if (ev.phase === 'post') {
          const good = ev.winner === 'bystanders';
          const m = ev.murderer;
          const sub = (m ? `The murderer was <b style="color:${textColor(m.color)}">${escapeHtml(m.nick)}</b>` : '') + (ev.reason ? `<br>${ev.reason}` : '');
          ui.bigMessage(good ? 'Bystanders Win!' : 'The Murderer Wins!', sub, good ? '#4af' : '#e33', CONFIG.ROUND.POST_TIME - 0.5, true);
          const meGood = this.myRole !== 'murderer';
          Audio.roundEnd(good === meGood);
        }
        break;
      case 'death': {
        const c = this.chars.get(ev.id);
        if (!c) break;
        c.alive = false;
        const vel = { x: ev.v[0], y: ev.v[1], z: ev.v[2] };
        if (c.id !== this.localId) { c.x = ev.p[0]; c.y = ev.p[1]; c.z = ev.p[2]; }
        this.spawnRagdoll(c, vel, { x: ev.i[0], y: ev.i[1], z: ev.i[2] });
        const pos = { x: ev.p[0], y: ev.p[1] + 1, z: ev.p[2] };
        if (ev.cause === 'knife') Audio.stab(pos);
        Audio.thud(pos);
        if (ev.cause !== 'suicide' && Math.random() < 0.6) Audio.scream(pos);
        if (c.id === this.localId) {
          this.deathT = 0;
          this.ui.toast(ev.cause === 'suicide' ? 'You are now spectating. Press X again for the menu.' : 'You died! Press X for the main menu.', '#f66', 3);
        }
        break;
      }
      case 'shot': {
        this.addTracer(ev.f, ev.t);
        const c = this.chars.get(ev.id);
        if (ev.id === this.localId) {
          if (performance.now() - this.lastLocalShot > 400) { Audio.gunshot({ x: ev.f[0], y: ev.f[1], z: ev.f[2] }); this.viewModel.recoil(); }
        } else {
          Audio.gunshot({ x: ev.f[0], y: ev.f[1], z: ev.f[2] });
          c?.model.recoil();
        }
        break;
      }
      case 'swing': {
        if (ev.id === this.localId) break; // already played locally
        const c = this.chars.get(ev.id);
        if (c) { c.model.swing(); Audio.swing({ x: c.rx, y: c.ry + 1.4, z: c.rz }); }
        break;
      }
      case 'throw': {
        const c = this.chars.get(ev.id);
        if (c) Audio.swing({ x: c.rx, y: c.ry + 1.4, z: c.rz });
        if (ev.id === this.localId) this.viewModel.throwAnim();
        break;
      }
      case 'clink': Audio.clink({ x: ev.p[0], y: ev.p[1], z: ev.p[2] }); break;
      case 'prop': Audio.prop({ x: ev.p[0], y: ev.p[1], z: ev.p[2] }, ev.s, ev.v); break;
      case 'msg':
        if (ev.big) ui.bigMessage(ev.text, '', ev.color || '#fff', 2.5);
        else ui.toast(ev.text, ev.color || '#fff');
        if (ev.snd === 'pickup') Audio.pickup();
        if (ev.snd === 'gun') Audio.gunReady();
        break;
      case 'chat':
        ui.toast(`<b style="color:${textColor(ev.color)}">${escapeHtml(ev.from)}:</b> ${escapeHtml(ev.text)}`, '#fff', 6);
        break;
      default: break;
    }
  }

  spawnRagdoll(c, vel, impulse) {
    const old = this.ragdolls.get(c.id);
    if (old) old.dispose();
    // make sure the model pose matches where the character is right now
    c.model.update(0, { x: c.rx, y: c.ry, z: c.rz, yaw: c.ryaw, pitch: 0, speed: c.rspeed, onGround: true, weapon: 0 }, c.ry);
    const rd = new Ragdoll(this.root, c.model, this.map, vel, impulse);
    this.ragdolls.set(c.id, rd);
    c.model.setVisible(false);
  }

  addTracer(f, t) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...f), new THREE.Vector3(...t)]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    this.root.add(line);
    // muzzle flash
    // muzzle flash (a glowing ball, not a real light: adding lights at runtime stutters on phones)
    const flash = new THREE.Mesh(FLASH_GEO, new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 1, depthWrite: false }));
    flash.position.set(...f);
    this.root.add(flash);
    this.tracers.push({ mesh: line, flash, t: 0.12 });
  }

  rebuildPartMeshes() {
    for (const m of this.partMeshes) this.root.remove(m);
    this.partMeshes = [];
    if (!this.partsVisible) return;
    this.partSpots.forEach((s, k) => {
      const g = new THREE.Group();
      const metal = new THREE.MeshLambertMaterial({ color: 0x8a8f96, emissive: 0x332a00 });
      const variants = [
        () => new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.28, 8), metal),           // barrel
        () => new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 10), metal),          // cylinder
        () => new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.08), new THREE.MeshLambertMaterial({ color: 0x6a4020, emissive: 0x221100 })), // grip
        () => new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.05), metal),                   // frame
        () => new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.015, 6, 12), metal),               // trigger guard
      ];
      const piece = variants[k % variants.length]();
      piece.rotation.z = Math.PI / 2;
      g.add(piece);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 24), new THREE.MeshBasicMaterial({ color: 0xffd040, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = -0.33;
      g.add(ring);
      g.position.set(s.x, s.y + 0.35, s.z);
      g.userData.k = k;
      g.userData.piece = piece;
      this.root.add(g);
      this.partMeshes.push(g);
    });
  }

  syncItemMeshes(dt) {
    for (const [id, it] of this.items) {
      let m = this.itemMeshes.get(id);
      if (!m) {
        const inner = it.type === 'gun' ? makeGunMesh() : makeKnifeMesh();
        inner.scale.setScalar(1.6);
        m = new THREE.Group(); m.add(inner); m.userData.inner = inner;
        m.rotation.order = 'YXZ';
        this.root.add(m);
        this.itemMeshes.set(id, m);
        m.userData.rx = it.x; m.userData.ry = it.y; m.userData.rz = it.z; m.userData.spin = 0;
      }
      const u = m.userData;
      const k = this.isHost ? 1 : Math.min(1, dt * 15);
      const px = u.rx, py = u.ry, pz = u.rz;
      u.rx += (it.x - u.rx) * k; u.ry += (it.y - u.ry) * k; u.rz += (it.z - u.rz) * k;
      m.position.set(u.rx, u.ry + (it.flying ? 0 : 0.04), u.rz);
      if (it.flying) {
        // end-over-end spin along the flight direction (vertical spin)
        const vx = u.rx - px, vz = u.rz - pz;
        if (vx * vx + vz * vz > 1e-6) m.rotation.y = Math.atan2(-vx, -vz);
        u.spin -= dt * 28;
        m.rotation.x = u.spin; m.rotation.z = 0;
        this.updateTrail(id, u.rx, u.ry, u.rz, true);
      } else {
        m.rotation.set(Math.PI / 2, (id * 1.7) % 6.28, 0);
        this.updateTrail(id, u.rx, u.ry, u.rz, false);
      }
    }
    for (const [id, m] of this.itemMeshes) {
      if (!this.items.has(id)) { this.root.remove(m); this.itemMeshes.delete(id); this.updateTrail(id, 0, 0, 0, false, true); }
    }
    for (const [id, tr] of this.trails) if (!this.items.has(id) || !this.items.get(id).flying) this.updateTrail(id, 0, 0, 0, false);
  }

  // Wind trail: a fading ribbon following the flying knife
  updateTrail(id, x, y, z, flying, kill = false) {
    let tr = this.trails.get(id);
    if (!tr && flying) {
      const N = 16;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 2 * 3), 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(N * 2 * 4), 4));
      const idx = [];
      for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      mesh.frustumCulled = false;
      this.root.add(mesh);
      tr = { mesh, pts: [], N, fade: 1 };
      this.trails.set(id, tr);
    }
    if (!tr) return;
    if (kill) { this.root.remove(tr.mesh); tr.mesh.geometry.dispose(); tr.mesh.material.dispose(); this.trails.delete(id); return; }
    if (flying) { tr.pts.unshift([x, y, z]); tr.fade = 1; } else tr.fade -= 0.05;
    if (tr.pts.length > tr.N) tr.pts.length = tr.N;
    if (tr.fade <= 0) { this.updateTrail(id, 0, 0, 0, false, true); return; }
    const pos = tr.mesh.geometry.attributes.position.array, col = tr.mesh.geometry.attributes.color.array;
    for (let i = 0; i < tr.N; i++) {
      const p = tr.pts[Math.min(i, tr.pts.length - 1)] || [x, y, z];
      const t = i / (tr.N - 1), w = 0.07 * (1 - t);
      pos.set([p[0], p[1] + w, p[2], p[0], p[1] - w, p[2]], i * 6);
      const a = (1 - t) * 0.55 * tr.fade;
      col.set([0.85, 0.9, 1, a, 0.85, 0.9, 1, a], i * 8);
    }
    tr.mesh.geometry.attributes.position.needsUpdate = true;
    tr.mesh.geometry.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------
  //  LOCAL PLAYER
  // ---------------------------------------------------------------
  thirdPerson() { return this.camDist > 0.25; }

  // Direction the player is aiming. In third person we aim where the
  // camera's crosshair points, so shots land where you look.
  aimAngles() {
    const me = this.me;
    if (!this.thirdPerson() || !this._camPos) return { yaw: me.yaw, pitch: me.pitch };
    const cp = this._camPos, d = dirFromAngles(me.yaw, me.pitch);
    let t = raycastMap(this.map, cp.x, cp.y, cp.z, d.x, d.y, d.z, 90);
    for (const c of this.chars.values()) {
      if (c === me || !c.alive) continue;
      const tc = rayVsCharacter(cp.x, cp.y, cp.z, d.x, d.y, d.z, { x: c.rx, y: c.ry, z: c.rz });
      if (tc >= 0 && tc < t) t = tc;
    }
    const tx = cp.x + d.x * t, ty = cp.y + d.y * t, tz = cp.z + d.z * t;
    const ex = me.x, ey = me.y + P.EYE, ez = me.z;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
  }

  localAction(a) {
    const me = this.me;
    const aim = (a === 'attack' || a === 'throw') ? this.aimAngles() : { yaw: me.yaw, pitch: me.pitch };
    if (this.isHost) {
      const y = me.yaw, pt = me.pitch;
      me.yaw = aim.yaw; me.pitch = aim.pitch;
      this.hostAction(me, a);
      if (me.alive) { me.yaw = y; me.pitch = pt; }
      return;
    }
    this.net?.send({ t: 'act', a, yw: r2(aim.yaw), pt: r2(aim.pitch) });
  }

  updateLocal(dt, inp) {
    const me = this.me;
    if (!me) return;

    // X button: alive -> die & spectate; dead -> back to main menu
    if (inp.x) {
      if (me.alive) this.localAction('suicide');
      else { this.exit(null); return; }
    }
    if (inp.score) { this.scoreOpen = !this.scoreOpen || !this.ui.isTouch; this.ui.showScoreboard(this.scoreOpen, this); }
    if (inp.scoreUp && !this.ui.isTouch) { this.scoreOpen = false; this.ui.showScoreboard(false, this); }
    // camera zoom (mouse wheel, +/- buttons, V toggles)
    if (inp.zoom) this.camDist = clamp(this.camDist + inp.zoom, 0, 5);
    if (inp.toggleView) { if (this.camDist > 0.25) { this._lastDist = this.camDist; this.camDist = 0; } else this.camDist = this._lastDist || 2.5; }
    if (this.camDist < 0.25 && inp.zoom < 0) this.camDist = 0;

    me.yaw = wrapAngle(me.yaw - inp.lookDX);
    me.pitch = clamp(me.pitch - inp.lookDY, -1.5, 1.5);

    if (!me.alive) {
      if (inp.next || inp.attack) this.cycleSpectate();
      return;
    }

    if (inp.equip) this.localAction('equip');
    if (inp.throw && this.localWeapon() === 1) this.localAction('throw');
    if (inp.attack || (inp.attackHeld && this.localWeapon() === 2)) {
      const w = this.localWeapon();
      if (w === 0) this.localAction('attack');
      else if (this.phase === 'play' && this.localGunCd <= 0) {
        if (w === 1) {
          this.localGunCd = W.KNIFE_COOLDOWN;
          this.viewModel.swing(); me.model.swing(); Audio.swing(null);
          this.localAction('attack');
        } else {
          this.localGunCd = W.GUN_COOLDOWN;
          this.lastLocalShot = performance.now();
          this.viewModel.recoil(); me.model.recoil();
          Audio.gunshot(null);
          this.shake = 0.25;
          this.localAction('attack');
        }
      }
    }
    if (this.localGunCd > 0) this.localGunCd -= dt;

    // movement
    const fx = forwardX(me.yaw), fz = forwardZ(me.yaw);
    const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
    const mx = fx * inp.fwd + rx * inp.strafe, mz = fz * inp.fwd + rz * inp.strafe;
    const wasGround = me.onGround;
    moveCharacter(me, { mx, mz, run: inp.run, jump: inp.jump }, dt, this.map);
    if (me.landed > 5) { Audio.land(null, me.landed); this.shake = Math.min(0.3, me.landed * 0.02); }
    if (wasGround && !me.onGround && me.vy > 0) Audio.jump(null);

    // don't walk through other people or furniture (soft, so the host can push props)
    for (const o of this.chars.values()) {
      if (o === me || !o.alive) continue;
      const dx = me.x - o.rx, dz = me.z - o.rz;
      const d = Math.hypot(dx, dz), min = P.RADIUS * 2;
      if (d < min && d > 1e-4 && Math.abs(me.y - o.ry) < P.HEIGHT * 0.9) {
        me.x += (dx / d) * (min - d); me.z += (dz / d) * (min - d);
      }
    }
    pushOutOfProps(me, this.map, 0.35, this.isHost); // the host pushes props right away for its own player

    // client: send my state to the host
    if (!this.isHost && this.net) {
      this.sendT -= dt;
      if (this.sendT <= 0) {
        this.sendT = 1 / CONFIG.NET.INPUT_RATE;
        this.net.send({ t: 'in', p: [r2(me.x), r2(me.y), r2(me.z)], v: [r2(me.vx), r2(me.vy), r2(me.vz)], yw: r2(me.yaw), pt: r2(me.pitch), g: me.onGround ? 1 : 0, r: me.running ? 1 : 0, s: r2(me.speed) });
      }
    }
  }

  localWeapon() { const me = this.me; return me ? weaponOf(me) : 0; }

  cycleSpectate() {
    const alive = [...this.chars.values()].filter((c) => c.alive && c.id !== this.localId);
    if (!alive.length) { this.specId = null; return; }
    const i = alive.findIndex((c) => c.id === this.specId);
    this.specId = alive[(i + 1) % alive.length].id;
  }

  // ---------------------------------------------------------------
  //  FRAME
  // ---------------------------------------------------------------
  update(dt, inp) {
    if (this.ended) return;
    this.time += dt;
    if (!this.isHost) this.timeLeft -= dt;
    this.updateLocal(dt, inp);
    if (this.ended) return;
    if (this.isHost) this.hostTick(dt);
    const lampsDyn = (this.settings.dynLights || 0) > 0;

    // smooth remote characters & animate everyone
    const me = this.me;
    for (const c of this.chars.values()) {
      if (c === me) {
        c.rx = c.x; c.ry = c.y; c.rz = c.z; c.ryaw = c.yaw; c.rpitch = c.pitch; c.rspeed = c.speed; c.rground = c.onGround;
      } else {
        const k = Math.min(1, dt * (this.isHost && c.isBot ? 30 : 12));
        if (Math.hypot(c.x - c.rx, c.z - c.rz) > 5) { c.rx = c.x; c.ry = c.y; c.rz = c.z; }
        c.rx += (c.x - c.rx) * k; c.ry += (c.y - c.ry) * k; c.rz += (c.z - c.rz) * k;
        c.ryaw = turnToward(c.ryaw, c.yaw, dt * 14); c.rpitch += (c.pitch - c.rpitch) * k;
        c.rspeed += (c.speed - c.rspeed) * k; c.rground = c.onGround;
      }
      if (this.isHost) c.weaponVis = weaponOf(c);
      else if (c === me) c.weaponVis = weaponOf(c);

      const showModel = c.alive && !(c === me && !this.ownBodyVisible());
      c.model.setVisible(showModel);
      if (c.alive) {
        const gy = groundHeight(this.map, c.rx, c.rz, 0.2, c.ry + 0.1);
        c.model.update(dt, { x: c.rx, y: c.ry, z: c.rz, yaw: c.ryaw, pitch: c.rpitch, speed: c.rspeed, onGround: c.rground, weapon: c.weaponVis }, gy);
        // lighting: tint by the light probe at this spot (indoor lamps, shade, sun)
        c.model.lightT -= dt;
        if (c.model.lightT <= 0) {
          c.model.lightT = 0.15;
          const l = this.map.probe(c.rx, c.rz, !lampsDyn, this._probe || (this._probe = [0, 0, 0]));
          const tgt = c.model._tgt || (c.model._tgt = [l[0], l[1], l[2]]);
          tgt[0] = l[0]; tgt[1] = l[1]; tgt[2] = l[2];
        }
        const tl = c.model._tgt;
        if (tl) {
          const L = c.model.light, kk = Math.min(1, dt * 6);
          c.model.setLight(L[0] + (tl[0] - L[0]) * kk, L[1] + (tl[1] - L[1]) * kk, L[2] + (tl[2] - L[2]) * kk);
        }
        // footsteps (you can hear people coming)
        if (c.rground && c.rspeed > 1) {
          c.stepAcc += c.rspeed * dt;
          const stride = c.rspeed > 5 ? 2.5 : 1.9;
          if (c.stepAcc > stride) {
            c.stepAcc = 0;
            Audio.step(c === me ? null : { x: c.rx, y: c.ry, z: c.rz }, c.rspeed > 5 ? 1 : 0.6, this.map.floorTypeAt(c.rx, c.rz), this.settings.footVol ?? 1);
          }
        }
      }
    }

    for (const rd of this.ragdolls.values()) rd.update(dt);
    this.props.render(dt, lampsDyn);
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.t -= dt;
      t.mesh.material.opacity = Math.max(0, t.t / 0.12);
      t.flash.material.opacity = Math.max(0, t.t / 0.12);
      t.flash.scale.setScalar(1 + (0.12 - t.t) * 6);
      if (t.t <= -0.1) { this.root.remove(t.mesh); this.root.remove(t.flash); t.mesh.geometry.dispose(); t.mesh.material.dispose(); t.flash.material.dispose(); this.tracers.splice(i, 1); }
    }
    this.syncItemMeshes(dt);
    // gun part meshes: hide the ones I already have
    for (const g of this.partMeshes) {
      const k = g.userData.k;
      g.visible = this.partsVisible && !this.myParts.has(k);
      g.userData.piece.rotation.y += dt * 1.5;
      g.position.y = this.partSpots[k].y + 0.35 + Math.sin(this.time * 2 + k) * 0.05;
    }

    this.updateCamera(dt);
    this.updateHud(dt);
  }

  // own body is drawn in third person (only on this screen; others always see you)
  ownBodyVisible() { return this.thirdPerson() && (this._camActualDist ?? 9) > 0.55; }
  firstPerson() { const me = this.me; return me && me.alive && !this.thirdPerson(); }

  updateCamera(dt) {
    const cam = this.camera, me = this.me;
    if (!me) return;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
    const sh = (this.settings.shake !== false ? this.shake || 0 : 0);
    if (me.alive) {
      const bobOn = this.settings.viewBob !== false;
      const bob = bobOn && me.onGround ? Math.sin(this.time * 9) * 0.035 * Math.min(1, me.speed / 4) : 0;
      const ex = me.x, ey = me.y + P.EYE + bob, ez = me.z;
      if (this.thirdPerson()) {
        // over-the-shoulder camera, pulled in when a wall is in the way
        const d = dirFromAngles(me.yaw, me.pitch);
        const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
        // weapon out -> tighter over-the-right-shoulder view for aiming
        const aiming = weaponOf(me) !== 0;
        const tSide = aiming ? 0.68 : 0.38 * Math.min(1, this.camDist / 1.5);
        const tDist = aiming ? Math.min(this.camDist, 1.8) : this.camDist;
        const kk = Math.min(1, dt * 8);
        this._side = (this._side ?? tSide) + (tSide - (this._side ?? tSide)) * kk;
        this._tdist = (this._tdist ?? tDist) + (tDist - (this._tdist ?? tDist)) * kk;
        const side = this._side;
        const px = ex + rx * side, py = ey + (aiming ? 0.2 : 0.12), pz = ez + rz * side;
        let dist = this._tdist;
        const sideHit = raycastMap(this.map, ex, ey, ez, rx, 0, rz, side + 0.2);
        const spx = sideHit < side + 0.2 ? ex + rx * Math.max(0, sideHit - 0.2) : px, spz = sideHit < side + 0.2 ? ez + rz * Math.max(0, sideHit - 0.2) : pz;
        const hit = raycastMap(this.map, spx, py, spz, -d.x, -d.y, -d.z, dist + 0.3);
        dist = Math.max(0.1, Math.min(dist, hit - 0.25));
        this._camActualDist = dist;
        cam.position.set(spx - d.x * dist, py - d.y * dist, spz - d.z * dist);
      } else {
        this._camActualDist = 0;
        cam.position.set(ex, ey, ez);
      }
      cam.rotation.set(me.pitch + (Math.random() - 0.5) * sh * 0.05, me.yaw + (Math.random() - 0.5) * sh * 0.05, 0);
      this._camPos = cam.position;
      this.viewModel.setLook(me.look, me.color, Math.min(1.4, me.model.light[1]));
      this.viewModel.update(dt, weaponOf(me), me.onGround ? me.speed : 0, !this.thirdPerson());
    } else {
      this.viewModel.update(dt, 0, 0, false);
      this.deathT += dt;
      let target = null;
      const rd = this.ragdolls.get(me.id);
      if (rd && this.deathT < 3 && !me.spectator) {
        const c = rd.center;
        target = { x: c.x, y: c.y - 0.6, z: c.z };
      } else {
        let s = this.chars.get(this.specId);
        if (!s || !s.alive) { this.cycleSpectate(); s = this.chars.get(this.specId); }
        if (s && s.alive) target = { x: s.rx, y: s.ry, z: s.rz, c: s };
      }
      if (target) {
        const yaw = me.yaw, pitch = clamp(me.pitch, -1.2, 0.6);
        const d = dirFromAngles(yaw, pitch);
        const hx = target.x, hy = target.y + 1.6, hz = target.z;
        let dist = Math.max(2, this.camDist || 3.2);
        const hit = raycastMap(this.map, hx, hy, hz, -d.x, -d.y, -d.z, dist + 0.3);
        dist = Math.max(0.4, Math.min(dist, hit - 0.3));
        cam.position.set(hx - d.x * dist, hy - d.y * dist, hz - d.z * dist);
        cam.rotation.set(pitch, yaw, 0);
      } else {
        const c = this.map.center();
        const a = this.time * 0.1;
        cam.position.set(c.x + Math.cos(a) * 12, 4, c.z + Math.sin(a) * 12);
        cam.lookAt(c.x, 1, c.z);
        cam.rotation.order = 'YXZ';
      }
    }
    const f = dirFromAngles(cam.rotation.y, cam.rotation.x);
    Audio.setListener(cam.position.x, cam.position.y, cam.position.z, f.x, f.y, f.z);
  }

  updateHud(dt) {
    const me = this.me;
    if (!me) return;
    // who am I looking at? (ray from the camera through the crosshair)
    let look = null;
    if (me.alive) {
      const cp = this.camera.position;
      const d = dirFromAngles(me.yaw, me.pitch);
      const wall = raycastMap(this.map, cp.x, cp.y, cp.z, d.x, d.y, d.z, 14 + (this._camActualDist || 0));
      let bt = wall;
      for (const c of this.chars.values()) {
        if (c === me || !c.alive) continue;
        const t = rayVsCharacter(cp.x, cp.y, cp.z, d.x, d.y, d.z, { x: c.rx, y: c.ry, z: c.rz }, 0.4);
        if (t >= 0 && t < bt) { bt = t; look = c; }
      }
      if (!look) {
        for (const rd of this.ragdolls.values()) {
          const c = rd.center;
          const t = rayVsCharacter(cp.x, cp.y, cp.z, d.x, d.y, d.z, { x: c.x, y: c.y - 0.5, z: c.z }, 0.6);
          if (t >= 0 && t < Math.min(bt, 6 + (this._camActualDist || 0))) { look = { nick: 'Dead body', color: 0x999999, corpse: true }; break; }
        }
      }
    }
    const spec = !me.alive ? this.chars.get(this.specId) : null;
    this.ui.updateHud({
      me, role: this.myRole, phase: this.phase, timeLeft: this.timeLeft,
      look, spec, weapon: weaponOf(me), hasKnife: me.hasKnife, hasGun: me.hasGun,
      parts: this.partsVisible && this.myRole !== 'murderer' && !me.hasGun ? this.myParts.size : -1,
      server: this.serverLabel, code: this.code, players: this.chars.size,
      deathT: this.deathT, third: this.thirdPerson(),
    });
  }

  // ---------------------------------------------------------------
  //  Leave the match
  // ---------------------------------------------------------------
  exit(reason) {
    if (this.ended) return;
    this.ended = true;
    if (this.net) {
      if (this.isHost) { this.net.off('message', this._onMsg); this.net.off('leave', this._onLeave); }
      else { this.net.off('message', this._onMsg); this.net.off('close', this._onClose); }
      this.net.close();
    }
    this.dispose();
    this.o.onExit?.(reason);
  }

  dispose() {
    for (const id of [...this.trails.keys()]) this.updateTrail(id, 0, 0, 0, false, true);
    for (const id of [...this.chars.keys()]) this.removeChar(id);
    for (const rd of this.ragdolls.values()) rd.dispose();
    this.ragdolls.clear();
    this.scene.remove(this.root);
    this.camera.remove(this.viewModel.group);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { escapeHtml, rand, pick };
