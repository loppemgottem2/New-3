// =====================================================================
//  MAP.JS — the level. Edit the ASCII LAYOUT below to change the map!
//
//  Each character = one CELL (2 x 2 meters).
//   FLOORS   .  tile (indoor)      ,  wood (indoor)     ;  carpet (indoor)
//            _  concrete (indoor)  o  grass (outdoor)   a  asphalt (outdoor)
//            ~  trashed room floor (normal tile look, plus graffiti tags and a few dirt / trash spots)
//   SOLID    #  wall (6 m)         P  pillar            Q  tall shelf (2.2 m)
//            W  counter / desk (1 m, you can jump on it)
//   PROPS (movable physics objects)
//            B  cardboard box      C  wooden crate      K  chair
//            T  table              X  barrel             M  mattress
//            L  floor lamp         b  beer bottle        U  trash can
//            f  takeout food boxes  p  pile of beer bottles   m  stack of mattresses
//            V  two barrels stacked Y  pile of 3 barrels lying on their sides
//            Z  two crates stacked  J  crate pyramid (2 crates + 1 on top)
//   MARKERS  S  spawn point        (G = unused marker, plain floor)
//  Markers / props / solid furniture take the floor type of their neighbours.
//  Indoor floors get a ceiling with lights automatically (every 3rd cell).
//  Keep the outer border made of '#'. All rows must be the same length.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js?v=720';
import { fbm } from './textures.js?v=720';
import { furnish, DARK_ROOMS } from './furnish.js?v=720';

export const CELL = 2;          // meters per character
export const WALL_H = 6;        // wall height
export const CEIL_H = 6;        // ceiling height indoors

export const LAYOUT = [
  '############################################################',
  '############################################################',
  '##;QQQQ;;;;;;;;;#....#................#....#_____________G##',
  '##;;;;;;;;;;;;;;#..G.#..S............G#....#____S_________##',
  '##;;S;;;;;;;;;;;#....#...K....K....K..#....#______________##',
  '##;;WWW;;;WWW;;;#....#..KTK..KTK..KTK.#....#__QQQQQQQQQ___##',
  '##;;;K;;;;;K;;;;#....#...K....K....K..#....#_____________S##',
  '##G;;;;;;;;;S;;;............................______G_______##',
  '##;;;;;;;;;;;;;;..S...G.............S.......______________##',
  '##;;WWW;;;WWW;;;.........K....K....K........__QQQQQQQQQ___##',
  '##;;;K;;;;;K;;;;#....#..KTK..KTK..KTK.#....#______________##',
  '##;S;;;;;G;;;;;;#....#...K....K....K..#....#_______S______##',
  '##;;;;;;;;;;;;;G#....#.S..............#....#______________##',
  '##;;WWW;;;WWW;;;#....#.......S........#..S.#_SQQQQQQQQQ___##',
  '##;;;K;;;;;K;;;;#....#.WWWWW..........#....#______________##',
  '##;;;;;;S;;;;;;;#....#.........G......#....#_________G____##',
  '#######...#######....#######....#######....######...########',
  '##.................................G......................##',
  '##........S...............................................##',
  '##................................................S.......##',
  '##........................................................##',
  '#######...#######....#######....#######....######...########',
  '##.......G......#....#oooooooaaooooooo#....#~~~~U~~G~~~~~~##',
  '##.SKKK...KKK...#....#ooooooSaaGoooooo#....#~WW~~~LM~~~~m~##',
  '##..............#....#oooooooaaooooooo#....#~~K~~S~~~f~~~~##',
  '##...P......P...#..G.#ooKTKooaaooKTKoo#....#~~~~~~~~p~~~~~##',
  '##......T.S.....#....#oooooooaaSoooooo#....#U~~~~~~~~~~~~L##',
  '##..............#....#oooooooaaooooooo#....#~S~~~~~~~~~~MG##',
  '##...........S........oooooooaaooooooo......~~~~b~~~~~~p~~##',
  '##....................aaaaaaaaaaaaaaaa......~~~~~~T~~~~~~f##',
  '##....WWWWW...........aGaaaaaaaaaaaaaa......~~~~~b~f~~~~S~##',
  '##....................oooooooaaooooooo......~~~~~~b~~~~WW~##',
  '##G.............#....#oooooooaaooooooS#....#L~~~~~~~~b~~~~##',
  '##..............#....#oooooooaaooooooo#....#GM~~~~~~~~~~~~##',
  '##...P......P...#....#ooKTKooaaooKTKoo#....#~~~~~~~~~~~~~~##',
  '##..............#....#oooooooaaooooooo#.G..#~~p~~~~~~~~~~U##',
  '##..KKK...KKK...#....#oSoooooaaooooooG#....#~f~~~b~KS~~~~~##',
  '##.............G#....#oooooooaaooooooo#....#~~~~~~~~U~~~~~##',
  '#######...#######....#######....#######....######...########',
  '##........................................................##',
  '##............................S...........................##',
  '##.......................G.............................S..##',
  '##........................................................##',
  '#######...#######....#######....#######....######...########',
  '##;;;;;;;;;;;;;;#....#________________#....#aaaaaGaaaaaaaa##',
  '##;S;;;;;;;;;;;;#....#_WWWW____WWWWWWW#....#aaaaaaaaaaaaaa##',
  '##;;QQQQQQQQQ;;;#....#__K_____ZS_____G#....#aaaaaaaaaaaaaa##',
  '##;;;;;;;;G;;;;;#....#___C___Z__XX_XXV#....#aaaaaaaaaaaaSa##',
  '##;;;;;;;;;;;;S;#....#_S________XX_XX_#....#aaaaaaaaaaaaaa##',
  '##;;QQQQQQQQQ;;;......__J__J__CX______......aaaSaaaaaaaaaa##',
  '##G;;;;;;;;;;;;;...S.._______Z__XX_XXV......aaaaaaaaaaaaaa##',
  '##;;;;;;;;;;;;;;......__________XX_XX_......aaaaaaaaaaaaaG##',
  '##;;QQQQQQQQQ;;;#....#__J__J___X_____S#....#aaaaaaaaaaaaaa##',
  '##;;;;;;;;;;;;;;#....#_______Z__XX_XXV#....#aaaaaaaaaaaaaa##',
  '##;;;;;;;;;;;S;;#....#Z_________XX_XX_#.S..#aSaaaaaaaaaaaa##',
  '##;;KTK;;;KTK;;;#....#_C_KZ_G_C_______#....#aaaaaaaaaaaaaa##',
  '##;;;K;;;;;K;;;;#....#_WWWW_____Y__Y_Y#....#aaaaaaaaaaaaaa##',
  '##;;;;;;S;;;;;;G#....#G_____S_________#....#GaaaaaaaSaaaaa##',
  '############################################################',
  '############################################################',
];

