// =====================================================================
//  MAIN.JS — starts everything: renderer, map, menus, settings,
//  character editor, matchmaking and the main loop.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js?v=660';
import { CONFIG } from './config.js?v=660';
import { store, makeCode, clamp } from './util.js?v=660';
import { makeTextures } from './textures.js?v=660';
import { GameMap, SUN_DIR } from './map.js?v=660';
import { NavGrid } from './nav.js?v=660';
import { Input, isTouchDevice } from './input.js?v=660';
import { UI } from './ui.js?v=660';
import { Audio } from './audio.js?v=660';
import { Game } from './game.js?v=660';
import { PropSystem } from './props.js?v=660';
import { CharacterModel, DEFAULT_LOOK, randomLook, sanitizeLook, FACES, WHITE_SKIN, BLOB_SHADOWS } from './character.js?v=660';
import { NetHost, NetClient, probePublicServers, publicId, privateId, netAvailable, LOCAL_MODE } from './net.js?v=660';

const $ = (id) => document.getElementById(id);
let game = null; // the current match (null while in the menu)
const tick = () => new Promise((r) => setTimeout(r, 0));

// =====================================================================
//  SETTINGS — add a new option by adding a line to SCHEMA below.
// =====================================================================
const touch = isTouchDevice();
const DEFAULTS = {
  name: 'Player' + Math.floor(Math.random() * 900 + 100),
  look: { ...DEFAULT_LOOK },
  touchLook: 1, mouseSens: CONFIG.CONTROLS.MOUSE_SENS * 1000,
  autoSprint: true, lefty: false, btnScale: 1,
  fov: CONFIG.GRAPHICS.FOV, camDist: 3, viewBob: true, shake: true, shiftLock: false,
  quality: touch ? 'medium' : 'high', ...CONFIG.GRAPHICS.PRESETS[touch ? 'medium' : 'high'], fog: true, antialias: !touch,
  volume: 1, footVol: 1,
  fps: false, blood: false, shadows: !touch, crosshair: 'dot', crossSize: 4, hudScale: 1, hints: true,
};
// (falls back to Killer Mystery's saved settings, so your character comes along)
const settings = { ...DEFAULTS, ...store.get('findthethings-settings', store.get('killermystery-settings', {})) };
settings.look = sanitizeLook(settings.look);
// v3: everyone starts with the white skin tone (you can still change it in the editor)
if (!settings.lookV3) { settings.look.skin = WHITE_SKIN; settings.lookV3 = true; store.set('findthethings-settings', settings); }
// v1.3: start in third person, a bit faster touch look (only if you never changed them)
if (!settings.camV13) { if (!settings.camDist) settings.camDist = 3; settings.camV13 = true; store.set('findthethings-settings', settings); }
// v1.4: look direction back to normal (turn off any "invert" that was switched on)
if (!settings.lookV14 || 'invert' in settings) { delete settings.invert; delete settings.invertX; settings.lookV14 = true; store.set('findthethings-settings', settings); }
// shadows: on by default on computers, off by default on phones (switched back off once for phones)
if (!settings.shadowsV3) { if (touch) settings.shadows = false; settings.shadowsV3 = true; store.set('findthethings-settings', settings); }
const saveSettings = () => store.set('findthethings-settings', settings);
const pct = (v) => `${Math.round(v * 100)}%`;
const SCHEMA = [
  { tab: 'Controls', key: 'touchLook', label: 'Touch look sensitivity', note: '1.0× = the view follows your finger exactly', type: 'range', min: 0.25, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
  { tab: 'Controls', key: 'mouseSens', label: 'Mouse sensitivity', type: 'range', min: 0.5, max: 8, step: 0.1, fmt: (v) => v.toFixed(1) },
  { tab: 'Controls', key: 'autoSprint', label: 'Auto-sprint', note: 'sprint when the stick is pushed to the edge', type: 'check' },
  { tab: 'Controls', key: 'lefty', label: 'Left-handed layout', note: 'joystick on the right, buttons on the left', type: 'check' },
  { tab: 'Controls', key: 'btnScale', label: 'Touch button size', type: 'range', min: 0.7, max: 1.4, step: 0.05, fmt: pct },
  { tab: 'Camera', key: 'fov', label: 'Field of view', type: 'range', min: 60, max: 110, step: 1, fmt: (v) => `${v}°` },
  { tab: 'Camera', key: 'camDist', label: 'Starting camera', type: 'select', options: [[0, 'First person'], [1.6, 'Third person (close)'], [3, 'Third person (far)']] },
  { tab: 'Camera', key: 'viewBob', label: 'View bobbing', type: 'check' },
  { tab: 'Camera', key: 'shake', label: 'Camera shake', note: 'when shooting and landing', type: 'check' },
  { tab: 'Graphics', key: 'quality', label: 'Quality preset', type: 'select', options: [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']] },
  { tab: 'Graphics', key: 'renderScale', label: 'Resolution', type: 'range', min: 0.4, max: 2, step: 0.05, fmt: pct },
  { tab: 'Graphics', key: 'dynLights', label: 'Real-time lights', note: 'ceiling lights shine on people & furniture', type: 'select', options: [[0, 'Off (baked only)'], [4, '4'], [6, '6'], [8, '8'], [12, '12']] },
  { tab: 'Graphics', key: 'viewDist', label: 'View distance', type: 'range', min: 50, max: 250, step: 10, fmt: (v) => `${v} m` },
  { tab: 'Graphics', key: 'blood', label: 'Blood', note: 'blood splatter and drops when a prop is hit', type: 'check' },
  { tab: 'Graphics', key: 'shadows', label: 'Shadows', note: 'people and furniture cast shadows under the ceiling lights', type: 'check' },
  { tab: 'Graphics', key: 'fog', label: 'Fog', type: 'check' },
  { tab: 'Graphics', key: 'glow', label: 'Light glow', type: 'check' },
  { tab: 'Graphics', key: 'antialias', label: 'Smooth edges (anti-aliasing)', note: 'applies after reloading the page', type: 'check' },
  { tab: 'Audio', key: 'volume', label: 'Master volume', type: 'range', min: 0, max: 1.5, step: 0.05, fmt: pct },
  { tab: 'Audio', key: 'footVol', label: 'Footsteps volume', type: 'range', min: 0, max: 2, step: 0.05, fmt: pct },
  { tab: 'HUD', key: 'crosshair', label: 'Crosshair', type: 'select', options: [['dot', 'Dot'], ['cross', 'Cross'], ['circle', 'Circle'], ['none', 'None']] },
  { tab: 'HUD', key: 'crossSize', label: 'Crosshair size', type: 'range', min: 2, max: 14, step: 1, fmt: (v) => `${v}px` },
  { tab: 'HUD', key: 'hudScale', label: 'HUD size', type: 'range', min: 0.7, max: 1.4, step: 0.05, fmt: pct },
  { tab: 'HUD', key: 'fps', label: 'Show FPS counter', note: 'top right: green = smooth, yellow = OK, red = slow', type: 'check' },
  { tab: 'HUD', key: 'hints', label: 'Show control hints', type: 'check' },
];

// ---------------- renderer / scene ----------------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !!settings.antialias, powerPreference: 'high-performance' });
renderer.localClippingEnabled = true;   // blood / bullet marks are cut off at the edge of the surface they're on
renderer.setClearColor(0x8fbbe8);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
const scene = new THREE.Scene();
const fog = new THREE.Fog(0xb9c9d8, 40, 140);
scene.fog = fog;
const camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.05, 400);
scene.add(camera);

const ui = new UI();
ui.setTouch(touch);
const input = new Input({ touchRoot: $('touch'), canvas, joyBase: $('joy-base'), joyKnob: $('joy-knob') });

let textures, map, nav, glow, preview = null, skyDome = null;
const lightPool = [];

// lights for moving things (characters / props). The level itself is pre-lit (baked).
const hemi = new THREE.HemisphereLight(0xf2f4ff, 0x8a7a68, 2.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 0.9);
sun.position.set(45, 82, 36);
scene.add(sun);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  checkRotate();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

function setDynLights(n) {
  while (lightPool.length > n) { const l = lightPool.pop(); scene.remove(l); scene.remove(l.target); }
  while (lightPool.length < n) {
    // ceiling lights are spotlights pointing straight down, reaching the floor
    const l = new THREE.SpotLight(0xffe2bc, 0, 16, 1.1, 0.6, 1.4);
    scene.add(l); scene.add(l.target); lightPool.push(l);
  }
}
let lightT = 0;
// ---------------- real shadows ----------------
// The 3 ceiling lights nearest the camera get a shadow-casting spotlight (no extra light, intensity 0:
// the level's lighting is baked). Their shadows land on an invisible "shadow catcher" over the floors.
const shadowSpots = [];
// the sun: shadows of things standing outdoors (courtyard, loading yard, the menu view). It's a far-away
// spotlight up in the sun's direction (no extra light, intensity 0), only used while the camera is outdoors
// so furniture inside the rooms never throws a sun shadow.
const sunShadow = new THREE.SpotLight(0xffffff, 0, 0, 0.42, 0, 0);
sunShadow.castShadow = true; sunShadow.shadow.mapSize.set(1024, 1024); sunShadow.shadow.bias = -0.0004;
sunShadow.shadow.camera.near = 30; sunShadow.shadow.camera.far = 120;
let shadowCatcher = null, shadowsOn = false, castT = 0;
function buildShadowCatcher() {
  const pos = [];
  for (let z = 0; z < map.h; z++) {
    let x = 0;
    while (x < map.w) {
      if (map.cellHeight(x, z) > 0) { x++; continue; }
      let x1 = x; while (x1 + 1 < map.w && map.cellHeight(x1 + 1, z) === 0) x1++;
      const X0 = x * 2, X1 = (x1 + 1) * 2, Z0 = z * 2, Z1 = (z + 1) * 2, y = 0.004;
      pos.push(X0, y, Z0, X0, y, Z1, X1, y, Z1, X0, y, Z0, X1, y, Z1, X1, y, Z0);
      x = x1 + 1;
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  shadowCatcher = new THREE.Mesh(g, new THREE.ShadowMaterial({ opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  shadowCatcher.receiveShadow = true; shadowCatcher.renderOrder = 1; shadowCatcher.name = 'shadow-catcher';
  scene.add(shadowCatcher);
}
function setShadows(on) {
  on = !!on;
  BLOB_SHADOWS.on = !on;
  if (on === shadowsOn && (shadowCatcher || !map)) return;
  shadowsOn = on;
  renderer.shadowMap.enabled = on;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (on && map && !shadowCatcher) buildShadowCatcher();
  if (shadowCatcher) shadowCatcher.visible = on;
  while (shadowSpots.length < 3) {
    const s = new THREE.SpotLight(0xffffff, 0, 14, 0.95, 0.5, 1);
    s.castShadow = true; s.shadow.mapSize.set(512, 512); s.shadow.bias = -0.0006; s.shadow.camera.near = 0.3; s.shadow.camera.far = 14;
    shadowSpots.push(s);
  }
  for (const s of [...shadowSpots, sunShadow]) { if (on) { scene.add(s); scene.add(s.target); } else { scene.remove(s); scene.remove(s.target); } }
  // every material has to be rebuilt with / without shadow support
  scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
}
function updateShadows(dt) {
  if (!shadowsOn || !map) return;
  castT -= dt;
  if (castT > 0) return;
  castT = 0.25;
  const p = camera.position;
  const near = map.lights.filter((L) => !L.off).map((L) => [L, (L.x - p.x) ** 2 + (L.z - p.z) ** 2]).sort((a, b) => a[1] - b[1]);
  shadowSpots.forEach((s, i) => {
    const L = near[i] && near[i][0];
    if (!L) return;
    s.position.set(L.x, L.y - 0.1, L.z); s.target.position.set(L.x, 0, L.z); s.target.updateMatrixWorld();
  });
  // the sun's shadow box follows the camera (snapped to whole meters so the shadows don't shimmer)
  const cx = Math.round(p.x), cz = Math.round(p.z);
  sunShadow.target.position.set(cx, 0, cz); sunShadow.target.updateMatrixWorld();
  sunShadow.position.set(cx + SUN_DIR.x * 70, SUN_DIR.y * 70, cz + SUN_DIR.z * 70);
  sunShadow.castShadow = map.isOutdoor(p.x, p.z);
  // people, furniture and disguises cast shadows (marks, particles and tracers don't)
  for (const top of scene.children) if (top !== camera) top.traverse((o) => {     // (not your own first-person arm)
    if (!o.isMesh || o === shadowCatcher) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    o.castShadow = !!(m && !m.transparent && o.parent && o.parent !== scene && !o.userData.noShadow);
  });
}

function updateDynLights(dt) {
  updateShadows(dt);
  if (!lightPool.length || !map) return;
  lightT -= dt;
  if (lightT > 0) return;
  lightT = 0.2;
  const p = camera.position;
  const near = map.lights.filter((L) => !L.off).map((L) => [L, (L.x - p.x) ** 2 + (L.z - p.z) ** 2]).sort((a, b) => a[1] - b[1]).slice(0, lightPool.length);
  lightPool.forEach((l, i) => {
    const L = near[i] && near[i][0];
    if (!L) { l.intensity = 0; return; }
    l.position.set(L.x, L.y - 0.1, L.z);
    l.target.position.set(L.x, 0, L.z); l.target.updateMatrixWorld();
    l.intensity = 6;
  });
}

function applyAll() {
  // graphics
  const pr = clamp(Math.min(window.devicePixelRatio || 1, 2) * settings.renderScale, 0.35, 2.5);
  renderer.setPixelRatio(pr);
  fog.near = settings.viewDist * 0.3; fog.far = settings.viewDist;
  scene.fog = settings.fog ? fog : null;
  camera.far = settings.viewDist + 60;
  camera.fov = settings.fov;
  if (glow) glow.visible = !!settings.glow;
  setDynLights(+settings.dynLights || 0);
  setShadows(settings.shadows);
  // input
  input.touchSens = settings.touchLook ?? 1;
  input.fovDeg = settings.fov;
  input.mouseSens = settings.mouseSens / 1000;
  input.autoSprint = settings.autoSprint;
  input.lefty = settings.lefty;
  document.body.classList.toggle('lefty', !!settings.lefty);
  document.documentElement.style.setProperty('--btn-scale', settings.btnScale);
  document.documentElement.style.setProperty('--hud-scale', settings.hudScale);
  $('crosshair').className = settings.crosshair === 'dot' ? '' : settings.crosshair;
  $('crosshair').style.setProperty('--cross', `${settings.crossSize ?? 4}px`);
  Audio.setVolume(settings.volume);
  $('fps').classList.toggle('hidden', !settings.fps);
  resize();
}

// ---------------- settings screen (built from SCHEMA) ----------------
let settingsTab = 'Controls';
function buildSettings() {
  const tabs = [...new Set(SCHEMA.map((s) => s.tab))];
  $('settings-tabs').innerHTML = '';
  for (const t of tabs) {
    const b = document.createElement('button');
    b.className = 'tab' + (t === settingsTab ? ' on' : '');
    b.textContent = t;
    b.onclick = () => { settingsTab = t; buildSettings(); };
    $('settings-tabs').appendChild(b);
  }
  const body = $('settings-body');
  body.innerHTML = '';
  for (const f of SCHEMA.filter((s) => s.tab === settingsTab)) {
    const row = document.createElement('label');
    row.className = 'set-row';
    const lab = document.createElement('span'); lab.className = 'lab';
    lab.textContent = f.label;
    if (f.note) { const n = document.createElement('small'); n.textContent = f.note; lab.appendChild(n); }
    row.appendChild(lab);
    let el;
    if (f.type === 'range') {
      el = document.createElement('input'); el.type = 'range'; el.min = f.min; el.max = f.max; el.step = f.step; el.value = settings[f.key];
      const v = document.createElement('b'); v.textContent = f.fmt ? f.fmt(+settings[f.key]) : settings[f.key];
      el.oninput = () => { settings[f.key] = +el.value; v.textContent = f.fmt ? f.fmt(+el.value) : el.value; changed(f); };
      row.appendChild(el); row.appendChild(v);
    } else if (f.type === 'check') {
      el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!settings[f.key];
      el.onchange = () => { settings[f.key] = el.checked; changed(f); };
      row.appendChild(el);
    } else {
      el = document.createElement('select');
      for (const [val, text] of f.options) { const o = document.createElement('option'); o.value = val; o.textContent = text; el.appendChild(o); }
      el.value = settings[f.key];
      el.onchange = () => { const o = f.options.find(([v]) => String(v) === el.value); settings[f.key] = o ? o[0] : el.value; changed(f); };
      row.appendChild(el);
    }
    body.appendChild(row);
  }
}
function changed(f) {
  if (f.key === 'quality') { Object.assign(settings, CONFIG.GRAPHICS.PRESETS[settings.quality]); buildSettings(); }
  if (f.key === 'camDist' && game) game.camDist = settings.camDist;
  applyAll(); saveSettings();
}
$('btn-settings-reset').onclick = () => {
  const keep = { name: settings.name, look: settings.look };
  Object.assign(settings, DEFAULTS, keep);
  buildSettings(); applyAll(); saveSettings();
};
function openSettings() {
  buildSettings();
  if (game) { ui.openOverlay(true); input.setActive(false); }
  else ui.show('settings');
}
$('btn-settings').onclick = openSettings;
$('gearbtn').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
$('btn-settings-back').onclick = () => {
  if (game) {
    ui.openOverlay(false); input.setActive(true);
    if (!ui.isTouch) canvas.requestPointerLock?.();
  } else ui.show('menu');
};
// desktop: losing mouse lock (Esc) opens the settings/pause panel
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && game && !ui.overlayOpen && !ui.isTouch && input.active) openSettings();
});

// ---------------- character editor ----------------
const L = CONFIG.LOOKS;
const ED = [
  { tab: 'Look', key: 'face', label: 'Face', list: FACES },
  { tab: 'Look', key: 'skin', label: 'Skin tone', colors: L.SKINS },
  { tab: 'Hair', key: 'hair', label: 'Hairstyle', list: L.HAIR },
  { tab: 'Hair', key: 'hairColor', label: 'Hair color', colors: L.HAIR_COLORS },
  { tab: 'Clothes', key: 'shirt', label: 'Shirt', list: L.SHIRTS },
  { tab: 'Clothes', key: 'shirtColor', label: 'Shirt color (menu preview)', colors: L.SHIRT_COLORS },
  { tab: 'Clothes', key: 'pants', label: 'Pants', list: L.PANTS },
  { tab: 'Clothes', key: 'pantsColor', label: 'Pants color', colors: L.PANTS_COLORS },
  { tab: 'Accessories', key: 'acc', label: 'Accessory', list: L.ACCESSORIES },
  { tab: 'Accessories', key: 'accColor', label: 'Cap color', colors: L.ACC_COLORS, only: (lk) => lk.acc === 'cap' },
];
const NICE = { tshirt: 'T-shirt', dressshirt: 'Dress shirt', sweater: 'Sweater', sidepart: 'Side part', none: 'None' };
let edTab = 'Look';
function buildEditor() {
  // tabs
  const tabs = $('editor-tabs');
  tabs.innerHTML = '';
  for (const t of [...new Set(ED.map((e) => e.tab))]) {
    const b = document.createElement('button');
    b.className = 'tab' + (t === edTab ? ' on' : ''); b.textContent = t;
    b.onclick = () => { edTab = t; buildEditor(); $('editor-body').scrollTop = 0; };
    tabs.appendChild(b);
  }
  $('name-field').style.display = edTab === 'Look' ? '' : 'none';
  const body = $('editor-fields');
  body.innerHTML = '';
  for (const e of ED) {
    if (e.tab !== edTab || (e.only && !e.only(settings.look))) continue;
    if (e.list) {
      const row = document.createElement('div'); row.className = 'ed-row';
      const i = e.list.indexOf(settings.look[e.key]);
      row.innerHTML = `<span style="width:96px">${e.label}</span>`;
      const prev = document.createElement('button'); prev.className = 'btn ed-arrow'; prev.textContent = '◀';
      const val = document.createElement('span'); val.className = 'val'; val.textContent = NICE[settings.look[e.key]] || settings.look[e.key];
      const next = document.createElement('button'); next.className = 'btn ed-arrow'; next.textContent = '▶';
      prev.onclick = () => { settings.look[e.key] = e.list[(i - 1 + e.list.length) % e.list.length]; lookChanged(); };
      next.onclick = () => { settings.look[e.key] = e.list[(i + 1) % e.list.length]; lookChanged(); };
      row.append(prev, val, next);
      body.appendChild(row);
    } else {
      const lab = document.createElement('div'); lab.className = 'ed-label'; lab.textContent = e.label;
      const sw = document.createElement('div'); sw.className = 'swatches';
      for (const c of e.colors) {
        const d = document.createElement('div');
        d.className = 'sw' + (settings.look[e.key] === c ? ' on' : '');
        d.style.background = '#' + c.toString(16).padStart(6, '0');
        d.onclick = () => { settings.look[e.key] = c; lookChanged(); };
        sw.appendChild(d);
      }
      body.append(lab, sw);
    }
  }
}
function lookChanged() { saveSettings(); buildEditor(); makePreview(); }
function makePreview() {
  if (preview) { preview.model.removeFrom(scene); preview.model.dispose(); }
  const model = new CharacterModel(textures, settings.look);
  model.setColor(settings.look.shirtColor);
  model.addTo(scene);
  const l = map.probe(PREVIEW.x, PREVIEW.z, true);
  model.setLight(l[0] * 1.1, l[1] * 1.1, l[2] * 1.1);
  preview = { model, yaw: preview ? preview.yaw : 0.4, t: 0 };
  model.setVisible(ui.current === 'editor');
}
const PREVIEW = { x: 58.4, z: 49 };
let dragX = null;
$('editor').addEventListener('pointerdown', (e) => {
  if (ui.current !== 'editor' || e.target.closest('.editor-panel')) return;
  dragX = e.clientX; userSpun = true;
  e.preventDefault();
});
let userSpun = false;
window.addEventListener('pointermove', (e) => { if (dragX !== null && preview) { preview.yaw += (e.clientX - dragX) * 0.014; dragX = e.clientX; } });
window.addEventListener('pointerup', () => { dragX = null; });
window.addEventListener('pointercancel', () => { dragX = null; });
$('btn-editor').onclick = () => { buildEditor(); ui.show('editor'); ui.current = 'editor'; makePreview(); };
$('btn-editor-done').onclick = () => { ui.show('menu'); ui.current = 'menu'; if (preview) preview.model.setVisible(false); };
$('btn-editor-random').onclick = () => { settings.look = { ...randomLook(), skin: settings.look.skin }; lookChanged(); };
const nameInput = $('name-input');
nameInput.value = settings.name;
const onName = () => {
  settings.name = nameInput.value.trim().slice(0, 20) || DEFAULTS.name;
  $('card-name').textContent = settings.name;
  saveSettings();
};
nameInput.addEventListener('change', onName);
nameInput.addEventListener('input', () => { $('card-name').textContent = nameInput.value.trim().slice(0, 20) || settings.name; });
$('card-name').textContent = settings.name;
const myName = () => (settings.name || DEFAULTS.name);

// ---------------- menus ----------------
$('ver-n').textContent = `v${CONFIG.VERSION}`;
$('ver-info').textContent = LOCAL_MODE ? 'local test build' : 'online build';
let rotateDismissed = false;
function checkRotate() {
  const portrait = window.innerHeight > window.innerWidth;
  $('rotate').classList.toggle('hidden', !(game && ui.isTouch && portrait && !rotateDismissed));
}
$('rotate-ok').onclick = () => { rotateDismissed = true; checkRotate(); };

document.addEventListener('pointerdown', () => Audio.unlock(), { capture: true });
document.addEventListener('touchstart', () => Audio.unlock(), { capture: true, passive: true });

$('btn-quick').onclick = () => quickPlay();
$('btn-browser').onclick = () => { ui.show('browser'); refreshBrowser(); };
$('btn-private').onclick = () => ui.show('private');
$('btn-offline').onclick = () => startGame('offline', null, { serverLabel: 'Offline' });
$('btn-help').onclick = () => ui.show('help');
$('btn-help-back').onclick = () => ui.show('menu');
$('btn-browser-back').onclick = () => ui.show('menu');
$('btn-refresh').onclick = () => refreshBrowser();
$('btn-private-back').onclick = () => ui.show('menu');
$('btn-create-private').onclick = () => createPrivate();
$('btn-join-private').onclick = () => joinPrivate($('code-input').value);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinPrivate($('code-input').value); });
$('btn-return').onclick = () => ui.show('menu');

// X button: in game -> die/spectate -> menu. In menu -> leave the game.
$('xbtn').addEventListener('click', (e) => {
  e.preventDefault();
  if (game) { if (ui.overlayOpen) { ui.openOverlay(false); input.setActive(true); } input.press('x'); return; }
  leaveWholeGame();
});
function leaveWholeGame() {
  ui.show('left');
  try { window.close(); } catch { /* browsers only allow this for script-opened tabs */ }
}

// ---------------- matchmaking ----------------
let cancelToken = 0;
function failToMenu(msg) {
  ui.show('menu');
  ui.notice(msg);
}

function requireNet() {
  if (netAvailable()) return true;
  failToMenu('Online play could not load (no internet?). You can still Play Offline with bots.');
  return false;
}

async function hostServer(peerId, label, code) {
  const net = await NetHost.create(peerId);
  startGame('host', net, { serverLabel: label, code });
}

async function joinServer(hostId, expectLabel = null) {
  const net = await NetClient.connect(hostId);
  const welcome = await new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(t); net.off('message', onMsg); net.off('close', onClose); fn(v); };
    const onMsg = (m) => {
      if (m.t === 'welcome') done(resolve, m);
      else if (m.t === 'reject') done(reject, { type: 'full', message: m.reason || 'Server is full' });
    };
    const onClose = () => done(reject, { type: 'closed', message: 'The server closed the connection' });
    const t = setTimeout(() => done(reject, { type: 'timeout', message: 'The server did not answer' }), 8000);
    net.on('message', onMsg);
    net.on('close', onClose);
    net.send({ t: 'hello', name: myName(), ap: settings.look });
  }).catch((e) => { net.close(); throw e; });
  // joining a public server by its number: the slot may now hold a different server
  if (expectLabel && welcome.server !== expectLabel) { net.close(); throw { type: 'unavailable', message: 'gone' }; }
  startGame('client', net, { welcome, serverLabel: welcome.server });
}

