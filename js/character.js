// =====================================================================
//  CHARACTER.JS — humanoid character: shaped low-poly body (lathe torso,
//  tapered limbs), big head with a face made of shapes (eyes, brows,
//  mouth), hairstyles, clothing
//  types, procedural walk/run/jump/weapon animation, first-person arms.
//
//  Facing: the model looks toward -Z when yaw = 0. Right hand is +X.
//  Every body segment has a "vis" group so ragdolls can clone it.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js?v=500';
import { CONFIG } from './config.js?v=500';


const L = CONFIG.LOOKS;
export const FACES = L.FACES;
export const WHITE_SKIN = L.SKINS[0];
// old saved looks -> new choices
const SHIRT_MAP = { longsleeve: 'sweater', hoodie: 'sweater', jacket: 'sweater', polo: 'dressshirt', buttonup: 'dressshirt', tank: 'tshirt' };
const pickR = (a, rng = Math.random) => a[Math.floor(rng() * a.length)];

export const DEFAULT_LOOK = {
  hair: 'short', hairColor: 0x3b2716, face: 'smile', skin: WHITE_SKIN,
  shirt: 'tshirt', shirtColor: 0x2f6fd8, pants: 'jeans', pantsColor: 0x2c3e66,
  acc: 'none', accColor: 0x2f8a3a,
};
export function randomLook(rng = Math.random) {
  return {
    hair: pickR(L.HAIR, rng), hairColor: pickR(L.HAIR_COLORS.slice(0, 6), rng), face: pickR(FACES, rng), skin: pickR(L.SKINS, rng),
    shirt: pickR(L.SHIRTS, rng), shirtColor: pickR(L.SHIRT_COLORS, rng), pants: pickR(L.PANTS, rng), pantsColor: pickR(L.PANTS_COLORS, rng),
    acc: rng() < 0.8 ? 'none' : 'cap', accColor: pickR(L.ACC_COLORS, rng),
  };
}
// Validate a look received over the network
export function sanitizeLook(l) {
  l = l || {};
  const col = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : d);
  const oldCap = l.hair === 'cap';         // the cap used to be a hairstyle: now it's an accessory
  return {
    hair: L.HAIR.includes(l.hair) ? l.hair : DEFAULT_LOOK.hair,
    hairColor: col(l.hairColor, DEFAULT_LOOK.hairColor),
    face: FACES.includes(l.face) ? l.face : DEFAULT_LOOK.face,
    skin: col(l.skin, DEFAULT_LOOK.skin),
    shirt: L.SHIRTS.includes(l.shirt) ? l.shirt : (SHIRT_MAP[l.shirt] || DEFAULT_LOOK.shirt),
    shirtColor: col(l.shirtColor, DEFAULT_LOOK.shirtColor),
    pants: L.PANTS.includes(l.pants) ? l.pants : DEFAULT_LOOK.pants,
    pantsColor: col(l.pantsColor, DEFAULT_LOOK.pantsColor),
    acc: L.ACCESSORIES.includes(l.acc) ? l.acc : oldCap ? 'cap' : DEFAULT_LOOK.acc,
    accColor: col(l.accColor, oldCap ? col(l.hairColor, DEFAULT_LOOK.accColor) : DEFAULT_LOOK.accColor),
  };
}

// ---------------- shared geometries ----------------
let G = null;
const v2 = (pts) => pts.map(([r, y]) => new THREE.Vector2(r, y));
function down(geo, len) { geo.translate(0, -len / 2, 0); return geo; }
function geos() {
  if (G) return G;
  G = {};
  // torso is a bit wider/deeper so the legs never stick out past the hips
  G.torso = new THREE.LatheGeometry(v2([[0.001, -0.03], [0.15, -0.02], [0.168, 0.05], [0.16, 0.17], [0.168, 0.29], [0.188, 0.4], [0.204, 0.47], [0.184, 0.535], [0.13, 0.578], [0.058, 0.6], [0.001, 0.6]]), 18);
  G.torso.scale(1, 1, 0.74);
  G.pelvis = new THREE.LatheGeometry(v2([[0.001, -0.15], [0.12, -0.145], [0.16, -0.07], [0.168, 0.0], [0.16, 0.05], [0.001, 0.05]]), 18);
  G.pelvis.scale(1, 1, 0.78);
  G.neck = new THREE.CylinderGeometry(0.052, 0.058, 0.12, 10); G.neck.translate(0, 0.585, 0);
  G.head = new THREE.SphereGeometry(0.155, 24, 16); G.head.scale(0.94, 1.08, 1.0); G.head.translate(0, 0.15, 0);
  // face parts (shapes, no textures)
  G.eye = new THREE.SphereGeometry(0.03, 12, 10);
  G.pupil = new THREE.SphereGeometry(0.016, 10, 8);
  G.lid = new THREE.SphereGeometry(0.033, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  G.brow = new THREE.BoxGeometry(0.05, 0.012, 0.014);
  G.mouthArc = new THREE.TorusGeometry(0.034, 0.008, 6, 14, Math.PI);
  G.mouthLine = new THREE.BoxGeometry(0.05, 0.01, 0.012);
  G.mouthO = new THREE.TorusGeometry(0.016, 0.007, 6, 14);
  G.mouthOpen = new THREE.CircleGeometry(0.036, 16, Math.PI, Math.PI);
  G.shoulder = new THREE.SphereGeometry(0.066, 10, 8);
  G.upperArm = down(new THREE.CylinderGeometry(0.06, 0.052, 0.29, 10), 0.29);
  G.sleeveShort = down(new THREE.CylinderGeometry(0.066, 0.06, 0.16, 10), 0.16);
  G.elbow = new THREE.SphereGeometry(0.049, 8, 6);
  G.foreArm = down(new THREE.CylinderGeometry(0.048, 0.038, 0.25, 10), 0.25);
  G.cuff = down(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 10), 0.04); G.cuff.translate(0, -0.22, 0);
  G.hand = new THREE.SphereGeometry(0.05, 10, 8); G.hand.scale(0.82, 1.3, 0.55); G.hand.translate(0, -0.3, 0);
  G.thigh = down(new THREE.CylinderGeometry(0.074, 0.058, 0.44, 12), 0.44);
  G.thighShort = down(new THREE.CylinderGeometry(0.078, 0.07, 0.24, 12), 0.24);
  G.knee = new THREE.SphereGeometry(0.058, 10, 8);
  G.shin = down(new THREE.CylinderGeometry(0.057, 0.044, 0.4, 10), 0.4);
  G.shoe = new THREE.CapsuleGeometry(0.052, 0.15, 4, 10); G.shoe.rotateX(Math.PI / 2); G.shoe.scale(1, 0.72, 1); G.shoe.translate(0, -0.405, -0.045);
  G.collar = new THREE.TorusGeometry(0.062, 0.016, 6, 16); G.collar.rotateX(Math.PI / 2); G.collar.translate(0, 0.585, 0);
  G.blob = new THREE.PlaneGeometry(0.9, 0.9);
  // weapons
  G.blade = new THREE.BoxGeometry(0.016, 0.034, 0.24); G.blade.translate(0, 0, -0.17);
  G.handle = new THREE.BoxGeometry(0.028, 0.038, 0.11);
  G.guard = new THREE.BoxGeometry(0.03, 0.07, 0.015); G.guard.translate(0, 0, -0.055);
  G.barrel = new THREE.CylinderGeometry(0.014, 0.014, 0.2, 8);
  G.cyl = new THREE.CylinderGeometry(0.03, 0.03, 0.06, 10);
  G.frame = new THREE.BoxGeometry(0.035, 0.05, 0.1);
  G.grip = new THREE.BoxGeometry(0.032, 0.11, 0.045);
  G.trigger = new THREE.TorusGeometry(0.018, 0.004, 4, 10, Math.PI);
  G.hammer = new THREE.BoxGeometry(0.01, 0.02, 0.015);
  return G;
}
export { geos };

