// Navigation grid + A* pathfinding for bots.
// The nav grid is 2x finer than the map grid (1 m nodes), so bots keep
// a margin from walls and can walk around crates / pillars.
import { CELL } from './map.js?v=120';
import { CONFIG } from './config.js?v=120';
import { circleFree } from './physics.js?v=120';

const SUB = 2;                   // nav nodes per map cell (each axis)
const NODE = CELL / SUB;         // 1 meter
const CLEAR_R = CONFIG.PLAYER.RADIUS + 0.12; // clearance used when smoothing

export class NavGrid {
  constructor(map) {
    this.map = map;
    this.w = map.w * SUB;
    this.h = map.h * SUB;
    const n = this.w * this.h;
    this.walk = new Uint8Array(n);
    this.walkList = [];
    for (let z = 0; z < this.h; z++) for (let x = 0; x < this.w; x++) {
      const wx = (x + 0.5) * NODE, wz = (z + 0.5) * NODE;
      if (map.heightAt(wx, wz) <= CONFIG.PLAYER.STEP_HEIGHT && circleFree(map, wx, wz, CONFIG.PLAYER.RADIUS + 0.05)) {
        this.walk[z * this.w + x] = 1;
        this.walkList.push(z * this.w + x);
      }
    }
    // A* working arrays (reused between searches)
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.gen = 1;
    this.heap = new Heap(this.f);
  }

  nodeOf(x, z) {
    return [Math.floor(x / NODE), Math.floor(z / NODE)];
  }
  isWalk(nx, nz) {
    return nx >= 0 && nz >= 0 && nx < this.w && nz < this.h && this.walk[nz * this.w + nx] === 1;
  }
  toWorld(i) {
    return { x: ((i % this.w) + 0.5) * NODE, z: (Math.floor(i / this.w) + 0.5) * NODE };
  }

  // Nearest walkable node to a world position (spiral search)
  nearestWalkable(x, z) {
    const [nx, nz] = this.nodeOf(x, z);
    if (this.isWalk(nx, nz)) return nz * this.w + nx;
    for (let r = 1; r < 12; r++) {
      let best = -1, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        if (this.isWalk(nx + dx, nz + dz)) {
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = (nz + dz) * this.w + nx + dx; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  randomPoint() {
    const i = this.walkList[Math.floor(Math.random() * this.walkList.length)];
    return this.toWorld(i);
  }

  // Random walkable point between minD and maxD meters away from (x,z), optionally far from `avoid`
  randomPointNear(x, z, minD, maxD, tries = 25) {
    for (let t = 0; t < tries; t++) {
      const p = this.randomPoint();
      const d = Math.hypot(p.x - x, p.z - z);
      if (d >= minD && d <= maxD) return p;
    }
    return this.randomPoint();
  }

  // Find a point far away from a threat, reachable from (x,z)
  fleePoint(x, z, tx, tz) {
    let best = null, bestScore = -Infinity;
    for (let t = 0; t < 30; t++) {
      const p = this.randomPoint();
      const dMe = Math.hypot(p.x - x, p.z - z);
      if (dMe < 8 || dMe > 45) continue;
      const dThreat = Math.hypot(p.x - tx, p.z - tz);
      // prefer points away from the threat and in the direction away from it
      const away = ((p.x - x) * (x - tx) + (p.z - z) * (z - tz)) / (dMe * (Math.hypot(x - tx, z - tz) + 0.01));
      const score = dThreat + away * 12 - dMe * 0.15;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best || this.randomPoint();
  }

  // A* (8-directional, no corner cutting). Returns smoothed list of world points, or null.
  findPath(sx, sz, gx, gz, maxIter = 9000) {
    const start = this.nearestWalkable(sx, sz);
    const goal = this.nearestWalkable(gx, gz);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [{ x: gx, z: gz }];
    const W = this.w;
    const gen = ++this.gen;
    const gxN = goal % W, gzN = Math.floor(goal / W);
    const H = (i) => {
      const dx = Math.abs((i % W) - gxN), dz = Math.abs(Math.floor(i / W) - gzN);
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    const heap = this.heap; heap.clear();
    this.g[start] = 0; this.f[start] = H(start); this.stamp[start] = gen; this.parent[start] = -1;
    heap.push(start);
    let found = false, iter = 0;
    while (heap.size && iter++ < maxIter) {
      const cur = heap.pop();
      if (cur === goal) { found = true; break; }
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      const cx = cur % W, cz = (cur - cx) / W;
      for (let k = 0; k < 8; k++) {
        const dx = DX[k], dz = DZ[k];
        const nx = cx + dx, nz = cz + dz;
        if (!this.isWalk(nx, nz)) continue;
        if (dx && dz && (!this.isWalk(cx + dx, cz) || !this.isWalk(cx, cz + dz))) continue;
        const ni = nz * W + nx;
        if (this.closed[ni] === gen) continue;
        const ng = this.g[cur] + (dx && dz ? Math.SQRT2 : 1);
        if (this.stamp[ni] !== gen || ng < this.g[ni]) {
          this.stamp[ni] = gen; this.g[ni] = ng; this.f[ni] = ng + H(ni) * 1.05; this.parent[ni] = cur;
          heap.push(ni);
        }
      }
    }
    if (!found) return null;
    const raw = [];
    for (let i = goal; i !== -1; i = this.parent[i]) raw.push(this.toWorld(i));
    raw.reverse();
    raw[raw.length - 1] = { x: gx, z: gz };
    if (!circleFree(this.map, gx, gz, CONFIG.PLAYER.RADIUS)) raw[raw.length - 1] = this.toWorld(goal);
    return this.smooth({ x: sx, z: sz }, raw);
  }

  // Can a character walk in a straight line from a to b without touching walls?
  clearLine(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / 0.3);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!circleFree(this.map, ax + (bx - ax) * t, az + (bz - az) * t, CLEAR_R)) return false;
    }
    return true;
  }

  // String-pulling: skip waypoints that can be reached in a straight line
  smooth(start, pts) {
    const out = [];
    let from = start, i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.clearLine(from.x, from.z, pts[j].x, pts[j].z)) j--;
      out.push(pts[j]);
      from = pts[j];
      i = j + 1;
    }
    return out;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

// Binary min-heap of node indices keyed by f[]
class Heap {
  constructor(f) { this.f = f; this.a = []; }
  get size() { return this.a.length; }
  clear() { this.a.length = 0; }
  push(i) {
    const a = this.a, f = this.f; a.push(i);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (f[a[p]] <= f[a[k]]) break;
      [a[p], a[k]] = [a[k], a[p]]; k = p;
    }
  }
  pop() {
    const a = this.a, f = this.f;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < a.length && f[a[l]] < f[a[m]]) m = l;
        if (r < a.length && f[a[r]] < f[a[m]]) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]]; k = m;
      }
    }
    return top;
  }
}