// Public servers get a 4-digit number like "Public random-4821". The number is random, but its
// remainder (number % slot count) is the server's slot, so two live servers can never share a
// number (only one server can hold a slot at a time), and typing the number joins that server.
const PUB_BASE = 1000;
function publicNumber(slot) {
  const S = CONFIG.NET.PUBLIC_SLOTS, k = Math.floor(Math.random() * Math.floor((9999 - PUB_BASE - (S - 1)) / S + 1));
  return PUB_BASE + k * S + (slot - 1);
}
function publicLabel(slot) { return `Public random-${publicNumber(slot)}`; }
function slotOfNumber(n) {
  const S = CONFIG.NET.PUBLIC_SLOTS;
  return n >= PUB_BASE && n <= 9999 ? ((n - PUB_BASE) % S) + 1 : 0;
}

async function quickPlay() {
  if (!requireNet()) return;
  const token = ++cancelToken;
  ui.loading('Looking for public servers…', () => { cancelToken++; ui.show('menu'); });
  try {
    // join the first open server as soon as it answers instead of waiting for every slot to time out
    const isOpen = (r) => r.info && r.info.humans < r.info.max;
    let first = null, gotFirst;
    const firstOpen = new Promise((res) => { gotFirst = res; });
    const all = probePublicServers((r) => { if (!first && isOpen(r)) { first = r; gotFirst(); } });
    await Promise.race([firstOpen, all]);
    if (token !== cancelToken) return;
    if (first) {
      ui.loading(`Joining ${first.info.name}…`, () => { cancelToken++; ui.show('menu'); });
      try { await joinServer(first.id); return; } catch (e) { console.warn('join failed', e); }
      if (token !== cancelToken) return;
    }
    const results = await all;
    if (token !== cancelToken) return;
    const open = results.filter((r) => isOpen(r) && r !== first)
      .sort((a, b) => b.info.humans - a.info.humans || Math.random() - 0.5);
    for (const r of open) {
      if (token !== cancelToken) return;
      ui.loading(`Joining ${r.info.name}…`, () => { cancelToken++; ui.show('menu'); });
      try { await joinServer(r.id); return; } catch (e) { console.warn('join failed', e); }
    }
    // nobody is playing: become the host of the first free slot
    const free = results.filter((r) => !r.info).map((r) => r.slot);
    for (const slot of free) {
      if (token !== cancelToken) return;
      const label = publicLabel(slot);
      ui.loading(`Starting ${label}…`, () => { cancelToken++; ui.show('menu'); });
      try { await hostServer(publicId(slot), label, null); return; } catch (e) {
        if (e?.type === 'unavailable-id') { try { await joinServer(publicId(slot)); return; } catch { /* next */ } }
        else throw e;
      }
    }
    failToMenu('All public servers are full. Try again or create a private server.');
  } catch (e) {
    if (token !== cancelToken) return;
    console.warn(e);
    failToMenu(netErrorText(e));
  }
}

