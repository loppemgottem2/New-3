// Small math / helper functions shared by every module.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const DEG = Math.PI / 180;

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Wrap angle to [-PI, PI]
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

// Shortest signed difference b - a
export const angleDiff = (a, b) => wrapAngle(b - a);

// Turn `cur` toward `target` by at most `maxStep` radians
export function turnToward(cur, target, maxStep) {
  const d = angleDiff(cur, target);
  if (Math.abs(d) <= maxStep) return target;
  return wrapAngle(cur + Math.sign(d) * maxStep);
}

// Convention: yaw 0 looks toward -Z (same as a three.js camera).
export const forwardX = (yaw) => -Math.sin(yaw);
export const forwardZ = (yaw) => -Math.cos(yaw);
export const yawTo = (dx, dz) => Math.atan2(-dx, -dz);

// Direction vector from yaw + pitch
export function dirFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

export function makeCode(len = 5) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

export function hexToCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

// Same color, but lightened if it's too dark to read as text on a dark HUD
export function textColor(hex) {
  let r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.38) {
    const k = (0.38 - lum) / 0.38 * 0.75 + 0.2;
    r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// localStorage wrapped in try/catch (private mode etc.)
export const store = {
  get(key, def) {
    try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
  },
};

// Tiny event emitter
export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  off(ev, fn) { const a = this._h[ev]; if (a) this._h[ev] = a.filter((f) => f !== fn); return this; }
  emit(ev, ...args) { const a = this._h[ev]; if (a) for (const f of a.slice()) f(...args); }
}
