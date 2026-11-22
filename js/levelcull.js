// =====================================================================
//  LEVELCULL.JS — don't draw wall surfaces and ceiling lights you can't see.
//  The walls (and their trim, pillars, shelves, painted decals) and the ceiling lights are baked into a
//  few big meshes. They're cut into 20 x 20 m chunks (sharing the same vertex data, so almost no extra
//  memory). Each time the camera moves to a new spot, a fan of rays all the way around it walks the map
//  grid and marks every cell it can see (full-height walls and pillars stop a ray; shelves and counters
//  don't), plus a two-cell safety margin. A chunk is drawn only if a cell it touches was marked.
//  Above the roof or outside the map everything is drawn.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js?v=1010';
import { CELL, WALL_H, CEIL_H } from './map.js?v=1010';

const CHUNK = 10;                         // cells per chunk side (20 m)
const CULLED = /^(wall-|pillar|shelf|trim|graffiti|fixture|light-panel)/;

export class LevelCuller {
  constructor(map, level) {
    this.map = map;
    this.entries = [];                    // { obj, cx0, cz0, cx1, cz1 }
    this.vis = new Uint8Array(map.w * map.h);
    this.seen = new Uint8Array(map.w * map.h);
    this.last = { x: 1e9, z: 1e9 };
    this.allOn = true;
    // every corner where a full-height wall meets open floor: rays aimed just either side of each one
    // catch even the narrowest gap (e.g. a view through two doorways in a row), which an even fan of
    // rays can slip between
    this.corners = [];
    const solid = (i, j) => !map.inBounds(i, j) || map.cellHeight(i, j) >= WALL_H;
    for (let j = 0; j <= map.h; j++) for (let i = 0; i <= map.w; i++) {
      const n = solid(i - 1, j - 1) + solid(i, j - 1) + solid(i - 1, j) + solid(i, j);
      if (n === 1 || n === 3) this.corners.push(i * CELL, j * CELL);
    }
    const meshes = level.children.filter((o) => o.isMesh && CULLED.test(o.name || ''));
    for (const m of meshes) this.split(level, m);
  }

  // cut one mesh into chunk meshes (triangles go to the chunk of their centre)
  split(level, mesh) {
    const g = mesh.geometry, pos = g.attributes.position;
    const idx = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
    const groups = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      const k = Math.floor(cx / CELL / CHUNK) + ',' + Math.floor(cz / CELL / CHUNK);
      let e = groups.get(k);
      if (!e) { e = { tri: [], x0: 1e9, z0: 1e9, x1: -1e9, z1: -1e9, cells: new Set() }; groups.set(k, e); }
      e.tri.push(a, b, c);
      // the cell this face looks onto (a little in front of it): the chunk only needs drawing if a
      // cell its faces look onto can be seen
      const nor = g.attributes.normal;
      const nx = nor ? (nor.getX(a) + nor.getX(b) + nor.getX(c)) / 3 : 0, nz = nor ? (nor.getZ(a) + nor.getZ(b) + nor.getZ(c)) / 3 : 0;
      e.cells.add(Math.floor((cz + nz * 0.4) / CELL) * 100000 + Math.floor((cx + nx * 0.4) / CELL));
      e.cells.add(Math.floor(cz / CELL) * 100000 + Math.floor(cx / CELL));
      for (const v of [a, b, c]) { const x = pos.getX(v), z = pos.getZ(v); e.x0 = Math.min(e.x0, x); e.x1 = Math.max(e.x1, x); e.z0 = Math.min(e.z0, z); e.z1 = Math.max(e.z1, z); }
    }
    level.remove(mesh);
    for (const e of groups.values()) {
      const cg = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(g.attributes)) cg.setAttribute(name, attr);   // shared data
      cg.setIndex(e.tri);
      cg.computeBoundingSphere();
      const cm = new THREE.Mesh(cg, mesh.material);
      cm.name = mesh.name; cm.renderOrder = mesh.renderOrder; cm.userData.noShadow = true;
      level.add(cm);
      this.add(cm, e.x0, e.z0, e.x1, e.z1, e.cells);
    }
  }

  // register any object covering the world box x0..x1, z0..z1
  // (cells: optional exact list of cells it faces; otherwise every cell of its box counts)
  add(obj, x0, z0, x1, z1, cells = null) {
    const W = this.map.w;
    const list = cells ? [...cells].map((k) => Math.floor(k / 100000) * W + (k % 100000)) : null;
    this.entries.push({ obj, cells: list ? Int32Array.from(list.filter((i) => i >= 0 && i < W * this.map.h)) : null,
      cx0: Math.floor((x0 - 0.01) / CELL), cz0: Math.floor((z0 - 0.01) / CELL), cx1: Math.floor((x1 + 0.01) / CELL), cz1: Math.floor((z1 + 0.01) / CELL) });
  }

  // which cells can be seen from (x, y, z)? (only re-done when the camera moved a bit)
  update(x, y, z) {
    const map = this.map, W = map.w, H = map.h;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const out = y > CEIL_H + 0.6 || !map.inBounds(cx, cz) || map.cellHeight(cx, cz) >= WALL_H;
    if (out) { if (!this.allOn) { this.allOn = true; for (const e of this.entries) e.obj.visible = true; } return; }
    if (!this.allOn && Math.hypot(x - this.last.x, z - this.last.z) < 0.35) return;
    this.allOn = false; this.last.x = x; this.last.z = z;
    const seen = this.seen; seen.fill(0);
    const RAYS = 720, angles = [];
    for (let r = 0; r < RAYS; r++) angles.push((r / RAYS) * Math.PI * 2);
    for (let k = 0; k < this.corners.length; k += 2) {
      const a = Math.atan2(this.corners[k + 1] - z, this.corners[k] - x);
      angles.push(a - 0.0004, a + 0.0004);
    }
    for (const a of angles) {
      const dx = Math.cos(a), dz = Math.sin(a);
      let gx = cx, gz = cz;
      const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
      const tdx = Math.abs(dx) > 1e-9 ? CELL / Math.abs(dx) : Infinity, tdz = Math.abs(dz) > 1e-9 ? CELL / Math.abs(dz) : Infinity;
      let tmx = Math.abs(dx) > 1e-9 ? (dx > 0 ? (gx + 1) * CELL - x : x - gx * CELL) / Math.abs(dx) : Infinity;
      let tmz = Math.abs(dz) > 1e-9 ? (dz > 0 ? (gz + 1) * CELL - z : z - gz * CELL) / Math.abs(dz) : Infinity;
      for (let n = 0; n < 200; n++) {
        if (gx < 0 || gz < 0 || gx >= W || gz >= H) break;
        seen[gz * W + gx] = 1;
        if (map.heights[gz * W + gx] >= WALL_H) break;          // a full-height wall / pillar stops the view
        if (tmx < tmz) { tmx += tdx; gx += sx; } else { tmz += tdz; gz += sz; }
      }
    }
    // two-cell safety margin
    const vis = this.vis; vis.fill(0);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (!seen[j * W + i]) continue;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < W && jj < H) vis[jj * W + ii] = 1;
      }
    }
    for (const e of this.entries) {
      let on = false;
      if (e.cells) { for (let k = 0; k < e.cells.length; k++) if (vis[e.cells[k]]) { on = true; break; } }
      else for (let j = Math.max(0, e.cz0); j <= Math.min(H - 1, e.cz1) && !on; j++) for (let i = Math.max(0, e.cx0); i <= Math.min(W - 1, e.cx1); i++) if (vis[j * W + i]) { on = true; break; }
      e.obj.visible = on;
    }
  }
}
