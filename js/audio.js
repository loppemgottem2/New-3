// Synthesized 3D sound effects using the Web Audio API (no sound files needed).
let ctx = null, master = null, noiseBuf = null;
let volume = 1.0;

export const Audio = {
  // Must be called from a user gesture (tap/click) on mobile
  unlock() {
    try {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = volume;
        // compressor lets everything be louder without crackling
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
        master.connect(comp); comp.connect(ctx.destination);
        const len = ctx.sampleRate * 1.0;
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended') ctx.resume();
    } catch { /* audio unsupported */ }
  },
  setVolume(v) { volume = v; if (master) master.gain.value = v; },

  setListener(x, y, z, fx, fy, fz) {
    if (!ctx) return;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = x; L.positionY.value = y; L.positionZ.value = z;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(x, y, z); L.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  },

  // Returns a destination node: 3D panner if pos given, otherwise master
  _out(pos, ref = 3) {
    if (!pos) return master;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = 1.0; p.maxDistance = 200;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
    else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(master);
    return p;
  },

  _noise(dest, dur, freq, q, type, gainStart, t0 = 0, sweepTo = null) {
    const now = ctx.currentTime + t0;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainStart, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(now, Math.random() * 0.5); src.stop(now + dur + 0.05);
  },

  _tone(dest, freq, dur, gain, type = 'sine', t0 = 0, toFreq = null) {
    const now = ctx.currentTime + t0;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, now);
    if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g); g.connect(dest); o.start(now); o.stop(now + dur + 0.05);
  },

  gunshot(pos) {
    if (!ctx) return;
    const d = this._out(pos, 8);
    this._noise(d, 0.45, 1800, 0.7, 'lowpass', 1.6);
    this._noise(d, 0.12, 4000, 0.5, 'highpass', 0.8);
    this._tone(d, 120, 0.25, 0.9, 'sine', 0, 40);
    // echo
    this._noise(d, 0.6, 900, 0.5, 'lowpass', 0.25, 0.12);
  },
  swing(pos) {
    if (!ctx) return;
    this._noise(this._out(pos, 3), 0.25, 600, 2, 'bandpass', 0.9, 0, 3200);
  },
  stab(pos) {
    if (!ctx) return;
    const d = this._out(pos, 3);
    this._noise(d, 0.2, 500, 1, 'lowpass', 1.3);
    this._tone(d, 90, 0.22, 0.9, 'triangle', 0, 50);
  },
  thud(pos) {
    if (!ctx) return;
    const d = this._out(pos, 3);
    this._tone(d, 70, 0.35, 1.0, 'sine', 0, 35);
    this._noise(d, 0.25, 300, 1, 'lowpass', 0.8);
  },
  // a scatter of tiny grains (crunching gravel / grit): n short noise ticks over `spread` seconds
  _grains(dest, n, spread, fLo, fHi, gain, t0 = 0) {
    for (let k = 0; k < n; k++) {
      const t = t0 + (k / n) * spread + Math.random() * (spread / n);
      this._noise(dest, 0.01 + Math.random() * 0.014, fLo + Math.random() * (fHi - fLo), 2.2, 'bandpass', gain * (1 - (k / n) * 0.55) * (0.6 + Math.random() * 0.6), t);
    }
  },
  // Footstep matched to the floor: a heel strike then the toe, made of shaped noise (no beeping tones).
  // surface = 'tile','wood','carpet','concrete','grass','asphalt','dirty'
  step(pos, loud = 0.6, surface = 'tile', vol = 1) {
    if (!ctx) return;
    const d = this._out(pos, 4);
    const g = loud * vol * (pos ? 1.15 : 0.7);
    const v = 0.9 + Math.random() * 0.2;
    const toe = 0.05 + Math.random() * 0.025;
    switch (surface) {
      case 'grass':
        // soft blades brushing: a muffled heel and an airy rustle, no click at all
        this._noise(d, 0.07, 260 * v, 0.7, 'lowpass', g * 0.35);
        this._env(d, 'bandpass', 3200 * v, 0.6, g * 0.22, 0.02, 0.14);
        this._env(d, 'highpass', 5000 * v, 0.5, g * 0.1, 0.03, 0.1, toe);
        break;
      case 'carpet':
        // dull and quiet
        this._noise(d, 0.08, 320 * v, 0.7, 'lowpass', g * 0.55);
        this._noise(d, 0.06, 260 * v, 0.7, 'lowpass', g * 0.3, toe);
        break;
      case 'wood':
        // hollow boards: a knock with some body, then the toe
        this._noise(d, 0.09, 420 * v, 3, 'bandpass', g * 0.7);
        this._noise(d, 0.05, 180 * v, 1, 'lowpass', g * 0.45);
        this._noise(d, 0.06, 520 * v, 3, 'bandpass', g * 0.35, toe);
        break;
      case 'asphalt':
        // gravelly outdoor ground: heel thud + a scatter of little stones crunching under the shoe
        this._noise(d, 0.06, 240 * v, 0.8, 'lowpass', g * 0.5);
        this._grains(d, 7, 0.09, 1800, 4200, g * 0.16, 0.005);
        this._grains(d, 4, 0.06, 1500, 3500, g * 0.1, toe);
        break;
      case 'concrete':
        // hard stone floor: a dry, gritty scuff (heel, then toe), a touch of grit on top
        this._noise(d, 0.05, 700 * v, 1.2, 'bandpass', g * 0.55);
        this._noise(d, 0.05, 200 * v, 0.8, 'lowpass', g * 0.4);
        this._grains(d, 3, 0.05, 2500, 4500, g * 0.07, 0.01);
        this._noise(d, 0.045, 900 * v, 1.2, 'bandpass', g * 0.3, toe);
        break;
      default: // tile (and the trashed room): a gentle, quiet step on a smooth plastic-y floor -
        // a soft muted tap with a little body (no bright click), then an even softer toe
        this._noise(d, 0.045, 900 * v, 1.1, 'bandpass', g * 0.26);
        this._noise(d, 0.06, 380 * v, 0.7, 'lowpass', g * 0.22);
        this._noise(d, 0.04, 1000 * v, 1.1, 'bandpass', g * 0.13, toe);
        break;
    }
  },
  // filtered noise with a soft attack (rustles)
  _env(dest, type, freq, q, gain, attack, dur, t0 = 0, sweepTo = null) {
    const now = ctx.currentTime + t0;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(now, Math.random() * 0.5); src.stop(now + dur + 0.05);
  },
  // jumping: the shoes push off the floor (a short scuff) and the clothes swish; no pitched "breath"
  jump(pos, surface = 'tile') {
    if (!ctx) return;
    const d = this._out(pos, 4);
    const g = pos ? 0.8 : 0.55;
    if (surface === 'grass') this._env(d, 'bandpass', 2800, 0.6, g * 0.22, 0.01, 0.12);
    else if (surface === 'asphalt') { this._noise(d, 0.05, 260, 0.8, 'lowpass', g * 0.35); this._grains(d, 5, 0.06, 1800, 4000, g * 0.12); }
    else if (surface === 'carpet') this._noise(d, 0.06, 300, 0.7, 'lowpass', g * 0.35);
    else this._noise(d, 0.04, surface === 'wood' ? 450 : 900, 1.4, 'bandpass', g * 0.4);
    this._env(d, 'bandpass', 1100, 0.7, g * 0.16, 0.03, 0.2, 0.01, 600);   // cloth swish
  },
  // landing: a body thud that gets heavier with the fall, plus a firm footstep on that floor
  land(pos, impact = 8, surface = 'tile') {
    if (!ctx) return;
    const d = this._out(pos, 4);
    const k = Math.min(1.4, impact / 8);
    this._noise(d, 0.14, 180, 0.8, 'lowpass', 0.75 * k);
    this._tone(d, 70, 0.12, 0.35 * k, 'sine', 0, 45);
    this.step(pos, 0.9 * k, surface);
  },
  prop(pos, kind = 'wood', v = 0.5) {
    if (!ctx) return;
    const d = this._out(pos, 4);
    const g = 0.3 + v * 0.9;
    if (kind === 'metal') { this._tone(d, 220 + Math.random() * 60, 0.5, g * 0.5, 'triangle', 0, 180); this._tone(d, 523, 0.35, g * 0.25, 'sine'); this._noise(d, 0.1, 2500, 2, 'bandpass', g * 0.6); }
    else if (kind === 'glass') { this._tone(d, 2600 + Math.random() * 900, 0.18, g * 0.35, 'sine'); this._tone(d, 4100 + Math.random() * 500, 0.12, g * 0.2, 'sine', 0.02); }
    else if (kind === 'soft') { this._noise(d, 0.14, 250, 0.7, 'lowpass', g * 0.9); }
    else if (kind === 'cardboard') { this._noise(d, 0.12, 600, 1, 'lowpass', g); this._tone(d, 120, 0.08, g * 0.4, 'sine'); }
    else { this._tone(d, 150 + Math.random() * 40, 0.14, g * 0.8, 'triangle', 0, 90); this._noise(d, 0.08, 1200, 1.4, 'bandpass', g * 0.7); }
  },
  clink(pos) {
    if (!ctx) return;
    const d = this._out(pos, 3);
    this._tone(d, 2400, 0.2, 0.5, 'triangle'); this._tone(d, 3600, 0.14, 0.3, 'triangle', 0.03);
  },
  pickup() {
    if (!ctx) return;
    this._tone(master, 660, 0.12, 0.3, 'triangle'); this._tone(master, 990, 0.18, 0.25, 'triangle', 0.08);
  },
  gunReady() {
    if (!ctx) return;
    this._tone(master, 523, 0.14, 0.25, 'triangle'); this._tone(master, 659, 0.14, 0.25, 'triangle', 0.1); this._tone(master, 784, 0.3, 0.25, 'triangle', 0.2);
  },
  roundStart(seeker) {
    if (!ctx) return;
    if (seeker) { this._tone(master, 110, 1.2, 0.45, 'triangle', 0, 55); this._tone(master, 82, 1.3, 0.35, 'sine'); }
    else { this._tone(master, 330, 0.5, 0.3, 'triangle'); this._tone(master, 440, 0.6, 0.3, 'triangle', 0.15); }
  },
  roundEnd(good) {
    if (!ctx) return;
    const notes = good ? [523, 659, 784] : [392, 330, 262];
    notes.forEach((n, i) => this._tone(master, n, 0.5, 0.3, 'triangle', i * 0.18));
  },
  scream(pos) {
    if (!ctx) return;
    const d = this._out(pos, 4);
    const base = 330 + Math.random() * 160;
    this._tone(d, base, 0.55, 0.28, 'triangle', 0, base * 0.65);
    this._noise(d, 0.45, base * 2.2, 2.5, 'bandpass', 0.14);
  },
  click() {
    if (!ctx) return;
    this._tone(master, 900, 0.04, 0.12, 'sine');
  },
  // menu / button press: a short, clean, snappy select tick (back = a touch lower, for close / back / no)
  _lastUi: 0,
  uiSelect(back = false) {
    if (!ctx) return;
    const t = performance.now();
    if (t - this._lastUi < 40) return;      // one press = one tick
    this._lastUi = t;
    const f = back ? 820 : 1180;
    this._tone(master, f, 0.055, 0.17, 'sine', 0, f * 0.72);            // the body of the tick
    this._tone(master, f * 2.02, 0.03, 0.045, 'triangle');                // a little shine on top
    this._noise(master, 0.014, 5200, 0.8, 'highpass', 0.06);              // the crisp click at the very start
  },
};