const SHARED = {};
const shared = (k, make) => (SHARED[k] ||= make());

// Knife: the origin is the middle of the handle (where the fist holds it); blade points to -Z.
let KNIFE_GEO = null;
// a crowbar (like the reference picture): hexagonal steel bar, red painted in the middle, chrome ends,
// a curled claw at the top with a forked tip, and a slightly bent flat chisel at the bottom.
// Same orientation as the knife: held in the fist at the origin, the claw end points along -Z.
let CROWBAR_GEO = null;
export function makeCrowbarMesh() {
  if (!CROWBAR_GEO) {
    const V = THREE.Vector3;
    // centre line of the bar, from the chisel tip (bottom, +Z) up to the claw tip (curled over, top)
    const path = new THREE.CatmullRomCurve3([
      new V(0, -0.03, 0.17), new V(0, -0.014, 0.125), new V(0, -0.003, 0.07), new V(0, 0.002, 0.0),
      new V(0, -0.002, -0.1), new V(0, 0.006, -0.2), new V(0, 0.022, -0.255), new V(0, 0.05, -0.278),
      new V(0, 0.079, -0.27), new V(0, 0.094, -0.245), new V(0, 0.088, -0.218), new V(0, 0.072, -0.207),
    ], false, 'catmullrom', 0.4);
    const pts = path.getSpacedPoints(120);
    const part = (a, b) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.slice(a, b + 1)), 40, 0.0105, 6, false);
    const lower = part(0, 26), middle = part(26, 72), upper = part(72, 116);
    // flat chisel blade at the bottom
    const chisel = new THREE.BoxGeometry(0.026, 0.006, 0.03); chisel.rotateX(-0.35); chisel.translate(0, -0.03, 0.172);
    // forked claw tip at the end of the curl
    const end = pts[118], prev = pts[110];
    const dir = end.clone().sub(prev).normalize();
    const fork = (side) => {
      const g = new THREE.BoxGeometry(0.008, 0.006, 0.026);
      const q = new THREE.Quaternion().setFromUnitVectors(new V(0, 0, 1), dir);
      g.applyQuaternion(q);
      g.translate(end.x + side * 0.007, end.y + dir.y * 0.012, end.z + dir.z * 0.012);
      return g;
    };
    CROWBAR_GEO = { lower, middle, upper, chisel, forkL: fork(-1), forkR: fork(1) };
  }
  const G2 = CROWBAR_GEO;
  const g = new THREE.Group();
  const red = shared('crowbarRed', () => new THREE.MeshPhongMaterial({ color: 0x9e120c, shininess: 40, specular: 0x442020 }));
  const chrome = shared('crowbarChrome', () => new THREE.MeshPhongMaterial({ color: 0x7c828b, shininess: 70, specular: 0xd8dce2 }));
  // inner group turned half a turn around the bar so the claw curls away from the holder
  const inner = new THREE.Group(); inner.rotation.z = Math.PI;
  inner.position.z = 0.07;   // grip point near the middle of the bar, not at the chisel end
  inner.add(new THREE.Mesh(G2.middle, red), new THREE.Mesh(G2.lower, chrome), new THREE.Mesh(G2.upper, chrome),
    new THREE.Mesh(G2.chisel, chrome), new THREE.Mesh(G2.forkL, chrome), new THREE.Mesh(G2.forkR, chrome));
  g.add(inner);
  return g;
}