// ---- cell kinds ----
export const K = { FLOOR: 0, WALL: 1, PILLAR: 2, SHELF: 3, COUNTER: 4 };
const SOLID = { '#': [K.WALL, WALL_H], 'P': [K.PILLAR, WALL_H], 'Q': [K.SHELF, 2.2], 'W': [K.COUNTER, 1.0] };
const FLOOR_CH = { '.': 'tile', ',': 'wood', ';': 'carpet', '_': 'concrete', 'o': 'grass', 'a': 'asphalt', '~': 'dirty' };
const FLOOR_LIST = ['tile', 'wood', 'carpet', 'concrete', 'grass', 'asphalt', 'dirty'];
const OUTDOOR = new Set(['grass', 'asphalt']);
export const PROP_CH = { B: 'box', C: 'crate', K: 'chair', T: 'table', X: 'barrel', M: 'mattress', L: 'lamp', b: 'bottle', U: 'trashcan', f: 'takeout', p: 'bottle', m: 'mattress', V: 'barrel', Y: 'barrel', Z: 'crate', J: 'crate' };
export const ROOF_T = 0.55;   // thickness of the concrete roof slab above the ceilings

// ---- lighting constants (baked into vertex colors) ----
export const SUN_DIR = new THREE.Vector3(0.45, 0.82, 0.36).normalize();
const SUN_COL = [1.15, 1.05, 0.88];
const SKY_COL = [0.42, 0.5, 0.62];
const INDOOR_AMB = [0.13, 0.125, 0.12];
const LAMP_COL = [1.0, 0.96, 0.9];
const LAMP_INT = 0.55;      // same light on the floor under a lamp as the original lights
const LAMP_RANGE = 14;     // ceiling lights are downward spotlights that reach all the way to the floor

export class GameMap {
  constructor(layout = LAYOUT) {
    this.layout = layout;
    this.h = layout.length;
    this.w = layout[0].length;
    this.worldW = this.w * CELL;
    this.worldD = this.h * CELL;
    const n = this.w * this.h;
    this.heights = new Float32Array(n);
    this.kinds = new Uint8Array(n);
    this.floor = new Uint8Array(n);     // index into FLOOR_LIST
    this.outdoor = new Uint8Array(n);
    this.spawns = [];
    this.propSpawns = [];
    this.props = [];                    // live physics props (filled by the game)
    const chAt = (x, z) => (x < 0 || z < 0 || x >= this.w || z >= this.h ? '#' : layout[z][x] || '#');

    // floor type for every cell (markers inherit from the nearest real floor)
    const floorOf = (x, z) => {
      for (let r = 0; r < 6; r++) {
        const counts = {};
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const f = FLOOR_CH[chAt(x + dx, z + dz)];
          if (f) counts[f] = (counts[f] || 0) + 1;
        }
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (best) return best[0];
      }
      return 'tile';
    };

