// =====================================================================
//  PROPS.JS — movable physics furniture with REAL rigid-body physics.
//
//  Each prop is built from a few boxes ("parts") — e.g. a chair is a
//  seat, a backrest and two leg frames. Those boxes are its hitbox for
//  bullets, knives, people, ragdolls and other props. Props have mass,
//  gravity, spin, and can tip / fall over (push a lamp near the top!).
//
//  The host simulates; clients receive position + rotation.
//  To add a new prop: add an entry to PROP_TYPES (collision parts) and to
//  buildGeometry() (what it looks like), then give it a letter in map.js.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js?v=660';
import { CONFIG } from './config.js?v=660';
import { CELL, CEIL_H, WALL_H } from './map.js?v=660';
import { footWorld } from './physics.js?v=660';

const V = THREE.Vector3, Q = THREE.Quaternion;
const GRAV = 18;
const CHAR_MASS = 3;   // a person, for shoving props
// heights (above the feet) where a character's body is tested against props
// legs included: jumping into a table hits it with your legs (pushes it) instead of sliding over the edge
const CHAR_SAMPLES = [];
for (let y = 0.05; y < 1.8; y += 0.06) CHAR_SAMPLES.push(y);   // the whole body, feet to head
const KICK_SAMPLES = [0.05, 0.2, 0.35];
const P = CONFIG.PLAYER;

// parts: [cx, cy, cz, hx, hy, hz, yaw?] — box center + half sizes, origin = bottom center of the prop.
// Round things (barrels, bins, lamp parts, bottles) are made of 4 thin boxes turned 0/45/90/135°
// whose corners sit exactly on the circle, so the hitbox stays inside the real round shape
// (a single square box would stick out at the corners and make stacked barrels float).
const cyl = (cy, r, hy) => [0, 1, 2, 3].map((k) => [0, cy, 0, r * Math.cos(Math.PI / 8), hy, r * Math.sin(Math.PI / 8), (k * Math.PI) / 4]);
const legs = (x, z, hy, w) => [[-x, hy, -z, w, hy, w], [x, hy, -z, w, hy, w], [-x, hy, z, w, hy, w], [x, hy, z, w, hy, w]];
export const PROP_TYPES = {
  box:      { mass: 1.2, sound: 'cardboard', mu: 0.6, parts: [[0, 0.28, 0, 0.3, 0.28, 0.28]] },
  crate:    { mass: 3.0, sound: 'wood', mu: 0.6, parts: [[0, 0.45, 0, 0.45, 0.45, 0.45]] },
  // seat, backrest, 4 legs, 2 side rails
  chair:    { mass: 1.4, sound: 'wood', mu: 0.5, parts: [[0, 0.455, 0, 0.22, 0.025, 0.21], [0, 0.71, 0.2, 0.22, 0.21, 0.02], ...legs(0.19, 0.18, 0.22, 0.018), [-0.19, 0.08, 0, 0.012, 0.012, 0.18], [0.19, 0.08, 0, 0.012, 0.012, 0.18]] },
  // top, 4 legs, 2 rails
  table:    { mass: 8.0, sound: 'wood', mu: 0.3, parts: [[0, 0.745, 0, 0.62, 0.025, 0.4], ...legs(0.55, 0.33, 0.36, 0.024), [-0.55, 0.1, 0, 0.015, 0.02, 0.35], [0.55, 0.1, 0, 0.015, 0.02, 0.35]] },
  barrel:   { mass: 2.2, sound: 'metal', mu: 0.45, parts: cyl(0.45, 0.31, 0.45) },
  mattress: { mass: 1.6, sound: 'soft', mu: 0.7, parts: [[0, 0.12, 0, 1.02, 0.12, 0.52]] },
  // round base, pole, round shade
  lamp:     { mass: 2.0, sound: 'metal', mu: 0.5, parts: [...cyl(0.025, 0.17, 0.025), [0, 0.8, 0, 0.018, 0.75, 0.018], ...cyl(1.56, 0.15, 0.12)] },
  // round body + narrow neck
  bottle:   { mass: 0.2, sound: 'glass', mu: 0.35, parts: [...cyl(0.115, 0.048, 0.115), [0, 0.29, 0, 0.02, 0.07, 0.02]] },
  trashcan: { mass: 1.1, sound: 'metal', mu: 0.4, parts: cyl(0.32, 0.235, 0.32) },
  takeout:  { mass: 0.25, sound: 'cardboard', mu: 0.5, parts: [[0, 0.13, 0, 0.125, 0.13, 0.1]] },
  // a big, long wooden storage crate (heavy, lots of health)
  longcrate: { mass: 40, sound: 'wood', mu: 0.8, parts: [[0, 0.65, 0, 2.0, 0.65, 0.75]] },
  // simple counters: wooden cabinet with a stone countertop (4 m and 2 m)
  longcounter: { mass: 20, sound: 'wood', mu: 0.8, parts: [[0, 0.5, 0, 2.0, 0.5, 0.5]] },
  shortcounter: { mass: 10, sound: 'wood', mu: 0.8, parts: [[0, 0.5, 0, 1.0, 0.5, 0.5]] },
  // ---- office / classroom furniture ----
  // office desk: top, drawer pedestal, side panel, modesty panel at the back (the sitter is on the +z side)
  desk:     { mass: 6.0, sound: 'wood', mu: 0.5, parts: [[0, 0.735, 0, 0.7, 0.025, 0.35], [-0.5, 0.355, 0, 0.18, 0.355, 0.32], [0.66, 0.355, 0, 0.02, 0.355, 0.32], [0.08, 0.45, -0.31, 0.56, 0.24, 0.012]] },
  // office swivel chair: 5-spoke base, gas column, seat, backrest (+z), two armrests
  swivelchair: { mass: 1.6, sound: 'metal', mu: 0.35, parts: [[0, 0.04, 0, 0.3, 0.03, 0.035, 0], [0, 0.04, 0, 0.3, 0.03, 0.035, 1.2566], [0, 0.04, 0, 0.3, 0.03, 0.035, 2.5133], [0, 0.26, 0, 0.03, 0.2, 0.03], [0, 0.49, 0, 0.25, 0.05, 0.24], [0, 0.84, 0.21, 0.23, 0.28, 0.04], [-0.24, 0.63, 0, 0.025, 0.03, 0.17], [0.24, 0.63, 0, 0.025, 0.03, 0.17]] },
  // desktop computer monitor on a stand (screen faces +z)
  computer: { mass: 0.9, sound: 'metal', mu: 0.5, parts: [[0, 0.012, 0, 0.11, 0.012, 0.08], [0, 0.11, -0.02, 0.02, 0.09, 0.015], [0, 0.32, 0, 0.29, 0.18, 0.025]] },
  keyboard: { mass: 0.3, sound: 'cardboard', mu: 0.5, parts: [[0, 0.015, 0, 0.22, 0.015, 0.075]] },
  // pen / pencil cup with a few pencils sticking out
  pencup:   { mass: 0.12, sound: 'glass', mu: 0.5, parts: [...cyl(0.05, 0.04, 0.05), [0, 0.13, 0, 0.025, 0.04, 0.025]] },
  // two-seat couch: base, cushions, backrest (+z), two arms
  couch:    { mass: 14, sound: 'soft', mu: 0.8, parts: [[0, 0.22, 0, 1.0, 0.2, 0.45], [0, 0.47, -0.05, 0.86, 0.06, 0.38], [0, 0.62, 0.36, 1.0, 0.3, 0.09], [-0.93, 0.5, 0, 0.07, 0.1, 0.45], [0.93, 0.5, 0, 0.07, 0.1, 0.45]] },
  // potted plant: pot + leafy top
  plant:    { mass: 2.5, sound: 'soft', mu: 0.6, parts: [...cyl(0.19, 0.19, 0.19), [0, 0.72, 0, 0.3, 0.34, 0.3]] },
  // mobile whiteboard on two legs
  whiteboard: { mass: 5, sound: 'metal', mu: 0.6, parts: [[0, 1.35, 0, 0.9, 0.5, 0.02], [-0.85, 0.65, 0, 0.03, 0.65, 0.03], [0.85, 0.65, 0, 0.03, 0.65, 0.03], [-0.85, 0.03, 0, 0.04, 0.03, 0.3], [0.85, 0.03, 0, 0.04, 0.03, 0.3]] },
  // an old, broken baby doll lying on its back: head, body, legs, one arm (the other is missing)
  babydoll: { mass: 0.3, sound: 'soft', mu: 0.6, parts: [[0.2, 0.075, 0, 0.075, 0.075, 0.07], [0, 0.055, 0, 0.12, 0.055, 0.075], [-0.2, 0.035, 0.045, 0.09, 0.035, 0.032], [-0.2, 0.035, -0.045, 0.09, 0.035, 0.032], [0.06, 0.03, 0.11, 0.07, 0.025, 0.025]] },
};