export function makeKnifeMesh() {
  if (!KNIFE_GEO) {
    // blade outline (x = along the blade, y = height): straight spine, curved edge up to a sharp tip
    const sh = new THREE.Shape();
    sh.moveTo(0, 0);
    sh.lineTo(0.15, 0.0);
    sh.quadraticCurveTo(0.225, 0.006, 0.255, 0.034);
    sh.lineTo(0.205, 0.036);
    sh.lineTo(0, 0.036);
    sh.lineTo(0, 0);
    const blade = new THREE.ExtrudeGeometry(sh, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0018, bevelSize: 0.0018, bevelSegments: 1, curveSegments: 6 });
    blade.rotateY(Math.PI / 2);            // length -> -Z, thickness -> X
    blade.translate(-0.002, -0.018, -0.06);
    const handle = new THREE.CapsuleGeometry(0.016, 0.085, 3, 8); handle.rotateX(Math.PI / 2); handle.scale(0.85, 1.15, 1);
    const guard = new THREE.BoxGeometry(0.024, 0.06, 0.012); guard.translate(0, 0, -0.056);
    const pommel = new THREE.BoxGeometry(0.026, 0.038, 0.016); pommel.translate(0, 0, 0.058);
    const rivet = new THREE.CylinderGeometry(0.0045, 0.0045, 0.032, 6); rivet.rotateZ(Math.PI / 2);
    KNIFE_GEO = { blade, handle, guard, pommel, rivet };
  }
  const G2 = KNIFE_GEO;
  const knife = new THREE.Group();
  const steel = shared('blade', () => new THREE.MeshLambertMaterial({ color: 0xd9dee4, emissive: 0x30353a }));
  const dark = shared('kgrip', () => new THREE.MeshLambertMaterial({ color: 0x1d130c }));
  const brass = shared('brass', () => new THREE.MeshLambertMaterial({ color: 0xa08850 }));
  knife.add(new THREE.Mesh(G2.blade, steel), new THREE.Mesh(G2.handle, dark), new THREE.Mesh(G2.guard, brass), new THREE.Mesh(G2.pommel, brass));
  for (const z of [-0.02, 0.025]) { const r = new THREE.Mesh(G2.rivet, brass); r.position.z = z; knife.add(r); }
  return knife;
}

// Revolver: the origin is the middle of the grip (where the hand holds it); barrel points to -Z.
export function makeGunMesh() {
  const g = geos();
  const gun = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.set(0, 0.04, -0.042);
  gun.add(inner);
  const metal = shared('gunmetal', () => new THREE.MeshLambertMaterial({ color: 0x2b2d31, emissive: 0x0c0c0e }));
  const b = new THREE.Mesh(g.barrel, metal); b.rotation.x = Math.PI / 2; b.position.set(0, 0.03, -0.14);
  const c = new THREE.Mesh(g.cyl, metal); c.rotation.x = Math.PI / 2; c.position.set(0, 0.02, -0.03);
  const f = new THREE.Mesh(g.frame, metal); f.position.set(0, 0.025, 0);
  const gr = new THREE.Mesh(g.grip, shared('grip', () => new THREE.MeshLambertMaterial({ color: 0x5a3518 })));
  gr.position.set(0, -0.03, 0.04); gr.rotation.x = -0.35;
  const tg = new THREE.Mesh(g.trigger, metal); tg.position.set(0, -0.005, 0.0); tg.rotation.set(0, Math.PI / 2, Math.PI);
  const hammer = new THREE.Mesh(g.hammer, metal); hammer.position.set(0, 0.055, 0.045);
  inner.add(b, c, f, gr, tg, hammer);
  return gun;
}

// ---------------- hairstyles ----------------
function hairMeshes(style, hairMat) {
  const out = [];
  const add = (geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, mat = hairMat) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.scale.set(sx, sy, sz); out.push(m); return m;
  };
  const cap = (r, th, tilt) => add(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI * th), 0, 0.15, 0, tilt, 0, 0, 0.95, 1.1, 1.03);
  switch (style) {
    case 'short': cap(0.166, 0.42, 0.28); break;
    case 'buzz': cap(0.159, 0.45, 0.2); break;
    case 'sidepart':
      cap(0.167, 0.42, 0.28);
      add(new THREE.CapsuleGeometry(0.03, 0.12, 3, 6), 0.035, 0.285, -0.115, 0.3, 0, 1.2, 1, 1, 0.9);
      break;
    case 'long': {
      // every piece is bigger than the head in all directions, so nothing pokes through the face/skin
      cap(0.168, 0.46, 0.3);                                                                     // top + fringe line
      add(new THREE.SphereGeometry(0.17, 20, 12, 0, Math.PI, 0, Math.PI * 0.78), 0, 0.15, 0, 0, 0, 0, 0.95, 1.1, 1.03); // back half shell
      const curtain = new THREE.CylinderGeometry(0.165, 0.15, 0.2, 20, 1, true, -1.35, 2.7);  // hair hanging down the back
      add(curtain, 0, 0.055, 0.008, 0.06, 0, 0, 1, 1, 1, hairMat).material.side = THREE.DoubleSide;
      break;
    }
    case 'ponytail':
      cap(0.167, 0.44, 0.32);
      add(new THREE.SphereGeometry(0.035, 8, 6), 0, 0.2, 0.165);
      add(new THREE.CapsuleGeometry(0.04, 0.17, 3, 8), 0, 0.07, 0.2, 0.35);
      break;
    case 'bun':
      cap(0.167, 0.44, 0.3);
      add(new THREE.SphereGeometry(0.068, 12, 8), 0, 0.32, 0.075);
      break;
    case 'mohawk':
      cap(0.158, 0.4, 0.2);
      add(new THREE.BoxGeometry(0.035, 0.09, 0.32), 0, 0.3, 0.01, -0.05);
      break;
    case 'spiky': {
      cap(0.166, 0.42, 0.28);
      const cone = new THREE.ConeGeometry(0.035, 0.1, 5);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2, rr = i === 0 ? 0 : 0.08;
        add(cone, Math.cos(a) * rr, 0.31 - rr * 0.35, Math.sin(a) * rr + 0.01, Math.sin(a) * rr * 4, 0, -Math.cos(a) * rr * 4);
      }
      break;
    }
    case 'afro':
      // sits higher and further back so the front edge stays above the eyebrows
      add(new THREE.SphereGeometry(0.205, 18, 14), 0, 0.265, 0.07, 0, 0, 0, 1.02, 0.86, 1);
      add(new THREE.SphereGeometry(0.19, 16, 12), 0, 0.17, 0.11, 0, 0, 0, 1.0, 0.95, 0.9);   // volume at the back / sides
      break;
    case 'beanie':
      add(new THREE.SphereGeometry(0.172, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), 0, 0.15, 0.005, 0.12, 0, 0, 0.96, 1.16, 1.05);
      add(new THREE.TorusGeometry(0.162, 0.024, 6, 22), 0, 0.17, 0.0, Math.PI / 2 + 0.12, 0, 0, 0.96, 1.05, 1);
      break;
    default: break; // bald
  }
  return out;
}

