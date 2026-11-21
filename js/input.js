// Input: keyboard + mouse (pointer lock) on desktop, virtual joystick +
// drag-to-look + buttons on touch screens. Each finger is tracked by its
// touch identifier so moving, looking and pressing buttons all work at once.
import { CONFIG } from './config.js?v=190';
import { clamp } from './util.js?v=190';

export const isTouchDevice = () =>
  ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
  (window.matchMedia?.('(pointer: coarse)').matches ?? true);

export class Input {
  constructor({ touchRoot, canvas, joyBase, joyKnob }) {
    this.touchRoot = touchRoot;
    this.canvas = canvas;
    this.joyBase = joyBase;
    this.joyKnob = joyKnob;
    this.active = false;        // true while in a match
    this.keys = new Set();
    this.lookDX = 0; this.lookDY = 0;
    this.joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.lookTouches = new Map(); // touch id -> {x,y}
    this.btnTouches = new Map();  // touch id -> button name
    this.edges = {};
    this.held = {};
    this.mouseSens = CONFIG.CONTROLS.MOUSE_SENS;
    this.touchSens = 1;      // touch look multiplier: 1 = the view follows your finger exactly
    this.fovDeg = 75;        // camera field of view (set from settings), used to turn pixels into angles
    this.locked = false;
    this.lockMode = false;   // shift lock: mouse is captured (pointer lock). Off: free cursor, right-drag turns the camera
    this.mouse = null;       // cursor position on screen (free cursor mode)
    this.point = null;       // where the last click happened (free cursor mode)
    this.canvas = canvas;
    this.isTouch = isTouchDevice();
    this.zoom = 0;
    this.lefty = false;     // left-handed: joystick on the right

    // ---------- keyboard ----------
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.code;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(k)) e.preventDefault();
      if (!this.keys.has(k)) {
        if (k === 'Space') this.press('jump');
        if (k === 'KeyQ') this.press('equip');
        if (k === 'KeyG' || k === 'KeyR') this.press('throw');
        if (k === 'KeyX') this.press('x');
        if (k === 'KeyF' || k === 'KeyE') this.press('next');
        if (k === 'Tab') this.press('score');
        if (k === 'KeyV') this.press('toggleView');
        if (k === 'KeyP' || k === 'Escape') this.press('menu');
        if (k === 'KeyI' || k === 'KeyB') this.press('inv');
        if (k === 'KeyL') this.press('shiftLock');
        if (/^Digit[1-9]$/.test(k)) this.slotKey = +k.slice(5) - 1;   // hotbar 1-5
      }
      this.keys.add(k);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') this.press('scoreUp');
    });
    window.addEventListener('blur', () => this.clearAll());

    // ---------- mouse ----------
    canvas.addEventListener('click', () => {
      if (this.active && !this.isTouch && !this.locked && this.lockMode) canvas.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      if (this.locked || this.dragR) {
        this.lookDX += e.movementX * this.mouseSens;
        this.lookDY += e.movementY * this.mouseSens;
      }
      if (!this.locked) this.mouse = { x: e.clientX, y: e.clientY };
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.active || this.isTouch) return;
      if (this.locked) {
        if (e.button === 0) { this.press('attack'); this.held.attack = true; }
        if (e.button === 2) this.press('throw');
        return;
      }
      // free cursor (shift lock off): left click acts on the spot under the cursor, right-drag turns the camera
      if (e.target !== canvas) return;
      if (e.button === 0) { this.press('attack'); this.held.attack = true; this.point = { x: e.clientX, y: e.clientY }; }
      if (e.button === 2) this.dragR = true;
    });
    document.addEventListener('mouseup', (e) => { if (e.button === 0) this.held.attack = false; if (e.button === 2) this.dragR = false; });
    document.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
    // mouse wheel = zoom camera in/out
    window.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.zoom += e.deltaY > 0 ? 0.6 : -0.6;
    }, { passive: true });

    // ---------- touch ----------
    const opts = { passive: false };
    touchRoot.addEventListener('touchstart', (e) => this.onTouchStart(e), opts);
    touchRoot.addEventListener('touchmove', (e) => this.onTouchMove(e), opts);
    touchRoot.addEventListener('touchend', (e) => this.onTouchEnd(e), opts);
    touchRoot.addEventListener('touchcancel', (e) => this.onTouchEnd(e), opts);
    // stop iOS pinch-zoom / double-tap zoom while playing
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => { if (this.active) e.preventDefault(); });
  }

  press(name) { this.edges[name] = true; }

  moveJoy(x, y) {
    const R = CONFIG.CONTROLS.JOYSTICK_RADIUS;
    let dx = x - this.joy.ox, dy = y - this.joy.oy;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    this.joy.x = dx / R; this.joy.y = dy / R;
    this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  // shift lock on = capture the mouse; off = release it so the cursor can aim
  setLockMode(on) {
    this.lockMode = on;
    if (this.isTouch) return;
    if (!on && this.locked) document.exitPointerLock?.();
    if (on && this.active && !this.locked) { try { const r = this.canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* needs a click */ } }
  }

  onTouchStart(e) {
    if (!this.active) return;
    e.preventDefault();
    this.isTouch = true;
    for (const t of e.changedTouches) {
      const btn = t.target && t.target.closest ? t.target.closest('[data-btn]') : null;
      if (btn) {
        const name = btn.dataset.btn;
        if (name === 'run') { // sprint is a toggle on phones
          this.runToggle = !this.runToggle;
          btn.classList.toggle('on', this.runToggle);
          continue;
        }
        this.btnTouches.set(t.identifier, { name, el: btn });
        btn.classList.add('down');
        this.press(name);
        this.held[name] = true;
        // the attack button also works as a look-drag area (shoot + aim with one thumb)
        if (name === 'attack') this.lookTouches.set(t.identifier, { x: t.clientX, y: t.clientY, btn: true });
        continue;
      }
      const onJoySide = !this.noJoy && (this.lefty ? t.clientX > window.innerWidth * 0.58 : t.clientX < window.innerWidth * 0.42);
      if (onJoySide && this.joy.id === null) {
        // the joystick stays where it is: the finger steers relative to its fixed center
        const j = this.joy;
        const r = this.joyBase.getBoundingClientRect();
        j.id = t.identifier; j.ox = r.left + r.width / 2; j.oy = r.top + r.height / 2; j.x = 0; j.y = 0;
        this.moveJoy(t.clientX, t.clientY);
      } else {
        // sx/sy/t0/moved: lets a quick tap (not a drag) on the screen pick things (props: tap furniture to become it)
        this.lookTouches.set(t.identifier, { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t0: performance.now() });
      }
    }
  }

  // two free fingers on the look side = pinch to zoom the camera
  pinchPair() {
    const ids = [...this.lookTouches.entries()].filter(([, v]) => !v.btn);
    return ids.length >= 2 ? [ids[0][1], ids[1][1]] : null;
  }

  onTouchMove(e) {
    if (!this.active) return;
    e.preventDefault();
    const pair0 = this.pinchPair();
    const d0 = pair0 ? Math.hypot(pair0[0].x - pair0[1].x, pair0[0].y - pair0[1].y) : 0;
    if (pair0) {
      // update positions only; no looking around while pinching
      for (const t of e.changedTouches) {
        if (t.identifier === this.joy.id) continue;
        const lt = this.lookTouches.get(t.identifier);
        if (lt && !lt.btn) { lt.x = t.clientX; lt.y = t.clientY; }
      }
      const pair1 = this.pinchPair();
      const d1 = Math.hypot(pair1[0].x - pair1[1].x, pair1[0].y - pair1[1].y);
      this.zoom += (d0 - d1) * 0.02; // fingers apart = zoom in, together = zoom out
    }
    for (const t of e.changedTouches) {
      if (pair0 && t.identifier !== this.joy.id && this.lookTouches.get(t.identifier) && !this.lookTouches.get(t.identifier).btn) continue;
      if (t.identifier === this.joy.id) { this.moveJoy(t.clientX, t.clientY); continue; }
      const lt = this.lookTouches.get(t.identifier);
      if (lt) {
        const dx = t.clientX - lt.x, dy = t.clientY - lt.y;
        lt.x = t.clientX; lt.y = t.clientY;
        // ignore absurd jumps (finger lifted & re-landed reported as a move on some browsers)
        if (Math.abs(dx) < 300 && Math.abs(dy) < 300) {
          // 1:1 with your finger: the view turns exactly as far as the finger moved,
          // times the sensitivity setting. Drag right = look right, drag up = look up.
          const k = ((this.fovDeg * Math.PI) / 180 / Math.max(1, window.innerHeight)) * this.touchSens;
          this.lookDX += dx * k;
          this.lookDY += dy * k;
        }
      }
    }
  }

  onTouchEnd(e) {
    e.preventDefault?.();
    for (const t of e.changedTouches) {
      if (t.identifier === this.joy.id) {
        this.joy.id = null; this.joy.x = 0; this.joy.y = 0;
        this.joyKnob.style.transform = 'translate(-50%,-50%)';
      }
      const lt = this.lookTouches.get(t.identifier);
      if (lt && !lt.btn && lt.t0 && performance.now() - lt.t0 < 300 && Math.hypot(t.clientX - lt.sx, t.clientY - lt.sy) < 14) {
        this.tap = { x: t.clientX, y: t.clientY };
      }
      this.lookTouches.delete(t.identifier);
      const b = this.btnTouches.get(t.identifier);
      if (b) {
        this.btnTouches.delete(t.identifier);
        b.el.classList.remove('down');
        // only release if no other finger still holds this button
        if (![...this.btnTouches.values()].some((o) => o.name === b.name)) this.held[b.name] = false;
      }
    }
  }

  clearAll() {
    this.keys.clear();
    this.joy.id = null; this.joy.x = 0; this.joy.y = 0;
    if (this.joyKnob) this.joyKnob.style.transform = 'translate(-50%,-50%)';
    this.lookTouches.clear();
    for (const b of this.btnTouches.values()) b.el.classList.remove('down');
    this.btnTouches.clear();
    this.held = {}; this.edges = {};
    this.lookDX = this.lookDY = 0;
  }

  setActive(on) {
    this.active = on;
    this.clearAll();
    this.runToggle = false;
    document.getElementById('tb-run')?.classList.remove('on');
    if (!on && document.pointerLockElement) document.exitPointerLock?.();
  }

  // Called once per frame by the game. Returns this frame's input and resets edges.
  read() {
    const k = this.keys;
    let fwd = 0, strafe = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) strafe += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) strafe -= 1;
    let run = k.has('ShiftLeft') || k.has('ShiftRight');
    if (this.joy.id !== null) {
      fwd = -this.joy.y; strafe = this.joy.x;
      if (this.autoSprint !== false && Math.hypot(this.joy.x, this.joy.y) >= CONFIG.CONTROLS.JOYSTICK_RUN_AT) run = true;
    }
    if (this.runToggle) run = true;
    const len = Math.hypot(fwd, strafe);
    if (len > 1) { fwd /= len; strafe /= len; }
    // small dead zone for the stick
    if (len < 0.12) { fwd = 0; strafe = 0; }
    const out = {
      fwd, strafe, run,
      jump: !!this.edges.jump || !!this.held.jump || k.has('Space'),
      attack: !!this.edges.attack,
      attackHeld: !!this.held.attack,
      equip: !!this.edges.equip,
      throw: !!this.edges.throw,
      next: !!this.edges.next,
      slot: this.slotKey ?? -1,
      inv: !!this.edges.inv,
      tap: this.tap || null,
      point: this.point || null,
      shiftLock: !!this.edges.shiftLock,
      x: !!this.edges.x,
      score: !!this.edges.score,
      zoom: this.zoom,
      toggleView: !!this.edges.toggleView,
      menu: !!this.edges.menu,
      scoreUp: !!this.edges.scoreUp,
      lookDX: this.lookDX,
      lookDY: clamp(this.lookDY, -2, 2),
    };
    this.edges = {};
    this.slotKey = null; this.tap = null; this.point = null;
    this.lookDX = 0; this.lookDY = 0; this.zoom = 0;
    return out;
  }
}