// names shown to players ("Tap to become: baby doll")
export const PROP_NAMES = { babydoll: 'baby doll', takeout: 'takeout box', trashcan: 'trash can', longcrate: 'long crate', longcounter: 'long counter', shortcounter: 'short counter', swivelchair: 'swivel chair', computer: 'desktop computer', pencup: 'pen cup', plant: 'potted plant' };
export const propName = (type) => PROP_NAMES[type] || type;

// ---------------- shared temps ----------------
const t1 = new V(), t2 = new V(), t3 = new V(), t4 = new V(), t5 = new V(), t6 = new V();
const tq = new Q(), tq2 = new Q();
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------- geometry ----------------
function mergeParts(parts) {
  const pos = [], nor = [], uv = [], groups = [];
  let start = 0;
  parts.sort((a, b) => a.mat - b.mat);
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    g.applyMatrix4(p.m);
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
    const count = g.attributes.position.count;
    const last = groups[groups.length - 1];
    if (last && last.mat === p.mat) last.count += count; else groups.push({ start, count, mat: p.mat });
    start += count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  for (const g of groups) out.addGroup(g.start, g.count, g.mat);
  out.computeBoundingSphere();
  return out;
}
const M4 = (x, y, z, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(new V(x, y, z), new Q().setFromEuler(new THREE.Euler(rx, ry, rz)), new V(1, 1, 1));

let GEO = null;
function buildGeometry() {
  if (GEO) return GEO;
  GEO = {};
  const Box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const Cyl = (a, b, h, s = 10, open = false) => new THREE.CylinderGeometry(a, b, h, s, 1, open);
  GEO.box = mergeParts([{ geo: Box(0.6, 0.56, 0.56), mat: 0, m: M4(0, 0.28, 0) }]);
  GEO.crate = mergeParts([{ geo: Box(0.9, 0.9, 0.9), mat: 0, m: M4(0, 0.45, 0) }]);
  // counters: cabinet base, overhanging stone top, dark kick strip and door seams on both long sides
  const counter = (L) => {
    const p = [
      { geo: Box(L - 0.04, 0.9, 0.94), mat: 0, m: M4(0, 0.47, 0) },          // cabinet
      { geo: Box(L, 0.08, 1.0), mat: 1, m: M4(0, 0.96, 0) },                 // countertop
      { geo: Box(L - 0.1, 0.06, 0.96), mat: 2, m: M4(0, 0.03, 0) },          // kick strip
    ];
    const doors = Math.round(L / 0.66);
    for (let k = 1; k < doors; k++) for (const z of [-0.472, 0.472]) p.push({ geo: Box(0.015, 0.78, 0.01), mat: 2, m: M4(-L / 2 + (k * L) / doors, 0.5, z) });
    for (const z of [-0.474, 0.474]) p.push({ geo: Box(L - 0.1, 0.015, 0.01), mat: 2, m: M4(0, 0.86, z) });   // drawer line
    return mergeParts(p);
  };
  GEO.longcounter = counter(4.0);
  const Sph = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
  const Cyl2 = (a, b, h, s = 12) => new THREE.CylinderGeometry(a, b, h, s);
  // office desk: wood top, wood pedestal with dark drawer lines, metal handles
  GEO.desk = mergeParts([
    { geo: Box(1.4, 0.05, 0.7), mat: 0, m: M4(0, 0.735, 0) },
    { geo: Box(0.36, 0.71, 0.64), mat: 0, m: M4(-0.5, 0.355, 0) },
    { geo: Box(0.04, 0.71, 0.64), mat: 0, m: M4(0.66, 0.355, 0) },
    { geo: Box(1.12, 0.48, 0.024), mat: 0, m: M4(0.08, 0.45, -0.31) },
    ...[0.18, 0.4, 0.6].map((y) => ({ geo: Box(0.3, 0.012, 0.01), mat: 2, m: M4(-0.5, y + 0.08, 0.322) })),
    ...[0.22, 0.44, 0.64].map((y) => ({ geo: Box(0.1, 0.015, 0.02), mat: 1, m: M4(-0.5, y, 0.33) })),
  ]);
  // swivel chair: black fabric seat + back, metal base / column / arms, little wheels
  GEO.swivelchair = mergeParts([
    ...[0, 1, 2, 3, 4].map((k) => ({ geo: Box(0.3, 0.035, 0.05), mat: 1, m: M4(Math.cos(k * 1.2566) * 0.15, 0.06, -Math.sin(k * 1.2566) * 0.15, 0, k * 1.2566, 0) })),
    ...[0, 1, 2, 3, 4].map((k) => ({ geo: Sph(0.03, 6, 4), mat: 2, m: M4(Math.cos(k * 1.2566) * 0.29, 0.03, -Math.sin(k * 1.2566) * 0.29) })),
    { geo: Cyl2(0.028, 0.028, 0.4, 8), mat: 1, m: M4(0, 0.26, 0) },
    { geo: Box(0.5, 0.09, 0.48), mat: 0, m: M4(0, 0.49, 0) },
    { geo: Box(0.46, 0.56, 0.07), mat: 0, m: M4(0, 0.84, 0.21, -0.08, 0, 0) },
    { geo: Box(0.04, 0.2, 0.04), mat: 1, m: M4(0, 0.6, 0.2) },
    ...[-0.24, 0.24].flatMap((x) => [{ geo: Box(0.05, 0.05, 0.32), mat: 2, m: M4(x, 0.64, 0) }, { geo: Box(0.03, 0.12, 0.03), mat: 1, m: M4(x, 0.57, 0.05) }]),
  ]);
  // monitor: dark plastic shell + stand, lit screen on the front (+z)
  GEO.computer = mergeParts([
    { geo: Box(0.22, 0.024, 0.16), mat: 0, m: M4(0, 0.012, 0) },
    { geo: Box(0.04, 0.18, 0.03), mat: 0, m: M4(0, 0.11, -0.02) },
    { geo: Box(0.58, 0.36, 0.05), mat: 0, m: M4(0, 0.32, 0) },
    { geo: Box(0.54, 0.32, 0.004), mat: 1, m: M4(0, 0.325, 0.026) },
  ]);
  GEO.keyboard = mergeParts([
    { geo: Box(0.44, 0.022, 0.15), mat: 0, m: M4(0, 0.011, 0) },
    { geo: Box(0.42, 0.006, 0.13), mat: 1, m: M4(0, 0.025, 0, 0.06, 0, 0) },
  ]);
  GEO.pencup = mergeParts([
    { geo: Cyl2(0.04, 0.036, 0.1, 12), mat: 0, m: M4(0, 0.05, 0) },
    { geo: Cyl2(0.005, 0.005, 0.16, 6), mat: 1, m: M4(0.012, 0.12, 0.006, 0.12, 0, 0.1) },
    { geo: Cyl2(0.005, 0.005, 0.15, 6), mat: 2, m: M4(-0.014, 0.115, 0.01, -0.08, 0, -0.14) },
    { geo: Cyl2(0.005, 0.005, 0.15, 6), mat: 3, m: M4(0.002, 0.118, -0.014, -0.15, 0, 0.04) },
  ]);
  // couch: fabric body, separate seat cushions and back cushions, dark little feet
  GEO.couch = mergeParts([
    { geo: Box(1.86, 0.3, 0.86), mat: 0, m: M4(0, 0.21, 0) },
    ...[-0.43, 0.43].map((x) => ({ geo: Box(0.85, 0.13, 0.76), mat: 0, m: M4(x, 0.42, -0.05) })),
    { geo: Box(2.0, 0.6, 0.18), mat: 0, m: M4(0, 0.62, 0.36) },
    ...[-0.43, 0.43].map((x) => ({ geo: Box(0.84, 0.36, 0.12), mat: 0, m: M4(x, 0.64, 0.24, -0.12, 0, 0) })),
    ...[-0.93, 0.93].map((x) => ({ geo: Box(0.14, 0.4, 0.9), mat: 0, m: M4(x, 0.42, 0) })),
    ...[[-0.9, -0.38], [0.9, -0.38], [-0.9, 0.38], [0.9, 0.38]].map(([x, z]) => ({ geo: Box(0.06, 0.06, 0.06), mat: 1, m: M4(x, 0.03, z) })),
  ]);
  // potted plant: terracotta pot, dark soil, a bushy clump of leaves
  {
    const p = [{ geo: Cyl2(0.2, 0.15, 0.38, 14), mat: 0, m: M4(0, 0.19, 0) }, { geo: Cyl2(0.215, 0.215, 0.05, 14), mat: 0, m: M4(0, 0.36, 0) }, { geo: Cyl2(0.19, 0.19, 0.02, 14), mat: 1, m: M4(0, 0.387, 0) }];
    const lv = [[0, 0.62, 0, 0.17], [0.13, 0.75, 0.05, 0.15], [-0.12, 0.78, -0.06, 0.15], [0.04, 0.92, -0.08, 0.14], [-0.06, 0.88, 0.12, 0.13], [0.1, 0.55, -0.14, 0.12], [-0.15, 0.58, 0.1, 0.12], [0, 1.0, 0.02, 0.1]];
    for (const [x, y, z, r] of lv) p.push({ geo: Sph(r, 8, 6), mat: 2, m: M4(x, y, z, x * 3, y * 2, z * 4) });
    GEO.plant = mergeParts(p);
  }
  // mobile whiteboard: white board with a writing texture, grey frame, legs and feet
  GEO.whiteboard = mergeParts([
    { geo: Box(1.76, 0.96, 0.03), mat: 0, m: M4(0, 1.35, 0) },
    { geo: Box(1.8, 0.03, 0.05), mat: 1, m: M4(0, 1.85, 0) }, { geo: Box(1.8, 0.03, 0.05), mat: 1, m: M4(0, 0.86, 0) },
    { geo: Box(1.7, 0.02, 0.1), mat: 1, m: M4(0, 0.84, 0.05) },
    ...[-0.86, 0.86].flatMap((x) => [{ geo: Box(0.04, 1.3, 0.04), mat: 1, m: M4(x, 0.65, 0) }, { geo: Box(0.06, 0.05, 0.6), mat: 1, m: M4(x, 0.03, 0) }]),
  ]);
  GEO.shortcounter = counter(2.0);
  // long crate: four crate-sized sections in a row (so the planks aren't stretched) with dark frame bands
  GEO.longcrate = mergeParts([
    ...[-1.5, -0.5, 0.5, 1.5].map((x) => ({ geo: Box(0.98, 1.3, 1.5), mat: 0, m: M4(x, 0.65, 0) })),
    ...[-2.0, -1.0, 0, 1.0, 2.0].map((x) => ({ geo: Box(0.06, 1.34, 1.54), mat: 1, m: M4(x, 0.65, 0) })),
  ]);
  {
    const p = [{ geo: Box(0.44, 0.05, 0.42), mat: 0, m: M4(0, 0.455, 0) }, { geo: Box(0.44, 0.42, 0.04), mat: 0, m: M4(0, 0.71, 0.2) }];
    for (const [x, z] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) p.push({ geo: Cyl(0.018, 0.016, 0.44, 6), mat: 1, m: M4(x, 0.22, z) });
    p.push({ geo: Cyl(0.012, 0.012, 0.36, 6), mat: 1, m: M4(-0.19, 0.08, 0, Math.PI / 2) }, { geo: Cyl(0.012, 0.012, 0.36, 6), mat: 1, m: M4(0.19, 0.08, 0, Math.PI / 2) });
    GEO.chair = mergeParts(p);
  }
  {
    const p = [{ geo: Box(1.24, 0.05, 0.8), mat: 0, m: M4(0, 0.745, 0) }];
    for (const [x, z] of [[-0.55, -0.33], [0.55, -0.33], [-0.55, 0.33], [0.55, 0.33]]) p.push({ geo: Cyl(0.025, 0.022, 0.72, 8), mat: 1, m: M4(x, 0.36, z) });
    p.push({ geo: Box(0.03, 0.04, 0.7), mat: 1, m: M4(-0.55, 0.1, 0) }, { geo: Box(0.03, 0.04, 0.7), mat: 1, m: M4(0.55, 0.1, 0) });
    GEO.table = mergeParts(p);
  }
  {
    const p = [{ geo: Cyl(0.31, 0.31, 0.9, 18, true), mat: 0, m: M4(0, 0.45, 0) }, { geo: new THREE.CircleGeometry(0.31, 18), mat: 1, m: M4(0, 0.9, 0, -Math.PI / 2) }, { geo: new THREE.CircleGeometry(0.31, 18), mat: 1, m: M4(0, 0.0, 0, Math.PI / 2) }];
    for (const y of [0.04, 0.3, 0.6, 0.86]) p.push({ geo: new THREE.TorusGeometry(0.315, 0.018, 4, 18), mat: 1, m: M4(0, y, 0, Math.PI / 2) });
    GEO.barrel = mergeParts(p);
  }
  GEO.mattress = mergeParts([{ geo: Box(2.04, 0.24, 1.04), mat: 0, m: M4(0, 0.12, 0) }, { geo: Box(0.55, 0.09, 0.36), mat: 0, m: M4(0.68, 0.28, 0, 0, 0, 0.05) }]);
  GEO.lamp = mergeParts([
    { geo: Cyl(0.17, 0.17, 0.05, 16), mat: 1, m: M4(0, 0.025, 0) },
    { geo: Cyl(0.018, 0.018, 1.5, 8), mat: 1, m: M4(0, 0.8, 0) },
    { geo: Cyl(0.1, 0.18, 0.24, 16, true), mat: 2, m: M4(0, 1.56, 0) },
    { geo: new THREE.SphereGeometry(0.05, 8, 6), mat: 2, m: M4(0, 1.5, 0) },
  ]);
  GEO.bottle = mergeParts([
    { geo: Cyl(0.048, 0.048, 0.23, 12), mat: 0, m: M4(0, 0.115, 0) },
    { geo: Cyl(0.019, 0.045, 0.07, 12), mat: 0, m: M4(0, 0.265, 0) },
    { geo: Cyl(0.019, 0.019, 0.05, 10), mat: 0, m: M4(0, 0.325, 0) },
    { geo: Cyl(0.022, 0.022, 0.012, 10), mat: 1, m: M4(0, 0.352, 0) },
    { geo: Cyl(0.0485, 0.0485, 0.08, 12, true), mat: 2, m: M4(0, 0.12, 0) },   // paper label
  ]);
  {
    const p = [{ geo: Cyl(0.25, 0.22, 0.64, 16, true), mat: 0, m: M4(0, 0.32, 0) }, { geo: new THREE.CircleGeometry(0.22, 16), mat: 0, m: M4(0, 0.005, 0, -Math.PI / 2) },
      { geo: new THREE.TorusGeometry(0.25, 0.015, 4, 18), mat: 0, m: M4(0, 0.64, 0, Math.PI / 2) },
      { geo: new THREE.CircleGeometry(0.235, 16), mat: 1, m: M4(0, 0.55, 0, -Math.PI / 2) }];                    // garbage inside
    for (const a of [0, 1.6, 3.3]) p.push({ geo: Box(0.12, 0.1, 0.1), mat: 2, m: M4(Math.cos(a) * 0.1, 0.6, Math.sin(a) * 0.1, 0.3, a, 0.2) });
    GEO.trashcan = mergeParts(p);
  }
  {
    // classic folded "oyster pail": tapered box, closed folded top, little tabs and a wire handle
    const pail = Cyl(0.112, 0.085, 0.15, 4); pail.rotateY(Math.PI / 4); pail.scale(1.12, 1, 0.9);
    const lid = Cyl(0.035, 0.112, 0.04, 4); lid.rotateY(Math.PI / 4); lid.scale(1.12, 1, 0.9);
    const tab = Box(0.05, 0.03, 0.004);
    const handle = new THREE.TorusGeometry(0.075, 0.0035, 4, 18, Math.PI);
    GEO.takeout = mergeParts([
      { geo: pail, mat: 0, m: M4(0, 0.075, 0) },
      { geo: lid, mat: 0, m: M4(0, 0.17, 0) },
      { geo: tab, mat: 0, m: M4(0, 0.2, 0.012, 0.25) }, { geo: tab, mat: 0, m: M4(0, 0.2, -0.012, -0.25) },
      { geo: handle, mat: 1, m: M4(0, 0.15, 0) },
    ]);
    GEO.takeout.scale(1.4, 1.4, 1.4);
  }
  {
    // creepy broken baby doll lying on its back (head toward +x): cracked head, sunken dark eyes,
    // one arm torn off (just a stub), a dirty stained dress
    const S = (r, w = 12, h = 10) => new THREE.SphereGeometry(r, w, h);
    const head = S(0.075); head.scale(1, 0.95, 1.05);
    const body = Cyl(0.07, 0.06, 0.24, 12); body.rotateZ(Math.PI / 2); body.scale(1, 0.85, 1.15);
    const leg = Cyl(0.032, 0.026, 0.18, 8); leg.rotateZ(Math.PI / 2);
    const arm = Cyl(0.024, 0.02, 0.14, 8); arm.rotateZ(Math.PI / 2);
    const stub = Cyl(0.026, 0.026, 0.035, 8); stub.rotateX(Math.PI / 2);
    GEO.babydoll = mergeParts([
      { geo: head, mat: 0, m: M4(0.2, 0.075, 0, 0, 0, 0.15) },
      { geo: S(0.016, 8, 6), mat: 2, m: M4(0.24, 0.13, 0.026) }, { geo: S(0.016, 8, 6), mat: 2, m: M4(0.24, 0.128, -0.028) },   // empty eye sockets
      { geo: Box(0.004, 0.005, 0.06), mat: 2, m: M4(0.2, 0.149, 0.0, 0, 0.5, 0.3) },                                           // crack on the head
      { geo: Box(0.004, 0.005, 0.035), mat: 2, m: M4(0.17, 0.142, 0.03, 0, -0.7, 0.4) },
      { geo: body, mat: 1, m: M4(0, 0.055, 0) },
      { geo: Box(0.07, 0.004, 0.06), mat: 3, m: M4(-0.02, 0.105, 0.01, 0, 0.3, 0) },                                            // stain on the dress
      { geo: leg, mat: 0, m: M4(-0.2, 0.035, 0.045, 0, 0.08, 0) }, { geo: leg, mat: 0, m: M4(-0.19, 0.035, -0.05, 0, -0.25, 0) },
      { geo: arm, mat: 0, m: M4(0.06, 0.03, 0.11, 0, -0.5, 0) },
      { geo: stub, mat: 2, m: M4(0.1, 0.06, -0.085) },                                                                         // torn-off arm
    ]);
  }
  return GEO;
}

// list of prop types (index is sent over the network for disguises)
export const PROP_LIST = Object.keys(PROP_TYPES);

let _glow = null;
const GLOW_MAT = () => _glow || (_glow = new THREE.MeshBasicMaterial({ color: 0xffe1a8, side: THREE.DoubleSide }));
function propMaterials(T, type, i = 0) {
  switch (type) {
    case 'box': return [new THREE.MeshLambertMaterial({ map: T.cardboard })];
    case 'crate': return [new THREE.MeshLambertMaterial({ map: T.crate })];
    case 'desk': return [new THREE.MeshLambertMaterial({ map: T.deskWood }), new THREE.MeshLambertMaterial({ color: 0xb8bcc2 }), new THREE.MeshLambertMaterial({ color: 0x3a2a1c })];
    case 'swivelchair': return [new THREE.MeshLambertMaterial({ map: T.fabricDark }), new THREE.MeshLambertMaterial({ map: T.metal, color: 0x9aa0a8 }), new THREE.MeshLambertMaterial({ color: 0x1b1b1d })];
    case 'computer': return [new THREE.MeshLambertMaterial({ map: T.plasticDark }), new THREE.MeshBasicMaterial({ map: T.screen })];
    case 'keyboard': return [new THREE.MeshLambertMaterial({ map: T.plasticDark }), new THREE.MeshLambertMaterial({ map: T.keys })];
    case 'pencup': return [new THREE.MeshLambertMaterial({ map: T.metal, color: 0x6f7c8a }), new THREE.MeshLambertMaterial({ color: 0xe0b020 }), new THREE.MeshLambertMaterial({ color: 0x2050c0 }), new THREE.MeshLambertMaterial({ color: 0xc02a2a })];
    case 'couch': return [new THREE.MeshLambertMaterial({ map: [T.fabricBlue, T.fabricGreen, T.fabricBrown][i % 3] }), new THREE.MeshLambertMaterial({ color: 0x2a1d14 })];
    case 'plant': return [new THREE.MeshLambertMaterial({ map: T.terracotta }), new THREE.MeshLambertMaterial({ color: 0x2e2015 }), new THREE.MeshLambertMaterial({ map: T.leaves })];
    case 'whiteboard': return [new THREE.MeshLambertMaterial({ map: T.whiteboard }), new THREE.MeshLambertMaterial({ map: T.metal, color: 0xc8ccd2 })];
    case 'longcounter': case 'shortcounter': return [new THREE.MeshLambertMaterial({ map: T.wood }), new THREE.MeshLambertMaterial({ color: 0xcfc9bd }), new THREE.MeshLambertMaterial({ color: 0x2a201a })];
    case 'longcrate': return [new THREE.MeshLambertMaterial({ map: T.crate }), new THREE.MeshLambertMaterial({ color: 0x4a3420 })];
    case 'chair': case 'table': return [new THREE.MeshLambertMaterial({ map: T.wood }), new THREE.MeshLambertMaterial({ map: T.metal })];
    case 'barrel': return [new THREE.MeshLambertMaterial({ map: T.barrel }), new THREE.MeshLambertMaterial({ map: T.metal })];
    case 'mattress': return [new THREE.MeshLambertMaterial({ map: T.mattress })];
    case 'lamp': return [new THREE.MeshLambertMaterial({ map: T.metal }), new THREE.MeshLambertMaterial({ color: 0x333333 }), GLOW_MAT()];
    case 'bottle': return [new THREE.MeshLambertMaterial({ color: 0x8a4a16, transparent: true, opacity: 0.9 }), new THREE.MeshLambertMaterial({ color: 0xc9a227 }), new THREE.MeshLambertMaterial({ color: i % 2 ? 0xe8dcc0 : 0xd8c070 })];
    case 'trashcan': return [new THREE.MeshLambertMaterial({ map: T.metal, color: 0x8a8f86, side: THREE.DoubleSide }), new THREE.MeshLambertMaterial({ color: 0x2a2620 }), new THREE.MeshLambertMaterial({ map: T.cardboard })];
    case 'takeout': return [new THREE.MeshLambertMaterial({ map: T.takeout }), new THREE.MeshLambertMaterial({ color: 0x999999 })];
    // grimy pale plastic, a stained old dress, dark empty eyes / cracks
    case 'babydoll': return [new THREE.MeshLambertMaterial({ color: 0xc9b9a0 }), new THREE.MeshLambertMaterial({ color: 0x7d7262 }), new THREE.MeshLambertMaterial({ color: 0x140f0c }), new THREE.MeshLambertMaterial({ color: 0x5a4a3a })];
    default: return [new THREE.MeshLambertMaterial({ color: 0x888888 })];
  }
}

// A prop-team player disguised as furniture: same mesh as the real prop, origin at the feet.
export class DisguiseMesh {
  constructor(T, type) {
    this.type = type;
    this.mats = propMaterials(T, type, 0);
    for (const m of this.mats) m.userData.base = m.color.clone();
    this.mesh = new THREE.Mesh(buildGeometry()[type], this.mats.length > 1 ? this.mats : this.mats[0]);
    this.mats = this.mats.filter((m) => m !== GLOW_MAT());
    let top = 0;
    for (const [, cy, , , hy] of PROP_TYPES[type].parts) top = Math.max(top, cy + hy);
    this.height = top;
  }
  setLight(l) {
    const lum = 0.3 * l[0] + 0.55 * l[1] + 0.15 * l[2];
    const tr = lum * 0.8 + l[0] * 0.2, tg = lum * 0.8 + l[1] * 0.2, tb = lum * 0.8 + l[2] * 0.2;
    for (const m of this.mats) { const b = m.userData.base; m.color.setRGB(b.r * tr, b.g * tg, b.b * tb); }
  }
  dispose() { for (const m of this.mats) m.dispose(); }
}

// collision size of a player disguised as this prop: radius that covers its parts (capped so it
// still fits through doors) and its height
const SHAPES = {};
export function propShape(type) {
  if (SHAPES[type]) return SHAPES[type];
  let r = 0, h = 0;
  for (const [cx, cy, cz, hx, hy, hz, yaw = 0] of PROP_TYPES[type].parts) {
    const ex = yaw ? Math.hypot(hx, hz) : Math.max(hx, hz);
    r = Math.max(r, Math.hypot(cx, cz) + ex);
    h = Math.max(h, cy + hy);
  }
  return (SHAPES[type] = { r: Math.min(0.75, Math.max(0.12, r)), h: Math.max(0.15, h) });
}

// Collision footprint of a prop type (for players disguised as it): circles covering every part's
// real outline, each at its own height band. Long things get a row of circles along their length.
const FOOTS = {};
export function propFoot(type) {
  if (FOOTS[type]) return FOOTS[type];
  const out = [];
  for (const [cx, cy, cz, hx, hy, hz, yaw = 0] of PROP_TYPES[type].parts) {
    const r = Math.max(0.06, Math.min(hx, hz)), long = Math.max(hx, hz), alongX = hx >= hz;
    const n = long > r + 1e-3 ? Math.min(12, Math.ceil((2 * (long - r)) / r) + 1) : 1;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0 : -(long - r) + (2 * (long - r) * k) / (n - 1);
      const lx = alongX ? t : 0, lz = alongX ? 0 : t;
      const f = { x: cx + lx * c + lz * s, z: cz - lx * s + lz * c, r, y0: cy - hy, y1: cy + hy };
      // skip circles already covered by a bigger one at the same height
      if (out.some((o) => Math.hypot(o.x - f.x, o.z - f.z) + f.r <= o.r + 1e-3 && o.y0 <= f.y0 + 0.02 && o.y1 >= f.y1 - 0.02)) continue;
      out.push(f);
    }
  }
  return (FOOTS[type] = out);
}