// ---------------- accessories ----------------
// Head center is at (0, 0.15, 0); the face looks toward -Z. Geometry is made per character (freed in dispose()).
function accessoryMeshes(kind, M) {
  const out = [];
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.scale.set(sx, sy, sz); out.push(m); return m;
  };
  if (kind === 'cap') {
    add(new THREE.SphereGeometry(0.168, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), M.acc, 0, 0.165, 0.005, 0.12, 0, 0, 0.96, 1.0, 1.04);
    add(new THREE.CylinderGeometry(0.105, 0.105, 0.012, 18), M.acc, 0, 0.2, -0.165, -0.1, 0, 0, 1, 1, 0.8);
    add(new THREE.SphereGeometry(0.014, 6, 4), M.acc, 0, 0.335, 0.005);
  }
  return out;
}

// ---------------- face (made of shapes) ----------------
// Head center is at (0, 0.15, 0); the face looks toward -Z.
function faceMeshes(face, M) {
  const g = geos();
  const out = [];
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.scale.set(sx, sy, sz); out.push(m); return m;
  };
  const EY = 0.165, EX = 0.052, EZ = -0.128;
  if (face === 'dead') {
    // X eyes (two crossed dark bars on the skin where each eye was) and a sad mouth
    const zx = -Math.sqrt(Math.max(0, 0.155 * 0.155 - ((EY - 0.15) / 1.08) ** 2)) * 0.94 - 0.012;
    for (const sx of [-1, 1]) for (const r of [0.785, -0.785]) add(g.mouthLine, M.mouthDark, sx * EX, EY, zx, -0.1, sx * 0.3, r, 0.95, 1.1, 1);
    const sY = 0.09, sz = -Math.sqrt(Math.max(0, 0.155 * 0.155 - ((sY - 0.15) / 1.08) ** 2)) - 0.004;
    add(g.mouthArc, M.mouth, 0, sY - 0.016, sz, -0.3, 0, 0, 0.9, 0.6, 1);
    return out;
  }
  // eyeballs + pupils
  for (const sx of [-1, 1]) {
    add(g.eye, M.eyeWhite, sx * EX, EY, EZ, 0, 0, 0, 1, face === 'surprised' ? 1.25 : 1.05, 0.9);
    add(g.pupil, M.pupil, sx * EX, EY - 0.002, EZ - 0.022, 0, 0, 0, 1, face === 'surprised' ? 1.1 : 1, 0.6);
    if (face === 'sleepy') add(g.lid, M.skin, sx * EX, EY + 0.001, EZ, -0.5, 0, 0, 1.02, 1.1, 0.95); // half-closed eyelids
  }
  // eyebrows: angle tells the mood
  const browTilt = { angry: 0.38, sad: -0.32, surprised: 0, sleepy: 0.08, happy: -0.08 }[face] ?? 0;
  const browY = { angry: EY + 0.04, surprised: EY + 0.068, sad: EY + 0.05 }[face] ?? EY + 0.052;
  for (const sx of [-1, 1]) add(g.brow, M.brow, sx * EX, browY, -0.14, -0.3, 0, -sx * browTilt);
  // mouth
  // z of the head's front surface at height y (so the mouth sits right on the skin)
  const surf = (y) => -Math.sqrt(Math.max(0, 0.155 * 0.155 - ((y - 0.15) / 1.08) ** 2)) - 0.004;
  const MY = 0.09;
  switch (face) {
    case 'smile': add(g.mouthArc, M.mouth, 0, MY + 0.026, surf(MY + 0.01), -0.3, 0, Math.PI, 1, 0.75, 1); break;   // ∪
    case 'happy': add(g.mouthOpen, M.mouthDark, 0, MY + 0.014, surf(MY + 0.002) - 0.002, -0.3, Math.PI, 0, 1, 0.9, 1); break; // open grin
    case 'sad': add(g.mouthArc, M.mouth, 0, MY - 0.016, surf(MY), -0.3, 0, 0, 0.9, 0.6, 1); break;                // ∩
    case 'angry': add(g.mouthArc, M.mouth, 0, MY - 0.01, surf(MY - 0.004), -0.3, 0, 0, 1.1, 0.35, 1); break;
    case 'surprised': add(g.mouthO, M.mouthDark, 0, MY, surf(MY), -0.3, 0, 0, 1, 1.3, 1); break;
    case 'sleepy': add(g.mouthLine, M.mouth, 0, MY + 0.004, surf(MY), -0.3, 0, 0.12, 0.8, 1, 1); break;
    default: add(g.mouthLine, M.mouth, 0, MY + 0.004, surf(MY), -0.3); break;                                      // neutral
  }
  return out;
}


