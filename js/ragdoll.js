// Verlet ragdoll: 15 joints linked by distance constraints ("limb connectors").
// The torso is kept rigid with cross-braces so the body keeps a human shape.
import * as THREE from '../vendor/three.module.min.js?v=920';
import { CELL } from './map.js?v=920';

// joint indices (see CharacterModel.jointPositions)
const HEAD = 0, NECK = 1, PELVIS = 2, SHL = 3, ELL = 4, HAL = 5, SHR = 6, ELR = 7, HAR = 8,
  HIPL = 9, KNL = 10, FTL = 11, HIPR = 12, KNR = 13, FTR = 14;

const RADII = [0.14, 0.09, 0.11, 0.07, 0.06, 0.05, 0.07, 0.06, 0.05, 0.08, 0.07, 0.06, 0.08, 0.07, 0.06];

// [a, b] pairs. Bones first, then torso braces.
const LINKS = [
  [HEAD, NECK], [NECK, PELVIS], [NECK, SHL], [NECK, SHR], [SHL, ELL], [ELL, HAL], [SHR, ELR], [ELR, HAR],
  [PELVIS, HIPL], [PELVIS, HIPR], [HIPL, KNL], [KNL, FTL], [HIPR, KNR], [KNR, FTR],
  // rigid torso box
  [SHL, SHR], [HIPL, HIPR], [SHL, HIPL], [SHR, HIPR], [SHL, HIPR], [SHR, HIPL], [SHL, PELVIS], [SHR, PELVIS],
  [NECK, HIPL], [NECK, HIPR],
  // keep head attached firmly
  [HEAD, SHL], [HEAD, SHR], [HEAD, PELVIS],
];
// "joint limits": minimum distances so elbows / knees can't fold completely
const MIN_LINKS = [
  [SHL, HAL, 0.22], [SHR, HAR, 0.22], [HIPL, FTL, 0.48], [HIPR, FTR, 0.48],
  [HAL, PELVIS, 0.12], [HAR, PELVIS, 0.12], [FTL, FTR, 0.12], [KNL, KNR, 0.12],
  [HEAD, HAL, 0.1], [HEAD, HAR, 0.1],
];