// height of a prop type (camera / hit tests for disguised players)
export function propHeight(type) {
  let top = 0;
  for (const [, cy, , , hy] of PROP_TYPES[type].parts) top = Math.max(top, cy + hy);
  return top;
}

// Ray vs. a prop shape standing upright at (x,y,z) turned by yaw. Returns distance or -1.
export function rayVsPropShape(type, x, y, z, yaw, ox, oy, oz, dx, dy, dz, pad = 0) {
  const def = PROP_TYPES[type];
  if (!def) return -1;
  let best = -1;
  const c = Math.cos(-yaw), s = Math.sin(-yaw);
  // into the prop's own space (yaw only)
  const lx = ox - x, lz = oz - z;
  const o0 = { x: lx * c + lz * s, y: oy - y, z: -lx * s + lz * c };
  const d0 = { x: dx * c + dz * s, y: dy, z: -dx * s + dz * c };
  for (const [cx, cy, cz, hx, hy, hz, py = 0] of def.parts) {
    const pc = Math.cos(-py), ps = Math.sin(-py);
    const ax = o0.x - cx, az = o0.z - cz;
    const o = { x: ax * pc + az * ps, y: o0.y - cy, z: -ax * ps + az * pc };
    const d = { x: d0.x * pc + d0.z * ps, y: d0.y, z: -d0.x * ps + d0.z * pc };
    const t = slab(o, d, { x: hx + pad, y: hy + pad, z: hz + pad });
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

// =====================================================================
export class PropSystem {
  constructor(map, root, T, isHost) {
    this.map = map;
    this.root = root;
    this.isHost = isHost;
    this.list = [];
    this.lastSent = new Map();
    this.fullT = 0;
    this.events = [];
    const G = buildGeometry();
    this.T = T;
    const glowMat = GLOW_MAT();
    const matsFor = (type, i) => propMaterials(T, type, i);
    // the shape data (center of mass, parts, contact points, inertia) only depends on the type: build it once
    const typeData = new Map();
    const shapeOf = (type) => {
      if (typeData.has(type)) return typeData.get(type);
      const def = PROP_TYPES[type];
      // parts relative to the center of mass
      let vol = 0; const com = new V();
      for (const [cx, cy, cz, hx, hy, hz] of def.parts) { const v = hx * hy * hz; vol += v; com.x += cx * v; com.y += cy * v; com.z += cz * v; }
      com.multiplyScalar(1 / vol);
      const parts = def.parts.map(([cx, cy, cz, hx, hy, hz, yaw = 0]) => {
        const q = new Q().setFromAxisAngle(new V(0, 1, 0), yaw);
        return { c: new V(cx - com.x, cy - com.y, cz - com.z), h: new V(hx, hy, hz), q, qi: q.clone().invert() };
      });
      // contact points of every part: corners, points along each edge (max 0.16 m apart) and face centers,
      // so thin things (lamp poles, mattress edges) can't slide through other props
      const corners = [];
      let mx = 0, my = 0, mz = 0;
      for (const pt of parts) {
        const local = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) local.push([sx, sy, sz]);
        const h = pt.h;
        for (const [ax, la] of [['x', h.x], ['y', h.y], ['z', h.z]]) {
          const n = Math.ceil((2 * la) / 0.16);
          for (let k = 1; k < n; k++) {
            const t = -1 + (2 * k) / n;
            for (const a of [-1, 1]) for (const b2 of [-1, 1]) {
              if (ax === 'x') local.push([t, a, b2]); else if (ax === 'y') local.push([a, t, b2]); else local.push([a, b2, t]);
            }
          }
        }
        for (const f of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) local.push(f);
        for (const [sx, sy, sz] of local) {
          const c = new V(sx * h.x, sy * h.y, sz * h.z).applyQuaternion(pt.q).add(pt.c);
          corners.push(c);
          mx = Math.max(mx, Math.abs(c.x)); my = Math.max(my, Math.abs(c.y)); mz = Math.max(mz, Math.abs(c.z));
        }
      }
      const m = def.mass;
      const dx = 2 * mx, dy = 2 * my, dz = 2 * mz;
      const invI = new V(12 / (m * (dy * dy + dz * dz)), 12 / (m * (dx * dx + dz * dz)), 12 / (m * (dx * dx + dy * dy)));
      const out = { com, parts, corners, invI };
      typeData.set(type, out);
      return out;
    };
    map.propSpawns.forEach((s, id) => {
      const def = PROP_TYPES[s.type];
      const { com, parts, corners, invI } = shapeOf(s.type);
      const m = def.mass;
      const mats = matsFor(s.type, id);
      for (const mm of mats) mm.userData.base = mm.color.clone();
      const group = new THREE.Group();
      const inner = new THREE.Mesh(G[s.type], mats.length > 1 ? mats : mats[0]);
      inner.position.copy(com).multiplyScalar(-1);
      group.add(inner);
      root.add(group);
      // starting pose: yaw (+ lying on its side if tipped), resting on the floor
      const quat = new Q().setFromAxisAngle(new V(0, 1, 0), s.yaw);
      if (s.tip) quat.multiply(new Q().setFromAxisAngle(new V(0, 0, 1), s.type === 'bottle' || s.tipAxis ? Math.PI / 2 : Math.PI / 2 * (id % 2 ? 1 : -1)));
      let minY = Infinity;
      for (const c of corners) minY = Math.min(minY, t1.copy(c).applyQuaternion(quat).y);
      // rest on the floor, or on top of props spawned earlier in the same spot (piles / stacks)
      const under = Math.max(0, this.topAt(s.x, s.z, 0.25, 3));
      const pos = new V(s.x, under - minY + 0.002, s.z);
      const p = {
        id, type: s.type, def, mass: m, invMass: 1 / m, invI, com, parts, corners, mu: def.mu,
        bound: Math.max(...corners.map((c) => c.length())),
        pos, quat, vel: new V(), ang: new V(),
        home: { pos: pos.clone(), quat: quat.clone() },
        sleepT: 0, asleep: true, mesh: group, mats: mats.filter((mm) => mm !== glowMat),
        rpos: pos.clone(), rquat: quat.clone(), lightT: 0, light: [1, 1, 1],
        x: 0, y: 0, z: 0, r: 0, h: 0, top: 0,
      };
      this.updateBounds(p);
      this.list.push(p);
    });
    map.propSys = this;
    map.props = this.list;
  }

  // free the per-prop materials when the game ends (geometry is shared and kept)
  dispose() {
    for (const p of this.list) { this.root.remove(p.mesh); for (const m of p.mats) m.dispose(); }
    this.list = [];
    if (this.map.propSys === this) { this.map.propSys = null; this.map.props = []; }
  }

  // keep simple fields used elsewhere: x/z center, y bottom, top, h, r (horizontal reach)
  updateBounds(p) {
    let lo = Infinity, hi = -Infinity, rr = 0;
    for (const c of p.corners) {
      t1.copy(c).applyQuaternion(p.quat);
      lo = Math.min(lo, t1.y); hi = Math.max(hi, t1.y);
      rr = Math.max(rr, Math.hypot(t1.x, t1.z));
    }
    p.x = p.pos.x; p.z = p.pos.z; p.y = p.pos.y + lo; p.top = p.pos.y + hi; p.h = hi - lo; p.r = rr;
  }

  reset() {
    for (const p of this.list) {
      p.removed = false;
      p.pos.copy(p.home.pos); p.quat.copy(p.home.quat); p.vel.set(0, 0, 0); p.ang.set(0, 0, 0);
      p.asleep = true; p.sleepT = 0; p.rpos.copy(p.pos); p.rquat.copy(p.quat); p.lightT = 0;
      this.updateBounds(p);
    }
    this.fullT = 0;
  }

  // Each new round a random 10-35% of the furniture is taken away (dropped far under the map, where nothing
  // can touch it), so the rooms change a little and there are new hiding spots. Positions reach the
  // players through the normal prop sync. Whatever was resting on a removed piece falls down.
  removeRandom(minFrac = 0.01, maxFrac = 0.1) {
    const N = this.list.length, lo = Math.ceil(N * minFrac), hi = Math.floor(N * maxFrac);   // never outside the range
    const n = Math.max(1, Math.min(hi, Math.max(lo, Math.round(N * (minFrac + Math.random() * (maxFrac - minFrac))))));
    const pool = this.list.slice();
    for (let k = 0; k < n && pool.length; k++) {
      const p = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      for (const q of this.list) {
        if (q === p || q.removed || Math.abs(q.y - p.top) > 0.15) continue;
        const reach = p.r + q.r;
        if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < reach * reach) this.wake(q);
      }
      p.removed = true; p.asleep = true; p.vel.set(0, 0, 0); p.ang.set(0, 0, 0);
      p.pos.set(p.home.pos.x, -60, p.home.pos.z);
      this.updateBounds(p);
    }
    this.fullT = 0;
    return n;
  }

  // ---------------- math helpers ----------------
  wake(p) { if (p.removed) return; p.asleep = false; p.sleepT = 0; }
  invIWorld(p, v, out) {
    tq.copy(p.quat).invert();
    out.copy(v).applyQuaternion(tq);
    out.x *= p.invI.x; out.y *= p.invI.y; out.z *= p.invI.z;
    return out.applyQuaternion(p.quat);
  }
  pointVel(p, r, out) { return out.crossVectors(p.ang, r).add(p.vel); }
  applyImpulse(p, r, J) {
    p.vel.addScaledVector(J, p.invMass);
    p.ang.add(this.invIWorld(p, t6.crossVectors(r, J), t5));
  }
  // effective inverse mass along direction n at offset r
  kAlong(p, r, n) {
    const rxn = t5.crossVectors(r, n);
    const w = this.invIWorld(p, rxn, t6);
    return p.invMass + n.dot(t5.crossVectors(w, r));
  }
  toPartLocal(p, part, w, out) {
    tq.copy(p.quat).invert();
    out.copy(w).sub(p.pos).applyQuaternion(tq).sub(part.c).applyQuaternion(part.qi);
    return out;
  }
  fromPartLocal(p, part, l, out) { return out.copy(l).applyQuaternion(part.q).add(part.c).applyQuaternion(p.quat).add(p.pos); }

  // Push a prop (bullets, knives, explosions) at a world point
  impulseAt(p, point, J) {
    this.applyImpulse(p, t3.copy(point).sub(p.pos), J);
    this.wake(p);
  }
  // old API: push at the center (+ spin)
  impulse(p, ix, iy, iz, spin = 0) {
    p.vel.x += ix * p.invMass; p.vel.y += iy * p.invMass; p.vel.z += iz * p.invMass;
    p.ang.y += spin * p.invMass;
    this.wake(p);
  }

  // ---------------- contacts ----------------
  // n points out of the obstacle toward body a. b may be null (world).
  contact(a, b, w, n, depth) {
    // a resting (asleep) prop acts like solid ground until it gets hit hard enough to wake up
    const bStatic = !b || b.asleep;
    const ra = t1.copy(w).sub(a.pos);
    const rb = b ? t2.copy(w).sub(b.pos) : null;
    const va = this.pointVel(a, ra, t3);
    if (b && !bStatic) va.sub(this.pointVel(b, rb, t4));
    const vn = va.dot(n);
    const ia = a.invMass, ib = bStatic ? 0 : b.invMass;
    const corr = Math.min(depth, 0.2) * 0.35;
    a.pos.addScaledVector(n, corr * ia / (ia + ib));
    if (!bStatic) b.pos.addScaledVector(n, -corr * ib / (ia + ib));
    if (vn >= 0) return;
    if (vn < -2.6) this.events.push({ p: a, s: -vn });
    // a hard hit from the side wakes the other prop (things landing ON TOP of it don't knock it loose)
    if (b && b.asleep && vn < -2.5 && Math.abs(n.y) < 0.7) this.wake(b);
    const kn = this.kAlong(a, ra, n) + (bStatic ? 0 : this.kAlong(b, rb, n));
    const e = vn < -2 ? 0.2 : 0;
    const j = (-(1 + e) * vn) / kn;
    const J = t4.copy(n).multiplyScalar(j);
    this.applyImpulse(a, ra, J);
    if (!bStatic) { J.multiplyScalar(-1); this.applyImpulse(b, rb, J); }
    // friction
    const vb = this.pointVel(a, ra, new V());
    if (!bStatic) vb.sub(this.pointVel(b, rb, new V()));
    const vt = vb.addScaledVector(n, -vb.dot(n));
    const lt = vt.length();
    if (lt > 1e-5) {
      vt.multiplyScalar(1 / lt);
      const kt = this.kAlong(a, ra, vt) + (bStatic ? 0 : this.kAlong(b, rb, vt));
      const jt = Math.min(lt / kt, a.mu * j);
      const Jt = vt.multiplyScalar(-jt);
      this.applyImpulse(a, ra, Jt);
      if (!bStatic) { Jt.multiplyScalar(-1); this.applyImpulse(b, rb, Jt); }
    }
  }

  collideWorld(p) {
    const map = this.map;
    const w = new V(), n = new V();
    let touching = false;
    for (const c of p.corners) {
      w.copy(c).applyQuaternion(p.quat).add(p.pos);
      const cx = Math.floor(w.x / CELL), cz = Math.floor(w.z / CELL);
      const H = map.cellHeight(cx, cz);
      if (w.y < H) {
        if (H < WALL_H && H - w.y < 0.3) { n.set(0, 1, 0); this.contact(p, null, w, n, H - w.y); touching = true; continue; }
        // pushed sideways out of a wall / furniture block, toward the nearest open side
        const opts = [
          [w.x - cx * CELL, -1, 0, map.cellHeight(cx - 1, cz)], [(cx + 1) * CELL - w.x, 1, 0, map.cellHeight(cx + 1, cz)],
          [w.z - cz * CELL, 0, -1, map.cellHeight(cx, cz - 1)], [(cz + 1) * CELL - w.z, 0, 1, map.cellHeight(cx, cz + 1)],
        ].filter((o) => o[3] < H).sort((a, b) => a[0] - b[0]);
        if (opts.length) { n.set(opts[0][1], 0, opts[0][2]); this.contact(p, null, w, n, opts[0][0]); touching = true; }
      } else if (w.y < 0) { n.set(0, 1, 0); this.contact(p, null, w, n, -w.y); touching = true; }
      if (w.y > CEIL_H && !map.isOutdoorCell(cx, cz)) { n.set(0, -1, 0); this.contact(p, null, w, n, w.y - CEIL_H); }
    }
    return touching;
  }

  // contact points of a inside parts of b.
  // flip = true: a is resting, so push b (the moving one) out instead of a.
  collidePair(a, b, flip = false) {
    const w = new V(), l = new V(), n = new V();
    for (const c of a.corners) {
      w.copy(c).applyQuaternion(a.quat).add(a.pos);
      if (w.distanceToSquared(b.pos) > b.bound * b.bound) continue;
      for (const part of b.parts) {
        this.toPartLocal(b, part, w, l);
        const px = part.h.x - Math.abs(l.x), py = part.h.y - Math.abs(l.y), pz = part.h.z - Math.abs(l.z);
        if (px <= 0 || py <= 0 || pz <= 0) continue;
        if (px < py && px < pz) n.set(Math.sign(l.x) || 1, 0, 0);
        else if (py < pz) n.set(0, Math.sign(l.y) || 1, 0);
        else n.set(0, 0, Math.sign(l.z) || 1);
        n.applyQuaternion(part.q).applyQuaternion(b.quat);
        if (flip) { n.multiplyScalar(-1); this.contact(b, a, w, n, Math.min(px, py, pz)); }
        else this.contact(a, b, w, n, Math.min(px, py, pz));
      }
    }
  }

  // ---------------- people vs props ----------------
  // Keeps a character out of props. soft = 0..1 how much of the overlap moves the character.
  // With push=true (host) the character shoves the prop (impulse at the contact point -> it can tip over).
  collideChar(ch, soft, push, dt = 1 / 60) {
    const H = ch.shapeH || P.HEIGHT;
    const s = t1, l = t2, q = t3;
    // every circle of the body's footprint (T-posed arms, every part of a disguise) collides
    const circles = footWorld(ch, ch.x, ch.z, this._foot || (this._foot = []));
    let span = 0; for (const f of circles) span = Math.max(span, Math.hypot(f.x - ch.x, f.z - ch.z) + f.r);
    for (const p of this.list) {
      const dx = p.pos.x - ch.x, dz = p.pos.z - ch.z;
      const reach = p.bound + span + 0.1;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (ch.y > p.top - 0.02 || ch.y + H < p.y) continue;
      // low things (bottles, food boxes, mattresses) are walked over and kicked, not blocking
      // walking onto something very low (a mattress) is a small step up, not a wall
      if (ch.onGround && p.top - ch.y <= P.WALK_STEP + 0.01 && p.mass >= 0.6) continue;
      const low = p.mass < 0.6; // tiny things (bottles, takeout boxes) get kicked; everything else blocks and is pushed
      const samples = low ? KICK_SAMPLES : CHAR_SAMPLES;
      let best = 0, nx = 0, nz = 0;
      const bq = new V();
      for (const fc of circles) for (const part of p.parts) {
        const R = fc.r;
        // sample heights inside this circle's band (always at least its middle)
        const hsList = samples.filter((h) => h <= H && h >= fc.y0 - 1e-3 && h <= fc.y1 + 1e-3);
        if (!hsList.length) hsList.push((fc.y0 + fc.y1) / 2);
        for (const hs of hsList) {
          s.set(fc.x, ch.y + hs, fc.z);
          this.toPartLocal(p, part, s, l);
          const inside = Math.abs(l.x) < part.h.x && Math.abs(l.y) < part.h.y && Math.abs(l.z) < part.h.z;
          l.set(Math.max(-part.h.x, Math.min(part.h.x, l.x)), Math.max(-part.h.y, Math.min(part.h.y, l.y)), Math.max(-part.h.z, Math.min(part.h.z, l.z)));
          this.fromPartLocal(p, part, l, q);
          if (Math.abs(s.y - q.y) > 0.04) continue; // above / below this part
          let hx = s.x - q.x, hz = s.z - q.z, dh = Math.hypot(hx, hz);
          let pen;
          if (inside || dh < 1e-4) { hx = fc.x - p.pos.x; hz = fc.z - p.pos.z; dh = Math.hypot(hx, hz) || 1; pen = R * 0.6; }
          else pen = R - dh;
          if (pen > best) { best = pen; nx = hx / dh; nz = hz / dh; bq.copy(q); }
        }
      }
      if (best <= 0) continue;
      // speed going into the prop (before the bump slows you down)
      const into = -((ch.vx || 0) * nx + (ch.vz || 0) * nz);
      if (!low) {
        // pushing into a piece of furniture: a prop can climb it like a wall
        if (into > 0.2 || best > 0.02) ch.climbT = 0.2;
        ch.x += nx * best * soft; ch.z += nz * best * soft;
        // bumping into furniture takes some of your speed (it goes into pushing it instead)
        if (soft > 0 && into > 0) { ch.vx += nx * into * 0.55; ch.vz += nz * into * 0.55; }
      }
      if (push) {
        const dir = t4.set(-nx, 0, -nz);
        // push point pulled a bit toward the center of mass: tall things still tip, tables mostly slide
        const r = new V().copy(bq).sub(p.pos);
        r.y *= 0.55;
        const vp = this.pointVel(p, r, new V()).dot(dir);
        const chv = Math.max(0, into);
        const want = low ? Math.min(chv * 1.2, 6) + best * 4 : Math.min(chv * 1.05, 5) + best * 6;
        if (vp < want) {
          const k = this.kAlong(p, r, dir);
          // steady pushing is limited, but a running/jumping body slam transfers its momentum
          const j = Math.min((want - vp) / k, Math.max(55 * dt, into * CHAR_MASS * 0.45));
          this.applyImpulse(p, r, dir.multiplyScalar(j));
          this.wake(p);
        }
      }
    }
  }

  // Highest prop surface under a circle (for standing on props), not above maxY
  topAt(x, z, r, maxY) {
    let best = -Infinity;
    const o = new V(), d = new V(0, -1, 0), lo = new V(), ld = new V();
    for (const p of this.list) {
      if (p.top < -1 || p.y > maxY) continue;
      const dx = p.pos.x - x, dz = p.pos.z - z, reach = p.r + r;
      if (dx * dx + dz * dz > reach * reach) continue;
      for (const [ox, oz] of [[0, 0], [r * 0.7, 0], [-r * 0.7, 0], [0, r * 0.7], [0, -r * 0.7]]) {
        o.set(x + ox, maxY + 0.01, z + oz);
        for (const part of p.parts) {
          this.toPartLocal(p, part, o, lo);
          ld.copy(d).applyQuaternion(tq2.copy(p.quat).invert()).applyQuaternion(part.qi);
          const t = slab(lo, ld, part.h);
          if (t > 0 && t < 4) best = Math.max(best, o.y - t);
        }
      }
    }
    return best;
  }

  // Ray vs every part box. Returns {prop, t, point} of the nearest hit or null.
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    let best = null, bt = maxT, bestN = null, bestPart = null, bestAxis = null;
    const o = new V(ox, oy, oz), d = new V(dx, dy, dz), lo = new V(), ld = new V();
    for (const p of this.list) {
      // bounding sphere test
      const cx = p.pos.x - ox, cy = p.pos.y - oy, cz = p.pos.z - oz;
      const tc = cx * dx + cy * dy + cz * dz;
      if (tc < -p.bound || tc > bt + p.bound) continue;
      if (cx * cx + cy * cy + cz * cz - tc * tc > p.bound * p.bound) continue;
      for (const part of p.parts) {
        this.toPartLocal(p, part, o, lo);
        ld.copy(d).applyQuaternion(tq2.copy(p.quat).invert()).applyQuaternion(part.qi);
        const t = slab(lo, ld, part.h);
        if (t >= 0 && t < bt) {
          bt = t; best = p;
          // which face of the part was hit -> surface normal (for bullet holes / blood on furniture)
          const hx = (lo.x + ld.x * t) / part.h.x, hy = (lo.y + ld.y * t) / part.h.y, hz = (lo.z + ld.z * t) / part.h.z;
          const ax = Math.abs(hx), ay = Math.abs(hy), az = Math.abs(hz);
          bestN = ax >= ay && ax >= az ? new V(Math.sign(hx), 0, 0) : ay >= az ? new V(0, Math.sign(hy), 0) : new V(0, 0, Math.sign(hz));
          bestPart = part; bestAxis = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';
          bestN.applyQuaternion(part.q).applyQuaternion(p.quat);
        }
      }
    }
    return best ? { prop: best, t: bt, point: new V(ox + dx * bt, oy + dy * bt, oz + dz * bt), normal: bestN, part: bestPart, axis: bestAxis } : null;
  }

  // Ragdoll joints: push a sphere out of any prop part. Returns true if it rests on top of something.
  pushPoint(q, rad) {
    const w = new V(q.x, q.y, q.z), l = new V(), n = new V();
    let onTop = false;
    for (const p of this.list) {
      if (w.distanceToSquared(p.pos) > (p.bound + rad) ** 2) continue;
      for (const part of p.parts) {
        this.toPartLocal(p, part, w, l);
        const px = part.h.x + rad - Math.abs(l.x), py = part.h.y + rad - Math.abs(l.y), pz = part.h.z + rad - Math.abs(l.z);
        if (px <= 0 || py <= 0 || pz <= 0) continue;
        if (px < py && px < pz) { n.set(Math.sign(l.x) || 1, 0, 0); l.x += n.x * px; }
        else if (py < pz) { n.set(0, Math.sign(l.y) || 1, 0); l.y += n.y * py; }
        else { n.set(0, 0, Math.sign(l.z) || 1); l.z += n.z * pz; }
        this.fromPartLocal(p, part, l, w);
        n.applyQuaternion(part.q).applyQuaternion(p.quat);
        if (n.y > 0.6) onTop = true;
      }
    }
    q.x = w.x; q.y = w.y; q.z = w.z;
    return onTop;
  }

  // ---------------- host simulation ----------------
  step(dt, chars) {
    for (const c of chars) if (c.alive) this.collideChar(c, c.isBot ? 0.6 : 0, true, dt);
    const awake = this.list.filter((p) => !p.asleep);
    if (!awake.length) return;
    const N = 3, h = Math.min(dt, 1 / 30) / N;
    for (let s = 0; s < N; s++) {
      for (const p of awake) {
        p.vel.y -= GRAV * h;
        p.pos.addScaledVector(p.vel, h);
        tq.set(p.ang.x * h * 0.5, p.ang.y * h * 0.5, p.ang.z * h * 0.5, 0).multiply(p.quat);
        p.quat.x += tq.x; p.quat.y += tq.y; p.quat.z += tq.z; p.quat.w += tq.w; p.quat.normalize();
      }
      for (let it = 0; it < 2; it++) {
        for (const p of awake) {
          p.touching = this.collideWorld(p) || p.touching;
          for (const o of this.list) {
            if (o === p) continue;
            const dd = p.bound + o.bound;
            if (p.pos.distanceToSquared(o.pos) > dd * dd) continue;
            this.collidePair(p, o);
            if (o.asleep) this.collidePair(o, p, true);
          }
        }
      }
      for (const p of awake) {
        p.vel.multiplyScalar(Math.exp(-0.05 * h));
        p.ang.multiplyScalar(Math.exp(-(p.touching ? 1.6 : 0.3) * h));
        if (p.vel.lengthSq() > 625) p.vel.setLength(25);
        if (p.ang.lengthSq() > 400) p.ang.setLength(20);
        p.touching = false;
      }
    }
    for (const p of awake) {
      const oldTop = p.top, ox = p.x, oz = p.z;
      this.updateBounds(p);
      // anything that was resting on this prop wakes up when it moves (so it falls instead of floating)
      if (p.vel.lengthSq() > 0.0004 || p.ang.lengthSq() > 0.001) {
        for (const q of this.list) {
          if (!q.asleep || q === p || Math.abs(q.y - oldTop) > 0.15) continue;
          const reach = p.r + q.r;
          if ((q.x - ox) ** 2 + (q.z - oz) ** 2 < reach * reach) this.wake(q);
        }
      }
      if (p.vel.lengthSq() < 0.012 && p.ang.lengthSq() < 0.03) p.sleepT += dt; else p.sleepT = 0;
      if (p.sleepT > 0.6 || p.pos.y < -10) {
        p.asleep = true; p.vel.set(0, 0, 0); p.ang.set(0, 0, 0);
        if (p.pos.y < -10) { p.pos.copy(p.home.pos); p.quat.copy(p.home.quat); this.updateBounds(p); }
      }
    }
  }

  // ---------------- network ----------------
  snapshot(dt) {
    this.fullT -= dt;
    const full = this.fullT <= 0;
    if (full) this.fullT = 2;
    const out = [];
    for (const p of this.list) {
      const last = this.lastSent.get(p.id);
      if (!full && last && last.pos.distanceToSquared(p.pos) < 1e-4 && Math.abs(last.quat.dot(p.quat)) > 0.99995) continue;
      this.lastSent.set(p.id, { pos: p.pos.clone(), quat: p.quat.clone() });
      out.push(this.stateOf(p));
    }
    return out;
  }
  stateOf(p) { return [p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r3(p.quat.x), r3(p.quat.y), r3(p.quat.z), r3(p.quat.w)]; }
  fullState() { return this.list.map((p) => this.stateOf(p)); }
  applyState(arr) {
    for (const s of arr) {
      const p = this.list[s[0]];
      if (!p || s.length < 8) continue;
      p.pos.set(s[1], s[2], s[3]); p.quat.set(s[4], s[5], s[6], s[7]).normalize();
      this.updateBounds(p);
    }
  }

  // ---------------- rendering ----------------
  render(dt, lampsDynamic) {
    const k = this.isHost ? 1 : Math.min(1, dt * 14);
    for (const p of this.list) {
      if (p.rpos.distanceToSquared(p.pos) > 9) { p.rpos.copy(p.pos); p.rquat.copy(p.quat); }
      p.rpos.lerp(p.pos, k); p.rquat.slerp(p.quat, k);
      p.mesh.position.copy(p.rpos); p.mesh.quaternion.copy(p.rquat);
      p.mesh.visible = p.pos.y > -20;                    // taken away this round
      p.lightT -= dt;
      if (p.lightT <= 0) {
        p.lightT = 0.4 + Math.random() * 0.3;
        this.map.probe(p.rpos.x, p.rpos.z, !lampsDynamic, p.light);
        const lum = 0.3 * p.light[0] + 0.55 * p.light[1] + 0.15 * p.light[2];
        const tr = lum * 0.8 + p.light[0] * 0.2, tg = lum * 0.8 + p.light[1] * 0.2, tb = lum * 0.8 + p.light[2] * 0.2;
        for (const m of p.mats) { const b = m.userData.base; m.color.setRGB(b.r * tr, b.g * tg, b.b * tb); }
      }
    }
  }
}

// ray (origin o, dir d, in box-local space) vs box of half size h: entry distance or -1
function slab(o, d, h) {
  let tmin = -Infinity, tmax = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    if (Math.abs(d[ax]) < 1e-9) { if (Math.abs(o[ax]) > h[ax]) return -1; continue; }
    let ta = (-h[ax] - o[ax]) / d[ax], tb = (h[ax] - o[ax]) / d[ax];
    if (ta > tb) [ta, tb] = [tb, ta];
    tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  return tmin < 0 ? 0 : tmin;
}