export class CharacterModel {
  constructor(textures, look = DEFAULT_LOOK) {
    this.T = textures;
    this.root = new THREE.Group();
    this.look = sanitizeLook(look);
    const lk = this.look;
    const T = textures;
    const g = geos();
    const mat = (o) => { const m = new THREE.MeshLambertMaterial(o); m.userData.base = (o.color ?? 0xffffff); return m; };
    this.mats = {
      shirt: mat({ map: T.shirt[lk.shirt], color: lk.shirtColor }),
      sleeve: mat({ map: lk.shirt === 'sweater' ? T.sleeveKnit : T.sleeve, color: lk.shirtColor }),
      pants: mat({ map: T.pants[lk.pants], color: lk.pantsColor }),
      hips: mat({ map: T.hips[lk.pants], color: lk.pantsColor }),
      skin: mat({ color: lk.skin }),
      brow: mat({ color: lk.hairColor === 0x9a9a9a ? 0x777777 : lk.hairColor }),
      hair: mat({ color: lk.hairColor }),
      shoes: mat({ color: 0x1e1c1b }),
      acc: mat({ color: lk.accColor }),
    };
    this.skinColor = lk.skin;
    // eyes and mouth get darker in the dark like the rest of the body (an off-white, not glowing white)
    this.mats.eyeWhite = mat({ color: 0xd9d5cb });
    this.mats.pupil = shared('pupil', () => new THREE.MeshBasicMaterial({ color: 0x15100c }));
    this.mats.mouth = mat({ color: 0x5a1d1a });
    this.mats.mouthDark = mat({ color: 0x2a0b0a, side: THREE.DoubleSide });
    const M = this.mats;
    const mk = (parent, geo, m, x = 0, y = 0, z = 0) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); parent.add(mesh); return mesh; };
    const seg = (parent, x, y, z) => { const joint = new THREE.Group(); joint.position.set(x, y, z); parent.add(joint); const vis = new THREE.Group(); joint.add(vis); return { joint, vis }; };

    // hips
    this.pelvis = seg(this.root, 0, 0.92, 0);
    mk(this.pelvis.vis, g.pelvis, M.hips);
    // torso
    this.torso = seg(this.pelvis.joint, 0, 0, 0);
    mk(this.torso.vis, g.torso, M.shirt);
    mk(this.torso.vis, g.neck, M.skin);
    if (lk.shirt === 'sweater' || lk.shirt === 'tshirt') mk(this.torso.vis, g.collar, M.sleeve);
    // head
    this.head = seg(this.torso.joint, 0, 0.6, 0);
    this.headMesh = mk(this.head.vis, g.head, M.skin);
    // a cap goes over short hair
    const hairStyle = lk.acc === 'cap' && ['afro', 'mohawk', 'spiky', 'bun', 'beanie'].includes(lk.hair) ? 'short' : lk.hair;
    this.faceParts = faceMeshes(lk.face, M);
    for (const f of this.faceParts) this.head.vis.add(f);
    for (const h of hairMeshes(hairStyle, M.hair)) this.head.vis.add(h);
    for (const a of accessoryMeshes(lk.acc, M)) this.head.vis.add(a);
    // arms
    const longSleeve = lk.shirt === 'dressshirt' || lk.shirt === 'sweater';
    const noSleeve = false;
    const makeArm = (side) => {
      const sh = seg(this.torso.joint, 0.222 * side, 0.465, 0);
      mk(sh.vis, g.shoulder, noSleeve ? M.skin : M.shirt);
      mk(sh.vis, g.upperArm, longSleeve ? M.sleeve : M.skin);
      if (!longSleeve && !noSleeve) mk(sh.vis, g.sleeveShort, M.sleeve);
      const el = seg(sh.joint, 0, -0.29, 0);
      mk(el.vis, g.elbow, longSleeve ? M.sleeve : M.skin);
      mk(el.vis, g.foreArm, longSleeve ? M.sleeve : M.skin);
      if (longSleeve) mk(el.vis, g.cuff, M.sleeve);
      mk(el.vis, g.hand, M.skin);
      const hand = new THREE.Group(); hand.position.y = -0.29; el.joint.add(hand);
      return { sh: sh.joint, shVis: sh.vis, el: el.joint, elVis: el.vis, hand };
    };
    this.armL = makeArm(-1);
    this.armR = makeArm(1);
    // legs
    const shorts = lk.pants === 'shorts';
    const makeLeg = (side) => {
      const hip = seg(this.pelvis.joint, 0.088 * side, -0.05, 0);
      if (shorts) { mk(hip.vis, g.thighShort, M.pants); mk(hip.vis, g.thigh, M.skin).scale.set(0.92, 1, 0.92); }
      else mk(hip.vis, g.thigh, M.pants);
      const kn = seg(hip.joint, 0, -0.44, 0);
      mk(kn.vis, g.knee, shorts ? M.skin : M.pants);
      mk(kn.vis, g.shin, shorts ? M.skin : M.pants);
      mk(kn.vis, g.shoe, M.shoes);
      const foot = new THREE.Group(); foot.position.y = -0.4; kn.joint.add(foot);
      return { hip: hip.joint, hipVis: hip.vis, kn: kn.joint, knVis: kn.vis, foot };
    };
    this.legL = makeLeg(-1);
    this.legR = makeLeg(1);

    // weapons in the right hand
    // knife held upright in the fist (blade points up when the arm is forward)
    this.knife = makeKnifeMesh(); this.knife.position.set(0, -0.005, 0); this.knife.scale.setScalar(1.15);
    // revolver held by its grip, barrel along the arm
    this.gun = makeGunMesh(); this.gun.rotation.x = -Math.PI / 2; this.gun.position.set(0, -0.005, 0.0); this.gun.scale.setScalar(1.4);
    this.crowbar = makeCrowbarMesh(); this.crowbar.position.set(0, -0.005, 0); this.crowbar.scale.setScalar(1.15);
    this.armR.hand.add(this.knife, this.gun, this.crowbar);
    this.knife.visible = false; this.gun.visible = false; this.crowbar.visible = false;

    // blob shadow
    this.blob = new THREE.Mesh(g.blob, new THREE.MeshBasicMaterial({ map: T.blob, transparent: true, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 1;

    this.phase = Math.random() * 10;
    this.swingT = 0; this.recoilT = 0; this.weapon = 0;
    this.light = [1, 1, 1];
    this.lightT = 0;
    this.applyLight();
  }

  // dead: X eyes and a sad mouth (used for the ragdoll); alive again: back to the chosen face
  setDead(dead) {
    if (!!dead === !!this.dead) return;
    this.dead = !!dead;
    for (const f of this.faceParts) this.head.vis.remove(f);
    this.faceParts = faceMeshes(dead ? 'dead' : this.look.face, this.mats);
    for (const f of this.faceParts) this.head.vis.add(f);
  }

  addTo(scene) { scene.add(this.root); scene.add(this.blob); }
  removeFrom(scene) { scene.remove(this.root); scene.remove(this.blob); }
  setVisible(v) { this.root.visible = v; this.blob.visible = v; }

  // recolor the shirt (keeps your own color unless something calls this)
  setColor(hex) {
    this.mats.shirt.userData.base = hex; this.mats.sleeve.userData.base = hex;
    this.applyLight();
  }
  setLight(r, g, b) { this.light[0] = r; this.light[1] = g; this.light[2] = b; this.applyLight(); }
  applyLight() {
    // mostly brightness, only a little of the light's color (so skin doesn't turn orange under warm lamps)
    let [r, g, b] = this.light;
    const lum = 0.3 * r + 0.55 * g + 0.15 * b;
    r = lum * 0.8 + r * 0.2; g = lum * 0.8 + g * 0.2; b = lum * 0.8 + b * 0.2;
    for (const m of Object.values(this.mats)) {
      if (m.userData.base === undefined) continue;
      m.color.setHex(m.userData.base); m.color.r *= r; m.color.g *= g; m.color.b *= b;
    }
  }

  setWeapon(w) { this.weapon = w; this.knife.visible = w === 1; this.gun.visible = w === 2; this.crowbar.visible = w === 3; }
  swing() { this.swingT = 0.35; }
  recoil() { this.recoilT = 0.25; }

  // state: x,y,z,yaw,pitch,speed,onGround,weapon
  update(dt, s, groundY = 0) {
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;
    this.blob.position.set(s.x, groundY + 0.02, s.z);
    const air = Math.min(1, Math.max(0, (s.y - groundY) / 1.2));
    this.blob.material.opacity = 1 - air * 0.7;
    this.setWeapon(s.weapon);

    if (s.tpose) { this.tPose(s.pitch); return; }

    const speed = s.speed || 0;
    const moving = Math.min(1, speed / 3.8);
    const runAmt = Math.min(1, Math.max(0, (speed - 4) / 2.6));
    this.phase += dt * (Math.min(speed, 8) * 1.75 + 0.001);
    const ph = this.phase;
    const amp = 0.5 * moving + 0.25 * runAmt;

    let legLx = Math.sin(ph) * amp, legRx = -Math.sin(ph) * amp;
    let kneeL = -Math.max(0, -Math.sin(ph)) * amp * 1.6 - runAmt * 0.3 - 0.05;
    let kneeR = -Math.max(0, Math.sin(ph)) * amp * 1.6 - runAmt * 0.3 - 0.05;
    let legLz = 0, legRz = 0; // legs swing straight forward/back, never out to the sides
    if (!s.onGround) {
      // little "hop" pose: right knee up, out and bent; left leg back, slightly out and bent
      // legs stay in front of the body (no sideways spread): right knee up, left leg tucked more
      legRx = 1.0; legRz = 0; kneeR = -1.4;
      legLx = 0.3; legLz = 0; kneeL = -1.35;
    }
    this.legL.hip.rotation.set(legLx, 0, legLz); this.legR.hip.rotation.set(legRx, 0, legRz);
    this.legL.kn.rotation.x = kneeL; this.legR.kn.rotation.x = kneeR;

    // no up/down bobbing of the body when walking, running or jumping
    this.pelvis.joint.position.y = 0.92;
    this.pelvis.joint.rotation.y = 0; // no hip twist, so the legs move in a straight line
    // upper body stays facing forward (no left/right sway) when walking, running or jumping
    this.torso.joint.rotation.set(-runAmt * 0.18 + s.pitch * 0.15, 0, 0);
    this.head.joint.rotation.set(s.pitch * 0.6, 0, 0);

    // in the air the arms stop swinging and just bend (elbows up, hands in front)
    const inAir = !s.onGround;
    const armSw = inAir ? 0 : Math.sin(ph) * amp * 0.9;
    const elbowBend = inAir ? 1.75 : 0.25 + runAmt * 0.9;
    // left arm goes the opposite way (swung back) and is bent more
    this.armL.sh.rotation.set(inAir ? -1.55 : -armSw * 0.9, 0, inAir ? -0.2 : -0.1);    // swung all the way back
    this.armL.el.rotation.x = inAir ? 2.2 : elbowBend;

    if (this.swingT > 0) this.swingT -= dt;
    if (this.recoilT > 0) this.recoilT -= dt;
    if (s.weapon === 2) {
      const rec = this.recoilT > 0 ? this.recoilT * 2.5 : 0;
      // both hands on the revolver: right hand on the grip, left hand cupped under it
      // gun held in front of the chest (centered) so both hands can reach it
      // upper arm angled down by the same amount the elbow bends up, so the barrel points straight at the aim
      this.armR.sh.rotation.set(Math.PI / 2 + s.pitch * 0.9 + rec - 0.6, 0, -0.42);
      this.armR.el.rotation.x = 0.6;
      // left hand reaches over to the revolver grip (2-bone IK)
      this.leftHandToGrip();
    } else if (s.weapon === 3 && this.swingT > 0) {
      // crowbar: sideways swing — wind up out to the right, sweep across the body to the left
      const e = sideSwing(1 - this.swingT / 0.35);
      this.armR.sh.rotation.set(1.45 + s.pitch * 0.5, 0, 0.35 - e * 1.25);
      this.armR.el.rotation.x = 0.35 - Math.max(0, e) * 0.2;
      this.crowbar.rotation.x = -Math.max(0, e) * 0.6;
    } else if (s.weapon === 1 || s.weapon === 3) {
      this.crowbar.rotation.x = 0;
      const k = this.swingT > 0 ? Math.sin((1 - this.swingT / 0.35) * Math.PI) : 0;
      this.armR.sh.rotation.set(0.9 + k * 1.4 + s.pitch * 0.5, 0, 0.1 - k * 0.3);
      this.armR.el.rotation.x = 0.9 - k * 0.8;
    } else {
      this.armR.sh.rotation.set(inAir ? 0.7 : armSw * 0.9, 0, inAir ? 0.2 : 0.1);        // forward, angled down
      this.armR.el.rotation.x = elbowBend;
    }
  }

  // Prop team: stiff T-pose, no animation at all (walking, running and jumping look the same)
  tPose(pitch = 0) {
    this.pelvis.joint.position.y = 0.92;
    this.pelvis.joint.rotation.set(0, 0, 0);
    this.torso.joint.rotation.set(0, 0, 0);
    this.head.joint.rotation.set(pitch * 0.4, 0, 0);
    this.legL.hip.rotation.set(0, 0, 0); this.legR.hip.rotation.set(0, 0, 0);
    this.legL.kn.rotation.set(0, 0, 0); this.legR.kn.rotation.set(0, 0, 0);
    this.armL.sh.quaternion.identity(); this.armR.sh.quaternion.identity();
    this.armL.sh.rotation.set(0, 0, -Math.PI / 2);   // arms straight out to the sides
    this.armR.sh.rotation.set(0, 0, Math.PI / 2);
    this.armL.el.rotation.set(0, 0, 0); this.armR.el.rotation.set(0, 0, 0);
  }

  // Two-bone IK: bend the left arm so the left hand wraps the revolver grip held in the right hand
  leftHandToGrip() {
    const V3 = THREE.Vector3;
    this.root.updateMatrixWorld(true);
    // on the grip itself, just below the right hand (in the right hand's own space, +z = down along the grip)
    const T = this.torso.joint.worldToLocal(this.armR.hand.localToWorld(new V3(-0.012, 0.0, 0.06)));
    const S = this.armL.sh.position.clone();
    const L1 = 0.29, L2 = 0.29; // shoulder->elbow, elbow->hand (same as the model)
    const toT = T.clone().sub(S);
    const dist = Math.min(toT.length(), L1 + L2 - 0.002);
    const dir = toT.normalize();
    const pole = new V3(-0.6, -1, 0.25).normalize();            // elbow points down and out to the left
    let n = new V3().crossVectors(dir, pole);
    if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
    n.normalize();
    const a = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist))));
    const u1 = dir.clone().applyAxisAngle(n, a), u2 = dir.clone().applyAxisAngle(n, -a);
    const u = u1.dot(pole) > u2.dot(pole) ? u1 : u2;             // upper arm direction
    const E = S.clone().addScaledVector(u, L1);                   // elbow
    const f = S.clone().addScaledVector(dir, dist).sub(E).normalize(); // forearm direction
    const y = u.clone().multiplyScalar(-1);
    const z = f.clone().addScaledVector(u, -f.dot(u)).multiplyScalar(-1);
    if (z.lengthSq() < 1e-8) z.set(0, 0, 1);
    z.normalize();
    const x = new V3().crossVectors(y, z);
    this.armL.sh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.armL.el.rotation.set(Math.acos(Math.max(-1, Math.min(1, u.dot(f)))), 0, 0);
  }

  // Hitboxes that follow the body's actual pose: one capsule per body part
  // [ax, ay, az, bx, by, bz, radius] in world space (head, torso, upper/lower arms, upper/lower legs, feet).
  hitCapsules() {
    const j = this.jointPositions();
    const out = [];
    const cap = (a, b, r) => out.push([a.x, a.y, a.z, b.x, b.y, b.z, r]);
    const head = j[0], neck = j[1], pelvis = j[2];
    cap(head, head, 0.16);                                                              // head
    const down = pelvis.clone().sub(neck).normalize();
    cap(neck.clone().addScaledVector(down, 0.1), pelvis.clone().addScaledVector(down, 0.06), 0.15);   // torso + hips
    cap(j[3], j[4], 0.065); cap(j[4], j[5], 0.055);                                       // left arm
    cap(j[6], j[7], 0.065); cap(j[7], j[8], 0.055);                                       // right arm
    cap(j[9], j[10], 0.08); cap(j[10], j[11], 0.065);                                     // left leg
    cap(j[12], j[13], 0.08); cap(j[13], j[14], 0.065);                                    // right leg
    return out;
  }

  // World positions of the 15 joints used by the ragdoll
  jointPositions() {
    this.root.updateMatrixWorld(true);
    const v = (obj, x = 0, y = 0, z = 0) => obj.localToWorld(new THREE.Vector3(x, y, z));
    return [
      v(this.head.joint, 0, 0.15, 0),   // 0 head center
      v(this.head.joint),               // 1 neck (base of head)
      v(this.pelvis.joint),             // 2 pelvis
      v(this.armL.sh), v(this.armL.el), v(this.armL.hand),  // 3 4 5
      v(this.armR.sh), v(this.armR.el), v(this.armR.hand),  // 6 7 8
      v(this.legL.hip), v(this.legL.kn), v(this.legL.foot), // 9 10 11
      v(this.legR.hip), v(this.legR.kn), v(this.legR.foot), // 12 13 14
    ];
  }

  dispose() {
    for (const m of Object.values(this.mats)) if (m.userData.base !== undefined) m.dispose();
    this.blob.material.dispose();
    this.head.vis.traverse((o) => { if (o.isMesh && o.geometry !== geos().head && !Object.values(geos()).includes(o.geometry)) o.geometry.dispose(); });
  }
}