    const crateCells = [], cellKind = new Map();
    for (let z = 0; z < this.h; z++) for (let x = 0; x < this.w; x++) {
      const ch = chAt(x, z);
      const i = z * this.w + x;
      const f = floorOf(x, z);
      this.floor[i] = FLOOR_LIST.indexOf(f);
      this.outdoor[i] = OUTDOOR.has(f) && ch !== '#' ? 1 : 0;
      const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL;
      // wooden counters / desks and the storeroom shelves (not the bookshelves) are now rows of big
      // long crates you can push / hide as
      if (ch === 'W' || (ch === 'Q' && f === 'concrete')) { crateCells.push([x, z]); cellKind.set(x + ',' + z, ch === 'W' ? 'counter' : 'crate'); continue; }
      if (SOLID[ch]) { [this.kinds[i], this.heights[i]] = SOLID[ch]; continue; }
      if (ch === 'S') this.spawns.push({ x: cx, z: cz });
      if (PROP_CH[ch]) {
        const type = PROP_CH[ch];
        // chairs face a neighbouring table / desk
        let yaw = (hash2(x, z) - 0.5) * 0.6;
        if (type === 'chair') {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const c2 = chAt(x + dx, z + dz);
            if (c2 === 'T' || c2 === 'W') { yaw = Math.atan2(-dx, -dz) + (hash2(z, x) - 0.5) * 0.4; break; }
          }
        }
        const messy = f === 'dirty';
        const jit = (k) => (hash2(x * 7 + k, z * 3 + k) - 0.5);
        if (ch === 'p') {
          // a pile of bottles: some standing, most lying around
          for (let k = 0; k < 7; k++) {
            const a = k * 2.4 + jit(k) * 2, r = k === 0 ? 0 : 0.18 + (k % 3) * 0.12;
            this.propSpawns.push({ type: 'bottle', x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, yaw: jit(k + 9) * 6.28, tip: k > 1 });
          }
        } else if (ch === 'm') {
          // stack of old mattresses (they get stacked on top of each other when spawned)
          for (let k = 0; k < 3; k++) this.propSpawns.push({ type: 'mattress', x: cx + jit(k) * 0.2, z: cz + jit(k + 5) * 0.2, yaw: yaw + jit(k + 2) * 0.4, tip: false });
        } else if (ch === 'Z') {
          for (let k = 0; k < 2; k++) this.propSpawns.push({ type: 'crate', x: cx, z: cz, yaw: jit(k) * 0.3, tip: false });
        } else if (ch === 'J') {
          // two crates side by side with a third resting on top in the middle
          for (const [ox, k] of [[-0.47, 0], [0.47, 1], [0, 2]]) this.propSpawns.push({ type: 'crate', x: cx + ox, z: cz + jit(k) * 0.08, yaw: jit(k + 3) * 0.15, tip: false });
        } else if (ch === 'V') {
          // two upright barrels, one on top of the other
          for (let k = 0; k < 2; k++) this.propSpawns.push({ type: 'barrel', x: cx, z: cz, yaw: jit(k) * 0.5, tip: false });
        } else if (ch === 'Y') {
          // pyramid: two barrels lying side by side, one lying on top
          for (const [oz, k] of [[-0.33, 0], [0.33, 1], [0, 2]]) this.propSpawns.push({ type: 'barrel', x: cx, z: cz + oz, yaw: 0, tip: true, tipAxis: 'z' });
        } else if (ch === 'f') {
          this.propSpawns.push({ type: 'takeout', x: cx - 0.15, z: cz + jit(1) * 0.3, yaw: jit(2) * 6.28, tip: false });
          this.propSpawns.push({ type: 'takeout', x: cx + 0.2, z: cz + jit(3) * 0.3, yaw: jit(4) * 6.28, tip: true });
        } else {
          const tip = type === 'bottle' ? hash2(x + 7, z) < 0.75 : messy && type === 'chair' && hash2(z, x + 3) < 0.6;
          this.propSpawns.push({ type, x: cx + jit(1) * (messy ? 0.5 : 0.1), z: cz + jit(2) * (messy ? 0.5 : 0.1), yaw: messy ? hash2(x * 3, z) * 6.28 : yaw, tip });
        }
      }
    }
    // rows of counters / shelves -> long crates of the same size, close together along each row
    // (rows along x first; whatever is left forms rows along z)
    {
      const key = new Set(crateCells.map(([x, z]) => x + ',' + z));
      const same = (a, b) => cellKind.get(a) === cellKind.get(b);
      const done = new Set();
      const row = (x, z, along) => {
        const dx = along ? 1 : 0, dz = along ? 0 : 1;
        let n1 = 0; const k0 = x + ',' + z;
        while (key.has((x + dx * (n1 + 1)) + ',' + (z + dz * (n1 + 1))) && !done.has((x + dx * (n1 + 1)) + ',' + (z + dz * (n1 + 1))) && same(k0, (x + dx * (n1 + 1)) + ',' + (z + dz * (n1 + 1)))) n1++;
        return n1 + 1;
      };
      const place = (x, z, cells, along) => {
        for (let k = 0; k < cells; k++) done.add((x + (along ? k : 0)) + ',' + (z + (along ? 0 : k)));
        const len = cells * CELL, at = (a) => ({ x: along ? x * CELL + a : (x + 0.5) * CELL, z: along ? (z + 0.5) * CELL : z * CELL + a, yaw: along ? 0 : Math.PI / 2, tip: false });
        if (cellKind.get(x + ',' + z) === 'counter') {
          // counters: 4 m pieces end to end, a 2 m piece for what's left
          let a = 0;
          while (len - a >= 3.99) { this.propSpawns.push({ type: 'longcounter', ...at(a + 2) }); a += 4; }
          if (len - a >= 1.99) this.propSpawns.push({ type: 'shortcounter', ...at(a + 1) });
        } else {
          const n = Math.max(1, Math.round(len / 4.4)), step = len / n;
          for (let k = 0; k < n; k++) this.propSpawns.push({ type: 'longcrate', ...at(step * (k + 0.5)) });
        }
      };
      for (const [x, z] of crateCells) if (!done.has(x + ',' + z) && !(key.has((x - 1) + ',' + z) && same(x + ',' + z, (x - 1) + ',' + z)) && row(x, z, true) > 1) place(x, z, row(x, z, true), true);
      for (const [x, z] of crateCells) if (!done.has(x + ',' + z) && (done.has(x + ',' + (z - 1)) || !key.has(x + ',' + (z - 1)) || !same(x + ',' + z, x + ',' + (z - 1)))) place(x, z, row(x, z, false), false);
    }
    // every room is furnished by hand in furnish.js (the letters in the layout only mark where the
    // old furniture was; walls, floors, shelves and spawn points still come from the layout)
    this.propSpawns = furnish();
    // ceiling lights
    this.lights = [];
    for (let z = 0; z < this.h; z++) for (let x = 0; x < this.w; x++) {
      const i = z * this.w + x;
      if (x % 3 === 1 && z % 3 === 1 && !this.outdoor[i] && this.heights[i] < WALL_H) {
        const L = { x: (x + 0.5) * CELL, y: CEIL_H - 0.1, z: (z + 0.5) * CELL };
        // some rooms have their lights switched off (the fixture is still there, just dark)
        L.off = DARK_ROOMS.some(([x0, z0, x1, z1]) => L.x > x0 && L.x < x1 && L.z > z0 && L.z < z1);
        this.lights.push(L);
      }
    }
    this.lightBins = new Map();
    for (const L of this.lights) {
      if (L.off) continue;
      const k = `${Math.floor(L.x / LAMP_RANGE)},${Math.floor(L.z / LAMP_RANGE)}`;
      if (!this.lightBins.has(k)) this.lightBins.set(k, []);
      this.lightBins.get(k).push(L);
    }
  }

  inBounds(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }
  cellHeight(cx, cz) { return this.inBounds(cx, cz) ? this.heights[cz * this.w + cx] : WALL_H; }
  heightAt(x, z) { return this.cellHeight(Math.floor(x / CELL), Math.floor(z / CELL)); }
  isOutdoorCell(cx, cz) { return this.inBounds(cx, cz) && this.outdoor[cz * this.w + cx] === 1; }
  isOutdoor(x, z) { return this.isOutdoorCell(Math.floor(x / CELL), Math.floor(z / CELL)); }
  // cells under the building's roof slab (everything that isn't open sky)
  roofedCell(cx, cz) { return this.inBounds(cx, cz) && this.outdoor[cz * this.w + cx] === 0; }
  // is (x,z) under a ceiling light fixture? (fixtures are 1.44 x 0.76 m boxes, 7 cm thick, on every 3rd cell)
  underLight(x, z, pad = 0) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const lx = cx + dx, lz = cz + dz;
      if (lx % 3 !== 1 || lz % 3 !== 1 || !this.roofedCell(lx, lz) || this.cellHeight(lx, lz) >= WALL_H) continue;
      if (Math.abs(x - (lx + 0.5) * CELL) < 0.72 + pad && Math.abs(z - (lz + 0.5) * CELL) < 0.38 + pad) return true;
    }
    return false;
  }
  floorTypeAt(x, z) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    return this.inBounds(cx, cz) ? FLOOR_LIST[this.floor[cz * this.w + cx]] : 'tile';
  }
  center() { return { x: this.worldW / 2, z: this.worldD / 2 }; }

  // ---------------------------------------------------------------
  //  Ray through the grid (same as physics.raycastMap, local copy to
  //  avoid an import cycle). Returns hit distance or maxDist.
  // ---------------------------------------------------------------
  ray(ox, oy, oz, dx, dy, dz, maxDist) {
    let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const adx = Math.abs(dx), adz = Math.abs(dz);
    const tDX = adx > 1e-9 ? CELL / adx : Infinity, tDZ = adz > 1e-9 ? CELL / adz : Infinity;
    let tMX = adx > 1e-9 ? (dx > 0 ? (cx + 1) * CELL - ox : ox - cx * CELL) / adx : Infinity;
    let tMZ = adz > 1e-9 ? (dz > 0 ? (cz + 1) * CELL - oz : oz - cz * CELL) / adz : Infinity;
    const tFloor = dy < -1e-9 ? -oy / dy : Infinity;
    let t = 0;
    for (let g = 0; g < 400 && t < maxDist; g++) {
      if (!this.inBounds(cx, cz)) return oy + dy * t > WALL_H ? maxDist : t;
      const tEnd = Math.min(tMX, tMZ, maxDist);
      const h = this.heights[cz * this.w + cx];
      if (h > 0) {
        const y0 = oy + dy * t, y1 = oy + dy * tEnd;
        if (y0 < h) return t;
        if (y1 < h) return (h - oy) / dy;
      }
      if (dy > 0 && !this.outdoor[cz * this.w + cx] && oy + dy * t < CEIL_H) {
        if (oy + dy * tEnd > CEIL_H) return Math.max(t, (CEIL_H - oy) / dy);
      }
      if (tFloor <= tEnd) return tFloor;
      t = Math.min(tMX, tMZ);
      if (tMX < tMZ) { tMX += tDX; cx += stepX; } else { tMZ += tDZ; cz += stepZ; }
    }
    return maxDist;
  }

  // ---------------------------------------------------------------
  //  Lighting model (used for baking AND for character light probes)
  //  n = surface normal, or null for "any direction" (characters)
  // ---------------------------------------------------------------
  lightAt(px, py, pz, nx, ny, nz, lamps = true, base = true) {
    let r = 0, g = 0, b = 0;
    const hasN = nx !== null;
    const ox = px + (hasN ? nx * 0.04 : 0), oy = py + (hasN ? ny * 0.04 : 0), oz = pz + (hasN ? nz * 0.04 : 0);
    const sx = Math.floor((px + (hasN ? nx * 0.3 : 0)) / CELL), sz = Math.floor((pz + (hasN ? nz * 0.3 : 0)) / CELL);
    const outside = this.isOutdoorCell(sx, sz);
    if (base) {
      r += INDOOR_AMB[0]; g += INDOOR_AMB[1]; b += INDOOR_AMB[2];
      if (outside || py > CEIL_H - 0.01) {
        // sky: how much of the sky can this point see?
        let vis = 0;
        const N = 6;
        for (let k = 0; k < N; k++) {
          const a = (k / N) * Math.PI * 2 + 0.3, el = 0.5 + (k % 2) * 0.45;
          let dx = Math.cos(a) * Math.cos(el), dy = Math.sin(el), dz = Math.sin(a) * Math.cos(el);
          if (hasN && dx * nx + dy * ny + dz * nz < 0) { dx = -dx; dz = -dz; }
          if (this.ray(ox, oy, oz, dx, dy, dz, 40) >= 40) vis++;
        }
        const f = (vis / N) * (hasN ? 0.55 + 0.45 * Math.max(0, ny) : 0.8);
        r += SKY_COL[0] * f; g += SKY_COL[1] * f; b += SKY_COL[2] * f;
        // sun (with real shadows from the walls)
        const ndl = hasN ? nx * SUN_DIR.x + ny * SUN_DIR.y + nz * SUN_DIR.z : 0.6;
        if (ndl > 0 && this.ray(ox, oy, oz, SUN_DIR.x, SUN_DIR.y, SUN_DIR.z, 60) >= 60) {
          r += SUN_COL[0] * ndl; g += SUN_COL[1] * ndl; b += SUN_COL[2] * ndl;
        }
      }
    }
    if (lamps && !outside) {
      const bx = Math.floor(px / LAMP_RANGE), bz = Math.floor(pz / LAMP_RANGE);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const bin = this.lightBins.get(`${bx + i},${bz + j}`);
        if (!bin) continue;
        for (const L of bin) {
          const vx = L.x - px, vy = L.y - py, vz = L.z - pz;
          const d = Math.hypot(vx, vy, vz);
          if (d > LAMP_RANGE || d < 1e-3) continue;
          const ndl = hasN ? (vx * nx + vy * ny + vz * nz) / d : 0.75;
          if (ndl <= 0) continue;
          const down = Math.max(0, vy / d);
          const emit = 0.15 + 0.85 * down * Math.sqrt(down);               // spotlight: strongest straight down
          const fall = (1 / (1 + (d / 5) ** 2)) * (1 - d / LAMP_RANGE);
          const k = LAMP_INT * ndl * emit * fall;
          if (k < 0.01) continue;
          if (this.ray(ox, oy, oz, vx / d, vy / d, vz / d, d - 0.15) < d - 0.2) continue;
          r += LAMP_COL[0] * k; g += LAMP_COL[1] * k; b += LAMP_COL[2] * k;
        }
      }
    }
    return [r, g, b];
  }

  // Ambient occlusion: darker in corners and next to walls / furniture
  aoAt(px, py, pz, nx, ny, nz) {
    let occ = 0, tot = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      for (const rad of [0.45, 1.0]) {
        const sx = px + Math.cos(a) * rad + nx * 0.3, sz = pz + Math.sin(a) * rad + nz * 0.3;
        const h = this.heightAt(sx, sz);
        const w = rad < 0.6 ? 1 : 0.5;
        tot += w;
        if (h > py + 0.05 && py < h + 0.1) occ += w;
      }
    }
    let ao = 1 - 0.55 * (occ / tot);
    if (ny === 0) { // walls: darker near floor and ceiling
      if (py < 0.7) ao *= 0.62 + 0.38 * (py / 0.7);
      if (!this.isOutdoor(px + nx * 0.3, pz + nz * 0.3) && py > CEIL_H - 0.5) ao *= 0.78 + 0.22 * ((CEIL_H - py) / 0.5);
    }
    return ao;
  }

  dirtAt(px, py, pz, isWall, nx = 0, nz = 0) {
    const u = px / this.worldW, v = pz / this.worldD;
    let d = 1 - Math.max(0, fbm(u, v, 12, 3, 901) - 0.5) * 0.7;
    if (isWall && this.floorTypeAt(px + nx * 0.4, pz + nz * 0.4) === 'dirty') d *= 0.85 + fbm(u * 3, v * 3 + py * 0.05, 16, 3, 903) * 0.15;
    if (isWall) {
      const s = fbm(u + v, py / 24, 16, 3, 902);
      d *= 1 - (1 - Math.min(1, py / 1.6)) * 0.28 * s * 2;     // grime near the floor
      d *= 1 - Math.max(0, s - 0.62) * 0.8;                       // stains
    }
    return d;
  }

  bakeColor(px, py, pz, nx, ny, nz, isWall = false) {
    const [r, g, b] = this.lightAt(px, py, pz, nx, ny, nz);
    const k = this.aoAt(px, py, pz, nx, ny, nz) * this.dirtAt(px, py, pz, isWall, nx, nz);
    return [r * k, g * k, b * k];
  }

  // ---------------------------------------------------------------
  //  Light probes for moving things (characters, props): a 1m grid
  //  of pre-computed light at chest height, read with bilinear filtering.
  // ---------------------------------------------------------------
  buildProbes() {
    const pw = this.w * 2, ph = this.h * 2;
    this.probeBase = new Float32Array(pw * ph * 3);
    this.probeLamp = new Float32Array(pw * ph * 3);
    this.pw = pw; this.ph = ph;
    for (let z = 0; z < ph; z++) for (let x = 0; x < pw; x++) {
      const px = x + 0.5, pz = z + 0.5;
      const i = (z * pw + x) * 3;
      if (this.heightAt(px, pz) >= WALL_H) continue;
      const a = this.lightAt(px, 1.1, pz, null, null, null, false, true);
      const l = this.lightAt(px, 1.1, pz, null, null, null, true, false);
      this.probeBase.set(a, i); this.probeLamp.set(l, i);
    }
  }
  probe(x, z, withLamps = true, out = [0, 0, 0]) {
    if (!this.probeBase) { out[0] = out[1] = out[2] = 1; return out; }
    const fx = Math.max(0, Math.min(this.pw - 1.001, x - 0.5)), fz = Math.max(0, Math.min(this.ph - 1.001, z - 0.5));
    const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
    for (let c = 0; c < 3; c++) {
      let v = 0, wsum = 0;
      for (const [dx, dz, w] of [[0, 0, (1 - tx) * (1 - tz)], [1, 0, tx * (1 - tz)], [0, 1, (1 - tx) * tz], [1, 1, tx * tz]]) {
        const i = ((z0 + dz) * this.pw + x0 + dx) * 3 + c;
        if (this.heightAt(x0 + dx + 0.5, z0 + dz + 0.5) >= WALL_H) continue;
        v += (this.probeBase[i] + (withLamps ? this.probeLamp[i] : 0)) * w; wsum += w;
      }
      out[c] = wsum > 0 ? v / wsum : 0.4;
    }
    return out;
  }

  // ---------------------------------------------------------------
  //  Build all level meshes (with baked lighting)
  // ---------------------------------------------------------------
  build(T, onProgress) {
    const group = new THREE.Group();
    const builders = new Map();
    const B = (key, map) => {
      if (!builders.has(key)) builders.set(key, { b: new Builder(this), map });
      return builders.get(key).b;
    };
    const floorTex = { tile: T.floorTile, wood: T.floorWood, carpet: T.floorCarpet, concrete: T.floorConcrete, grass: T.grass, asphalt: T.asphalt, dirty: T.floorTile };
    const W = this.w, H = this.h;
    const idx = (x, z) => z * W + x;
    const trimRoof = [];
    const graffitiSpots = [];

    // ---- floors & ceilings (greedy rectangles, subdivided every 1 m) ----
    const rects = (pred) => {
      const used = new Uint8Array(W * H), out = [];
      for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        if (used[idx(x, z)] || !pred(x, z)) continue;
        let x1 = x;
        while (x1 + 1 < W && !used[idx(x1 + 1, z)] && pred(x1 + 1, z) && x1 - x < 7) x1++;
        let z1 = z;
        outer: while (z1 + 1 < H && z1 - z < 7) {
          for (let xx = x; xx <= x1; xx++) if (used[idx(xx, z1 + 1)] || !pred(xx, z1 + 1)) break outer;
          z1++;
        }
        for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) used[idx(xx, zz)] = 1;
        out.push([x, z, x1, z1]);
      }
      return out;
    };
    for (let fi = 0; fi < FLOOR_LIST.length; fi++) {
      const f = FLOOR_LIST[fi];
      const tsz = f === 'grass' || f === 'asphalt' ? 4 : 2;
      const b = B('floor-' + f, floorTex[f]);
      for (const [x0, z0, x1, z1] of rects((x, z) => this.floor[idx(x, z)] === fi && this.heights[idx(x, z)] === 0)) {
        b.gridY(x0 * CELL, z0 * CELL, (x1 + 1) * CELL, (z1 + 1) * CELL, 0, false, tsz);
      }
    }
    onProgress?.(0.3);
    {
      const b = B('ceiling', T.ceiling);
      for (const [x0, z0, x1, z1] of rects((x, z) => !this.outdoor[idx(x, z)] && this.kinds[idx(x, z)] !== K.WALL)) {
        b.gridY(x0 * CELL, z0 * CELL, (x1 + 1) * CELL, (z1 + 1) * CELL, CEIL_H, true, 2);
      }
    }
    // ---- thick concrete roof slab over the whole building ----
    {
      const roofed = (x, z) => this.inBounds(x, z) && !this.outdoor[idx(x, z)];
      const rb = B('roof', T.roof);
      for (const [x0, z0, x1, z1] of rects((x, z) => roofed(x, z))) {
        rb.gridY(x0 * CELL, z0 * CELL, (x1 + 1) * CELL, (z1 + 1) * CELL, WALL_H + ROOF_T, false, 4);
      }
      // slab edges facing the open courtyard / parking lot (gives the roof its thickness)
      const eb = B('roof-edge', T.wallConcrete);
      for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        if (!roofed(x, z)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (!this.inBounds(nx, nz) || roofed(nx, nz)) continue;
          const ex = dx > 0 ? (x + 1) * CELL : dx < 0 ? x * CELL : null;
          const ez = dz > 0 ? (z + 1) * CELL : dz < 0 ? z * CELL : null;
          let a, c2;
          if (ex !== null) { a = [ex, z * CELL]; c2 = [ex, (z + 1) * CELL]; if (dx > 0) [a, c2] = [c2, a]; }
          else { a = [(x + 1) * CELL, ez]; c2 = [x * CELL, ez]; if (dz > 0) [a, c2] = [c2, a]; }
          eb.wall(a, c2, this.heights[idx(x, z)] >= WALL_H ? WALL_H : CEIL_H, WALL_H + ROOF_T, dx, dz, 2);
          // drip edge / trim along the top of the slab
          trimRoof.push([a, c2, dx, dz]);
        }
      }
    }
    onProgress?.(0.45);

    // ---- vertical faces of walls / pillars / shelves / counters ----
    const trim = B('trim', null);
    for (const [a, c2, dx, dz] of trimRoof) trim.box(a, c2, dx, dz, WALL_H + ROOF_T - 0.08, WALL_H + ROOF_T + 0.04, 0.08, [0.6, 0.6, 0.58]);
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      const i = idx(x, z);
      const h = this.heights[i];
      if (h <= 0) continue;
      const kind = this.kinds[i];
      for (const [dx, dz] of DIRS) {
        const nxC = x + dx, nzC = z + dz;
        if (!this.inBounds(nxC, nzC)) continue;
        const nh = this.heights[idx(nxC, nzC)];
        if (nh >= h) continue;
        const nOut = this.outdoor[idx(nxC, nzC)];
        const nFloor = FLOOR_LIST[this.floor[idx(nxC, nzC)]];
        const top = Math.min(h, nOut ? WALL_H : CEIL_H);
        let key, map, tsz = 2;
        if (kind === K.WALL) {
          if (nOut || nFloor === 'concrete') { key = 'wall-concrete'; map = T.wallConcrete; }
          else if (nFloor === 'dirty') { key = 'wall-painted'; map = T.wallPainted; }
          else { key = 'wall-painted'; map = T.wallPainted; }
        } else if (kind === K.PILLAR) { key = 'pillar'; map = T.pillar; tsz = 6; }
        else if (kind === K.SHELF) { if (nFloor === 'carpet') { key = 'shelf-books'; map = T.shelfBooks; } else { key = 'shelf'; map = T.shelf; } tsz = 2.2; }
        else { key = 'counter'; map = T.counter; tsz = 1; }
        // the face lies on the cell edge facing the neighbour
        const ex = dx > 0 ? (x + 1) * CELL : dx < 0 ? x * CELL : null;
        const ez = dz > 0 ? (z + 1) * CELL : dz < 0 ? z * CELL : null;
        let a, c2;
        if (ex !== null) { a = [ex, z * CELL]; c2 = [ex, (z + 1) * CELL]; if (dx > 0) [a, c2] = [c2, a]; }
        else { a = [(x + 1) * CELL, ez]; c2 = [x * CELL, ez]; if (dz > 0) [a, c2] = [c2, a]; }
        const isPillarOrShelf = kind !== K.WALL;
        if (kind === K.WALL && nFloor === 'dirty' && nh === 0) graffitiSpots.push([a, c2, dx, dz]);
        B(key, map).wall(a, c2, nh, top, dx, dz, tsz, kind === K.PILLAR ? 6 : 1);
        // baseboard + crown trim along room walls (adds real depth)
        if (kind === K.WALL && !nOut && nh === 0) {
          trim.box(a, c2, dx, dz, 0, 0.14, 0.03, [0.32, 0.31, 0.3]);
          trim.box(a, c2, dx, dz, CEIL_H - 0.12, CEIL_H, 0.05, [0.85, 0.84, 0.8]);
        }
        if (kind === K.WALL && nOut) trim.box(a, c2, dx, dz, 0, 0.35, 0.06, [0.55, 0.54, 0.52]);
        if (kind === K.COUNTER) trim.box(a, c2, dx, dz, h - 0.05, h, 0.05, [0.35, 0.24, 0.15]);
        if (isPillarOrShelf && kind === K.PILLAR && nh === 0) trim.box(a, c2, dx, dz, 0, 0.25, 0.04, [0.4, 0.4, 0.4]);
      }
      // tops of low furniture
      if (h < WALL_H) {
        const books = kind === K.SHELF && FLOOR_LIST[this.floor[i]] === 'carpet';
        const key = books ? 'shelf-top-books' : kind === K.SHELF ? 'shelf-top' : 'counter';
        B(key, books ? T.bookTop : kind === K.SHELF ? T.metal : T.counter).gridY(x * CELL, z * CELL, (x + 1) * CELL, (z + 1) * CELL, h, false, 2);
      }
    }
    onProgress?.(0.85);

    // ---- graffiti: only a handful of spray-painted tags on the trashed room's walls ----
    graffitiSpots.forEach(([a, c2, dx, dz], i) => {
      if (hash2(i * 13 + 5, 77) > 0.3) return;
      const k = Math.floor(hash2(i, 31) * T.graffiti.length);
      const b = B('graffiti-' + k, T.graffiti[k]);
      const mx = (a[0] + c2[0]) / 2, mz = (a[1] + c2[1]) / 2, ux = (c2[0] - a[0]) / 2, uz = (c2[1] - a[1]) / 2;
      const w = 0.75 + hash2(i, 3) * 0.2, y0 = 0.6 + hash2(i, 5) * 0.8, y1 = y0 + 1.1 + hash2(i, 9) * 0.4, off = 0.012;
      b.decal([mx - ux * w + dx * off, mz - uz * w + dz * off], [mx + ux * w + dx * off, mz + uz * w + dz * off], y0, y1, dx, dz);
    });

    // ---- floor dirt / trash decals in the trashed room, placed where that mess belongs ----
    {
      const inRoom = (x, z) => this.floorTypeAt(x, z) === 'dirty' && this.heightAt(x, z) === 0;
      const spots = [];   // [x, z, kind, size, rot]
      const KIND_NEAR = {
        mattress: ['grime', 'litter', 'butts', 'spill'],
        bottle: ['spill', 'glass', 'butts'],
        trashcan: ['litter', 'spill', 'food', 'grime'],
        table: ['food', 'litter', 'spill'],
        takeout: ['food', 'litter'],
        chair: ['scuffs', 'butts'],
        lamp: ['grime'],
      };
      this.propSpawns.forEach((p, i) => {
        const kinds = KIND_NEAR[p.type];
        if (!kinds || !inRoom(p.x, p.z)) return;
        if (p.type === 'bottle' && hash2(i, 61) > 0.35) return; // piles have many bottles: only some get a spill
        const k = kinds[Math.floor(hash2(i, 17) * kinds.length)];
        spots.push([p.x + (hash2(i, 5) - 0.5) * 1.2, p.z + (hash2(i, 6) - 0.5) * 1.2, k, 2.2 + hash2(i, 23) * 1.4, hash2(i, 9) * 6.28]);
      });
      // footprints and scuffs coming in through the doors, grime collecting in corners and along walls
      for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL;
        if (!inRoom(cx, cz)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ox = cx + dx * CELL, oz = cz + dz * CELL;
          if (this.heightAt(ox, oz) === 0 && !inRoom(ox, oz) && (x + z) % 2 === 0) {
            // a doorway: tracks heading into the room
            spots.push([cx - dx * 0.6, cz - dz * 0.6, hash2(x, z * 7) < 0.7 ? 'footprints' : 'scuffs', 2.6, Math.atan2(-dx, dz)]);
          }
        }
        let walls = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.heightAt(cx + dx * CELL, cz + dz * CELL) >= WALL_H) walls++;
        if ((walls >= 2 && hash2(x, z) < 0.8) || (walls === 1 && hash2(x + 11, z) < 0.12)) spots.push([cx, cz, hash2(z, x) < 0.75 ? 'grime' : 'litter', 2.4 + hash2(x, z + 2) * 1.2, hash2(z, x + 4) * 6.28]);
      }
      // don't let them pile up on top of each other
      const used = [];
      spots.forEach(([x, z, kind, size, rot], i) => {
        if (used.some((u) => Math.hypot(u[0] - x, u[1] - z) < 1.6)) return;
        used.push([x, z]);
        const v = Math.floor(hash2(i, 33) * 2);
        B('floordecal-' + kind + v, T.floorDecals[kind][v]).floorDecal(x, z, size, rot);
      });
      this.decalCount = used.length;
    }

    // ---- graffiti: only a handful of spray-painted tags on the trashed room's walls ----
    graffitiSpots.forEach(([a, c2, dx, dz], i) => {
      if (hash2(i * 13 + 5, 77) > 0.3) return;
      const k = Math.floor(hash2(i, 31) * T.graffiti.length);
      const b = B('graffiti-' + k, T.graffiti[k]);
      const mx = (a[0] + c2[0]) / 2, mz = (a[1] + c2[1]) / 2, ux = (c2[0] - a[0]) / 2, uz = (c2[1] - a[1]) / 2;
      const w = 0.75 + hash2(i, 3) * 0.2, y0 = 0.6 + hash2(i, 5) * 0.8, y1 = y0 + 1.1 + hash2(i, 9) * 0.4, off = 0.012;
      b.decal([mx - ux * w + dx * off, mz - uz * w + dz * off], [mx + ux * w + dx * off, mz + uz * w + dz * off], y0, y1, dx, dz);
    });

    // ---- light fixtures ----
    {
      const fx = B('fixture', null);
      const panel = new Builder(this), dark = new Builder(this);
      for (const L of this.lights) {
        fx.boxXZ(L.x - 0.72, L.z - 0.38, L.x + 0.72, L.z + 0.38, CEIL_H - 0.07, CEIL_H, [0.55, 0.55, 0.55]);
        (L.off ? dark : panel).flat(L.x - 0.64, L.z - 0.3, L.x + 0.64, L.z + 0.3, CEIL_H - 0.075);
      }
      const pm = new THREE.Mesh(panel.geometry(), new THREE.MeshBasicMaterial({ color: 0xfff6e2, toneMapped: false }));
      group.add(pm);
      // switched-off lights: a dull grey panel (lit only by whatever light reaches the ceiling)
      if (dark.pos.length) group.add(new THREE.Mesh(dark.geometry(), new THREE.MeshBasicMaterial({ color: 0x34342f, vertexColors: true })));
    }

    // ---- solid backing: every wall, pillar, shelf, counter and the roof slab is a closed box on the inside ----
    // (all 6 sides, slightly inset), so no seam or corner can ever show the bright sky / sun behind a wall
    {
      const pos = [], e = 0.03, ROOF_TOP = WALL_H + ROOF_T;
      const box = (x0, y0, z0, x1, y1, z1) => {
        const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        for (const [a, b, c, d] of [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]])
          pos.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
      };
      const heightsSeen = new Set(this.heights);
      for (const h of heightsSeen) {
        if (h <= 0) continue;
        const top = h >= WALL_H ? ROOF_TOP : h;
        for (const [x0, z0, x1, z1] of rects((x, z) => this.heights[idx(x, z)] === h))
          box(x0 * CELL + e, 0.002, z0 * CELL + e, (x1 + 1) * CELL - e, top - e, (z1 + 1) * CELL - e);
      }
      for (const [x0, z0, x1, z1] of rects((x, z) => !this.outdoor[idx(x, z)] && this.heights[idx(x, z)] < WALL_H))
        box(x0 * CELL + e, CEIL_H + e, z0 * CELL + e, (x1 + 1) * CELL - e, ROOF_TOP - e, (z1 + 1) * CELL - e);
      box(-1, -0.6, -1, this.worldW + 1, -0.03, this.worldD + 1);      // under the whole floor
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const back = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x1d1c1a, side: THREE.DoubleSide }));
      back.name = 'backing';
      group.add(back);
    }

    for (const [key, { b, map }] of builders) {
      const decal = key.startsWith('graffiti') || key.startsWith('floordecal');
      const mat = new THREE.MeshBasicMaterial({ map, vertexColors: true, side: key === 'ceiling' ? THREE.DoubleSide : THREE.FrontSide,
        transparent: decal, depthWrite: !decal, polygonOffset: decal, polygonOffsetFactor: -2 });
      const mesh = new THREE.Mesh(b.geometry(), mat);
      mesh.name = key;
      group.add(mesh);
    }
    onProgress?.(1);
    return group;
  }
}