async function refreshBrowser() {
  if (!requireNet()) return;
  const list = $('server-list');
  list.innerHTML = '<div class="muted">Searching for servers…</div>';
  const rows = new Map();
  try {
    const results = await probePublicServers();
    list.innerHTML = '';
    for (const r of results) {
      const row = document.createElement('div');
      if (r.info) {
        const phase = { waiting: 'Waiting', pre: 'Starting', play: 'In round', post: 'Round over' }[r.info.phase] || '';
        row.className = 'srv';
        row.innerHTML = `<div><div class="name"></div><div class="meta">${r.info.humans} players · ${r.info.total - r.info.humans} bots · ${phase}</div></div>`;
        row.querySelector('.name').textContent = r.info.name;
        const b = document.createElement('button');
        b.className = 'btn small'; b.textContent = r.info.humans >= r.info.max ? 'Full' : 'Join';
        b.disabled = r.info.humans >= r.info.max;
        b.onclick = () => joinFromBrowser(r.id);
        row.appendChild(b);
      } else {
        row.className = 'srv empty';
        const label = publicLabel(r.slot);
        row.innerHTML = `<div><div class="name"></div><div class="meta">Empty — start it and others can join</div></div>`;
        row.querySelector('.name').textContent = label;
        const b = document.createElement('button');
        b.className = 'btn small'; b.textContent = 'Host';
        b.onclick = () => hostFromBrowser(r.slot, label);
        row.appendChild(b);
      }
      rows.set(r.slot, row);
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = '';
    const d = document.createElement('div'); d.className = 'muted'; d.textContent = netErrorText(e);
    list.appendChild(d);
  }
}

async function joinFromBrowser(id) {
  const token = ++cancelToken;
  ui.loading('Joining server…', () => { cancelToken++; ui.show('browser'); });
  try { await joinServer(id); } catch (e) { if (token === cancelToken) { failToMenu(netErrorText(e)); } }
}
async function hostFromBrowser(slot, label = publicLabel(slot)) {
  const token = ++cancelToken;
  ui.loading(`Starting ${label}…`, () => { cancelToken++; ui.show('browser'); });
  try { await hostServer(publicId(slot), label, null); }
  catch (e) {
    if (token !== cancelToken) return;
    if (e?.type === 'unavailable-id') { try { await joinServer(publicId(slot)); return; } catch (e2) { failToMenu(netErrorText(e2)); return; } }
    failToMenu(netErrorText(e));
  }
}

async function createPrivate() {
  if (!requireNet()) return;
  const token = ++cancelToken;
  ui.loading('Creating private server…', () => { cancelToken++; ui.show('private'); });
  for (let i = 0; i < 4; i++) {
    const code = makeCode(5);
    try { await hostServer(privateId(code), 'Private Server', code); return; } catch (e) {
      if (token !== cancelToken) return;
      if (e?.type !== 'unavailable-id') { failToMenu(netErrorText(e)); return; }
    }
  }
  failToMenu('Could not create a server, try again.');
}

async function joinPrivate(code) {
  code = String(code || '').trim().toUpperCase().replace(/^(PUBLIC\s*)?RANDOM-?/, '');
  if (code.length < 4) { ui.notice('Type the server code first.'); ui.show('menu'); return; }
  if (!requireNet()) return;
  // 4 digits = a public server's number (private codes are 5 letters/digits)
  if (/^\d{4}$/.test(code)) {
    const slot = slotOfNumber(+code);
    const label = `Public random-${code}`;
    const token = ++cancelToken;
    ui.loading(`Joining ${label}…`, () => { cancelToken++; ui.show('private'); });
    try {
      if (!slot || slot > CONFIG.NET.PUBLIC_SLOTS) throw { type: 'unavailable' };
      await joinServer(publicId(slot), label);
    } catch (e) {
      if (token !== cancelToken) return;
      failToMenu(e?.type === 'unavailable' ? `No server with number ${code} is running.` : netErrorText(e));
    }
    return;
  }
  const token = ++cancelToken;
  ui.loading(`Joining ${code}…`, () => { cancelToken++; ui.show('private'); });
  try { await joinServer(privateId(code)); } catch (e) {
    if (token !== cancelToken) return;
    failToMenu(e?.type === 'unavailable' ? `No server with code ${code} was found.` : netErrorText(e));
  }
}

function netErrorText(e) {
  if (!e) return 'Something went wrong.';
  if (e.type === 'full') return e.message || 'That server is full.';
  if (e.type === 'unavailable') return e.message || 'Server not found.';
  if (e.type === 'timeout' || e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error')
    return 'Could not reach the online service. Check your internet, or Play Offline.';
  if (e.type === 'browser-incompatible') return 'This browser does not support online play (WebRTC).';
  return e.message || String(e.type || e);
}

// "Tap to play": the first tap goes fullscreen (and sideways on phones) and unlocks sound.
function goFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) return;
  if (goFullscreen.pending) return;                 // one request at a time (two in one tap would fail)
  goFullscreen.pending = true;
  setTimeout(() => { goFullscreen.pending = false; }, 1000);
  const fail = (why) => { ui.notice(why); if (game && !goFullscreen.told) ui.toast(why, '#fd6', 7); goFullscreen.told = true; };
  const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const iPhone = /iPhone|iPod/.test(navigator.userAgent);
  // every browser's spelling of "go fullscreen"
  const fs = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (!fs) {
    fail(iPhone
      ? 'iPhones don\'t let websites go fullscreen. For fullscreen: tap Share → "Add to Home Screen", then open the game from your home screen.'
      : 'This browser can\'t go fullscreen. Open the game in Chrome, or use the browser menu → "Add to Home screen".');
    return;
  }
  const done = () => {
    if (touch) screen.orientation?.lock?.('landscape').catch(() => {});
    setTimeout(() => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement && touch) {
        fail(inFrame ? 'Fullscreen is blocked inside this preview. Open the game\'s website in Chrome to play fullscreen.'
          : 'Your browser blocked fullscreen. Open the game in Chrome, or use the browser menu → "Add to Home screen".');
      }
    }, 700);
  };
  try {
    let p;
    try { p = fs.call(el, { navigationUI: 'hide' }); } catch { p = fs.call(el); }   // older browsers don't take the options
    if (p && p.then) p.then(done).catch((err) => {
      try { const p2 = fs.call(el); if (p2 && p2.then) p2.then(done).catch((e2) => fail(`Fullscreen was refused by the browser (${(e2 || err)?.message || e2 || err}).`)); else done(); } catch { done(); }
    });
    else done();
  } catch { done(); }
}
// (a plain click, exactly like the menu buttons, which every phone browser accepts for fullscreen)
// backup: on phones, the first taps anywhere (menu buttons included) also go fullscreen until it works
document.addEventListener('click', () => {
  if (!touch || goFullscreen.ok || document.fullscreenElement || document.webkitFullscreenElement) return;
  goFullscreen();
}, true);
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) goFullscreen.ok = true; });
$('tapplay').addEventListener('click', () => {
  if ($('tapplay').classList.contains('hidden')) return;
  goFullscreen();
  Audio.unlock();
  $('tapplay').classList.add('hidden');
});
$('inv-x').onclick = () => ui.toggleInventory(null, false);
$('sb-x').addEventListener('click', (e) => { e.preventDefault(); if (ui.game) ui.game.scoreOpen = false; ui.showScoreboard(false); });
$('slbtn').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); game?.toggleShiftLock(); });
$('anchorbtn').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); game?.toggleAnchor(); });

