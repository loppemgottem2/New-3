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
  // Footstep matched to the floor. surface = 'tile','wood','carpet','concrete','grass','asphalt','dirty'
  step(pos, loud = 0.6, surface = 'tile', vol = 1) {
    if (!ctx) return;
    const d = this._out(pos, 4);
    const g = loud * vol * (pos ? 1.3 : 0.9);
    const vary = 0.9 + Math.random() * 0.2;
    switch (surface) {
      case 'grass':
        // soft crunchy rustle: high, airy noise with a slow-ish attack and no knock
        this._env(d, 'highpass', 2600 * vary, 0.5, g * 0.55, 0.025, 0.16);
        this._env(d, 'bandpass', 5200 * vary, 0.8, g * 0.3, 0.04, 0.12, 0.03);
        this._noise(d, 0.08, 300, 0.7, 'lowpass', g * 0.25);
        break;
      case 'carpet':
        this._noise(d, 0.09, 380 * vary, 0.7, 'lowpass', g * 0.8);
        this._tone(d, 65 * vary, 0.08, g * 0.35, 'sine');
        break;
      case 'wood':
        // hollow boards: low knock + a little creak
        this._tone(d, 160 * vary, 0.1, g * 0.7, 'triangle', 0, 95);
        this._noise(d, 0.07, 900 * vary, 1.6, 'bandpass', g * 0.55);
        if (Math.random() < 0.15) this._tone(d, 420 + Math.random() * 200, 0.12, g * 0.08, 'sawtooth', 0.02, 380);
        break;
      case 'concrete': case 'asphalt':
        // gritty scuff on hard ground
        this._noise(d, 0.06, 1500 * vary, 1.1, 'bandpass', g * 0.75);
        this._noise(d, 0.05, 3200, 0.9, 'highpass', g * 0.25, 0.012);
        this._tone(d, 85 * vary, 0.06, g * 0.45, 'sine');
        break;
      default: // tile: a firm, short "tock" (no hiss)
        this._noise(d, 0.04, 1100 * vary, 1.2, 'lowpass', g * 0.8);
        this._tone(d, 210 * vary, 0.05, g * 0.45, 'triangle', 0, 150);
        this._tone(d, 95, 0.06, g * 0.35, 'sine');
        break;
    }
  },
  // filtered noise with a soft attack (rustles)
  _env(dest, type, freq, q, gain, attack, dur, t0 = 0) {
    const now = ctx.currentTime + t0;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(now, Math.random() * 0.5); src.stop(now + dur + 0.05);
  },
  jump(pos) {
    if (!ctx) return;
    const d = this._out(pos, 4);
    this._noise(d, 0.18, 700, 1.2, 'bandpass', 0.55, 0, 1600); // cloth whoosh
    this._tone(d, 180, 0.12, 0.25, 'sine', 0, 140);              // little breath
  },
  land(pos, impact = 8) {
    if (!ctx) return;
    const d = this._out(pos, 4);
    const k = Math.min(1.6, impact / 7);
    this._tone(d, 75, 0.22, 0.9 * k, 'sine', 0, 38);
    this._noise(d, 0.16, 450, 1, 'lowpass', 0.9 * k);
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
    this._tone(master, 880, 0.1, 0.45, 'square'); this._tone(master, 1320, 0.15, 0.4, 'square', 0.08);
  },
  gunReady() {
    if (!ctx) return;
    this._tone(master, 660, 0.12, 0.3, 'square'); this._tone(master, 990, 0.12, 0.3, 'square', 0.1); this._tone(master, 1320, 0.25, 0.3, 'square', 0.2);
  },
  roundStart(seeker) {
    if (!ctx) return;
    if (seeker) { this._tone(master, 110, 1.2, 0.5, 'sawtooth', 0, 55); this._tone(master, 116, 1.2, 0.3, 'sawtooth'); }
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
    const base = 500 + Math.random() * 300;
    this._tone(d, base, 0.6, 0.35, 'sawtooth', 0, base * 0.6);
    this._noise(d, 0.5, base * 2, 3, 'bandpass', 0.2);
  },
  click() {
    if (!ctx) return;
    this._tone(master, 1200, 0.04, 0.15, 'square');
  },
};