function hash2(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Geometry builder: positions, normals, uvs and BAKED vertex colors
class Builder {
  constructor(map) { this.map = map; this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; }
  _v(x, y, z, nx, ny, nz, u, v, color, isWall) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(u, v);
    const c = this.map.bakeColor(x, y, z, nx, ny, nz, isWall);
    if (color) { c[0] *= color[0]; c[1] *= color[1]; c[2] *= color[2]; }
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  // horizontal grid (floor / ceiling / tops), 1 m subdivisions
  gridY(x0, z0, x1, z1, y, down, tsz) {
    const nx = Math.max(1, Math.round(x1 - x0)), nz = Math.max(1, Math.round(z1 - z0));
    const base = this.pos.length / 3;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + (x1 - x0) * (i / nx), z = z0 + (z1 - z0) * (j / nz);
      this._v(x, y, z, 0, down ? -1 : 1, 0, x / tsz, -z / tsz, null, false);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      if (down) this.idx.push(a, b, d, a, d, c); else this.idx.push(a, c, d, a, d, b);
    }
  }
  // vertical wall from point a to point c (seen from the outward normal side)
  wall(a, c, y0, y1, nx, nz, tsz, vsz = 1) {
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const cols = Math.max(1, Math.round(len)), rows = Math.max(1, Math.round(y1 - y0));
    const base = this.pos.length / 3;
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const t = i / cols, y = y0 + (y1 - y0) * (j / rows);
      const x = a[0] + (c[0] - a[0]) * t, z = a[1] + (c[1] - a[1]) * t;
      this._v(x, y, z, nx, 0, nz, (x * nz - z * nx) / tsz, y / (vsz === 6 ? 6 : tsz), null, true); // world-space u: textures line up across faces
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const p = base + j * (cols + 1) + i, q = p + 1, r = p + cols + 1, s = r + 1;
      this.idx.push(p, q, s, p, s, r);
    }
  }
  // a picture glued flat on a wall (graffiti decals), uv 0..1
  decal(a, c, y0, y1, nx, nz) {
    const base = this.pos.length / 3;
    for (const [p, y, u, v] of [[a, y0, 0, 0], [c, y0, 1, 0], [c, y1, 1, 1], [a, y1, 0, 1]]) {
      this.pos.push(p[0], y, p[1]); this.nor.push(nx, 0, nz); this.uv.push(u, v);
      const col = this.map.bakeColor(p[0] - nx * 0.05, y, p[1] - nz * 0.05, nx, 0, nz, true);
      this.col.push(col[0], col[1], col[2]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // flat picture lying on the floor (dirt / trash decals), uv 0..1
  floorDecal(cx, cz, size, rot) {
    const base = this.pos.length / 3, h = size / 2, c = Math.cos(rot), s = Math.sin(rot);
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const lx = (u - 0.5) * size, lz = (0.5 - v) * size;
      const x = cx + lx * c - lz * s, z = cz + lx * s + lz * c;
      this.pos.push(x, 0.006, z); this.nor.push(0, 1, 0); this.uv.push(u, v);
      const col = this.map.bakeColor(x, 0, z, 0, 1, 0, false);
      this.col.push(col[0], col[1], col[2]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // thin strip sticking out of a wall face (baseboard, trim)
  box(a, c, nx, nz, y0, y1, depth, color) {
    const ox = nx * depth, oz = nz * depth;
    const A = [a[0], a[1]], C = [c[0], c[1]], A2 = [a[0] + ox, a[1] + oz], C2 = [c[0] + ox, c[1] + oz];
    const quad = (p, n) => {
      const base = this.pos.length / 3;
      for (const v of p) this._v(v[0], v[1], v[2], n[0], n[1], n[2], 0, 0, color, false);
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad([[A2[0], y0, A2[1]], [C2[0], y0, C2[1]], [C2[0], y1, C2[1]], [A2[0], y1, A2[1]]], [nx, 0, nz]);
    quad([[A2[0], y1, A2[1]], [C2[0], y1, C2[1]], [C[0], y1, C[1]], [A[0], y1, A[1]]], [0, 1, 0]);
    quad([[A[0], y0, A[1]], [C[0], y0, C[1]], [C2[0], y0, C2[1]], [A2[0], y0, A2[1]]], [0, -1, 0]);
  }
  // small axis-aligned box (fixture housings)
  boxXZ(x0, z0, x1, z1, y0, y1, color) {
    const quad = (p, n) => {
      const base = this.pos.length / 3;
      for (const v of p) this._v(v[0], v[1], v[2], n[0], n[1], n[2], 0, 0, color, false);
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]);
    quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]);
    quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  }
  // unlit flat quad facing down (light panels)
  flat(x0, z0, x1, z1, y) {
    const base = this.pos.length / 3;
    for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) { this.pos.push(x, y, z); this.nor.push(0, -1, 0); this.uv.push(0, 0); this.col.push(1, 1, 1); }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