// Body segments as capsules: [joint a, joint b, radius]
const SEGS = [
  [SHL, ELL, 0.055], [ELL, HAL, 0.05], [SHR, ELR, 0.055], [ELR, HAR, 0.05],   // 0-3 arms
  [HIPL, KNL, 0.07], [KNL, FTL, 0.055], [HIPR, KNR, 0.07], [KNR, FTR, 0.055], // 4-7 legs
  [NECK, PELVIS, 0.13], [HEAD, HEAD, 0.14],                                    // 8 torso, 9 head
];
// pairs that should never overlap (attached neighbours are left out)
const SELF_PAIRS = [];
for (let i = 0; i < SEGS.length; i++) for (let j = i + 1; j < SEGS.length; j++) {
  const A = SEGS[i], B = SEGS[j];
  if (A[0] === B[0] || A[0] === B[1] || A[1] === B[0] || A[1] === B[1]) continue; // share a joint
  if (i === 8 && (j === 9 || [0, 2, 4, 6].includes(i) )) continue;
  if (j === 8 && [0, 2, 4, 6].includes(i)) continue;   // upper arms / thighs are attached to the torso
  if ((i === 4 && j === 6)) continue;                    // thighs start right next to each other
  SELF_PAIRS.push([i, j]);
}
// closest points between segments p0-p1 and q0-q1 -> [s, t] in 0..1
function closestST(p0, p1, q0, q1) {
  const d1x = p1.x - p0.x, d1y = p1.y - p0.y, d1z = p1.z - p0.z;
  const d2x = q1.x - q0.x, d2y = q1.y - q0.y, d2z = q1.z - q0.z;
  const rx = p0.x - q0.x, ry = p0.y - q0.y, rz = p0.z - q0.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a < 1e-9 && e < 1e-9) return [0, 0];
  if (a < 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e < 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return [s, t];
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const mtx = new THREE.Matrix4();

export class Ragdoll {
  // model: CharacterModel; vel: {x,y,z} body velocity; impulse: {x,y,z} hit direction*strength
  constructor(scene, model, map, vel, impulse) {
    this.scene = scene;
    this.map = map;
    const joints = model.jointPositions();
    const dt = 1 / 60;
    this.p = joints.map((j, i) => {
      const upper = i <= SHR + 2; // head, neck, pelvis, arms -> take more of the hit
      const k = upper ? 1 : 0.45;
      const vx = vel.x + impulse.x * k, vy = vel.y + impulse.y * k + 0.6, vz = vel.z + impulse.z * k;
      return { x: j.x, y: j.y, z: j.z, px: j.x - vx * dt, py: j.y - vy * dt, pz: j.z - vz * dt, r: RADII[i] };
    });
    // rest lengths from the current pose
    this.links = LINKS.map(([a, b]) => [a, b, this._d(a, b)]);
    this.minLinks = MIN_LINKS;
    this.time = 0;
    this.sleepT = 0;
    this.asleep = false;

    // Visuals: clone the character's own body segments (same clothes, hair, face).
    // Clones share geometry + materials, so they're cheap.
    this.group = new THREE.Group();
    const cl = (vis) => { const c = vis.clone(true); c.position.set(0, 0, 0); c.rotation.set(0, 0, 0); this.group.add(c); return c; };
    this.m = {
      pelvis: cl(model.pelvis.vis), torso: cl(model.torso.vis), head: cl(model.head.vis),
      upL: cl(model.armL.shVis), foL: cl(model.armL.elVis), upR: cl(model.armR.shVis), foR: cl(model.armR.elVis),
      thL: cl(model.legL.hipVis), shL: cl(model.legL.knVis), thR: cl(model.legR.hipVis), shR: cl(model.legR.knVis),
    };
    scene.add(this.group);
    this.right = new THREE.Vector3(1, 0, 0);
    this._render();
  }

  _d(a, b) {
    const p = this.p;
    return Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y, p[a].z - p[b].z);
  }

  get center() { return this.p[PELVIS]; }

  update(dt) {
    if (this.asleep) return;
    this.time += dt;
    const steps = 2;
    const h = Math.min(dt, 1 / 30) / steps;
    for (let s = 0; s < steps; s++) this._step(h);
    this._render();
    // sleep when still
    let ke = 0;
    for (const q of this.p) ke += (q.x - q.px) ** 2 + (q.y - q.py) ** 2 + (q.z - q.pz) ** 2;
    if (ke < 1e-6) this.sleepT += dt; else this.sleepT = 0;
    if (this.sleepT > 1 || this.time > 12) this.asleep = true;
  }

  _step(h) {
    const g = -18 * h * h;
    const p = this.p;
    for (const q of p) {
      const vx = (q.x - q.px) * 0.995, vy = (q.y - q.py) * 0.995, vz = (q.z - q.pz) * 0.995;
      q.px = q.x; q.py = q.y; q.pz = q.z;
      q.x += vx; q.y += vy + g; q.z += vz;
    }
    for (let it = 0; it < 10; it++) {
      for (const [a, b, rest] of this.links) this._solve(a, b, rest, 1, false);
      for (const [a, b, min] of this.minLinks) this._solve(a, b, min, 1, true);
      if (it % 3 === 0) this._selfCollide();
      for (const q of p) this._collide(q);
    }
  }

  // Limbs are capsules: keep them from passing through each other / the body
  _selfCollide() {
    const p = this.p;
    for (const [i, j] of SELF_PAIRS) {
      const A = SEGS[i], Bs = SEGS[j];
      const a0 = p[A[0]], a1 = p[A[1]], b0 = p[Bs[0]], b1 = p[Bs[1]];
      const [s, t] = closestST(a0, a1, b0, b1);
      const ax = a0.x + (a1.x - a0.x) * s, ay = a0.y + (a1.y - a0.y) * s, az = a0.z + (a1.z - a0.z) * s;
      const bx = b0.x + (b1.x - b0.x) * t, by = b0.y + (b1.y - b0.y) * t, bz = b0.z + (b1.z - b0.z) * t;
      let dx = bx - ax, dy = by - ay, dz = bz - az;
      const d = Math.hypot(dx, dy, dz), min = A[2] + Bs[2];
      if (d >= min || d < 1e-6) continue;
      const push = (min - d) * 0.5 / d;
      dx *= push; dy *= push; dz *= push;
      // spread the correction over the two end points of each segment
      const wa0 = 1 - s, wa1 = s, wb0 = 1 - t, wb1 = t;
      a0.x -= dx * wa0; a0.y -= dy * wa0; a0.z -= dz * wa0;
      a1.x -= dx * wa1; a1.y -= dy * wa1; a1.z -= dz * wa1;
      b0.x += dx * wb0; b0.y += dy * wb0; b0.z += dz * wb0;
      b1.x += dx * wb1; b1.y += dy * wb1; b1.z += dz * wb1;
    }
  }

  _solve(a, b, rest, k, onlyMin) {
    const pa = this.p[a], pb = this.p[b];
    let dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    if (onlyMin && d >= rest) return;
    const diff = ((d - rest) / d) * 0.5 * k;
    dx *= diff; dy *= diff; dz *= diff;
    pa.x += dx; pa.y += dy; pa.z += dz;
    pb.x -= dx; pb.y -= dy; pb.z -= dz;
  }

  _collide(q) {
    const map = this.map;
    const cx = Math.floor(q.x / CELL), cz = Math.floor(q.z / CELL);
    const hgt = map.cellHeight(cx, cz);
    let support = 0;
    if (hgt > 0 && q.y - q.r < hgt) {
      if (q.py - q.r >= hgt - 0.05 && hgt < 3) {
        support = hgt; // landed on top of a crate / half wall
      } else {
        // push sideways out of the solid cell to the closest open edge
        const minX = cx * CELL, maxX = minX + CELL, minZ = cz * CELL, maxZ = minZ + CELL;
        const opts = [
          [q.x - minX, () => { q.x = minX - q.r * 0.5; }, map.cellHeight(cx - 1, cz)],
          [maxX - q.x, () => { q.x = maxX + q.r * 0.5; }, map.cellHeight(cx + 1, cz)],
          [q.z - minZ, () => { q.z = minZ - q.r * 0.5; }, map.cellHeight(cx, cz - 1)],
          [maxZ - q.z, () => { q.z = maxZ + q.r * 0.5; }, map.cellHeight(cx, cz + 1)],
        ].filter((o) => o[2] < hgt).sort((a, b) => a[0] - b[0]);
        if (opts.length) { opts[0][1](); q.px = q.x; q.pz = q.z; }
        else support = hgt;
      }
    }
    // also keep a small margin from neighbouring walls (circle vs cell)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz;
      const nh = map.cellHeight(nx, nz);
      if (nh <= q.y - q.r) continue;
      const minX = nx * CELL, minZ = nz * CELL;
      const px = Math.max(minX, Math.min(q.x, minX + CELL)), pz = Math.max(minZ, Math.min(q.z, minZ + CELL));
      const ddx = q.x - px, ddz = q.z - pz, d2 = ddx * ddx + ddz * ddz;
      if (d2 < q.r * q.r && d2 > 1e-9) {
        const d = Math.sqrt(d2), push = q.r - d;
        q.x += (ddx / d) * push; q.z += (ddz / d) * push;
      }
    }
    // physics props: per-part hitboxes (lands on top / pushed out of the sides)
    if (map.propSys && map.propSys.pushPoint(q, q.r * 0.8)) {
      q.px = q.x - (q.x - q.px) * 0.6; q.pz = q.z - (q.z - q.pz) * 0.6;
    }
    const floor = support + q.r;
    if (q.y < floor) {
      q.y = floor;
      // ground friction
      q.px = q.x - (q.x - q.px) * 0.55;
      q.pz = q.z - (q.z - q.pz) * 0.55;
      if (q.py < q.y) q.py = q.y + (q.py - q.y) * -0.15; // tiny bounce
    }
  }

  // place a limb segment: its origin at joint a, its local -Y pointing at joint b
  _seg(obj, a, b) {
    const pa = this.p[a], pb = this.p[b];
    const yAxis = tmpA.set(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z).normalize(); // local +Y (points back up the limb)
    const xAxis = tmpB.copy(this.right).addScaledVector(yAxis, -this.right.dot(yAxis));
    if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0);
    xAxis.normalize();
    const zAxis = tmpC.crossVectors(xAxis, yAxis);
    mtx.makeBasis(xAxis, yAxis, zAxis);
    obj.quaternion.setFromRotationMatrix(mtx);
    obj.position.set(pa.x, pa.y, pa.z);
  }

  _render() {
    const p = this.p, m = this.m;
    const up = new THREE.Vector3(p[NECK].x - p[PELVIS].x, p[NECK].y - p[PELVIS].y, p[NECK].z - p[PELVIS].z).normalize();
    const right = new THREE.Vector3(
      (p[SHR].x + p[HIPR].x) - (p[SHL].x + p[HIPL].x),
      (p[SHR].y + p[HIPR].y) - (p[SHL].y + p[HIPL].y),
      (p[SHR].z + p[HIPR].z) - (p[SHL].z + p[HIPL].z)).normalize();
    right.addScaledVector(up, -right.dot(up)).normalize();
    this.right.copy(right);
    const back = new THREE.Vector3().crossVectors(right, up);
    mtx.makeBasis(right, up, back);
    const P = p[PELVIS], N = p[NECK], H = p[HEAD];
    m.pelvis.position.set(P.x, P.y, P.z); m.pelvis.quaternion.setFromRotationMatrix(mtx);
    m.torso.position.copy(m.pelvis.position); m.torso.quaternion.copy(m.pelvis.quaternion);
    // head: up = neck -> head center
    const hup = new THREE.Vector3(H.x - N.x, H.y - N.y, H.z - N.z).normalize();
    const hr = right.clone().addScaledVector(hup, -right.dot(hup)).normalize();
    const hb = new THREE.Vector3().crossVectors(hr, hup);
    mtx.makeBasis(hr, hup, hb);
    m.head.quaternion.setFromRotationMatrix(mtx);
    m.head.position.set(N.x, N.y, N.z);
    this._seg(m.upL, SHL, ELL); this._seg(m.foL, ELL, HAL);
    this._seg(m.upR, SHR, ELR); this._seg(m.foR, ELR, HAR);
    this._seg(m.thL, HIPL, KNL); this._seg(m.shL, KNL, FTL);
    this._seg(m.thR, HIPR, KNR); this._seg(m.shR, KNR, FTR);
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