// ---------------- the match ----------------
// The furnished map behind the menu: the same furniture as in a game (just standing still).
// It's removed while you play (the game builds its own) and comes back when you leave.
let menuProps = null;
const menuRoot = new THREE.Group();
function showMenuProps() {
  if (menuProps || game || !map) return;
  if (!menuRoot.parent) scene.add(menuRoot);
  menuProps = new PropSystem(map, menuRoot, textures, false);
  menuProps.render(0, false);
}
function hideMenuProps() {
  if (!menuProps) return;
  menuProps.dispose();
  menuProps = null;
}

function startGame(mode, net, opts) {
  ui.notice('');
  hideMenuProps();
  Audio.unlock();
  if (preview) preview.model.setVisible(false);
  game = new Game({
    mode, net, scene, camera, map, nav, textures, ui, settings,
    myName: myName(), myLook: settings.look, onSettings: saveSettings,
    serverLabel: opts.serverLabel, code: opts.code, welcome: opts.welcome,
    onExit: (reason) => {
      game = null;
      showMenuProps();
      input.setActive(false);
      ui.openOverlay(false);
      ui.show('menu'); ui.current = 'menu';
      if (reason) ui.notice(reason);
      checkRotate();
    },
  });
  ui.game = game;
  ui.input = input;
  ui.show('game'); ui.current = 'game';
  input.setActive(true);
  input.setLockMode(!!settings.shiftLock);
  if (ui.isTouch) {
    // go fullscreen + landscape on phones (tries again in case the start screen's attempt was refused)
    goFullscreen();
    $('touch-hint').style.display = settings.hints ? '' : 'none';
    setTimeout(() => { $('touch-hint').style.display = 'none'; }, 8000);
  }
  checkRotate();
  if (mode === 'host' && opts.code) ui.toast(`Private server code: <b>${opts.code}</b> — share it with friends!`, '#fd6', 10);
  if (mode === 'host' && !opts.code) ui.toast('You are hosting this public server. Keep this tab open!', '#9ad', 7);
  if (settings.hints && !ui.isTouch) ui.toast('Right-drag to turn the camera · L = shift lock · Esc for settings · Mouse wheel to zoom', '#ccc', 7);
}

