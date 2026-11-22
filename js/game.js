// =====================================================================
//  GAME.JS — one match of FIND THE THINGS (prop hunt). Runs in 3 modes:
//    'offline' : you + bots, no network
//    'host'    : you run the server (authoritative) + bots, others join
//    'client'  : you joined someone else's server
//
//  Two teams: SEEKERS (knife + revolver, hotbar + inventory) and PROPS
//  (stiff T-posing people who can turn into any piece of furniture).
//  The HOST decides everything important (teams, hits, deaths, pickups,
//  rounds). Clients only send their own movement and button presses.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js?v=850';
import { CONFIG } from './config.js?v=850';
import { clamp, shuffle, pick, dirFromAngles, forwardX, forwardZ, turnToward, textColor, wrapAngle, DEG, rand } from './util.js?v=850';
import { moveCharacter, separateCharacters, footOverlap, raycastMap, rayVsCharacter, rayVsCapsules, rayCapsuleIndex, hasLOS, groundHeight, pushOutOfProps } from './physics.js?v=850';
import { CharacterModel, ViewModel, makeKnifeMesh, makeCrowbarMesh, randomLook, sanitizeLook } from './character.js?v=850';
import { PropSystem, PROP_LIST, DisguiseMesh, propHeight, propShape, propFoot, rayVsPropShape, propName } from './props.js?v=850';
import { Ragdoll } from './ragdoll.js?v=850';
import { Audio } from './audio.js?v=850';
import { initBrain, updateBots } from './bots.js?v=850';

const P = CONFIG.PLAYER;
const W = CONFIG.WEAPONS;
const TM = CONFIG.TEAMS;
const INV = CONFIG.INVENTORY;
const r2 = (v) => Math.round(v * 100) / 100;
const FLASH_GEO = new THREE.SphereGeometry(0.12, 8, 6);
const DECAL_GEO = new THREE.PlaneGeometry(1, 1);
const MAX_DECALS = 500;   // safety limit only (oldest go first); normally every mark stays until the next round
const r3 = (v) => Math.round(v * 1000) / 1000;

// Flags packed into snapshots
const F_ALIVE = 1, F_KNIFE = 2, F_GUN = 4, F_GROUND = 8, F_RUN = 16, F_SEEKER = 32, F_PROP = 64, F_CROWBAR = 128;

// melee weapons (the crowbar works exactly like the knife)
const isMelee = (w) => w === 1 || w === 3;

export function newChar(id, nick, isBot, look) {
  return {
    id, nick, isBot, cid: null, look: sanitizeLook(look),
    color: CONFIG.TEAM_COLORS.none,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    onGround: true, speed: 0, running: false, stamina: P.STAMINA_MAX, exhausted: false,
    alive: false, spectator: true,
    team: 'none', hp: TM.SEEKER_HP, maxHp: TM.SEEKER_HP,
    disguise: null, morphCd: 0, anchored: false,   // anchored: a prop frozen in place (its player flies the camera)           // prop team: furniture type you look like (null = T-posing person)
    hasKnife: false, hasGun: false, hasCrowbar: false,   // seekers: knife / crowbar can be thrown away, then picked back up
    hotbar: new Array(INV.HOTBAR).fill(null), backpack: new Array(INV.BACKPACK).fill(null),
    slot: -1, lastSlot: 0,                // selected hotbar slot (-1 = hands empty)
    attackCd: 0,
    // render state (smoothed)
    rx: 0, ry: 0, rz: 0, ryaw: 0, rpitch: 0, rspeed: 0, rground: true,
    weaponVis: 0, model: null, dmesh: null, stepAcc: 0,
    brain: null,
  };
}