const KNIFE_REST = Math.PI / 2 - 0.3;
// crowbar side swing curve over t = 0..1: wind up (to -0.35), fast sweep (to 1), ease back to 0
function sideSwing(t) {
  if (t < 0.25) return -0.35 * Math.sin((t / 0.25) * Math.PI / 2);
  if (t < 0.55) { const u = (t - 0.25) / 0.3; return -0.35 + 1.35 * u * u * (3 - 2 * u); }
  const u = (t - 0.55) / 0.45; return 1 - u * u * (3 - 2 * u);
} // first-person knife: upright, leaning slightly forward

// First-person arm + weapon attached to the camera
export class ViewModel {
  constructor(camera, textures) {
    this.T = textures;
    this.group = new THREE.Group();
    camera.add(this.group);
    this.arm = new THREE.Group();
    this.group.add(this.arm);
    this.sleeve = new THREE.MeshLambertMaterial({ color: 0x888888, map: textures.sleeve });
    this.sleeveKnit = new THREE.MeshLambertMaterial({ color: 0x888888, map: textures.sleeveKnit });
    this.skin = new THREE.MeshLambertMaterial({ color: 0xe0b48c });
    const g = geos();
    // forearm runs from the hand (arm origin) back toward the camera
    this.fore = new THREE.Mesh(g.foreArm, this.skin); this.fore.rotation.x = Math.PI / 2; this.fore.position.z = 0.375; this.fore.scale.set(1.15, 1.5, 1.15);
    this.hand = new THREE.Mesh(g.hand, this.skin); this.hand.rotation.x = Math.PI / 2; this.hand.position.set(0, -0.01, 0.31); this.hand.scale.set(1.3, 1.05, 1.3);
    this.arm.add(this.fore, this.hand);
    // knife upright in the fist, leaning slightly forward
    this.knife = makeKnifeMesh(); this.knife.scale.setScalar(1.3); this.knife.rotation.x = KNIFE_REST; this.knife.position.set(0, 0.0, 0.0);
    // revolver held by the grip (bigger), with the left hand supporting it
    this.gun = makeGunMesh(); this.gun.scale.setScalar(1.55); this.gun.position.set(0, -0.005, 0.0);
    this.crowbar = makeCrowbarMesh(); this.crowbar.scale.setScalar(0.72); this.crowbar.position.set(-0.02, -0.015, 0.03); this.crowbar.rotation.x = KNIFE_REST;
    this.arm.add(this.knife, this.gun, this.crowbar);
    this.support = new THREE.Group();
    const sFore = new THREE.Mesh(g.foreArm, this.skin); sFore.rotation.x = Math.PI / 2; sFore.position.z = 0.375; sFore.scale.set(1.15, 1.5, 1.15);
    const sHand = new THREE.Mesh(g.hand, this.skin); sHand.rotation.x = Math.PI / 2; sHand.position.set(0, -0.01, 0.31); sHand.scale.set(1.3, 1.05, 1.3);
    this.support.add(sFore, sHand);
    this.support.position.set(-0.012, -0.055, 0.0);   // wrapped around the grip, just under the right hand
    this.support.rotation.set(0.1, -0.35, 0.2);
    this.supportFore = sFore;
    this.arm.add(this.support);
    this.swingT = 0; this.recoilT = 0; this.bob = 0; this.throwT = 0;
    this.base = new THREE.Vector3(0.24, -0.24, -0.42);
    this.arm.position.copy(this.base);
    this.lookKey = '';
  }
  setLook(look, shirtColor, light) {
    const long = look.shirt === 'dressshirt' || look.shirt === 'sweater';
    const sl = look.shirt === 'sweater' ? this.sleeveKnit : this.sleeve;
    this.fore.material = long ? sl : this.skin;
    this.supportFore.material = long ? sl : this.skin;
    sl.color.setHex(shirtColor).multiplyScalar(light);
    this.skin.color.setHex(look.skin).multiplyScalar(light);
  }
  swing() { this.swingT = 0.35; }
  recoil() { this.recoilT = 0.3; }
  throwAnim() { this.throwT = 0.4; }
  update(dt, weapon, speed, visible) {
    this.group.visible = visible && weapon !== 0;
    this.knife.visible = weapon === 1 && this.throwT <= 0;
    this.crowbar.visible = weapon === 3 && this.throwT <= 0;
    this.gun.visible = weapon === 2;
    this.support.visible = weapon === 2;
    this.base.x = weapon === 2 ? 0.17 : 0.24; // two-handed: hold it more in the middle
    this.bob += dt * speed * 1.8;
    const bx = Math.sin(this.bob) * 0.012 * Math.min(1, speed / 4);
    const by = Math.abs(Math.cos(this.bob)) * 0.014 * Math.min(1, speed / 4);
    this.arm.position.set(this.base.x + bx, this.base.y + by, this.base.z);
    this.arm.rotation.set(0, 0, 0);
    if (this.swingT > 0 && weapon === 3) {
      this.swingT -= dt;
      // crowbar: sideways swing from right to left across the screen
      const e = sideSwing(1 - this.swingT / 0.35);
      this.arm.position.x -= e * 0.3;
      this.arm.position.y += Math.abs(e) * 0.03;
      this.arm.position.z -= Math.max(0, e) * 0.06;
      this.arm.rotation.set(0, e * 0.45, e * 1.15);
      this.crowbar.rotation.x = KNIFE_REST - Math.max(0, e) * 0.35;
      this.knife.rotation.x = KNIFE_REST;
    } else if (this.swingT > 0) {
      this.swingT -= dt;
      // same forward stab as the third-person animation: quick pull back, thrust forward
      // (blade tips forward to point at the target), then ease back
      const t = 1 - this.swingT / 0.35;
      const k = t < 0.22 ? -(t / 0.22) * 0.3 : t < 0.5 ? -0.3 + ((t - 0.22) / 0.28) * 1.3 : 1 - (t - 0.5) / 0.5;
      const e = k < 0 ? k : k * k * (3 - 2 * k);
      this.arm.position.z -= e * 0.27;
      this.arm.position.x -= Math.max(0, e) * 0.08;
      this.arm.position.y += Math.abs(e) * 0.04;
      this.arm.rotation.x = e * 0.12;                         // forearm dips a little as it extends
      this.knife.rotation.x = KNIFE_REST - e * 0.8;           // blade tips forward to point at the target
      this.crowbar.rotation.x = KNIFE_REST - e * 0.8;
    }
    else { this.knife.rotation.x = KNIFE_REST; this.crowbar.rotation.x = KNIFE_REST; }
    if (this.recoilT > 0) {
      this.recoilT -= dt;
      const k = this.recoilT / 0.3;
      this.arm.rotation.x = k * 0.5; this.arm.position.z += k * 0.06;
    }
    if (this.throwT > 0) this.throwT -= dt;
  }
}