// If the host hides the tab, keep the server ticking (browsers pause requestAnimationFrame)
setInterval(() => {
  if (document.hidden && game && game.isHost) step(0.05, true);
}, 50);

// ---------------- main loop ----------------
let last = performance.now();
let menuT = 0;
let fpsAcc = 0, fpsN = 0;

function step(dt, background = false) {
  if (!game) return;
  const inp = background ? emptyInput() : input.read();
  if (inp.menu && !ui.overlayOpen) openSettings();
  game.update(dt, inp);
}
const emptyInput = () => ({ fwd: 0, strafe: 0, run: false, jump: false, attack: false, attackHeld: false, equip: false, throw: false, next: false, slot: -1, inv: false, tap: null, point: null, shiftLock: false, anchor: false, x: false, score: false, scoreUp: false, lookDX: 0, lookDY: 0, zoom: 0, toggleView: false, menu: false });

function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  if (!map) return;
  if (game) {
    step(dt);
  } else if (ui.current === 'editor' && preview) {
    // character editor: look at the preview model
    preview.t += dt;
    if (dragX === null && !userSpun) preview.yaw += dt * 0.35; // slow spin until you grab it
    preview.model.setVisible(true);
    preview.model.update(dt, { x: PREVIEW.x, y: 0, z: PREVIEW.z, yaw: preview.yaw, pitch: Math.sin(preview.t * 0.7) * 0.08, speed: 0, onGround: true, weapon: 0 }, 0);
    const wide = window.innerWidth / window.innerHeight;
    camera.rotation.order = 'YXZ';
    if (wide < 1 && window.innerWidth <= 700) {
      // phone upright: the editor sits along the bottom, so show the character centred in the top part
      camera.position.set(PREVIEW.x, 1.25, PREVIEW.z + 4.4);
      camera.lookAt(PREVIEW.x, -0.15, PREVIEW.z);
    } else {
      camera.position.set(PREVIEW.x - 0.1, 1.3, PREVIEW.z + 2.3 + (wide < 1.4 ? 0.7 : 0));
      camera.lookAt(PREVIEW.x - 0.62 * Math.min(1.2, wide / 1.6), 1.05, PREVIEW.z);
    }
    input.read();
  } else {
    // menu background: slow walk through the courtyard
    menuT += dt;
    const c = map.center();
    const a = menuT * 0.05;
    camera.rotation.order = 'YXZ';
    camera.position.set(c.x + Math.cos(a) * 9, 2.6, c.z + Math.sin(a) * 9);
    camera.lookAt(c.x + Math.cos(a + 1.3) * 7, 2.2, c.z + Math.sin(a + 1.3) * 7);
    input.read();
  }
  updateDynLights(dt);
  if (skyDome) { skyDome.position.copy(camera.position); skyDome.position.y -= camera.far * 0.06; skyDome.scale.setScalar(camera.far * 0.9); }
  renderer.render(scene, camera);
  if (settings.fps) {
    // real frame time (not the capped game step), shown twice a second: green 50+, yellow 30-49, red under 30
    fpsAcc += Math.min(1, (now - (frame.lastNow || now)) / 1000); fpsN++;
    if (fpsAcc > 0.5) {
      const f = Math.round(fpsN / fpsAcc), el = $('fps');
      el.textContent = `${f} FPS`;
      el.classList.toggle('ok', f >= 30 && f < 50);
      el.classList.toggle('bad', f < 30);
      fpsAcc = 0; fpsN = 0;
    }
  }
  frame.lastNow = now;
}