// 0 = nothing in hand, 1 = knife, 2 = revolver
export function weaponOf(c) {
  if (c.slot < 0) return 0;
  const it = c.hotbar[c.slot];
  if (it === 'knife' && c.hasKnife) return 1;
  if (it === 'revolver' && c.hasGun) return 2;
  if (it === 'crowbar' && c.hasCrowbar) return 3;
  return 0;
}

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
    this.items = new Map();       // thrown knives: id -> {id,type:'knife',x,y,z,vx,vy,vz,flying,owner}
    this.itemMeshes = new Map();
    this.ragdolls = new Map();    // char id -> Ragdoll
    this.tracers = [];
    this.decals = [];             // bullet holes, knife cuts, blood (stay until the next round)
    this.bloodLog = [];           // host: this round's blood events (sent to players who join later)
    this.bloodShown = !!(o.settings && o.settings.blood);
    this.phase = 'waiting';
    this.timeLeft = 0;
    this.myTeam = 'none';
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
    this.camDist = this.settings.camDist ?? 3;   // 0 = first person … 8 m, same with shift lock on or off
    // camera angles are separate from where your character faces:
    //  shift lock ON  = you always face where the camera looks, aim with the crosshair in the middle
    //  shift lock OFF = the camera orbits freely, you face where you walk, aim where you tap / click
    this.camYaw = 0; this.camPitch = -0.15;
    this.shiftLock = !!this.settings.shiftLock;
    this.faceT = 0;
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
      // offline starts right away; a host gives joiners a moment to connect
      this.timeLeft = this.mode === 'offline' ? 0.05 : 1;
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
    this.setDisguiseMesh(c, null);
    const rd = this.ragdolls.get(id);
    if (rd) { rd.dispose(); this.ragdolls.delete(id); }
    c.model.dispose();
    this.chars.delete(id);
  }

  roster() {
    return [...this.chars.values()].map((c) => ({ id: c.id, nick: c.nick, color: c.color, bot: c.isBot ? 1 : 0, ap: c.look, team: c.team }));
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

  startRound() {
    this.ensureBots();
    const all = [...this.chars.values()];
    if (all.length < 2) { this.phase = 'waiting'; this.timeLeft = 2; return; }
    this.emit({ e: 'reset' });
    this.items.clear();
    this.corpses = [];
    this.props.reset();
    this.props.removeRandom(0.10, 0.35);      // a random 10-35% of the furniture is gone this round

    // teams: about a third seekers (at least one), the rest props.
    // The round has seats: some seeker seats and some prop seats. Each real player takes one seat
    // picked at random (every seat equally likely, so you replace a random bot seeker or bot prop);
    // the bots fill the seats that are left.
    const nSeek = clamp(Math.round(all.length * TM.SEEKER_SHARE), 1, all.length - 1);
    const seats = all.map((_, i) => (i < nSeek ? 'seeker' : 'prop'));
    const takeSeat = () => seats.splice(Math.floor(Math.random() * seats.length), 1)[0];
    const teamOf = new Map();
    for (const c of all) if (!c.isBot) teamOf.set(c, takeSeat());
    for (const c of all) if (c.isBot) teamOf.set(c, takeSeat());
    const spawns = shuffle(this.map.spawns.slice());
    const seekSpots = this.seekerSpawns(all.filter((c) => teamOf.get(c) === 'seeker').length);
    let si = 0;
    all.forEach((c, i) => {
      const seeker = teamOf.get(c) === 'seeker';
      c.team = seeker ? 'seeker' : 'prop';
      c.color = CONFIG.TEAM_COLORS[c.team];
      c.hasKnife = seeker; c.hasGun = seeker; c.hasCrowbar = seeker;
      c.hotbar = new Array(INV.HOTBAR).fill(null);
      c.backpack = new Array(INV.BACKPACK).fill(null);
      if (seeker) INV.START.forEach((it, k) => { if (k < INV.HOTBAR) c.hotbar[k] = it; else c.backpack[k - INV.HOTBAR] = it; });
      c.slot = seeker && c.isBot ? c.hotbar.indexOf('revolver') : -1; c.lastSlot = 0;   // bot seekers always have a weapon out
      c.hp = c.maxHp = seeker ? TM.SEEKER_HP : TM.PROP_HUMAN_HP;
      c.disguise = null; c.morphCd = 0; c.anchored = false;
      c.attackCd = 0;
      c.alive = true; c.spectator = false;
      if (seeker) { const s = seekSpots[si++]; c.x = s.x; c.z = s.z; }
      else { const s = spawns[i % spawns.length]; c.x = s.x + Math.floor(i / spawns.length) * 0.8; c.z = s.z; }
      c.y = 0; c.vx = c.vy = c.vz = 0;
      c.yaw = Math.random() * Math.PI * 2; c.pitch = 0;
      c.stamina = P.STAMINA_MAX; c.exhausted = false;
      c.rx = c.x; c.ry = c.y; c.rz = c.z; c.ryaw = c.yaw;
      if (c.isBot) c.brain = initBrain(c);
    });

    this.emit({ e: 'roster', list: this.roster() });
    for (const c of all) {
      if (c.isBot) continue;
      this.emit({ e: 'spawn', x: r2(c.x), y: r2(c.y), z: r2(c.z), yaw: r2(c.yaw) }, [c.id]);
      this.emit({ e: 'team', team: c.team }, [c.id]);
    }
    this.phase = 'pre';
    this.timeLeft = CONFIG.ROUND.HIDE_TIME;
    this.emit({ e: 'phase', phase: 'pre', tl: this.timeLeft });
  }

  // Seekers start together on the path crossing in the middle of the grass courtyard,
  // bunched up close to the centre (within ~2 m, at least 0.9 m apart, clear of furniture)
  seekerSpawns(n) {
    const map = this.map, cx = map.worldW / 2, cz = map.worldD / 2, out = [];
    const free = (x, z) => map.floorTypeAt(x, z) === 'asphalt' && map.heightAt(x, z) === 0 &&
      !this.props.list.some((p) => Math.hypot(p.pos.x - x, p.pos.z - z) < p.r + 0.5) &&
      out.every((o) => Math.hypot(o.x - x, o.z - z) >= 0.9);
    for (let k = 0; k < n; k++) {
      let spot = null;
      for (let t = 0; t < 300 && !spot; t++) {
        const r = 2.2 * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (free(x, z)) spot = { x, z };
      }
      out.push(spot || { x: cx + (k % 3 - 1) * 0.9, z: cz + (Math.floor(k / 3) - 1) * 0.9 });
    }
    return out;
  }

  // A player who joins mid-round plays right away: they replace a bot on the team that needs a real
  // player most (see below), standing where that bot was.
  // If the round has no bot on that team they take any bot; with no bots at all they watch until next round.
  joinRound(c) {
    // which team: if a team has no real players yet, join that one (so a lone host gets someone to play
    // against); once both teams have real players, join the side with fewer real players (a coin flip
    // when they're even), so the humans stay balanced
    const humans = [...this.chars.values()].filter((h) => !h.isBot && h !== c && (h.team === 'seeker' || h.team === 'prop'));
    const nS = humans.filter((h) => h.team === 'seeker').length, nP = humans.filter((h) => h.team === 'prop').length;
    const want = nS === 0 && nP === 0 ? (Math.random() < 0.5 ? 'seeker' : 'prop')
      : nS === 0 ? 'seeker' : nP === 0 ? 'prop'
      : nS < nP ? 'seeker' : nP < nS ? 'prop' : (Math.random() < 0.5 ? 'seeker' : 'prop');
    const bots = [...this.chars.values()].filter((b) => b.isBot && (b.team === 'seeker' || b.team === 'prop'));
    const pickFrom = (list) => list.filter((b) => b.alive)[0] ? list.filter((b) => b.alive)[Math.floor(Math.random() * list.filter((b) => b.alive).length)] : list[0];
    const b = pickFrom(bots.filter((x) => x.team === want)) || pickFrom(bots);
    if (!b) return;
    const seeker = b.team === 'seeker';
    c.team = b.team; c.color = CONFIG.TEAM_COLORS[c.team];
    c.hasKnife = seeker; c.hasGun = seeker; c.hasCrowbar = seeker;
    c.hotbar = new Array(INV.HOTBAR).fill(null); c.backpack = new Array(INV.BACKPACK).fill(null);
    if (seeker) INV.START.forEach((it, k) => { if (k < INV.HOTBAR) c.hotbar[k] = it; else c.backpack[k - INV.HOTBAR] = it; });
    c.slot = -1; c.lastSlot = 0;
    c.hp = c.maxHp = seeker ? TM.SEEKER_HP : TM.PROP_HUMAN_HP;
    c.disguise = null; c.morphCd = 0; c.anchored = false; c.attackCd = 0;
    c.alive = true; c.spectator = false; c.stamina = P.STAMINA_MAX; c.exhausted = false;
    c.x = b.x; c.y = b.alive ? b.y : 0; c.z = b.z; c.vx = c.vy = c.vz = 0; c.yaw = b.yaw; c.pitch = 0;
    c.rx = c.x; c.ry = c.y; c.rz = c.z; c.ryaw = c.yaw;
    c.spawnAt = performance.now();
    this.removeChar(b.id);
    this.emit({ e: 'spawn', x: r2(c.x), y: r2(c.y), z: r2(c.z), yaw: r2(c.yaw) }, [c.id]);
    this.emit({ e: 'team', team: c.team }, [c.id]);
  }

  endRound(winner, reason = '') {
    if (this.phase !== 'play' && this.phase !== 'pre') return;
    this.phase = 'post';
    this.timeLeft = CONFIG.ROUND.POST_TIME;
    const survivors = [...this.chars.values()].filter((c) => c.alive && c.team === 'prop').map((c) => c.nick);
    this.emit({ e: 'phase', phase: 'post', tl: this.timeLeft, winner, reason, survivors });
  }

  teamCount(team) { let n = 0; for (const c of this.chars.values()) if (c.alive && c.team === team) n++; return n; }

  hostTick(dt) {
    this.timeLeft -= dt;
    if (this.phase === 'waiting' && this.timeLeft <= 0) this.startRound();
    else if (this.phase === 'pre' || this.phase === 'play') {
      const seekers = this.teamCount('seeker'), props = this.teamCount('prop');
      if (props === 0) this.endRound('seekers', 'Every prop was found.');
      else if (seekers === 0) this.endRound('props', 'All seekers are down.');
      else if (this.timeLeft <= 0) {
        if (this.phase === 'pre') {
          this.phase = 'play';
          this.timeLeft = CONFIG.ROUND.TIME_LIMIT;
          this.emit({ e: 'phase', phase: 'play', tl: this.timeLeft });
        } else this.endRound('props', 'The props hid until time ran out.');
      }
    } else if (this.phase === 'post' && this.timeLeft <= 0) {
      this.startRound();
    }

    for (const c of this.chars.values()) {
      if (c.attackCd > 0) c.attackCd -= dt;
      if (c.morphCd > 0) c.morphCd -= dt;
      // live knife slash: keep checking for a short moment after the swing
      if (c.slashT > 0) {
        c.slashT -= dt;
        if (c.alive && isMelee(weaponOf(c)) && this.phase === 'play') this.knifeHitCheck(c); else c.slashT = 0;
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
      if (w === 3) f |= F_CROWBAR;
      if (w === 2) f |= F_GUN;
      if (c.onGround) f |= F_GROUND;
      if (c.running) f |= F_RUN;
      if (c.team === 'seeker') f |= F_SEEKER;
      if (c.team === 'prop') f |= F_PROP;
      cs.push([c.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yaw), r2(c.pitch), f, r2(c.speed), c.disguise ? PROP_LIST.indexOf(c.disguise) : -1]);
    }
    const it = [...this.items.values()].map((i) => [i.id, i.type === 'crowbar' ? 3 : 1, r2(i.x), r2(i.y), r2(i.z), i.flying ? 1 : 0]);
    const pr = this.props.snapshot(1 / CONFIG.NET.SNAPSHOT_RATE);
    for (const c of this.humans()) {
      if (c.cid == null) continue;
      this.net.send(c.cid, {
        t: 'snap', ph: this.phase, tl: r2(this.timeLeft), c: cs, it, pr,
        me: { k: c.hasKnife ? 1 : 0, g: c.hasGun ? 1 : 0, cb: c.hasCrowbar ? 1 : 0, sl: c.slot, hb: c.hotbar, bp: c.backpack, hp: Math.round(c.hp), mh: c.maxHp, an: c.anchored ? 1 : 0, cd: r2(Math.max(0, c.attackCd)), al: c.alive ? 1 : 0 },
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
      this.net.send(cid, {
        t: 'welcome', id: c.id, roster: this.roster(), phase: this.phase, tl: r2(this.timeLeft),
        server: this.serverLabel, code: this.code, props: this.props.fullState(), blood: this.bloodLog,
      });
      // joining in the middle of a round: take over a bot on the other team from the host
      if (this.phase === 'pre' || this.phase === 'play') this.joinRound(c);
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
      if (c.anchored) return;                                   // anchored props stay frozen
      if (c.team === 'seeker' && this.phase === 'pre') return; // seekers are frozen while the props hide
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
      this.hostAction(c, m.a, m.n);
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
    this.removeChar(id);
    this.emit({ e: 'roster', list: this.roster() });
    this.emit({ e: 'msg', text: `${c.nick} left the server`, color: '#9ad' });
    // if a whole team is gone, hostTick ends the round
  }

  // ----- host: actions (from local input, clients, or bots) -----
  hostAction(c, a, n) {
    if (!c || !c.alive) return;
    if (a === 'suicide') { this.kill(c, null, 'suicide', { x: Math.random() - 0.5, y: 0, z: Math.random() - 0.5 }); return; }
    if (c.team === 'seeker' && this.phase === 'pre') return;   // blindfolded seekers can't do anything yet

    // ---------- prop team ----------
    if (c.team === 'prop') {
      if (a === 'anchor') {
        // freeze in place (no gravity, can't be pushed) / let go again
        c.anchored = !c.anchored;
        c.vx = c.vy = c.vz = 0; c.speed = 0;
        return;
      }
      if (c.anchored) return;          // can't change furniture while anchored
      if (a === 'disguise') {
        const p = this.props.list[n | 0];
        if (p && p.removed) return;
        if (!p || c.morphCd > 0 || (this.phase !== 'pre' && this.phase !== 'play')) return;
        const d = Math.hypot(p.pos.x - c.x, p.pos.z - c.z);
        if (d > TM.DISGUISE_RANGE + p.r + 1) return;
        c.morphCd = TM.DISGUISE_COOLDOWN;
        // health follows the furniture's size, keeping the same fraction (half health stays half)
        const frac = c.hp / (c.maxHp || 1);
        c.disguise = p.type;
        c.maxHp = TM.PROP_HP[p.type] || TM.PROP_HUMAN_HP;
        c.hp = Math.max(1, Math.round(frac * c.maxHp));
        this.emit({ e: 'morph', id: c.id, type: p.type });
      }
      return;
    }
    if (c.team !== 'seeker') return;

    // ---------- seekers: hotbar / inventory ----------
    if (a === 'slot') {
      const k = n | 0;
      if (k < 0 || k >= INV.HOTBAR) return;
      if (c.slot === k) { c.lastSlot = k; c.slot = -1; } else c.slot = k;
      return;
    }
    if (a === 'equip') {
      if (c.slot >= 0) { c.lastSlot = c.slot; c.slot = -1; } else c.slot = c.lastSlot;
      return;
    }
    if (a === 'inv') {
      // swap two inventory slots: 0..HOTBAR-1 = hotbar, HOTBAR.. = backpack
      if (!Array.isArray(n)) return;
      const [i, j] = n.map((v) => v | 0), N = INV.HOTBAR + INV.BACKPACK;
      if (i === j || i < 0 || j < 0 || i >= N || j >= N) return;
      const get = (k) => (k < INV.HOTBAR ? c.hotbar[k] : c.backpack[k - INV.HOTBAR]);
      const set = (k, v) => { if (k < INV.HOTBAR) c.hotbar[k] = v; else c.backpack[k - INV.HOTBAR] = v; };
      const a1 = get(i), a2 = get(j);
      set(i, a2); set(j, a1);
      return;
    }
    if (a === 'attack') {
      const w = weaponOf(c);
      if (w === 0) {
        // nothing in hand: take out the first weapon in the hotbar
        const k = c.hotbar.findIndex((it) => (it === 'knife' && c.hasKnife) || (it === 'revolver' && c.hasGun) || (it === 'crowbar' && c.hasCrowbar));
        if (k >= 0) c.slot = k;
        return;
      }
      if (this.phase !== 'play' || c.attackCd > 0) return;
      if (isMelee(w)) this.knifeAttack(c);
      else this.gunAttack(c);
      return;
    }
    if (a === 'throw') {
      const tw = weaponOf(c);
      if (!isMelee(tw) || this.phase !== 'play' || c.attackCd > 0) return;
      c.attackCd = W.KNIFE_THROW_COOLDOWN;
      if (tw === 3) c.hasCrowbar = false; else c.hasKnife = false;
      const d = dirFromAngles(c.yaw, c.pitch + 0.03);
      const id = this.nextItem++;
      this.items.set(id, {
        id, type: tw === 3 ? 'crowbar' : 'knife', flying: true, owner: c.id,
        x: c.x + d.x * 0.5, y: c.y + P.EYE - 0.1, z: c.z + d.z * 0.5,
        vx: d.x * (tw === 3 ? W.CROWBAR_THROW_SPEED : W.KNIFE_THROW_SPEED) + c.vx * 0.5,
        vy: d.y * (tw === 3 ? W.CROWBAR_THROW_SPEED : W.KNIFE_THROW_SPEED) + (tw === 3 ? 2 : 1),
        vz: d.z * (tw === 3 ? W.CROWBAR_THROW_SPEED : W.KNIFE_THROW_SPEED) + c.vz * 0.5,
      });
      this.emit({ e: 'throw', id: c.id });
    }
  }

  // Can a weapon from `c` hurt `o`? Seekers only hurt props (no friendly fire).
  canHurt(c, o) { return o !== c && o.alive && c.team === 'seeker' && o.team === 'prop'; }

  // Ray vs. a character: a person (capsule) or, when disguised, the furniture shape it copies.
  hitTest(o, ox, oy, oz, dx, dy, dz, pad = 0, smooth = false) {
    const x = smooth ? o.rx : o.x, y = smooth ? o.ry : o.y, z = smooth ? o.rz : o.z;
    if (o.disguise) return rayVsPropShape(o.disguise, x, y, z, smooth ? o.ryaw : o.yaw, ox, oy, oz, dx, dy, dz, pad);
    // people: one hitbox per body part, following the pose (T-pose arms included). Cached for one frame.
    if (o._capsT !== this.time) { o._caps = o.model.hitCapsules(); o._capsT = this.time; }
    if (smooth) return rayVsCapsules(ox, oy, oz, dx, dy, dz, o._caps, pad);
    // the model is drawn at the smoothed position / turn; move the hitboxes to the real ones for the host's checks
    const turn = wrapAngle(o.yaw - o.ryaw), cs = Math.cos(turn), sn = Math.sin(turn);
    const mv = (x, z) => { const lx = x - o.rx, lz = z - o.rz; return [o.x + lx * cs + lz * sn, o.z - lx * sn + lz * cs]; };
    const caps = o._caps.map((c) => { const [ax, az] = mv(c[0], c[2]), [bx, bz] = mv(c[3], c[5]); return [ax, c[1] + o.y - o.ry, az, bx, c[4] + o.y - o.ry, bz, c[6]]; });
    return rayVsCapsules(ox, oy, oz, dx, dy, dz, caps, pad);
  }

  // A seeker hits a prop player: take health off, die at 0
  damage(target, attacker, amount, cause, impulse) {
    if (!target.alive) return;
    target.hp -= amount;
    if (target.hp <= 0) { target.hp = 0; this.kill(target, attacker, cause, impulse); return; }
    this.emit({ e: 'hit', id: target.id, p: [r2(target.x), r2(target.y + 0.6), r2(target.z)] });
    this.emit({ e: 'msg', text: `−${amount} HP`, color: '#f66' }, [target.id]);
  }

  // Seekers lose health for attacking real furniture (so they can't just shoot everything)
  wrongProp(c) {
    if (!c.alive || c.team !== 'seeker') return;
    c.hp -= TM.WRONG_PROP_DAMAGE;
    this.emit({ e: 'msg', text: `−${TM.WRONG_PROP_DAMAGE} HP`, color: '#f66' }, [c.id]);
    if (c.hp <= 0) this.kill(c, null, 'penalty', { x: 0, y: 0.5, z: 0 });
  }

  // A stab is a slash that stays "live" for a short moment (KNIFE_SLASH_WINDOW):
  // if you swing a bit early and turn onto someone right after, it still hits.
  knifeAttack(c) {
    c.attackCd = W.KNIFE_COOLDOWN;
    c.slashT = W.KNIFE_SLASH_WINDOW;
    this.emit({ e: 'swing', id: c.id });
    if (this.knifeHitCheck(c)) return;
    const mk = weaponOf(c) === 3 ? 'c' : 's';     // crowbar scratches / knife cut
    // stabbed a real piece of furniture?
    const d = dirFromAngles(c.yaw, c.pitch);
    const ph = this.props.raycast(c.x, c.y + P.EYE, c.z, d.x, d.y, d.z, W.KNIFE_RANGE);
    if (ph) {
      this.props.impulseAt(ph.prop, ph.point, new THREE.Vector3(d.x * 2, d.y * 2, d.z * 2));
      this.emit({ e: 'clink', p: [r2(ph.point.x), r2(ph.point.y), r2(ph.point.z)] });
      this.markImpact(mk, ph.point, ph.normal, ph.prop.id);
      c.slashT = 0;
      this.wrongProp(c);
      return;
    }
    // a cut (knife) or scratches (crowbar) in the wall / floor
    const tw = raycastMap(this.map, c.x, c.y + P.EYE, c.z, d.x, d.y, d.z, W.KNIFE_RANGE);
    if (tw < W.KNIFE_RANGE) {
      const hp = { x: c.x + d.x * tw, y: c.y + P.EYE + d.y * tw, z: c.z + d.z * tw };
      this.markImpact(mk, hp, this.mapNormal(hp, d));
    }
  }

  // ---------- marks: bullet holes, knife cuts, blood ----------
  // surface normal of the map where a ray (direction d) hit point p
  mapNormal(p, d) {
    const CELL = 2, CEIL = 6, ROOF_TOP = 6.55;
    if (p.y < 0.03 && d.y < 0) return { x: 0, y: 1, z: 0 };
    if (d.y > 0 && Math.abs(p.y - (CEIL - 0.07)) < 0.03) return { x: 0, y: -1, z: 0 };   // light fixture
    if (d.y > 0 && Math.abs(p.y - CEIL) < 0.03) return { x: 0, y: -1, z: 0 };
    if (d.y < 0 && Math.abs(p.y - ROOF_TOP) < 0.03) return { x: 0, y: 1, z: 0 };
    const ch = this.map.heightAt(p.x + d.x * 0.02, p.z + d.z * 0.02);
    if (d.y < 0 && ch > 0 && Math.abs(p.y - ch) < 0.03) return { x: 0, y: 1, z: 0 };      // top of a counter / shelf
    const fx = Math.abs(p.x / CELL - Math.round(p.x / CELL)), fz = Math.abs(p.z / CELL - Math.round(p.z / CELL));
    return fx < fz ? { x: -Math.sign(d.x) || 1, y: 0, z: 0 } : { x: 0, y: 0, z: -Math.sign(d.z) || 1 };
  }

  // host: tell everyone to put a mark at a hit (k: 'b' bullet hole, 's' knife cut), on the map or on a prop
  markImpact(k, p, n, pid = -1) {
    if (!n) n = { x: 0, y: 1, z: 0 };
    this.emit({ e: 'imp', k, p: [r3(p.x), r3(p.y), r3(p.z)], n: [r2(n.x), r2(n.y), r2(n.z)], pid });
  }

  // host: a prop player was hit -> blood splatters on the surfaces around (more / bigger / farther for gunshots)
  // The host picks a random seed so every player's splatter lands in exactly the same spots, and keeps a
  // log of this round's blood so players who join later get it too. Whether it's SHOWN is each player's
  // own Blood setting (it's always there, just hidden when the setting is off).
  bleed(target, p, d, gun, w = 's') {
    const ev = { e: 'blood', id: target.id, w, p: [r2(p.x), r2(p.y), r2(p.z)], d: [r2(d.x), r2(d.y), r2(d.z)], g: gun ? 1 : 0, s: (Math.random() * 2 ** 31) | 0 };
    this.bloodLog.push(ev);
    if (this.bloodLog.length > 200) this.bloodLog.shift();
    this.emit(ev);
  }

  // ----- cutting marks off at the edge of the surface they're on -----
  // planes (THREE.Plane, world space) around the flat map surface at p (normal n): a wall face, a floor / counter top,
  // a ceiling or a light fixture. Anything of the mark outside them is not drawn, so it never hangs in the air.
  mapClip(p, n) {
    const map = this.map, CELL = 2, CEIL = 6, ROOF_TOP = 6.55, MAXC = 3;
    const keep = (nx, ny, nz, c) => new THREE.Plane(new THREE.Vector3(nx, ny, nz), c);
    const cx0 = Math.floor(p.x / CELL), cz0 = Math.floor(p.z / CELL);
    const scan = (ok, horizontalAxis) => {
      // contiguous cells (from the hit cell) along x and along z where the surface exists
      let x0 = cx0, x1 = cx0, z0 = cz0, z1 = cz0;
      if (horizontalAxis !== 'z') { while (x0 - 1 >= cx0 - MAXC && ok(x0 - 1, cz0)) x0--; while (x1 + 1 <= cx0 + MAXC && ok(x1 + 1, cz0)) x1++; }
      if (horizontalAxis !== 'x') { while (z0 - 1 >= cz0 - MAXC && ok(cx0, z0 - 1)) z0--; while (z1 + 1 <= cz0 + MAXC && ok(cx0, z1 + 1)) z1++; }
      return [x0 * CELL, (x1 + 1) * CELL, z0 * CELL, (z1 + 1) * CELL];
    };
    if (Math.abs(n.y) > 0.5) {
      if (n.y < 0 && Math.abs(p.y - (CEIL - 0.07)) < 0.03) {
        // underside of a light fixture
        const lx = (Math.floor(p.x / CELL / 3) * 3 + 1.5) * CELL, lz = (Math.floor(p.z / CELL / 3) * 3 + 1.5) * CELL;
        return [keep(1, 0, 0, -(lx - 0.72)), keep(-1, 0, 0, lx + 0.72), keep(0, 0, 1, -(lz - 0.38)), keep(0, 0, -1, lz + 0.38)];
      }
      let ok;
      if (n.y > 0 && Math.abs(p.y - ROOF_TOP) < 0.03) ok = (x, z) => map.roofedCell(x, z);
      else if (n.y > 0) ok = (x, z) => map.inBounds(x, z) && Math.abs(map.cellHeight(x, z) - p.y) < 0.03;
      else ok = (x, z) => map.roofedCell(x, z) && map.cellHeight(x, z) < CEIL;
      const [x0, x1, z0, z1] = scan(ok);
      return [keep(1, 0, 0, -x0), keep(-1, 0, 0, x1), keep(0, 0, 1, -z0), keep(0, 0, -1, z1)];
    }
    // wall face: solid cell on one side of the cell edge, open (lower) cell on the other
    const alongX = Math.abs(n.x) > 0.5;
    const sgn = alongX ? Math.sign(n.x) : Math.sign(n.z);
    const solidC = Math.floor(((alongX ? p.x : p.z) - sgn * 0.01) / CELL), openC = solidC + sgn;
    const face = (t) => {
      const sx = alongX ? solidC : t, sz = alongX ? t : solidC, ox = alongX ? openC : t, oz = alongX ? t : openC;
      return map.cellHeight(sx, sz) > p.y && map.cellHeight(ox, oz) <= p.y;
    };
    const t0 = alongX ? cz0 : cx0;
    let a = t0, b = t0;
    while (a - 1 >= t0 - MAXC && face(a - 1)) a--;
    while (b + 1 <= t0 + MAXC && face(b + 1)) b++;
    const solidH = map.cellHeight(alongX ? solidC : cx0, alongX ? cz0 : solidC);
    const openH = map.cellHeight(alongX ? openC : cx0, alongX ? cz0 : openC);
    const indoor = !map.isOutdoor(p.x + n.x * 0.3, p.z + n.z * 0.3);
    const top = Math.min(solidH, indoor ? CEIL : solidH), bottom = Math.max(0, openH);
    const planes = [keep(0, 1, 0, -bottom), keep(0, -1, 0, top)];
    if (alongX) planes.push(keep(0, 0, 1, -a * CELL), keep(0, 0, -1, (b + 1) * CELL));
    else planes.push(keep(1, 0, 0, -a * CELL), keep(-1, 0, 0, (b + 1) * CELL));
    return planes;
  }

  // the 4 side planes of the face of a furniture part that was hit, in the prop's own space (they move with it)
  propClipLocal(part, axis) {
    const h = part.h, out = [];
    const m = new THREE.Matrix4().compose(part.c, part.q, new THREE.Vector3(1, 1, 1));
    for (const ax of ['x', 'y', 'z']) {
      if (ax === axis) continue;
      const v = new THREE.Vector3(); v[ax] = 1;
      out.push(new THREE.Plane(v.clone().negate(), h[ax]).applyMatrix4(m), new THREE.Plane(v.clone(), h[ax]).applyMatrix4(m));
    }
    return out;
  }

  addDecal(tex, p, n, w, h, prop = null, parentObj = null, clip = null, blood = false) {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const l = this.map.probe(p.x, p.z, true, [0, 0, 0]);
    const lum = Math.min(1.25, 0.3 * l[0] + 0.55 * l[1] + 0.15 * l[2]);
    mat.color.setRGB(lum, lum, lum);
    const m = new THREE.Mesh(DECAL_GEO, mat);
    m.scale.set(w, h, 1);
    const pos = new THREE.Vector3(p.x + n.x * 0.006, p.y + n.y * 0.006, p.z + n.z * 0.006);
    m.position.copy(pos);
    m.lookAt(pos.x + n.x, pos.y + n.y, pos.z + n.z);
    m.rotateZ((blood && this._bloodRnd ? this._bloodRnd() : Math.random()) * Math.PI * 2);
    m.renderOrder = 2;
    const parent = parentObj || (prop ? prop.mesh : null);
    if (parent) {
      // stick to the furniture / body part so the mark moves with it
      parent.updateMatrixWorld(true);
      const inv = parent.matrixWorld.clone().invert();
      m.updateMatrix();
      m.matrix.premultiply(inv);
      m.matrix.decompose(m.position, m.quaternion, m.scale);
      parent.add(m);
    } else this.root.add(m);
    // edge clipping: map surfaces use fixed world planes; furniture planes follow the prop every frame
    let local = null;
    if (clip && clip.world) mat.clippingPlanes = clip.world;
    else if (clip && clip.local && parent) { local = clip.local; mat.clippingPlanes = local.map((pl) => pl.clone().applyMatrix4(parent.matrixWorld)); }
    else if (!parent) mat.clippingPlanes = this.mapClip(p, n);
    if (blood) m.visible = this.bloodShown;
    this.decals.push({ m, local, parent: local ? parent : null, blood, wx: p.x, wy: p.y, wz: p.z, r: Math.max(w, h) * 0.6 });
    const maxMarks = Math.min(MAX_DECALS, this.settings.maxMarks || MAX_DECALS);   // (Graphics setting)
    while (this.decals.length > maxMarks) this.removeDecal(this.decals.shift());
  }

  // find the furniture part / face under a point on a prop (for clipping marks to that face)
  propFaceClip(prop, p, n) {
    const ph = this.props.raycast(p.x + n.x * 0.06, p.y + n.y * 0.06, p.z + n.z * 0.06, -n.x, -n.y, -n.z, 0.2);
    return ph && ph.prop === prop && ph.part ? { local: this.propClipLocal(ph.part, ph.axis) } : null;
  }
  removeDecal(dc) { dc.m.parent?.remove(dc.m); dc.m.material.dispose(); }
  // remove every mark and blood burst (round reset / leaving the game)
  clearMarks() {
    for (const dc of this.decals) this.removeDecal(dc);
    this.decals = [];
    for (const b of this.bursts || []) { this.root.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); }
    this.bursts = [];
  }
  clearTracers() {
    for (const t of this.tracers) { this.root.remove(t.mesh); this.root.remove(t.flash); t.mesh.geometry.dispose(); t.mesh.material.dispose(); t.flash.material.dispose(); }
    this.tracers = [];
  }

  // Blood drops bursting out of a hit prop and falling (more for gunshots); they fade after a moment
  bloodBurst(p, d, gun, rnd = Math.random) {
    const R = (lo, hi) => lo + rnd() * (hi - lo);
    if (!DROP_TEX) {
      const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
      const g = x.createRadialGradient(28, 28, 2, 32, 32, 30);
      g.addColorStop(0, 'rgba(185,24,18,1)'); g.addColorStop(0.45, 'rgba(148,12,9,1)'); g.addColorStop(0.8, 'rgba(108,6,5,0.9)'); g.addColorStop(1, 'rgba(95,4,4,0)');
      x.fillStyle = g; x.beginPath(); x.arc(32, 32, 30, 0, Math.PI * 2); x.fill();
      DROP_TEX = new THREE.CanvasTexture(c); DROP_TEX.colorSpace = THREE.SRGBColorSpace;
    }
    const n = gun ? 30 : 12;
    const pos = new Float32Array(n * 3), vel = [];
    for (let i = 0; i < n; i++) {
      pos.set([p.x, p.y, p.z], i * 3);
      // sprayed out of the hit, mostly onward in the direction of the hit, then gravity pulls them down
      const sp = gun ? R(2.5, 7) : R(1.2, 3.5);
      let vx = d.x * sp * 0.7 + (rnd() - 0.5) * sp, vy = rnd() * sp * 0.6 + 0.5, vz = d.z * sp * 0.7 + (rnd() - 0.5) * sp;
      vel.push([vx, vy, vz]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const l = this.map.probe(p.x, p.z, true, [0, 0, 0]), lum = Math.min(1.2, 0.3 * l[0] + 0.55 * l[1] + 0.15 * l[2]);
    const mat = new THREE.PointsMaterial({ map: DROP_TEX, size: gun ? 0.15 : 0.12, transparent: true, depthWrite: false, sizeAttenuation: true, opacity: 1, alphaTest: 0.05 });
    mat.color.setRGB(lum, lum, lum);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = this.bloodShown;
    this.root.add(pts);
    (this.bursts || (this.bursts = [])).push({ pts, vel, life: gun ? 1.6 : 1.2, max: gun ? 1.6 : 1.2, landed: new Uint8Array(n) });
  }

  updateBursts(dt) {
    if (!this.bursts) return;
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt;
      if (b.life <= 0) { this.root.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); this.bursts.splice(i, 1); continue; }
      const a = b.pts.geometry.attributes.position, arr = a.array;
      for (let k = 0; k < b.vel.length; k++) {
        if (b.landed[k]) continue;
        const v = b.vel[k];
        v[1] -= 14 * dt;
        const x = arr[k * 3], y = arr[k * 3 + 1], z = arr[k * 3 + 2];
        const len = Math.hypot(v[0], v[1], v[2]) * dt || 1e-6, dx = v[0] * dt / len, dy = v[1] * dt / len, dz = v[2] * dt / len;
        // did the drop hit a wall, the floor or furniture on the way? -> it stops there (no mark)
        const tw = raycastMap(this.map, x, y, z, dx, dy, dz, len);
        const ph = this.props.raycast(x, y, z, dx, dy, dz, Math.min(tw, len));
        const t = ph ? ph.t : tw;
        if (t < len) {
          const hp = { x: x + dx * t, y: y + dy * t, z: z + dz * t };
          arr[k * 3] = hp.x; arr[k * 3 + 1] = hp.y; arr[k * 3 + 2] = hp.z;
          b.landed[k] = 1;
          continue;
        }
        arr[k * 3] = x + v[0] * dt; arr[k * 3 + 1] = y + v[1] * dt; arr[k * 3 + 2] = z + v[2] * dt;
      }
      a.needsUpdate = true;
      b.pts.material.opacity = Math.min(1, b.life / (b.max * 0.4));
    }
  }

  // A ray against the people standing around (excluding `skip`): body part hit + surface normal
  rayChars(p, dir, maxT, skip) {
    let best = null;
    for (const c of this.chars.values()) {
      if (!c.alive || c === skip) continue;
      if (c.disguise) {
        if (!c.dmesh) continue;
        const t = rayVsPropShape(c.disguise, c.rx, c.ry, c.rz, c.ryaw, p.x, p.y, p.z, dir.x, dir.y, dir.z);
        if (t >= 0 && t < maxT && (!best || t < best.t)) best = { t, obj: c.dmesh.mesh, n: { x: -dir.x, y: -dir.y, z: -dir.z } };
        continue;
      }
      if (!c.model.root.visible && c !== this.me) continue;
      const caps = c.model.hitCapsules();
      const h = rayCapsuleIndex(p.x, p.y, p.z, dir.x, dir.y, dir.z, caps, maxT);
      if (h && (!best || h.t < best.t)) {
        const cp = caps[h.i], hx = p.x + dir.x * h.t, hy = p.y + dir.y * h.t, hz = p.z + dir.z * h.t;
        // normal = from the closest point on the body part's center line out to the hit point
        const sx = cp[3] - cp[0], sy = cp[4] - cp[1], sz = cp[5] - cp[2], ss = sx * sx + sy * sy + sz * sz || 1;
        const u = Math.max(0, Math.min(1, ((hx - cp[0]) * sx + (hy - cp[1]) * sy + (hz - cp[2]) * sz) / ss));
        let nx = hx - (cp[0] + sx * u), ny = hy - (cp[1] + sy * u), nz = hz - (cp[2] + sz * u);
        const nl = Math.hypot(nx, ny, nz) || 1;
        const M = c.model, bones = [M.head.joint, M.torso.joint, M.armL.sh, M.armL.el, M.armR.sh, M.armR.el, M.legL.hip, M.legL.kn, M.legR.hip, M.legR.kn];
        best = { t: h.t, obj: bones[h.i] || M.root, n: { x: nx / nl, y: ny / nl, z: nz / nl } };
      }
    }
    return best;
  }

  // client: splash blood onto nearby walls / floor / furniture / people (and a wound on the one who was hit)
  spawnBlood(p, d, gun, victim = null, w = 's', rnd = Math.random) {
    const R = (lo, hi) => lo + rnd() * (hi - lo);
    const T = this.T, n = gun ? 5 : 3, range = gun ? 4 : 2;
    // the prop that was hit gets the weapon's own mark where it was hit (bullet hole / knife cut / crowbar scratches)
    if (victim) {
      const back = { x: p.x - d.x * 1.2, y: p.y - d.y * 1.2, z: p.z - d.z * 1.2 };
      const own = this.rayChars(back, d, 2.4, null);
      if (own) {
        const hp = { x: back.x + d.x * own.t, y: back.y + d.y * own.t, z: back.z + d.z * own.t };
        if (w === 'b') this.addDecal(T.bulletHole, hp, own.n, 0.1, 0.1, null, own.obj);
        else if (w === 'c') { const sz = rand(0.22, 0.32); this.addDecal(T.scratch[(Math.random() * T.scratch.length) | 0], hp, own.n, sz, sz, null, own.obj); }
        else { const sz = rand(0.26, 0.4); this.addDecal(T.slash[(Math.random() * T.slash.length) | 0], hp, own.n, sz, sz * 0.25, null, own.obj); }
      }
    }
    // a big pool of blood on the floor under the hit
    {
      const tf = raycastMap(this.map, p.x, p.y, p.z, 0, -1, 0, 4);
      if (tf < 4) {
        const fp = { x: p.x, y: p.y - tf, z: p.z }, sz = gun ? R(1.0, 1.6) : R(0.6, 0.95);
        this.addDecal(T.bloodPool[(rnd() * T.bloodPool.length) | 0], fp, { x: 0, y: 1, z: 0 }, sz, sz, null, null, null, true);
      }
    }
    for (let i = 0; i < n; i++) {
      let dir;
      if (i === 0) dir = new THREE.Vector3((rnd() - 0.5) * 0.3, -1, (rnd() - 0.5) * 0.3);   // drips on the floor below
      else if (gun && i < n - 1) dir = new THREE.Vector3(d.x + (rnd() - 0.5) * 1.1, d.y + (rnd() - 0.5) * 0.9 - 0.15, d.z + (rnd() - 0.5) * 1.1);   // sprayed onward
      else dir = new THREE.Vector3(rnd() - 0.5, -rnd() * 0.9 - 0.1, rnd() - 0.5);
      dir.normalize();
      const tw = raycastMap(this.map, p.x, p.y, p.z, dir.x, dir.y, dir.z, range);
      const ph = this.props.raycast(p.x, p.y, p.z, dir.x, dir.y, dir.z, Math.min(tw, range));
      let t = ph ? ph.t : tw;
      // people standing nearby get splattered too (not the one who was hit: that's the wound above)
      const pc = this.rayChars(p, dir, Math.min(t, range), victim);
      if (pc) t = pc.t;
      if (t >= range) continue;
      const hp = { x: p.x + dir.x * t, y: p.y + dir.y * t, z: p.z + dir.z * t };
      const nrm = pc ? pc.n : ph ? ph.normal : this.mapNormal(hp, dir);
      let size = (gun ? R(0.55, 1.1) : R(0.28, 0.55)) * (0.8 + Math.min(1, t / range) * 0.5);
      if (pc) size *= 0.45;                        // smaller on a body
      const set = gun && i > 0 ? T.bloodSpray : T.blood;
      const clip = pc ? null : ph ? (ph.part ? { local: this.propClipLocal(ph.part, ph.axis) } : null) : null;
      this.addDecal(set[(rnd() * set.length) | 0], hp, nrm, size, size, pc ? null : ph ? ph.prop : null, pc ? pc.obj : null, clip, true);
    }
  }

  knifeHitCheck(c) {
    const fx = forwardX(c.yaw), fz = forwardZ(c.yaw);
    const cosA = Math.cos(W.KNIFE_ANGLE_DEG * DEG);
    let best = null, bd = Infinity;
    for (const o of this.chars.values()) {
      if (!this.canHurt(c, o)) continue;
      const dx = o.x - c.x, dz = o.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > W.KNIFE_RANGE + (o.shapeR || P.RADIUS) || Math.abs(o.y - c.y) > 1.3) continue;
      if (d > 0.4 && (dx * fx + dz * fz) / d < cosA) continue;
      if (!hasLOS(this.map, c.x, c.y + 1.3, c.z, o.x, o.y + 1.1, o.z)) continue;
      if (d < bd) { bd = d; best = o; }
    }
    if (best) {
      c.slashT = 0;
      const d = Math.hypot(best.x - c.x, best.z - c.z) || 1;
      const hy = best.y + (best.disguise ? (best.shapeH || 0.5) * 0.6 : 1.2);
      const crow = weaponOf(c) === 3;
      this.bleed(best, { x: best.x, y: hy, z: best.z }, { x: (best.x - c.x) / d, y: 0, z: (best.z - c.z) / d }, false, crow ? 'c' : 's');
      this.damage(best, c, crow ? W.CROWBAR_DAMAGE : W.KNIFE_DAMAGE, 'knife', { x: ((best.x - c.x) / d) * 3, y: 0.5, z: ((best.z - c.z) / d) * 3 });
      return true;
    }
    return false;
  }

  gunAttack(c, spread = 0) {
    c.attackCd = W.GUN_COOLDOWN;
    const yaw = c.yaw + (Math.random() - 0.5) * spread, pitch = c.pitch + (Math.random() - 0.5) * spread;
    const d = dirFromAngles(yaw, pitch);
    const ox = c.x, oy = c.y + P.EYE, oz = c.z;
    const wall = raycastMap(this.map, ox, oy, oz, d.x, d.y, d.z, W.GUN_RANGE);
    let hit = null, ht = wall;
    for (const o of this.chars.values()) {
      if (!this.canHurt(c, o)) continue;
      const t = this.hitTest(o, ox, oy, oz, d.x, d.y, d.z);
      if (t >= 0 && t < ht) { ht = t; hit = o; }
    }
    // real furniture blocks bullets (gets knocked around, and hurts the seeker)
    const ph = this.props.raycast(ox, oy, oz, d.x, d.y, d.z, ht);
    if (ph) {
      hit = null; ht = ph.t;
      this.props.impulseAt(ph.prop, ph.point, new THREE.Vector3(d.x * 7, d.y * 7 + 1, d.z * 7));
    }
    this.emit({ e: 'shot', id: c.id, f: [r2(ox), r2(oy - 0.15), r2(oz)], t: [r2(ox + d.x * ht), r2(oy + d.y * ht), r2(oz + d.z * ht)] });
    const end = { x: ox + d.x * ht, y: oy + d.y * ht, z: oz + d.z * ht };
    if (hit) { this.bleed(hit, end, d, true, 'b'); this.damage(hit, c, W.GUN_DAMAGE, 'gun', { x: d.x * 7, y: d.y * 7 + 1, z: d.z * 7 }); }
    else if (ph) { this.markImpact('b', ph.point, ph.normal, ph.prop.id); this.wrongProp(c); }
    else if (ht < W.GUN_RANGE) this.markImpact('b', end, this.mapNormal(end, d));
    return hit;
  }

  kill(target, killer, cause, impulse) {
    if (!target.alive) return;
    const wasObject = !!target.disguise;      // furniture vanishes; only a person (or human prop) ragdolls
    target.alive = false;
    target.anchored = false;
    target.slot = -1;
    target.disguise = null;
    this.corpses.push({ id: target.id, x: target.x, y: target.y, z: target.z, t: this.time });
    this.emit({
      e: 'death', id: target.id, cause,
      i: [r2(impulse.x), r2(impulse.y), r2(impulse.z)],
      v: [r2(target.vx), r2(target.vy), r2(target.vz)],
      p: [r2(target.x), r2(target.y), r2(target.z)],
      obj: wasObject ? 1 : 0,
    });
    if (killer && killer !== target) {
      this.emit({ e: 'msg', text: `${killer.nick} found ${target.nick}`, color: '#ccc' });
    }
  }

  hostItems(dt) {
    for (const it of this.items.values()) {
      if (!it.flying) continue;
      const steps = 3;
      for (let s = 0; s < steps && it.flying; s++) {
        const h = dt / steps;
        it.vy -= (it.type === 'crowbar' ? W.CROWBAR_GRAVITY : 9) * h;     // the crowbar is heavier
        const sp = Math.hypot(it.vx, it.vy, it.vz) || 1;
        const dx = it.vx / sp, dy = it.vy / sp, dz = it.vz / sp;
        const len = sp * h;
        const wall = raycastMap(this.map, it.x, it.y, it.z, dx, dy, dz, len);
        // characters
        let hit = null, ht = wall;
        const owner = this.chars.get(it.owner);
        for (const o of this.chars.values()) {
          if (!o.alive || o.id === it.owner || o.team !== 'prop') continue;
          const t = this.hitTest(o, it.x, it.y, it.z, dx, dy, dz, 0.04);
          if (t >= 0 && t <= ht) { ht = t; hit = o; }
        }
        const ph = this.props.raycast(it.x, it.y, it.z, dx, dy, dz, ht);
        if (ph) {
          hit = null;
          this.props.impulseAt(ph.prop, ph.point, new THREE.Vector3(dx * 3, dy * 3, dz * 3));
          if (owner) this.wrongProp(owner);              // a thrown knife into real furniture costs health too
          this.markImpact(it.type === 'crowbar' ? 'c' : 's', ph.point, ph.normal, ph.prop.id);
          it.x += dx * Math.max(0, ph.t - 0.1); it.y += dy * Math.max(0, ph.t - 0.1); it.z += dz * Math.max(0, ph.t - 0.1);
          it.flying = false;
          it.y = groundHeight(this.map, it.x, it.z, 0.1, it.y + 0.3) + 0.05;
          this.emit({ e: 'clink', p: [r2(it.x), r2(it.y), r2(it.z)] });
          break;
        }
        if (hit) {
          this.bleed(hit, { x: it.x + dx * ht, y: it.y + dy * ht, z: it.z + dz * ht }, { x: dx, y: dy, z: dz }, false, it.type === 'crowbar' ? 'c' : 's');
          this.damage(hit, owner || null, it.type === 'crowbar' ? W.CROWBAR_THROW_DAMAGE : W.THROW_DAMAGE, 'knife', { x: dx * 5, y: 1, z: dz * 5 });
          it.flying = false;
          it.x = hit.x; it.z = hit.z; it.y = groundHeight(this.map, it.x, it.z, 0.1, hit.y + 0.5) + 0.05;
          break;
        }
        if (wall < len) {
          { const hp = { x: it.x + dx * wall, y: it.y + dy * wall, z: it.z + dz * wall }; this.markImpact(it.type === 'crowbar' ? 'c' : 's', hp, this.mapNormal(hp, { x: dx, y: dy, z: dz })); }
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
      if (!c.alive || c.team !== 'seeker' || (c.hasKnife && c.hasCrowbar)) continue;
      // seekers pick thrown knives back up
      for (const it of this.items.values()) {
        if (it.flying) continue;
        if (Math.abs(it.y - c.y) > 1.5 || Math.hypot(it.x - c.x, it.z - c.z) > W.KNIFE_PICKUP_RADIUS) continue;
        const kind = it.type === 'crowbar' ? 'crowbar' : 'knife';
        if (kind === 'crowbar' ? c.hasCrowbar : c.hasKnife) continue;
        this.items.delete(it.id);
        if (kind === 'crowbar') c.hasCrowbar = true; else c.hasKnife = true;
        if (!c.hotbar.includes(kind) && !c.backpack.includes(kind)) {
          const k = c.hotbar.indexOf(null);
          if (k >= 0) c.hotbar[k] = kind; else { const b = c.backpack.indexOf(null); if (b >= 0) c.backpack[b] = kind; }
        }
        this.emit({ e: 'msg', text: `You picked your ${kind} back up.`, color: '#f66', snd: 'pickup' }, [c.id]);
        break;
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
    // blood that was already spilled this round (no flying drops: they landed long ago)
    if (Array.isArray(w.blood)) for (const ev of w.blood) this.applyEvent({ ...ev, old: 1 });
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
      c.nick = r.nick; c.isBot = !!r.bot; c.color = r.color; c.team = r.team || 'none';
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
        c.weaponVis = f & F_KNIFE ? 1 : f & F_GUN ? 2 : f & F_CROWBAR ? 3 : 0;
        c.team = f & F_SEEKER ? 'seeker' : f & F_PROP ? 'prop' : 'none';
        c.disguise = s[8] >= 0 ? PROP_LIST[s[8]] || null : null;
        if (c.id === this.localId) {
          if (m.me) {
            c.hasKnife = !!m.me.k; c.hasGun = !!m.me.g; c.hasCrowbar = !!m.me.cb; c.slot = m.me.sl;
            if (m.me.hb) c.hotbar = m.me.hb;
            if (m.me.bp) c.backpack = m.me.bp;
            c.hp = m.me.hp; if (m.me.mh) c.maxHp = m.me.mh;
            if (performance.now() - (this._anchorT || 0) > 600) c.anchored = !!m.me.an;
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
        if (!it) { it = { id, type: type === 3 ? 'crowbar' : 'knife', x, y, z }; this.items.set(id, it); }
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
        this.bloodLog = [];
        for (const rd of this.ragdolls.values()) rd.dispose();
        this.ragdolls.clear();
        this.clearTracers();
        this.clearMarks();
        if (!this.isHost) this.items.clear();
        for (const c of this.chars.values()) { c.disguise = null; this.setDisguiseMesh(c, null); }
        this.specId = null;
        this.myTeam = 'none';
        break;
      case 'roster':
        if (!this.isHost) this.syncRoster(ev.list);
        ui.refreshScoreboard?.();
        break;
      case 'spawn': {
        const me = this.me;
        if (!me) break;
        me.x = ev.x; me.y = ev.y; me.z = ev.z; me.yaw = ev.yaw; me.pitch = 0;
        this.camYaw = ev.yaw; this.camPitch = -0.15;
        me.vx = me.vy = me.vz = 0; me.alive = true; me.spectator = false;
        me.stamina = P.STAMINA_MAX; me.exhausted = false; me.spawnAt = performance.now();
        this.deathT = 0;
        break;
      }
      case 'team': {
        this.myTeam = ev.team;
        const me = this.me;
        if (me) me.team = ev.team;
        const R = {
          seeker: ['You are a Seeker', '', '#f55'],
          prop: ['You are a Prop', `${this.ui.isTouch ? 'Tap' : 'Click'} on any furniture to turn into it. Hide before the seekers are released!`, '#4af'],
        }[ev.team];
        if (R) ui.bigMessage(R[0], R[1], R[2], 5);
        Audio.roundStart(ev.team === 'seeker');
        break;
      }
      case 'phase':
        this.phase = ev.phase; this.timeLeft = ev.tl;
        if (ev.phase === 'play') { ui.toast('The seekers are coming!', '#fd6'); Audio.roundStart(true); }
        if (ev.phase === 'post') {
          const seekersWon = ev.winner === 'seekers';
          const surv = ev.survivors && ev.survivors.length ? `Survivors: ${ev.survivors.map(escapeHtml).join(', ')}` : '';
          const sub = [ev.reason ? escapeHtml(ev.reason) : '', surv].filter(Boolean).join('<br>');
          ui.bigMessage(seekersWon ? 'Seekers Win!' : 'Props Win!', sub, seekersWon ? '#f55' : '#4af', CONFIG.ROUND.POST_TIME - 0.5, true);
          Audio.roundEnd(seekersWon === (this.myTeam === 'seeker'));
        }
        break;
      case 'morph': {
        const c = this.chars.get(ev.id);
        if (!c) break;
        c.disguise = ev.type;
        if (ev.id === this.localId) Audio.pickup(); // the "poof" is only heard by the player who changed
        break;
      }
      case 'death': {
        const c = this.chars.get(ev.id);
        if (!c) break;
        c.alive = false;
        const vel = { x: ev.v[0], y: ev.v[1], z: ev.v[2] };
        if (c.id !== this.localId) { c.x = ev.p[0]; c.y = ev.p[1]; c.z = ev.p[2]; }
        c.disguise = null; this.setDisguiseMesh(c, null);
        const pos = { x: ev.p[0], y: ev.p[1] + 1, z: ev.p[2] };
        if (ev.obj) {
          // a prop that was furniture just disappears
          c.model.setVisible(false);
          Audio.prop(pos, 'wood', 0.8);
        } else {
          this.spawnRagdoll(c, vel, { x: ev.i[0], y: ev.i[1], z: ev.i[2] });
          if (ev.cause !== 'suicide' && Math.random() < 0.6) Audio.scream(pos);
        }
        if (ev.cause === 'knife') Audio.stab(pos);
        Audio.thud(pos);
        if (c.id === this.localId) {
          this.deathT = 0;
          this.specId = null; this.flyPos = null;   // start in the free flying camera
          this.ui.toast(ev.cause === 'suicide' ? 'You are now spectating. Press X again for the menu.' : ev.cause === 'penalty' ? 'You hit too much real furniture! Press X for the main menu.' : 'You were found! Press X for the main menu.', '#f66', 3);
        }
        break;
      }
      case 'imp': {
        const p = { x: ev.p[0], y: ev.p[1], z: ev.p[2] }, n = { x: ev.n[0], y: ev.n[1], z: ev.n[2] };
        const prop = ev.pid >= 0 ? this.props.list[ev.pid] : null;
        const clip = prop ? this.propFaceClip(prop, p, n) : null;
        if (ev.k === 'b') this.addDecal(this.T.bulletHole, p, n, 0.11, 0.11, prop, null, clip);
        else if (ev.k === 'c') { const sz = rand(0.28, 0.4); this.addDecal(this.T.scratch[(Math.random() * this.T.scratch.length) | 0], p, n, sz, sz, prop, null, clip); }
        else { const sz = rand(0.32, 0.5); this.addDecal(this.T.slash[(Math.random() * this.T.slash.length) | 0], p, n, sz, sz * 0.25, prop, null, clip); }
        break;
      }
      case 'blood': {
        const bp = { x: ev.p[0], y: ev.p[1], z: ev.p[2] }, bd = { x: ev.d[0], y: ev.d[1], z: ev.d[2] };
        const rnd = seededRandom(ev.s ?? ((Math.random() * 2 ** 31) | 0));
        this._bloodRnd = rnd;   // splat spin comes from the same seed too
        this.spawnBlood(bp, bd, !!ev.g, this.chars.get(ev.id), ev.w || (ev.g ? 'b' : 's'), rnd);
        this._bloodRnd = null;
        if (!ev.old) this.bloodBurst(bp, bd, !!ev.g, rnd);
        break;
      }
      case 'hit': Audio.thud({ x: ev.p[0], y: ev.p[1], z: ev.p[2] }); break;
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
    c.model.update(0, { x: c.rx, y: c.ry, z: c.rz, yaw: c.ryaw, pitch: 0, speed: c.rspeed, onGround: true, weapon: 0, tpose: c.team === 'prop' }, c.ry);
    c.model.setDead(true);                    // X eyes + sad mouth on the body
    const rd = new Ragdoll(this.root, c.model, this.map, vel, impulse);
    c.model.setDead(false);
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

  // show / hide the furniture mesh of a disguised prop player
  setDisguiseMesh(c, type) {
    if (c.dmesh && c.dmesh.type === type) return;
    if (c.dmesh) { this.root.remove(c.dmesh.mesh); c.dmesh.dispose(); c.dmesh = null; }
    if (type) { c.dmesh = new DisguiseMesh(this.T, type); this.root.add(c.dmesh.mesh); }
  }

  syncItemMeshes(dt) {
    for (const [id, it] of this.items) {
      let m = this.itemMeshes.get(id);
      if (!m) {
        const inner = it.type === 'crowbar' ? makeCrowbarMesh() : makeKnifeMesh();
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
  // free camera (shift lock off) and props are always third person
  thirdPerson() { return this.camDist > 0.25; }
  camDistance() { return this.camDist; }
  // free camera = shift lock off and not zoomed into first person
  freeCam() { return !this.shiftLock && this.thirdPerson(); }
  eyeHeight(c) { return c.disguise ? Math.max(0.6, propHeight(c.disguise) + 0.35) : P.EYE; }

  // A ray from the camera: through a point on the screen, or straight through the middle
  screenRay(screen = null) {
    const cam = this.camera;
    if (screen) {
      cam.updateMatrixWorld();
      const v = new THREE.Vector3((screen.x / window.innerWidth) * 2 - 1, -(screen.y / window.innerHeight) * 2 + 1, 0.5).unproject(cam);
      return { o: cam.position, d: v.sub(cam.position).normalize() };
    }
    return { o: cam.position, d: dirFromAngles(this.camYaw, this.camPitch) };
  }

  // Direction the player aims: from the eyes toward whatever the camera ray (crosshair,
  // or the tapped / clicked point on the screen) hits, so shots land where you point.
  aimAngles(screen = null) {
    const me = this.me;
    if (!this.thirdPerson() || !this._camPos) return { yaw: this.camYaw, pitch: this.camPitch };
    const { o: cp, d } = this.screenRay(screen);
    let t = raycastMap(this.map, cp.x, cp.y, cp.z, d.x, d.y, d.z, 90);
    for (const c of this.chars.values()) {
      if (c === me || !c.alive) continue;
      const tc = this.hitTest(c, cp.x, cp.y, cp.z, d.x, d.y, d.z, 0, true);
      if (tc >= 0 && tc < t) t = tc;
    }
    const ph = this.props.raycast(cp.x, cp.y, cp.z, d.x, d.y, d.z, t);
    if (ph) t = ph.t;
    const tx = cp.x + d.x * t, ty = cp.y + d.y * t, tz = cp.z + d.z * t;
    const ex = me.x, ey = me.y + P.EYE, ez = me.z;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
  }

  localAction(a, n, screen = null) {
    const me = this.me;
    const aimed = a === 'attack' || a === 'throw';
    const aim = aimed ? this.aimAngles(screen) : { yaw: me.yaw, pitch: me.pitch };
    if (aimed && this.freeCam()) { me.yaw = aim.yaw; me.pitch = aim.pitch; this.faceT = 0.7; } // turn toward what you shoot at
    if (this.isHost) {
      const y = me.yaw, pt = me.pitch;
      me.yaw = aim.yaw; me.pitch = aim.pitch;
      this.hostAction(me, a, n);
      if (me.alive) { me.yaw = y; me.pitch = pt; }
      return;
    }
    this.net?.send({ t: 'act', a, n, yw: r2(aim.yaw), pt: r2(aim.pitch) });
  }

  // called by the hotbar / inventory UI
  selectSlot(k) { if (this.me?.alive) this.localAction('slot', k); }
  invSwap(i, j) { if (this.me?.alive) this.localAction('inv', [i, j]); }
  // props: anchor = freeze your prop in place and fly the camera around; press again to go back
  toggleAnchor() {
    const me = this.me;
    if (!me || !me.alive || me.team !== 'prop') return;
    if (me.team === 'prop' && this.phase !== 'pre' && this.phase !== 'play') return;
    if (this.isHost) this.hostAction(me, 'anchor');          // the host flips it directly
    else { me.anchored = !me.anchored; this.net?.send({ t: 'act', a: 'anchor' }); }
    me.vx = me.vy = me.vz = 0; me.speed = 0;
    this._anchorT = performance.now();
    this.flyPos = me.anchored ? this.camera.position.clone() : null;
    this.specId = null;
  }

  toggleShiftLock(on = !this.shiftLock) {
    this.shiftLock = on;
    this.settings.shiftLock = on;
    this.o.onSettings?.();
    this.ui.input?.setLockMode?.(on);
    const me = this.me;
    if (on && me) { this.camYaw = me.yaw; }
  }

  // which real prop is under the crosshair (or under a tap on the screen)?
  // Props aim with a big ring a bit below the middle of the screen (where your body is), always shown.
  // Anything inside the ring counts: the middle first, then points around it (closest to the centre wins).
  pickProp(screen = null) {
    if (!screen && this.me && this.me.team === 'prop') {
      const cx = window.innerWidth / 2, cy = window.innerHeight * PROP_AIM_Y, R = PROP_AIM_R;
      for (const [dx, dy] of PROP_AIM_PTS) { const p = this.pickPropAt({ x: cx + dx * R, y: cy + dy * R }); if (p) return p; }
      return null;
    }
    return this.pickPropAt(screen);
  }
  pickPropAt(screen = null) {
    const me = this.me;
    const { o, d } = this.screenRay(screen);
    const reach = TM.DISGUISE_RANGE + (this._camActualDist || 0) + 1;
    const wall = raycastMap(this.map, o.x, o.y, o.z, d.x, d.y, d.z, reach);
    const ph = this.props.raycast(o.x, o.y, o.z, d.x, d.y, d.z, wall);
    if (!ph) return null;
    if (Math.hypot(ph.prop.pos.x - me.x, ph.prop.pos.z - me.z) > TM.DISGUISE_RANGE + ph.prop.r + 0.5) return null;
    return ph.prop;
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
    if (inp.zoom) this.camDist = clamp(this.camDist + inp.zoom, 0, 8);
    if (inp.toggleView) { if (this.camDist > 0.25) { this._lastDist = this.camDist; this.camDist = 0; } else this.camDist = this._lastDist || 2.5; }
    if (this.camDist < 0.25 && inp.zoom < 0) this.camDist = 0;

    if (inp.shiftLock && !(me.alive && me.team === 'seeker' && this.phase === 'pre')) this.toggleShiftLock();
    this.camYaw = wrapAngle(this.camYaw - inp.lookDX);
    this.camPitch = clamp(this.camPitch - inp.lookDY, -1.5, 1.5);
    if ((!this.freeCam() || !me.alive) && !me.anchored) { me.yaw = this.camYaw; me.pitch = this.camPitch; }
    // where an attack goes: shift lock = the crosshair; free camera = the tapped / clicked spot
    const point = !this.freeCam() || me.team === 'prop' ? null : (inp.tap || inp.point || (inp.attackHeld && !this.ui.isTouch ? this.ui.input?.mouse : null) || null);

    if (inp.anchor) this.toggleAnchor();
    if (!me.alive || me.anchored) {
      if (inp.inv) this.ui.toggleInventory?.(this);
      if (!me.alive && (inp.next || inp.attack)) this.cycleSpectate();
      // spectator / anchored free camera: fly with the joystick / WASD in the direction you look, through walls
      if (inp.fwd || inp.strafe) {
        if (this.specId != null) { this.specId = null; this.flyPos = this.camera.position.clone(); }  // moving stops watching
        if (!this.flyPos) this.flyPos = this.camera.position.clone();
        const f = dirFromAngles(this.camYaw, this.camPitch);
        const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
        const sp = (inp.run ? 18 : 9) * dt;
        this.flyPos.x += (f.x * inp.fwd + rx * inp.strafe) * sp;
        this.flyPos.y += f.y * inp.fwd * sp;
        this.flyPos.z += (f.z * inp.fwd + rz * inp.strafe) * sp;
        this.flyPos.y = clamp(this.flyPos.y, -2, 60);
      }
      return;
    }
    // blindfolded seeker: nothing works until the round starts (only settings, scoreboard and X)
    if (me.team === 'seeker' && this.phase === 'pre') {
      this.ui.toggleInventory?.(this, false);
      moveCharacter(me, { mx: 0, mz: 0, run: false, jump: false }, dt, this.map);
      return;
    }
    if (inp.inv) this.ui.toggleInventory?.(this);

    if (me.team === 'prop') {
      // tap / click furniture to turn into it (tap another piece to change)
      const target = inp.tap ? this.pickProp(inp.tap) : inp.attack ? this.pickProp(point) : null;
      if (target) this.localAction('disguise', target.id);
      else if (inp.attack && !inp.tap) this.ui.toast('Aim at furniture to turn into it', '#ccc', 1.5);
    }
    if (me.team === 'seeker') {
      if (inp.slot >= 0) this.localAction('slot', inp.slot);
      if (inp.equip) this.localAction('equip');
    }
    if (inp.throw && isMelee(this.localWeapon())) this.localAction('throw', undefined, point);
    // free camera: tapping the world with a weapon in hand attacks that spot
    const tapAttack = this.freeCam() && inp.tap && this.localWeapon() !== 0;
    if (me.team === 'seeker' && (inp.attack || tapAttack || (inp.attackHeld && this.localWeapon() === 2))) {
      const w = this.localWeapon();
      if (w === 0) this.localAction('attack');
      else if (this.phase === 'play' && this.localGunCd <= 0) {
        if (isMelee(w)) {
          this.localGunCd = W.KNIFE_COOLDOWN;
          this.viewModel.swing(); me.model.swing(); Audio.swing(null);
          this.localAction('attack', undefined, point);
        } else {
          this.localGunCd = W.GUN_COOLDOWN;
          this.lastLocalShot = performance.now();
          this.viewModel.recoil(); me.model.recoil();
          Audio.gunshot(null);
          this.shake = 0.25;
          this.localAction('attack', undefined, point);
        }
      }
    }
    if (this.localGunCd > 0) this.localGunCd -= dt;

    // movement (relative to the camera)
    const fx = forwardX(this.camYaw), fz = forwardZ(this.camYaw);
    const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
    let mx = fx * inp.fwd + rx * inp.strafe, mz = fz * inp.fwd + rz * inp.strafe;
    const frozen = me.team === 'seeker' && this.phase === 'pre';   // seekers wait blindfolded while props hide
    if (frozen) mx = mz = 0;
    if (this.freeCam()) {
      // free camera: turn to face where you walk (after a shot, keep facing it for a moment)
      this.faceT -= dt;
      if ((mx || mz) && this.faceT <= 0) me.yaw = turnToward(me.yaw, Math.atan2(-mx, -mz), dt * 12);
      if (this.faceT <= 0) me.pitch *= Math.exp(-dt * 4);
    }
    const wasGround = me.onGround;
    moveCharacter(me, { mx, mz, run: inp.run, jump: inp.jump && !frozen, wallClimb: me.team === 'prop' }, dt, this.map);
    const floorType = this.map.floorTypeAt(me.x, me.z);
    if (me.landed > 5) { Audio.land(null, me.landed, floorType); this.shake = Math.min(0.3, me.landed * 0.02); }
    if (wasGround && !me.onGround && me.vy > 0) Audio.jump(null, floorType);

    // don't walk through other people or furniture (soft, so the host can push props)
    for (const o of this.chars.values()) {
      if (o === me || !o.alive || Math.abs(me.x - o.rx) > 6 || Math.abs(me.z - o.rz) > 6) continue;
      const oy = o.y; o.y = o.ry;
      const hit = footOverlap(me, me.x, me.z, o, o.rx, o.rz);
      o.y = oy;
      if (hit) { me.x += hit.nx * hit.pen; me.z += hit.nz * hit.pen; me.climbT = 0.2; }   // (props can climb people too)
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

  // ▶ / click: watch the next player; after the last one, back to the free flying camera
  cycleSpectate() {
    const alive = [...this.chars.values()].filter((c) => c.alive && c.id !== this.localId);
    const i = alive.findIndex((c) => c.id === this.specId);
    if (!alive.length || i === alive.length - 1) { this.specId = null; this.flyPos = this.camera.position.clone(); return; }
    this.specId = alive[i + 1].id;
  }

  // ---------------------------------------------------------------
  //  FRAME
  // ---------------------------------------------------------------
  update(dt, inp) {
    if (this.ended) return;
    this.time += dt;
    if (!this.isHost) this.timeLeft -= dt;
    // collision size: disguised props are as big as the furniture they copy
    for (const c of this.chars.values()) {
      const sh = c.disguise ? propShape(c.disguise) : null;
      c.shapeR = sh ? sh.r : 0; c.shapeH = sh ? sh.h : 0;
      // collision footprint: every part of the furniture, or a human prop's T-posed arms
      c.foot = c.disguise ? propFoot(c.disguise) : !c.alive ? null : c.team === 'prop' ? TPOSE_FOOT : BODY_FOOT;
    }
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

      this.setDisguiseMesh(c, c.alive ? c.disguise : null);
      const showModel = c.alive && !c.disguise && !(c === me && !this.ownBodyVisible());
      c.model.setVisible(showModel);
      if (c.dmesh) {
        c.dmesh.mesh.position.set(c.rx, c.ry, c.rz);
        c.dmesh.mesh.rotation.y = c.ryaw;
        c.dmesh.mesh.visible = !(c === me && !this.ownBodyVisible());
      }
      if (c.alive) {
        const gy = groundHeight(this.map, c.rx, c.rz, 0.2, c.ry + 0.1);
        c.model.update(dt, { x: c.rx, y: c.ry, z: c.rz, yaw: c.ryaw, pitch: c.rpitch, speed: c.rspeed, onGround: c.rground, weapon: c.weaponVis, tpose: c.team === 'prop' }, gy);
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
          if (c.dmesh) c.dmesh.setLight(c.model.light);
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
    this.updateBursts(dt);
    // Blood setting changed: show / hide the blood that's already there
    const showBlood = !!this.settings.blood;
    if (showBlood !== this.bloodShown) {
      this.bloodShown = showBlood;
      for (const dc of this.decals) if (dc.blood) dc.m.visible = showBlood;
      for (const b of this.bursts || []) b.pts.visible = showBlood;
    }
    // marks stay until the next round starts; ones on furniture keep their edge clipping in step with it
    for (const dc of this.decals) {
      if (dc.local) { const cp = dc.m.material.clippingPlanes; for (let k = 0; k < cp.length; k++) cp[k].copy(dc.local[k]).applyMatrix4(dc.parent.matrixWorld); }
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.t -= dt;
      t.mesh.material.opacity = Math.max(0, t.t / 0.12);
      t.flash.material.opacity = Math.max(0, t.t / 0.12);
      t.flash.scale.setScalar(1 + (0.12 - t.t) * 6);
      if (t.t <= -0.1) { this.root.remove(t.mesh); this.root.remove(t.flash); t.mesh.geometry.dispose(); t.mesh.material.dispose(); t.flash.material.dispose(); this.tracers.splice(i, 1); }
    }
    this.syncItemMeshes(dt);

    this.updateCamera(dt);
    this.updateHud(dt);
  }

  // own body is drawn in third person (only on this screen; others always see you)
  ownBodyVisible() { return this.thirdPerson() && (this._camActualDist ?? 9) > 0.55; }

  updateCamera(dt) {
    const cam = this.camera, me = this.me;
    if (!me) return;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
    const sh = (this.settings.shake !== false ? this.shake || 0 : 0);
    if (me.alive && me.anchored) {
      // anchored prop: free flying camera (the prop itself stays frozen where it is)
      this.viewModel.update(dt, 0, 0, false);
      if (!this.flyPos) this.flyPos = cam.position.clone();
      cam.position.copy(this.flyPos);
      cam.rotation.set(this.camPitch, this.camYaw, 0);
      this._camActualDist = 9;
      this._camPos = cam.position;
    } else if (me.alive) {
      // view bobbing in first person only. In third person the camera stays smooth, so your
      // character / prop doesn't look like it bounces up and down on screen while moving.
      const bobOn = this.settings.viewBob !== false && !this.thirdPerson();
      const bob = bobOn && me.onGround ? Math.sin(this.time * 9) * 0.035 * Math.min(1, me.speed / 4) : 0;
      const ex = me.x, ey = me.y + this.eyeHeight(me) + bob, ez = me.z;
      if (this.thirdPerson()) {
        // camera behind you, pulled in when a wall is in the way
        const d = dirFromAngles(this.camYaw, this.camPitch);
        const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
        // shift lock + weapon out -> tighter over-the-right-shoulder view for aiming
        // shift lock: camera over your right shoulder (for aiming); free camera: right behind you
        const aiming = this.shiftLock;
        const cd = this.camDistance();
        const tSide = aiming ? 0.68 : 0;
        const tDist = cd;
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
      cam.rotation.set(this.camPitch + (Math.random() - 0.5) * sh * 0.05, this.camYaw + (Math.random() - 0.5) * sh * 0.05, 0);
      this._camPos = cam.position;
      this.viewModel.setLook(me.look, me.color, Math.min(1.4, me.model.light[1]));
      this.viewModel.update(dt, weaponOf(me), me.onGround ? me.speed : 0, !this.thirdPerson());
    } else {
      this.viewModel.update(dt, 0, 0, false);
      this.deathT += dt;
      // watching a player (picked with ▶), or the free flying camera
      let target = null;
      const s = this.chars.get(this.specId);
      if (s && s.alive) target = { x: s.rx, y: s.ry, z: s.rz, c: s };
      else if (this.specId != null) { this.specId = null; this.flyPos = cam.position.clone(); }
      if (target) {
        const yaw = this.camYaw, pitch = clamp(this.camPitch, -1.2, 0.6);
        const d = dirFromAngles(yaw, pitch);
        const hx = target.x, hy = target.y + 1.6, hz = target.z;
        let dist = Math.max(2, this.camDist || 3.2);
        const hit = raycastMap(this.map, hx, hy, hz, -d.x, -d.y, -d.z, dist + 0.3);
        dist = Math.max(0.4, Math.min(dist, hit - 0.3));
        cam.position.set(hx - d.x * dist, hy - d.y * dist, hz - d.z * dist);
        cam.rotation.set(pitch, yaw, 0);
      } else {
        if (!this.flyPos) {
          // start flying from where you were (a little above and behind), or above the map for late joiners
          this.flyPos = me.spectator ? new THREE.Vector3(this.map.center().x, 8, this.map.center().z)
            : new THREE.Vector3(me.x, me.y + 2.2, me.z).addScaledVector(dirFromAngles(this.camYaw, this.camPitch), -2.5);
        }
        cam.position.copy(this.flyPos);
        cam.rotation.set(this.camPitch, this.camYaw, 0);
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
    // shift lock: what the crosshair points at; free camera: what the mouse hovers (nothing on phones)
    // (props aim with an invisible ring over their body)
    const hover = !this.freeCam() || me.team === 'prop' ? null : this.ui.isTouch ? false : (this.ui.input?.mouse || false);
    if (me.alive && hover !== false) {
      const { o: cp, d } = this.screenRay(hover);
      const wall = raycastMap(this.map, cp.x, cp.y, cp.z, d.x, d.y, d.z, 14 + (this._camActualDist || 0));
      let bt = wall;
      for (const c of this.chars.values()) {
        if (c === me || !c.alive) continue;
        const t = this.hitTest(c, cp.x, cp.y, cp.z, d.x, d.y, d.z, 0.04, true);
        if (t >= 0 && t < bt) { bt = t; look = c; }
      }
      // a disguised prop only shows its name to its own team (seekers just see furniture)
      if (look && look.disguise && look.team !== me.team) look = null;
      if (look) look = { nick: look.nick, color: look.color };
      if (!look && me.team === 'prop') {
        this._pickT = (this._pickT || 0) - dt;
        if (this._pickT <= 0) { this._pickT = 0.1; this._pick = this.pickProp(null); }
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
      me, team: me.team, phase: this.phase, timeLeft: this.timeLeft,
      look, spec, weapon: weaponOf(me), hasKnife: me.hasKnife, hasGun: me.hasGun, hasCrowbar: me.hasCrowbar,
      hotbar: me.hotbar, backpack: me.backpack, slot: me.slot, hp: me.hp, maxHp: me.maxHp, disguise: me.disguise ? propName(me.disguise) : null,
      propsLeft: this.countAlive('prop'), seekersLeft: this.countAlive('seeker'),
      blind: me.alive && me.team === 'seeker' && this.phase === 'pre',
      shiftLock: this.shiftLock, crosshair: !this.freeCam() && me.team !== 'prop' && !me.anchored, propAim: false, anchored: !!me.anchored,
      server: this.serverLabel, code: this.code, players: this.chars.size,
      deathT: this.deathT, third: this.thirdPerson(),
    });
  }

  countAlive(team) { let n = 0; for (const c of this.chars.values()) if (c.alive && c.team === team) n++; return n; }

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
    this.ui.toggleInventory?.(this, false);
    for (const id of [...this.trails.keys()]) this.updateTrail(id, 0, 0, 0, false, true);
    for (const id of [...this.chars.keys()]) this.removeChar(id);
    for (const rd of this.ragdolls.values()) rd.dispose();
    this.ragdolls.clear();
    this.clearMarks();
    this.clearTracers();
    for (const m of this.itemMeshes.values()) this.root.remove(m);
    this.itemMeshes.clear();
    this.props.dispose();
    this.scene.remove(this.root);
    this.camera.remove(this.viewModel.group);
  }
}

// small seeded random generator (mulberry32): same seed -> same numbers on every player's screen
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// a person's collision footprint, shaped like the body instead of one big cylinder:
// two legs, the torso (shoulder-wide), the head
const BODY_FOOT = [
  { x: 0.1, z: 0, r: 0.11, y0: 0, y1: 0.92 }, { x: -0.1, z: 0, r: 0.11, y0: 0, y1: 0.92 },     // legs / hips
  { x: 0.11, z: 0, r: 0.18, y0: 0.85, y1: 1.46 }, { x: -0.11, z: 0, r: 0.18, y0: 0.85, y1: 1.46 },   // torso + shoulders
  { x: 0, z: 0, r: 0.17, y0: 1.42, y1: P.HEIGHT },                                              // head
];
// a human prop: the same body plus its T-posed arms (at shoulder height)
const TPOSE_FOOT = [...BODY_FOOT,
  ...[0.42, 0.56, 0.7, 0.82].flatMap((x) => [x, -x]).map((x) => ({ x, z: 0, r: 0.075, y0: 1.28, y1: 1.5 }))];

// the props' aiming ring: how far down the screen (0 top .. 1 bottom), its radius in pixels, and the
// spots inside it that are tried (centre first, then a ring halfway out, then the edge)
const PROP_AIM_Y = 0.6, PROP_AIM_R = 34;
const PROP_AIM_PTS = [[0, 0], ...[0.5, 1].flatMap((r) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos(k * Math.PI / 4) * r, Math.sin(k * Math.PI / 4) * r]))];

let DROP_TEX = null;   // round blood-drop sprite, shared by every game

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