// ---------------- startup: build textures, bake the lighting ----------------
async function init() {
  ui.loading('Painting textures…');
  $('loading-cancel').style.display = 'none';
  resize();
  await tick();
  textures = makeTextures(renderer, settings.quality);
  ui.loading('Building the map…'); await tick();
  map = new GameMap();
  const t0 = performance.now();
  const level = map.build(textures, () => {});
  level.traverse((o) => { o.userData.noShadow = true; });   // the level's look is baked; it doesn't cast real shadows
  scene.add(level);
  ui.loading('Lighting the map…'); await tick();
  map.buildProbes();
  nav = new NavGrid(map);
  console.log(`map built + baked in ${Math.round(performance.now() - t0)} ms`);
  // sky dome
  // the sky dome follows the camera and always fits inside the view distance
  // (if it were cut off by the far plane you'd see a flat disc overhead)
  skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshBasicMaterial({ map: textures.sky, side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false }));
  skyDome.renderOrder = -1;
  skyDome.frustumCulled = false;
  scene.add(skyDome);
  // soft glow around every ceiling light (one draw call)
  {
    const lit = map.lights.filter((L) => !L.off);          // no glow around switched-off lights
    const pos = new Float32Array(lit.length * 3);
    lit.forEach((L, i) => pos.set([L.x, L.y - 0.12, L.z], i * 3));
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    glow = new THREE.Points(g, new THREE.PointsMaterial({ map: textures.glow, size: 2.6, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe9c8 }));
    scene.add(glow);
  }
  $('loading-cancel').style.display = '';
  applyAll();
  ui.show('menu'); ui.current = 'menu';
  setTimeout(showMenuProps, 30);       // furniture behind the menu right after it appears (menu shows up sooner)
  requestAnimationFrame(frame);
}
init();

// warn hosts before closing the tab
window.addEventListener('beforeunload', (e) => {
  if (game && game.isHost && game.net && game.net.conns && game.net.conns.size > 0) { e.preventDefault(); e.returnValue = ''; }
});

// debug handle (open the browser console and type GMM)
window.GMM = { get game() { return game; }, get map() { return map; }, get nav() { return nav; }, scene, renderer, CONFIG, startGame, settings, applyAll };
