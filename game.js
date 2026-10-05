/* ============================================================
   EL SILBÓN: NOCHE EN EL LLANO
   Arcade survival runner — 100% procedural.
   Phaser 3 Graphics/Canvas + Web Audio API. Zero external assets.
   Myth rule (inverted whistle):
     LOUD whistle  -> El Silbón is FAR   (obstacle phase)
     FAINT whistle -> El Silbón is BEHIND YOU (act or die)
   Ported to the Platanus arcade cabinet: 800x600, CABINET_KEYS
   input and platanusArcadeStorage bridge.
   ============================================================ */
'use strict';

const W = 800, H = 600, GY = 500, PX = 150;

const COL = {
  poncho: 0x8a4232, poncho2: 0x63301f, skin: 0xc79a6b, hat: 0xa8843a,
  pants: 0x2c2836, boot: 0x171320, sil: 0x0d0d15, eye: 0xff2417,
  grass: 0x7a5f28, grass2: 0x503f16, light: 0xffd27a, bag: 0x8f6f46,
  kero: 0xc26a2a, bark: 0x241a12, mud: 0x2e1d12, mudTop: 0x452b18
};

/* La noche avanza: 4 niveles por distancia (m). AMANECER termina en victoria. */
const LEVELS = [
  { name: 'ANOCHER', at: 0, spawn: 1.0, dur: 0.88 },
  { name: 'MEDIA NOCHE', at: 900, spawn: 1.22, dur: 0.82 },
  { name: 'MADRUGADA', at: 1800, spawn: 1.45, dur: 0.74 },
  { name: 'AMANECER', at: 2700, spawn: 1.7, dur: 0.66 }
];
const NIGHT_LEN = 3600;          // meters for dawn
const NIGHT_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI'];

const R = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const ov = (ax, ay, aw, ah, bx, by, bw, bh) =>
  ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

/* ---------------- Arcade cabinet input ---------------------------------------
   CABINET_KEYS maps each arcade button to keyboard keys. It matches the real
   cabinet wiring: do NOT modify or replace keys. Game logic only ever reads
   the arcade codes (P1_U, START1...), never raw keyboard keys. */
const CABINET_KEYS = {
  P1_U: ['w'], P1_D: ['s'], P1_L: ['a'], P1_R: ['d'],
  P1_1: ['u'], P1_2: ['i'], P1_3: ['o'],
  P1_4: ['j'], P1_5: ['k'], P1_6: ['l'],
  P2_U: ['ArrowUp'], P2_D: ['ArrowDown'], P2_L: ['ArrowLeft'], P2_R: ['ArrowRight'],
  P2_1: ['r'], P2_2: ['t'], P2_3: ['y'],
  P2_4: ['f'], P2_5: ['g'], P2_6: ['h'],
  START1: ['Enter'], START2: ['2']
};

const KEY_TO_ARCADE = {};
for (const [code, keys] of Object.entries(CABINET_KEYS)) {
  for (const key of keys) {
    KEY_TO_ARCADE[key.length === 1 ? key.toLowerCase() : key] = code;
  }
}

const held = Object.create(null);
let PR = Object.create(null);        // edges: true only on the frame a button goes down
let heldPrev = {};                   // snapshot of held[] from the previous frame

window.addEventListener('keydown', (e) => {
  const code = KEY_TO_ARCADE[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (code) held[code] = true;
});
window.addEventListener('keyup', (e) => {
  const code = KEY_TO_ARCADE[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (code) held[code] = false;
});

/* ---------------- SFX: Web Audio synthesizer (100% procedural) ----------------- */
const SFX = {
  ctx: null, master: null, noise: null, rainG: null, drone: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    this.ctx = new C();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    const sr = this.ctx.sampleRate, len = sr * 2;
    const buf = this.ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // Rain: looping white noise -> lowpass
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1300; f.Q.value = 0.4;
    this.rainG = this.ctx.createGain();
    this.rainG.gain.value = 0.055;
    src.connect(f); f.connect(this.rainG); this.rainG.connect(this.master);
    src.start();
  },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  setRain(v, t) { if (this.rainG) this.rainG.gain.linearRampToValueAtTime(v, this.now() + (t || 0.4)); },
  // The whistle: C5-E5-G5-C6. Far = loud and clear. Near = faint, muffled, human tremolo.
  whistle(near, volMul) {
    if (!this.ctx) return;
    const t0 = this.now() + 0.02, seq = [523.25, 659.25, 783.99, 1046.5];
    const step = near ? 0.34 : 0.17, vol = (near ? 0.05 : 0.5) * (volMul || 1);
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * step, dur = step * 0.94, base = near ? seq[i] * 0.92 : seq[i];
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(),
        lfo = this.ctx.createOscillator(), lg = this.ctx.createGain(),
        fl = this.ctx.createBiquadFilter();
      o.type = 'sine';
      o.frequency.setValueAtTime(base, t);
      o.frequency.linearRampToValueAtTime(base * 1.035, t + dur);
      lfo.frequency.value = near ? 9.5 : 5.5;          // wind vibrato / human tremolo
      lg.gain.value = base * (near ? 0.06 : 0.016);
      lfo.connect(lg); lg.connect(o.frequency);
      fl.type = 'lowpass'; fl.frequency.value = near ? 1100 : 6800;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(fl); fl.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.05);
      lfo.start(t); lfo.stop(t + dur + 0.05);
    }
  },
  // released pack: three barks, sawtooth chirps through a bandpass
  dogs() {
    if (!this.ctx) return;
    const t0 = this.now() + 0.02;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.17, base = R(190, 270);
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(),
        f = this.ctx.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.5, t + 0.1);
      f.type = 'bandpass'; f.frequency.value = base * 2.2; f.Q.value = 1.6;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(f); f.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.14);
    }
  },
  thunder() {
    if (!this.ctx) return;
    const t = this.now() + 0.01, s = this.ctx.createBufferSource(),
      f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = this.noise; s.loop = true;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 1.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.75, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 1.6);
  },
  step() {
    if (!this.ctx) return;
    const t = this.now(), o = this.ctx.createOscillator(),
      f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(R(88, 102), t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.05);
    f.type = 'lowpass'; f.frequency.value = 260;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.08);
  },
  squelch() {
    if (!this.ctx) return;
    const t = this.now(), o = this.ctx.createOscillator(),
      f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.12);
    f.type = 'lowpass'; f.frequency.value = 180;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.14);
  },
  gust() {
    if (!this.ctx) return;
    const t = this.now(), s = this.ctx.createBufferSource(),
      f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = this.noise; s.loop = true;
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(320, t);
    f.frequency.exponentialRampToValueAtTime(1600, t + 0.45);
    f.frequency.exponentialRampToValueAtTime(380, t + 0.95);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 1);
  },
  pickup() {
    if (!this.ctx) return;
    const t = this.now(), o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.linearRampToValueAtTime(1318, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.18);
  },
  kero() {
    if (!this.ctx) return;
    for (let i = 0; i < 2; i++) {
      const t = this.now() + i * 0.09, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(520 + i * 160, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.13, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.1);
    }
  },
  lantern() {
    if (!this.ctx) return;
    const t = this.now(), s = this.ctx.createBufferSource(),
      f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = this.noise; s.loop = true;
    f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.2, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 0.4);
    const o = this.ctx.createOscillator(), g2 = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(1560, t + 0.04);
    g2.gain.setValueAtTime(0.0001, t + 0.04);
    g2.gain.linearRampToValueAtTime(0.1, t + 0.06);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g2); g2.connect(this.master);
    o.start(t + 0.04); o.stop(t + 0.32);
  },
  fail() {
    if (!this.ctx) return;
    const t = this.now(), o = this.ctx.createOscillator(),
      f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.16);
    f.type = 'lowpass'; f.frequency.value = 500;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.22);
  },
  scare() {
    if (!this.ctx) return;
    const t = this.now();
    [55, 58.5, 110].forEach(fr => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = fr;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.9);
    });
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = this.noise; s.loop = true;
    f.type = 'lowpass'; f.frequency.value = 900;
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 0.55);
    const o = this.ctx.createOscillator(), g2 = this.ctx.createGain(),
      lfo = this.ctx.createOscillator(), lg = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1750, t);
    o.frequency.linearRampToValueAtTime(900, t + 0.55);
    lfo.frequency.value = 28; lg.gain.value = 220;
    lfo.connect(lg); lg.connect(o.frequency);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.28, t + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g2); g2.connect(this.master);
    o.start(t); o.stop(t + 0.65);
    lfo.start(t); lfo.stop(t + 0.65);
  },
  droneOn() {
    if (!this.ctx || this.drone) return;
    const t = this.now(), o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 44;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.3);
    o.connect(g); g.connect(this.master);
    o.start(t);
    this.drone = { o, g };
  },
  droneOff() {
    if (!this.drone) return;
    const t = this.now(), d = this.drone;
    this.drone = null;
    d.g.gain.linearRampToValueAtTime(0.0001, t + 0.4);
    d.o.stop(t + 0.45);
  }
};

/* ---------------- Game state (single mutated object) ------------------------- */
const S = { mode: 'boot', t: 0 };
let best = 0;
// Sandboxed iframes throw just by TOUCHING localStorage: guard the access itself.
try { best = +(window.localStorage.getItem('silbon_best') || 0) || 0; } catch (e) { best = 0; }

let scene, G = {};

/* Arcade storage bridge: async read overrides the local best when the cabinet
   has one saved. Value shape may change over releases (number or {score:n}),
   so validate both and never let storage errors break the game. */
(async () => {
  try {
    const b = window.platanusArcadeStorage;
    if (!b || !b.get) return;
    const r = await b.get('silbon_best');
    let v = r && r.found ? r.value : null;
    if (v && typeof v === 'object' && typeof v.score === 'number') v = v.score;
    if (typeof v === 'number' && isFinite(v) && v > best) {
      best = Math.floor(v);
      if (scene && scene.menuT) scene.menuT[7].setText('MEJOR: ' + best);
    }
  } catch (e) {}
})();

// Fire-and-forget persistence: cabinet bridge when present, guarded localStorage otherwise.
function saveBest(n) {
  best = n;
  try {
    const b = window.platanusArcadeStorage;
    if (b && b.set) { b.set('silbon_best', { score: n }).catch(() => {}); }
    else window.localStorage.setItem('silbon_best', '' + n);
  } catch (e) {}
  if (scene && scene.menuT) scene.menuT[7].setText('MEJOR: ' + best);
}

class Main extends Phaser.Scene {
  create() {
    scene = this;

    buildTextures(this);
    buildLayers(this);
    buildTexts(this);
    resetRun(true);
    window.SILBON = S; // debug / testing handle
    window.SILG = G;

    this.input.on('pointerdown', () => {
      if (S.mode === 'menu' || S.mode === 'over') { SFX.init(); startRun(); }
    });
  }

  update(_, delta) {
    const dt = Math.min(delta, 50) / 1000;
    S.t += dt;

    // Per-frame edge detection: PR.X is true only on the frame X goes down.
    PR = Object.create(null);
    for (const k in held) if (held[k] && !heldPrev[k]) PR[k] = true;
    heldPrev = Object.assign({}, held);

    if (S.mode === 'menu') menuUpdate(dt);
    else if (S.mode === 'run') runUpdate(dt);
    else if (S.mode === 'paralyzed') paralyzedUpdate(dt);
    else if (S.mode === 'dying') dyingUpdate(dt);
    else overUpdate(dt);

    if ((PR.START1 || PR.START2) && (S.mode === 'menu' || S.mode === 'over')) {
      SFX.init();
      startRun();
    }

    drawWorld(dt);
    updatePops(dt);
    drawEnts();
    drawFearFx();
    drawChars();
    drawFx(dt);
    drawHud(dt);
  }
}

/* ---------------- State reset ------------------------------------------------ */
function resetRun(toMenu) {
  S.mode = toMenu ? 'menu' : 'run';
  S.dist = 0; S.speed = 255; S.rph = 0; S.wx = 0; S.runT = 0;
  S.paralyses = 0; S.mudT = 0; S.thr = 0;
  S.dogs = 0; S.dogFx = null;
  S.level = 0; S.night = 1; S.levelAt = 0; S.dawned = false; S.dawnT = 0;
  S.speedHint = false;
  S.player = { y: GY, vy: 0, ground: true, duck: false };
  S.face = 1; S.faceT = 0;
  S.fear = 0; S.kero = 100; S.bags = 0; S.bagPts = 0; S.repPts = 0; S.svPts = 0;
  S.slowT = 0; S.invT = 0; S.parT = 0; S.dieT = 0; S.hudT = 0; S.stepT = 0.3;
  S.spawnT = 1.7; S.pickT = 2.6; S.grassT = 2.2;
  S.obst = []; S.picks = []; S.grass = [];
  S.ltn = { next: R(5, 10), t: 0, a: 0 };
  S.threat = {
    near: false, nearT: 0, winT: 0, winMax: 1.15, farT: 0, farDur: R(4.2, 6),
    echoDone: false, recoilT: 0, ambT: R(4, 8), ambShow: 0,
    swoop: null, swoopDone: false, swoopsSeen: 0, whistlesSeen: 0, seenHint: false
  };
  S.hint = { msg: '', t: 0 };
  if (!toMenu) showHint('SILBIDO FUERTE = ESTA LEJOS  ·  SILBIDO CASI MUDO = ¡ESTA ATRAS!', 4.5);
}

function startRun() {
  resetRun(false);
  scene.menuT.forEach(o => o.setVisible(false));
  scene.overT.forEach(o => o.setVisible(false));
  scene.hudT.forEach(o => o.setVisible(true));
}

function gameOver() {
  S.mode = 'over';
  S.hint.t = 0;
  SFX.droneOff();
  const sc = scoreTotal();
  if (sc > best) saveBest(sc);
  scene.tOver1.setText('EL SILBON TE ALCANZO');
  scene.tOver2.setText('PUNTOS ' + sc + '   ·   ' + Math.floor(S.dist) + ' m   ·   BOLSAS x' + S.bags +
    (S.paralyses ? '   ·   MIEDO x' + S.paralyses : ''));
  scene.tOver3.setText('MEJOR: ' + best);
  scene.hudT.forEach(o => o.setVisible(false));
  scene.overT.forEach(o => o.setVisible(true));
}

function scoreTotal() { return Math.floor(S.dist) + S.bagPts + S.repPts + S.svPts; }

function showHint(msg, secs) { S.hint.msg = msg; S.hint.t = secs; }

/* Floating score popups */
function popScore(msg, color) {
  const p = scene.pops[(S.popI = (S.popI || 0) + 1) % scene.pops.length];
  p.age = 0;
  p.t.setText(msg).setColor(color).setPosition(PX + 28, GY - 80).setVisible(true);
}

function updatePops(dt) {
  for (const p of scene.pops) {
    if (p.age > 0.9) continue;
    p.age += dt;
    p.t.y = GY - 80 - p.age * 44;
    p.t.setAlpha(Math.max(0, 1 - p.age / 0.9));
    if (p.age > 0.9) p.t.setVisible(false);
  }
}

/* ---------------- Mode updates ------------------------------------------------ */
function menuUpdate(dt) {
  S.rph += dt * 2;
  if (S.hint.t > 0) S.hint.t -= dt;
}

function runUpdate(dt) {
  const p = S.player;
  S.runT += dt;
  const diff = clamp(S.dist / 3000, 0, 1);
  S.speed = 255 + 185 * diff;

  // --- arcade input: throttle / jump / duck / fast-fall ---
  S.thr = (held.P1_R || held.P2_R) ? 1 : (held.P1_L || held.P2_L) ? -1 : 0;
  if ((PR.P1_U || PR.P2_U) && p.ground) {
    p.vy = -640; p.ground = false; p.duck = false; SFX.step();
  }
  const duckHeld = held.P1_D || held.P2_D;
  if (p.ground) {
    p.duck = duckHeld;
  } else {
    p.duck = false;
    if (duckHeld) p.vy += 1400 * dt; // fast-fall
  }

  // --- physics ---
  if (!p.ground) {
    p.vy += 1800 * dt;
    p.y += p.vy * dt;
    if (p.y >= GY) { p.y = GY; p.vy = 0; p.ground = true; SFX.step(); }
  }

  // --- lantern turn (body in drawChars) + dogs of water ---
  if (PR.P1_1 || PR.P2_1) attemptLantern();
  if (PR.P1_2 || PR.P2_2) releaseDogs();
  if (S.faceT > 0) { S.faceT -= dt; if (S.faceT <= 0) S.face = 1; }

  // --- world scroll (throttle: accelerate for meters, brake to breathe) ---
  let mul = 1;
  if (S.slowT > 0) { S.slowT -= dt; mul = 0.55; }
  mul *= S.thr > 0 ? 1.45 : S.thr < 0 ? 0.55 : 1;
  if (S.invT > 0) S.invT -= dt;
  const sp = S.speed * mul;
  S.wx += sp * dt;
  S.dist += sp * dt / 10;
  S.rph += dt * (6 + sp * 0.022);
  G.ground.tilePositionX += sp * dt;

  // footsteps synced to run cycle
  if (p.ground) {
    S.stepT -= dt;
    if (S.stepT <= 0) { S.stepT = 0.3; SFX.step(); }
  }
  if (!S.speedHint && S.runT > 12) {
    S.speedHint = true;
    showHint('MANTEN [D] PARA ACELERAR  ·  [A] PARA FRENAR', 3);
  }
  scrollLayer(G.palmFar, sp * 0.16 * dt, 260, 460, 0.55);
  scrollLayer(G.palmNear, sp * 0.30 * dt, 240, 430, 1);
  updateFarm(dt, sp);
  scrollLayer(G.shrubs, sp * 0.55 * dt, 200, 380, 0.85);

  if (S.kero < 100 && !S.threat.near) S.kero = Math.min(100, S.kero + 3.5 * dt);
  if (!S.threat.near && S.fear > 0) S.fear = Math.max(0, S.fear - 3 * dt);

  threatUpdate(dt);   // the inverted whistle cycle
  lightningUpdate(dt);
  obstUpdate(dt);
  updateGrass(dt);
  if (S.hint.t > 0) S.hint.t -= dt;
}

function paralyzedUpdate(dt) {
  S.parT -= dt;
  S.rph += dt * 3;
  const sp = S.speed * 0.25;
  S.wx += sp * dt;
  S.dist += sp * dt / 10;
  G.ground.tilePositionX += sp * dt;
  if (S.parT <= 0) {
    S.mode = 'run';
    SFX.droneOff();
    showHint('¡RESPIRA! SIGUE CORRIENDO...', 2);
  }
}

function dyingUpdate(dt) {
  S.dieT += dt;
  if (S.dieT > 0.95) gameOver();
}

function overUpdate(dt) { S.rph += dt; }

/* ---------------- Threat AI: the inverted whistle cycle ------------------------ */
function threatUpdate(dt) {
  const th = S.threat, diff = clamp(S.dist / 3000, 0, 1);
  if (th.recoilT > 0) th.recoilT -= dt;

  if (!th.near) {
    // myth pressure: braking invites him closer, running away pulls him back a bit
    th.farT += dt * (S.thr < 0 ? 1.3 : S.thr > 0 ? 0.92 : 1);
    // ambient distant flicker of his silhouette
    if (th.ambShow > 0) th.ambShow -= dt;
    else {
      th.ambT -= dt;
      if (th.ambT <= 0) { th.ambT = R(5, 9); th.ambShow = 0.4; th.ambX = R(26, 84); }
    }
    // loud whistle at far-phase start + mid echo
    if (!th.whistled) {
      th.whistled = true;
      SFX.whistle(false);
    }
    if (!th.echoDone && th.farT > th.farDur * 0.55) {
      th.echoDone = true;
      SFX.whistle(false, 0.6);
    }
    // charge attack (ground rush from behind, myth-true): jump to dodge
    if (!th.swoop && !th.swoopDone && th.farT > 1.2 && th.farT < th.farDur - 1.6 && Math.random() < dt * 0.16) {
      th.swoop = { x: -140, y: GY + 6, t: 0, resolved: false };
      th.swoopDone = true;
      SFX.gust();
      S.threat.swoopsSeen++;
      if (S.threat.swoopsSeen <= 2) showHint('¡VIENE A LA CARRERA! SALTA', 2.5);
    }
    if (th.swoop) {
      const sw = th.swoop;
      sw.t += dt;
      sw.x += (S.speed * 1.2 + 300) * (S.thr < 0 ? 1.22 : 1) * dt;
      sw.y = GY + 6 - Math.abs(Math.sin(sw.t * 9)) * 4;
      if (!sw.resolved && sw.x > PX - 30) {
        sw.resolved = true;
        if (!S.player.ground) {
          S.svPts += 25;
          popScore('+25', '#8fd0a0');
          showHint('¡SALTASTE! +25', 1.2);
        } else {
          S.fear = clamp(S.fear + 25, 0, 100);
          S.slowT = 0.6;
          scene.cameras.main.shake(150, 0.005);
          SFX.fail();
        }
      }
      if (sw.x > W + 160) th.swoop = null;
    }
    // far phase ends -> he is RIGHT BEHIND YOU
    if (th.farT >= th.farDur) {
      th.near = true;
      th.winMax = 1.15 - 0.43 * diff;
      th.winT = th.winMax;
      th.swoop = null;
      SFX.whistle(true);
      SFX.setRain(0.022, 0.5);
      S.threat.whistlesSeen++;
      if (S.threat.whistlesSeen === 1) showHint('¡SILBIDO CASI MUDO! PULSA [U] YA', 2.2);
    }
  } else {
    // near phase: act within the window or die. Terror climbs while he's close.
    th.winT -= dt;
    S.fear = clamp(S.fear + 12 * dt, 0, 100);
    if (th.winT <= 0) {
      S.mode = 'dying';
      S.dieT = 0;
      SFX.scare();
      SFX.setRain(0.055, 0.2);
      scene.cameras.main.shake(700, 0.012);
    }
  }
}

function attemptLantern() {
  if (S.mode !== 'run') return;
  S.face = -1;
  S.faceT = 0.55;
  const th = S.threat;
  if (th.near) {
    if (S.kero >= 15) {
      S.kero = Math.max(0, S.kero - 25);
      th.near = false;
      th.recoilT = 0.55;
      th.farT = 0; th.whistled = false; th.echoDone = false;
      th.farDur = R(4.2, 6) - clamp(S.dist / 3000, 0, 1) * 1.8;
      th.swoopDone = false;
      S.fear = clamp(S.fear - 20, 0, 100);
      S.repPts += 50;
      popScore('+50', '#ff9a6a');
      SFX.lantern();
      SFX.setRain(0.055, 0.6);
      showHint('¡AHUYENTADO! +50', 1.2);
    } else {
      SFX.fail();
      showHint('SIN KEROSENE...', 1.2);
    }
  } else {
    S.kero = Math.max(0, S.kero - 8);
    SFX.fail();
    showHint('LA LINTERNA SOLO SIRVE CUANDO EL SILBIDO ES MUDO', 1.6);
  }
}

/* Dogs of water: myth-true repellent. Carry max 2, release with [I]. */
function releaseDogs() {
  if (S.mode !== 'run' || S.dogs <= 0) return;
  S.dogs--;
  S.dogFx = { t: 0 };
  const th = S.threat;
  if (th.near) {
    th.near = false;
    th.recoilT = 0.55;
    th.farT = 0; th.whistled = false; th.echoDone = false;
    th.farDur = R(4.2, 6) - clamp(S.dist / 3000, 0, 1) * 1.8;
    th.swoopDone = false;
    S.fear = clamp(S.fear - 30, 0, 100);
    S.repPts += 75;
    popScore('+75 ¡JAURIA!', '#9fd8ff');
    SFX.setRain(0.055, 0.6);
  } else {
    th.farDur += 2.2;   // spent early: the next silence takes longer to come
    popScore('JAURIA SUELTA', '#9fd8ff');
  }
  SFX.dogs();
  showHint('¡LOS PERROS DE AGUA AHUYENTAN AL SILBON!', 2);
}

/* ---------------- Lightning: 100ms whiteout revealing his silhouette ----------- */
function lightningUpdate(dt) {
  const L = S.ltn;
  L.t += dt;
  if (L.on) {
    if (!L.thDone && L.t >= 0.26) { L.thDone = true; SFX.thunder(); }
    L.a = L.t < 0.05 ? 0.88 : L.t < 0.09 ? 0.12 : L.t < 0.17 ? 0.78 : L.t < 0.26 ? 0 : L.t < 0.3 ? 0.45 : 0;
    if (L.t > 0.34) { L.on = false; L.a = 0; L.t = 0; L.next = R(6, 13); }
  } else if (L.t >= L.next && S.mode === 'run' && !S.threat.near) {
    L.on = true; L.a = 0.88; L.t = 0; L.thDone = false;
    S.fear = clamp(S.fear + 4, 0, 100);
  }
}

/* ---------------- Obstacles, pickups, fear paralysis --------------------------- */
function playerBox() {
  const p = S.player;
  return p.duck && p.ground
    ? { x: PX - 13, y: p.y - 26, w: 26, h: 26 }
    : { x: PX - 12, y: p.y - 48, w: 24, h: 48 };
}

function stumble(f) {
  S.fear = clamp(S.fear + f, 0, 100);
  S.invT = 1;
  S.slowT = Math.max(S.slowT, 0.5);
  scene.cameras.main.shake(140, 0.005);
  SFX.fail();
}

function triggerParalysis() {
  S.mode = 'paralyzed';
  S.parT = 1.6;
  S.paralyses = (S.paralyses || 0) + 1;
  showHint(S.bags > 0 ? '¡EL MIEDO TE PARALIZO! PERDISTE ' + S.bags + ' BOLSAS' : '¡EL MIEDO TE PARALIZO!', 2.2);
  if (S.bags > 0) popScore('-BOLSAS', '#ff5545');
  S.bags = 0;
  S.bagPts = 0;
  S.fear = 42;
  const th = S.threat;
  if (th.near) { th.near = false; th.recoilT = 0.55; SFX.setRain(0.055, 0.6); }
  th.farT = 0; th.whistled = false; th.echoDone = false; th.swoopDone = false;
  th.farDur = R(4.2, 6) - clamp(S.dist / 3000, 0, 1) * 1.8;
  SFX.droneOn();
  scene.cameras.main.shake(300, 0.006);
}

function obstUpdate(dt) {
  const diff = clamp(S.dist / 3000, 0, 1);
  const mul = S.slowT > 0 ? 0.55 : 1;

  if (S.fear >= 100 && S.mode === 'run') triggerParalysis();
  if (S.mode !== 'run') return;

  // spawns only while he is far
  if (!S.threat.near) {
    S.spawnT -= dt * (0.85 + 0.5 * diff);
    if (S.spawnT <= 0) {
      S.spawnT = R(1.25, 1.9) - 0.6 * diff;
      const r = Math.random();
      if (r < 0.36) S.obst.push({ t: 'mud', x: W + 70, w: R(60, 92) });
      else if (r < 0.74 || S.runT < 25) S.obst.push({ t: 'log', x: W + 70, w: 34, h: 20 });
      else S.obst.push({ t: 'gust', x: W + 70, w: 56, y: R(GY - 76, GY - 62) });
    }
    S.pickT -= dt;
    if (S.pickT <= 0) {
      S.pickT = R(2.1, 3.4) - 0.7 * diff;
      if (S.dogs < 2 && Math.random() < 0.16) {
        S.picks.push({ t: 'dog', x: W + R(90, 220), bob: R(0, 6.28) });
      } else {
        const isKero = S.kero < 25 || Math.random() < (S.kero < 40 ? 0.55 : 0.28);
        S.picks.push({ t: isKero ? 'kero' : 'bag', x: W + R(90, 220), bob: R(0, 6.28) });
      }
    }
  }

  const pb = playerBox();
  for (let i = S.obst.length - 1; i >= 0; i--) {
    const o = S.obst[i];
    o.x -= S.speed * mul * dt * (o.t === 'gust' ? 1.7 : 1);
    if (o.x + o.w < -80) { S.obst.splice(i, 1); continue; }
    if (o.t === 'mud') {
      if (S.player.ground && ov(PX - 12, GY - 6, 24, 6, o.x, GY - 8, o.w, 8)) {
        S.slowT = Math.max(S.slowT, 0.15);
        S.mudT = (S.mudT || 0) + dt;
        if (S.mudT > 0.24) { S.mudT = 0; SFX.squelch(); }
        S.fear = clamp(S.fear + 6 * dt, 0, 100);
      }
    } else if (o.t === 'log') {
      if (S.invT <= 0 && ov(pb.x, pb.y, pb.w, pb.h, o.x, GY - o.h, o.w, o.h)) stumble(15);
    } else if (!S.player.duck && S.invT <= 0 && ov(pb.x, pb.y, pb.w, pb.h, o.x, o.y, o.w, 30)) {
      stumble(10);
      S.obst.splice(i, 1);
    }
  }

  for (let i = S.picks.length - 1; i >= 0; i--) {
    const k = S.picks[i];
    k.x -= S.speed * mul * dt;
    k.bob += dt * 3;
    if (k.x < -60) { S.picks.splice(i, 1); continue; }
    const by = GY - 24 + Math.sin(k.bob) * 4;
    if (ov(pb.x, pb.y, pb.w, pb.h, k.x - 9, by - 14, 18, 20)) {
      if (k.t === 'bag') { S.bags++; S.bagPts += 100; SFX.pickup(); popScore('+100', '#ffd27a'); }
      else if (k.t === 'dog') { S.dogs = Math.min(2, S.dogs + 1); SFX.pickup(); popScore('+PERRO', '#9fd8ff'); }
      else { S.kero = Math.min(100, S.kero + 34); SFX.kero(); popScore('+KEROSENE', '#e0a33b'); }
      S.picks.splice(i, 1);
    }
  }
}

/* ---------------- Entity drawing ------------------------------------------------ */
function drawEnts() {
  const g = G.entG;
  g.clear();
  for (const o of S.obst) {
    if (o.t === 'mud') {
      g.fillStyle(COL.mud, 1);
      g.fillEllipse(o.x + o.w / 2, GY + 3, o.w, 14);
      g.fillStyle(COL.mudTop, 0.75);
      g.fillEllipse(o.x + o.w / 2, GY + 1, o.w * 0.8, 8);
    } else if (o.t === 'log') {
      g.fillStyle(COL.bark, 1);
      g.fillRoundedRect(o.x, GY - 20, 34, 20, 6);
      g.lineStyle(2, 0x3c2b1b, 1);
      g.strokeEllipse(o.x + 10, GY - 10, 9, 11);
      g.strokeEllipse(o.x + 25, GY - 10, 6, 8);
    } else {
      g.lineStyle(2, 0x9fb8e8, 0.45);
      for (let i = 0; i < 4; i++) {
        const yy = o.y + i * 8;
        g.lineBetween(o.x, yy, o.x + o.w, yy - 6);
      }
    }
  }
  for (const k of S.picks) {
    const by = GY - 24 + Math.sin(k.bob) * 4;
    if (k.t === 'bag') {
      g.fillStyle(COL.bag, 1);
      g.fillEllipse(k.x, by, 20, 16);
      g.fillStyle(0x6e5636, 1);
      g.fillRect(k.x - 3, by - 11, 6, 5);
      g.fillStyle(0xd8cfc0, 1);
      g.fillCircle(k.x - 4, by - 2, 2);
      g.fillCircle(k.x + 3, by + 2, 2.2);
      g.fillCircle(k.x + 1, by - 5, 1.8);
    } else if (k.t === 'dog') {
      // water dog pickup: dark silhouette with a wet shine, bobbing
      g.fillStyle(0x27404d, 1);
      g.fillEllipse(k.x, by, 22, 12);
      g.fillCircle(k.x + 8, by - 6, 5);
      g.fillRect(k.x + 5, by - 13, 3, 6);
      g.fillRect(k.x - 12, by - 3, 8, 2);
      g.fillStyle(0x8fd0e8, 1);
      g.fillCircle(k.x + 9, by - 7, 1.2);
      g.fillCircle(k.x, by - 11, 1.4);
    } else {
      g.fillStyle(0x7a4a22, 1);
      g.fillRect(k.x - 6, by - 12, 12, 20);
      g.fillStyle(0xc26a2a, 1);
      g.fillRect(k.x - 6, by - 6, 12, 8);
      g.fillStyle(0x3a2a1a, 1);
      g.fillRect(k.x - 2, by - 16, 4, 5);
    }
  }
}

/* ---------------- Grass patches (paja pelua) ---------------------------------- */
function updateGrass(dt) {
  S.grassT -= dt;
  if (S.grassT <= 0) {
    S.grassT = R(5, 9);
    const blades = [];
    const n = 16;
    for (let i = 0; i < n; i++) {
      blades.push({ ox: R(-46, 46), h: R(16, 30), ph: R(0, 6.28), c: Math.random() < 0.5 });
    }
    S.grass.push({ x: W + 60, w: 100, blades });
  }
  for (let i = S.grass.length - 1; i >= 0; i--) {
    S.grass[i].x -= S.speed * dt;
    if (S.grass[i].x < -120) S.grass.splice(i, 1);
  }
}

function inGrass() {
  for (const g of S.grass) {
    if (S.player.duck && Math.abs(PX - g.x) < g.w / 2 - 8) return true;
  }
  return false;
}

function scrollLayer(arr, dx, gapMin, gapMax, alphaReset) {
  let lastX = -1e9;
  for (const im of arr) {
    im.x -= dx;
    if (im.x > lastX) lastX = im.x;
  }
  for (const im of arr) {
    if (im.x < -90) {
      im.x = lastX + R(gapMin, gapMax);
      lastX = im.x;
    }
  }
}

/* Farm layer: rare barns/fences at mid parallax */
function updateFarm(dt, sp) {
  let lastX = -1e9;
  for (const im of G.farm) {
    im.x -= sp * 0.42 * dt;
    if (im.x > lastX) lastX = im.x;
  }
  for (const im of G.farm) {
    if (im.x < -160) {
      im.x = lastX + R(700, 1500);
      lastX = im.x;
      if (Math.random() < 0.62) { im.setTexture('granero').setScale(R(0.9, 1.12)); }
      else { im.setTexture('cerca').setScale(1); }
    }
  }
}

/* ---------------- Textures (all generated by code) ---------------------------- */
function mkCanvas(key, w, h, fn) {
  if (scene.textures.exists(key)) return;
  const ct = scene.textures.createCanvas(key, w, h);
  fn(ct.context, w, h);
  ct.refresh();
}

function buildTextures(sc) {
  // Night sky: vertical gradient + horizon glow
  mkCanvas('sky', W, H, (x) => {
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#020108'); g.addColorStop(0.45, '#0a0518');
    g.addColorStop(0.78, '#190b2e'); g.addColorStop(1, '#291342');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const rg = x.createRadialGradient(W / 2, GY + 50, 20, W / 2, GY + 50, 430);
    rg.addColorStop(0, 'rgba(122,62,142,0.18)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = rg; x.fillRect(0, 0, W, H);
  });

  // Vignette
  mkCanvas('vig', W, H, (x) => {
    const rg = x.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.82);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.55)');
    x.fillStyle = rg; x.fillRect(0, 0, W, H);
  });

  // Crescent moon
  mkCanvas('moon', 56, 56, (x) => {
    x.fillStyle = 'rgba(216,212,232,0.16)';
    x.beginPath(); x.arc(28, 28, 26, 0, 7); x.fill();
    x.fillStyle = '#cfcbe4';
    x.beginPath(); x.arc(28, 28, 13, 0, 7); x.fill();
    x.globalCompositeOperation = 'destination-out';
    x.beginPath(); x.arc(35, 23, 12, 0, 7); x.fill();
  });

  // Ground tile
  mkCanvas('ground', 256, H - GY, (x, w, h) => {
    x.fillStyle = '#171020'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#2b1d3a'; x.fillRect(0, 0, w, 4);
    x.fillStyle = '#100a18'; x.fillRect(0, 4, w, 2);
    for (let i = 0; i < 150; i++) {
      x.fillStyle = Math.random() < 0.5 ? 'rgba(60,42,86,0.5)' : 'rgba(10,6,16,0.6)';
      x.fillRect(R(0, w), R(6, h), R(1, 2.6), R(1, 2));
    }
    for (let i = 0; i < 10; i++) {
      x.fillStyle = 'rgba(80,62,102,0.45)';
      x.fillRect(R(0, w), R(10, h - 4), R(2, 4), 2);
    }
  });

  // Moriche palms (trig fronds), 3 variants
  for (let v = 0; v < 3; v++) {
    if (scene.textures.exists('palm' + v)) continue;
    const g = sc.make.graphics({ add: false });
    const seed = v * 1.7, cx = 45;
    g.fillStyle(0x140b24, 1);
    let px = cx;
    for (let i = 0; i <= 16; i++) {
      const tt = i / 16;
      const x2 = cx + Math.sin(tt * 2.4 + seed) * 7 + tt * 6;
      const y2 = 128 - (128 - 18) * tt;
      g.fillRect(x2 - 3, y2 - 4, 6, 9);
      px = x2;
    }
    for (let a = 0; a < 8; a++) {
      const ang = Math.PI * (a / 7);
      for (let k = 1; k <= 11; k++) {
        const tt = k / 11, rr = 6 + tt * 34;
        const x2 = px + Math.cos(ang) * rr * 0.9;
        const y2 = 20 + Math.sin(ang) * rr * 0.42 + tt * tt * 16 + seed;
        g.fillRect(x2 - 2, y2 - 1.5, 5, 3);
      }
    }
    g.generateTexture('palm' + v, 90, 132);
    g.destroy();
  }

  // Shrub silhouette
  if (!scene.textures.exists('shrub')) {
    const g = sc.make.graphics({ add: false });
    g.fillStyle(0x120a1e, 1);
    g.fillEllipse(30, 20, 46, 16);
    g.fillEllipse(16, 22, 24, 11);
    g.fillEllipse(44, 22, 26, 12);
    g.fillRect(28, 20, 4, 9);
    g.generateTexture('shrub', 60, 30);
    g.destroy();
  }

  // Granero llanero: hipped thatch roof (cuatro aguas), vertical plank walls, stilts
  if (!scene.textures.exists('granero')) {
    const g = sc.make.graphics({ add: false });
    g.fillStyle(0x150c12, 1);
    g.fillRect(34, 128, 7, 30); g.fillRect(78, 128, 7, 30);
    g.fillRect(118, 128, 7, 30); g.fillRect(160, 128, 7, 30);
    g.fillRect(24, 126, 154, 5);
    g.fillStyle(0x241419, 1);
    g.fillRect(30, 74, 142, 52);
    g.lineStyle(2, 0x170c10, 1);
    for (let x2 = 38; x2 < 170; x2 += 9) g.lineBetween(x2, 76, x2, 124);
    g.fillStyle(0x0a0508, 1);
    g.fillRect(52, 88, 40, 38);
    g.lineStyle(2, 0x3a2430, 1);
    g.strokeRect(52, 88, 40, 38);
    g.fillStyle(0x0a0508, 1);
    g.fillRect(122, 90, 20, 16);
    g.strokeRect(122, 90, 20, 16);
    g.fillStyle(0x2c1b14, 1);
    g.fillPoints([{ x: 55, y: 28 }, { x: 147, y: 28 }, { x: 188, y: 70 }, { x: 14, y: 70 }], true);
    g.lineStyle(2, 0x1e120c, 1);
    for (let i = 1; i < 5; i++) {
      const t2 = i / 5, yl = 28 + 42 * t2;
      g.lineBetween(55 - 41 * t2 + 4, yl, 147 + 41 * t2 - 4, yl);
    }
    g.lineStyle(3, 0x3a2430, 1);
    g.lineBetween(53, 28, 149, 28);
    g.lineStyle(2, 0x2c1b14, 1);
    for (let x2 = 16; x2 < 188; x2 += 7) {
      g.lineBetween(x2, 70, x2, 70 + 4 + (x2 % 3) * 3);
    }
    g.lineStyle(2, 0x3a2430, 1);
    g.lineBetween(101, 28, 101, 12);
    g.lineBetween(95, 17, 107, 17);
    g.generateTexture('granero', 202, 160);
    g.destroy();
  }

  // Cerca: fence segment
  if (!scene.textures.exists('cerca')) {
    const g = sc.make.graphics({ add: false });
    g.fillStyle(0x1a0f15, 1);
    g.fillRect(4, 10, 7, 30); g.fillRect(56, 10, 7, 30); g.fillRect(108, 10, 7, 30);
    g.fillRect(0, 16, 120, 4); g.fillRect(0, 28, 120, 4);
    g.generateTexture('cerca', 120, 40);
    g.destroy();
  }
}

/* ---------------- Layers & texts ---------------------------------------------- */
function buildLayers(sc) {
  sc.add.image(0, 0, 'sky').setOrigin(0);
  G.stars = [];
  for (let i = 0; i < 70; i++) G.stars.push({ x: R(0, W), y: R(4, 380), r: R(0.7, 1.8), ph: R(0, 6.28), sp: R(0.5, 2) });
  G.starG = sc.add.graphics();
  sc.add.image(650, 96, 'moon');

  G.palmFar = []; G.palmNear = [];
  for (let i = 0; i < 4; i++) {
    const im = sc.add.image(i * 280 + R(0, 120), GY + 6, 'palm' + (i % 3)).setOrigin(0.5, 1).setAlpha(0.45).setScale(0.62);
    G.palmFar.push(im);
  }
  for (let i = 0; i < 3; i++) {
    const im = sc.add.image(i * 380 + R(0, 160), GY + 10, 'palm' + ((i + 1) % 3)).setOrigin(0.5, 1).setAlpha(0.9);
    G.palmNear.push(im);
  }
  G.farm = [];
  for (let i = 0; i < 2; i++) {
    const im = sc.add.image(480 + i * 940 + R(0, 160), GY + 4, 'granero').setOrigin(0.5, 1).setAlpha(0.94).setScale(R(0.95, 1.12));
    G.farm.push(im);
  }
  G.shrubs = [];
  for (let i = 0; i < 6; i++) {
    const im = sc.add.image(i * 200 + R(0, 90), GY + 3, 'shrub').setOrigin(0.5, 1).setAlpha(0.85);
    G.shrubs.push(im);
  }

  G.ground = sc.add.tileSprite(0, GY, W, H - GY, 'ground').setOrigin(0);
  G.grassG = sc.add.graphics();
  G.entG = sc.add.graphics();
  G.fearFxG = sc.add.graphics();
  G.playerG = sc.add.graphics();
  G.silbG = sc.add.graphics();
  G.rain = [];
  for (let i = 0; i < 90; i++) G.rain.push({ x: R(0, W + 60), y: R(-40, H), l: R(10, 18), sp: R(0.7, 1.4), a: R(0.16, 0.4) });
  G.rainG = sc.add.graphics();
  sc.add.image(0, 0, 'vig').setOrigin(0);
  G.fxG = sc.add.graphics();
  G.hudG = sc.add.graphics();
}

function buildTexts(sc) {
  const T = (x, y, s, size, color, o) =>
    sc.add.text(x, y, s, Object.assign({ fontFamily: 'monospace', fontSize: size, color: color }, o || {}));
  // Menu
  sc.menuT = [
    T(W / 2, 130, 'EL SILBON', '56px', '#e8d9b0', { fontStyle: 'bold' }).setOrigin(0.5),
    T(W / 2, 180, 'NOCHE EN EL LLANO', '17px', '#9a86c8').setOrigin(0.5),
    T(W / 2, 224, '"Si el silbido suena LEJOS... ya esta ENCIMA de ti."', '13px', '#b7a6e0').setOrigin(0.5),
    T(W / 2, 262, '[W/\u2191] Saltar   [S/\u2193] Agacharse   [D/\u2192] Acelerar   [A/\u2190] Frenar', '12px', '#cfc4a0').setOrigin(0.5),
    T(W / 2, 283, '[U] Linterna   [I] Perros de agua   \u00b7   Sobrevive la noche y vera amanecer', '11px', '#8f86ad').setOrigin(0.5),
    T(W / 2, 304, 'Corre, roba sus bolsas de huesos y sigue corriendo hasta el alba.', '10px', '#8f86ad').setOrigin(0.5),
    T(W / 2, 430, 'PRESIONA ENTER / CLIC PARA CORRER', '16px', '#ffd27a', { fontStyle: 'bold' }).setOrigin(0.5),
    T(W / 2, 556, '100% PROCEDURAL · 0 ASSETS · <50KB', '10px', '#6f6a86').setOrigin(0.5),
    T(W - 10, 10, best ? 'MEJOR: ' + best : '', '11px', '#7d7396').setOrigin(1, 0)
  ];
  // HUD
  sc.hudT = [
    sc.tScore = T(W - 12, 12, 'PUNTOS 0', '17px', '#e8d9b0', { fontStyle: 'bold' }).setOrigin(1, 0),
    sc.tBags = T(W - 12, 34, 'BOLSAS x0 · 0 m', '11px', '#b3a8cc').setOrigin(1, 0),
    sc.tL1 = T(32, 2, 'MIEDO', '8px', '#9a8fb0'),
    sc.tL2 = T(32, 22, 'KEROSENE', '8px', '#9a8fb0'),
    sc.tHint = T(W / 2, 564, '', '11px', '#ffd9a0').setOrigin(0.5),
    sc.tState = T(W / 2, 10, '', '13px', '#9a86c8', { fontStyle: 'bold' }).setOrigin(0.5)
  ];
  sc.hudT.forEach(o => o.setVisible(false));
  // floating score popups pool
  sc.pops = [];
  for (let i = 0; i < 8; i++) {
    sc.pops.push({ t: T(0, 0, '', '13px', '#ffd27a', { fontStyle: 'bold' }).setOrigin(0.5).setVisible(false), age: 9 });
  }
  // Game over
  sc.overT = [
    sc.tOver1 = T(W / 2, 248, '', '40px', '#e05545', { fontStyle: 'bold' }).setOrigin(0.5),
    sc.tOver2 = T(W / 2, 302, '', '14px', '#e8d9b0').setOrigin(0.5),
    sc.tOver3 = T(W / 2, 330, '', '12px', '#9a86c8').setOrigin(0.5),
    T(W / 2, 372, 'ENTER / CLIC — REINTENTAR', '14px', '#ffd27a').setOrigin(0.5)
  ];
  sc.overT.forEach(o => o.setVisible(false));
}

/* ---------------- World drawing ------------------------------------------------ */
function drawWorld(dt) {
  const g = G.starG, t = S.t;
  g.clear();
  for (const st of G.stars) {
    const a = 0.2 + 0.75 * Math.abs(Math.sin(t * st.sp + st.ph));
    g.fillStyle(0xd8d4ee, a * 0.9);
    g.fillRect(st.x, st.y, st.r, st.r);
  }

  // Rain: diagonal lines, variable alpha, wind slant
  const wind = (Math.sin(t * 0.6) + 1) * 0.5;
  const rg = G.rainG;
  rg.clear();
  rg.lineStyle(1, 0x8fa8d8, 1);
  const slant = 0.3 + wind * 0.35;
  for (const d of G.rain) {
    d.y += d.sp * 520 * dt;
    d.x -= d.sp * 520 * dt * slant;
    if (d.y > H + 12) { d.y = R(-50, -5); d.x = R(0, W + 90); }
    if (d.x < -20) d.x += W + 110;
    rg.alpha = d.a;
    rg.lineBetween(d.x, d.y, d.x + d.l * slant, d.y + d.l);
  }
  rg.alpha = 1;

  // Paja pelua patches
  const gg = G.grassG;
  gg.clear();
  for (const patch of S.grass) {
    for (const b of patch.blades) {
      const sway = Math.sin(t * 3.2 + b.ph) * 2.6 + wind * 2;
      gg.lineStyle(2, b.c ? COL.grass : COL.grass2, 0.95);
      gg.lineBetween(patch.x + b.ox, GY + 2, patch.x + b.ox + sway, GY + 2 - b.h);
    }
  }
}

/* ---------------- Characters ---------------------------------------------------- */
function drawChars() {
  const pg = G.playerG, sg = G.silbG;
  pg.clear(); sg.clear();

  if (S.mode === 'menu') {
    drawSilbon(sg, 118, GY + 8, 1, 0.62, {});
    drawLlanero(pg, { idle: true });
    return;
  }
  if (S.mode === 'dying' || S.mode === 'over') {
    drawLlanero(pg, { frozen: true });
    const s = S.mode === 'over' ? 5.2 : 1.8 + Math.min(1, S.dieT / 0.4) * 3.4;
    drawSilbon(sg, PX + 40, 300 + 136 * s, s, S.mode === 'over' ? 0.35 : 0.95, { scare: true });
    return;
  }

  // run / paralyzed
  drawLlanero(pg, {});

  const th = S.threat;
  if (th.near) {
    drawSilbon(sg, PX - 92, GY + 6, 1.05, 0.96, { lit: true, lean: true });
  } else if (th.recoilT > 0) {
    const k = 1 - th.recoilT / 0.55;
    drawSilbon(sg, PX - 92 - k * 340, GY + 6, 1.05, 0.9 * (1 - k), {});
  } else if (th.swoop) {
    const sw = th.swoop;
    drawSilbon(sg, sw.x, sw.y, 0.9, 0.9, { blinkFast: true, lean: true });
    // warning shadow on the ground + alert mark
    if (!sw.resolved) {
      sg.fillStyle(0x000000, 0.35);
      sg.fillEllipse(PX, GY + 6, 46, 8);
      sg.fillStyle(0xff6a3a, 0.7 + 0.3 * Math.sin(S.t * 14));
      sg.fillTriangle(PX - 7, GY - 84, PX + 7, GY - 84, PX, GY - 70);
      sg.fillRect(PX - 2.5, GY - 68, 5, 12);
    }
  } else if (th.ambShow > 0) {
    drawSilbon(sg, th.ambX, GY + 8, 1, 0.16, {});
  }
}

function drawLlanero(g, o) {
  const p = S.player, t = S.t;
  const duck = p.duck && p.ground;
  const air = !p.ground;
  const shX = PX + (S.mode === 'paralyzed' ? Math.sin(t * 55) * 2 : 0);
  const flash = S.invT > 0 && Math.floor(t * 18) % 2 === 0;

  const footY = p.y;
  const hipY = footY - (duck ? 15 : 26);
  const shY = footY - (duck ? 25 : 42);
  const headY = footY - (duck ? 31 : 50);

  // legs
  g.lineStyle(3.5, flash ? 0xd23b2f : COL.pants, 1);
  const ph = S.rph;
  if (air) {
    g.lineBetween(shX - 3, hipY, shX - 9, hipY + 11);
    g.lineBetween(shX + 3, hipY, shX + 10, hipY + 8);
    g.fillStyle(COL.boot, 1);
    g.fillRect(shX - 12, hipY + 9, 6, 3); g.fillRect(shX + 8, hipY + 6, 6, 3);
  } else if (o.idle) {
    g.lineBetween(shX - 4, hipY, shX - 5, footY);
    g.lineBetween(shX + 4, hipY, shX + 5, footY);
    g.fillStyle(COL.boot, 1);
    g.fillRect(shX - 8, footY - 3, 7, 3); g.fillRect(shX + 2, footY - 3, 7, 3);
  } else {
    for (const off of [0, Math.PI]) {
      const s2 = Math.sin(ph + off);
      const kneeX = shX + s2 * 6, kneeY = (hipY + footY) / 2 - 2;
      const footX = shX + s2 * 10;
      const footYY = footY - Math.max(0, Math.cos(ph + off)) * 6;
      g.lineBetween(shX, hipY, kneeX, kneeY);
      g.lineBetween(kneeX, kneeY, footX, footYY);
      g.fillStyle(COL.boot, 1);
      g.fillRect(footX - 3, footYY - 3, 7, 3);
    }
  }

  // poncho (fluttering cobija)
  const flap = Math.sin(t * 9) * 2.5 + Math.sin(t * 3.7) * 1.6;
  const lean = air ? 5 : 3;
  g.fillStyle(flash ? 0xd23b2f : COL.poncho, 1);
  g.fillPoints([
    { x: shX - 8, y: shY + 1 }, { x: shX + 8 + lean * 0.4, y: shY + 1 },
    { x: shX + 12 + lean + flap, y: shY + (duck ? 12 : 17) },
    { x: shX - 13 - flap, y: shY + (duck ? 11 : 16) }
  ], true);
  g.lineStyle(2, flash ? 0x8a2018 : COL.poncho2, 1);
  g.lineBetween(shX - 10 - flap * 0.5, shY + (duck ? 7 : 10), shX + 10 + lean * 0.6, shY + (duck ? 7 : 10));

  // head + cogollo hat
  const hx = shX + lean * 0.5;
  g.fillStyle(flash ? 0xd23b2f : COL.skin, 1);
  g.fillCircle(hx, headY + 1, 4.5);
  g.fillStyle(COL.hat, 1);
  g.fillEllipse(hx, headY - 3.5, 24, 6);
  g.fillEllipse(hx, headY - 6.5, 13, 7);

  // arms + lantern
  g.lineStyle(3, flash ? 0xd23b2f : COL.poncho2, 1);
  const pump = air ? -3 : Math.sin(ph) * 5;
  if (S.face === -1 && S.faceT > 0) {
    // turned: lantern arm extended backwards (left)
    const handX = shX - 15, handY = shY + 7;
    g.lineBetween(shX - 3, shY + 4, handX, handY);
    g.lineBetween(shX + 3, shY + 4, shX + 8, shY + 13 + pump * 0.4);
    const flick = 0.13 + 0.03 * Math.sin(t * 31);
    g.fillStyle(COL.light, flick);
    g.fillPoints([{ x: handX - 2, y: handY }, { x: handX - 195, y: handY - 54 }, { x: handX - 205, y: handY + 30 }, { x: handX - 188, y: handY + 62 }], true);
    g.fillStyle(COL.light, flick * 0.8);
    g.fillPoints([{ x: handX - 2, y: handY }, { x: handX - 125, y: handY - 32 }, { x: handX - 130, y: handY + 38 }], true);
    g.fillStyle(COL.light, 0.12);
    g.fillCircle(handX - 4, handY + 2, 15);
    g.fillStyle(0x4a3418, 1);
    g.fillRect(handX - 4, handY - 2, 7, 11);
    g.fillStyle(0xffb347, 1);
    g.fillCircle(handX, handY + 2, 2.6);
  } else {
    g.lineBetween(shX - 3, shY + 4, shX - 7, shY + 14 - pump);
    g.lineBetween(shX + 3, shY + 4, shX + 8, shY + 14 + pump);
  }

  // near-phase reaction window bar
  if (S.threat.near) {
    const k = clamp(S.threat.winT / S.threat.winMax, 0, 1);
    g.fillStyle(0x000000, 0.5);
    g.fillRect(PX - 25, headY - 22, 50, 5);
    g.fillStyle(k > 0.45 ? 0xd23b2f : 0xff6a3a, 0.95);
    g.fillRect(PX - 24, headY - 21, 48 * k, 3);
  }
}

function drawSilbon(g, x, yFeet, s, alpha, o) {
  const t = S.t;
  const body = o.lit ? 0x2a2a3c : COL.sil;
  const bob = o.fly ? 0 : Math.sin(t * 3.1) * 2 * s;
  const lean = (o.lean ? 6 : 0) + (o.fly ? 14 : 0);
  const hip = yFeet - 80 * s + bob, sh = yFeet - 122 * s + bob, head = yFeet - 136 * s + bob;

  g.lineStyle(3, body, alpha);
  if (o.fly) {
    g.lineBetween(x - 6 * s, hip, x - 20 * s, hip + 22 * s);
    g.lineBetween(x + 6 * s, hip, x - 12 * s, hip + 26 * s);
  } else {
    g.lineBetween(x - 4 * s, hip, x - 9 * s, yFeet);
    g.lineBetween(x + 4 * s, hip, x + 10 * s, yFeet);
  }
  g.fillStyle(body, alpha);
  g.fillPoints([
    { x: x - 5 * s, y: hip }, { x: x + 5 * s, y: hip },
    { x: x + 3.5 * s + lean, y: sh }, { x: x - 3.5 * s + lean, y: sh }
  ], true);
  g.lineStyle(2.6, body, alpha);
  g.lineBetween(x - 4 * s + lean, sh + 4 * s, x - 8 * s + lean * 0.6, hip + 16 * s);
  g.lineBetween(x + 4 * s + lean, sh + 4 * s, x + 9 * s + lean * 0.6, hip + 14 * s);
  // machete in the forward hand: dark handle + pale steel blade
  g.lineStyle(2.8, o.lit ? 0x3a3226 : 0x0d0a12, alpha);
  g.lineBetween(x + 9 * s + lean * 0.6, hip + 14 * s, x + 13 * s + lean * 0.6, hip + 10 * s);
  g.lineStyle(2.2, 0xb9c0c9, alpha * 0.9);
  g.lineBetween(x + 13 * s + lean * 0.6, hip + 10 * s, x + 24 * s + lean * 0.6, hip - 3 * s);

  // head + wide hat
  g.fillStyle(body, alpha);
  g.fillCircle(x + lean, head, 6 * s);
  g.fillEllipse(x + lean, head - 6 * s, 34 * s, 7 * s);
  g.fillEllipse(x + lean, head - 9 * s, 15 * s, 9 * s);

  // bones sack on the back
  g.fillStyle(o.lit ? 0x2f2a40 : 0x120f18, alpha);
  g.fillEllipse(x - 15 * s, sh + 8 * s, 26 * s, 36 * s);
  g.fillStyle(0xd8cfc0, alpha * 0.85);
  g.fillCircle(x - 23 * s, sh - 2 * s, 1.9 * s);
  g.fillCircle(x - 26 * s, sh + 8 * s, 1.7 * s);
  g.fillCircle(x - 24 * s, sh + 18 * s, 1.8 * s);

  // red eyes: steady burn when he is near, slow blink when distant
  const on = o.scare || o.lit || (o.blinkFast ? Math.sin(t * 22) > -0.3 : Math.sin(t * 2.4) > 0.92);
  if (on) {
    const er = (o.scare ? 2.6 : o.lit ? 2.4 : 1.9) * s;
    g.fillStyle(COL.eye, alpha * 0.22);
    g.fillCircle(x - 2.5 * s + lean, head - 1, er * 3.2);
    g.fillCircle(x + 3.2 * s + lean, head - 1, er * 3.2);
    g.fillStyle(COL.eye, alpha);
    g.fillCircle(x - 2.5 * s + lean, head - 1, er);
    g.fillCircle(x + 3.2 * s + lean, head - 1, er);
    if (o.scare) {
      g.fillStyle(0x2a0404, alpha);
      g.fillEllipse(x + lean, head + 3.4 * s, 6.5 * s, 5 * s);
    }
  }
}

/* ---------------- FX layers: fear tint (under chars) / flash (over all) --------- */
function drawFearFx() {
  const g = G.fearFxG;
  g.clear();
  let red = 0;
  if (S.fear > 55) red = (S.fear - 55) / 45 * 0.2;
  if (S.threat.near) red += 0.06 + 0.05 * Math.sin(S.t * 10);
  if (red > 0) {
    g.fillStyle(0xc01818, red);
    g.fillRect(0, 0, W, H);
  }
}

function drawFx(dt) {
  const g = G.fxG;
  g.clear();
  // lightning whiteout revealing his giant silhouette
  if (S.ltn && S.ltn.a > 0) {
    g.fillStyle(0xe8ecff, S.ltn.a);
    g.fillRect(0, 0, W, H);
    if (S.ltn.a > 0.3) drawSilbon(g, PX - 235, GY + 10, 1.5, 0.85, {});
  }
  // jumpscare red pulse
  if (S.mode === 'dying') {
    g.fillStyle(0x7a0505, 0.25 + 0.2 * Math.sin(S.t * 40));
    g.fillRect(0, 0, W, H);
  }
  // dog pack released: water-dog silhouettes rushing left, myth-true rescue
  if (S.dogFx) {
    const df = S.dogFx;
    df.t += dt;
    const k = df.t / 1.4;
    if (k >= 1) S.dogFx = null;
    else {
      const a = k < 0.15 ? k / 0.15 : k > 0.8 ? (1 - k) / 0.2 : 1;
      const x0 = PX + 30 - k * 320;
      for (let i = 0; i < 3; i++) {
        const dx = x0 + i * 26, dy = GY - 12 - i * 7 + Math.sin(df.t * 14 + i * 2) * 3;
        g.fillStyle(0x27404d, 0.9 * a);
        g.fillEllipse(dx, dy, 26, 11);
        g.fillCircle(dx + 12, dy - 6, 5);
        g.fillRect(dx + 9, dy - 13, 3, 6);
        g.fillRect(dx - 14, dy - 4, 8, 2);
        g.fillStyle(0x8fd0e8, 0.9 * a);
        g.fillCircle(dx + 13, dy - 7, 1.1);
      }
    }
  }
}

/* ---------------- HUD ------------------------------------------------------------ */
function drawHud(dt) {
  const g = G.hudG;
  g.clear();
  if (S.mode === 'menu') {
    const m = scene.menuT[5];
    m.setAlpha(0.55 + 0.45 * Math.abs(Math.sin(S.t * 2.4)));
    return;
  }
  if (S.mode === 'over') {
    g.fillStyle(0x0a0612, 0.8);
    g.fillRoundedRect(W / 2 - 235, 200, 470, 200, 14);
    g.lineStyle(2, 0x4a3a66, 0.9);
    g.strokeRoundedRect(W / 2 - 235, 200, 470, 200, 14);
    return;
  }
  // HUD panels
  g.fillStyle(0x0a0612, 0.38);
  g.fillRoundedRect(8, 8, 176, 52, 8);
  g.fillStyle(0x0a0612, 0.38);
  g.fillRoundedRect(W - 158, 8, 150, 46, 8);
  // fear eye icon
  g.fillStyle(0xd23b2f, 0.95);
  g.fillEllipse(19, 18, 14, 8);
  g.fillStyle(0x0a0508, 1);
  g.fillCircle(19, 18, 2.4);
  // kerosene lantern icon
  g.fillStyle(0xe0a33b, 0.95);
  g.fillRect(15, 33, 8, 10);
  g.fillStyle(0x3a2a1a, 1);
  g.fillRect(14, 30, 10, 3);
  g.fillRect(17, 44, 4, 2);
  g.fillStyle(0xfff2c9, 1);
  g.fillCircle(19, 38, 1.8);
  // fear + kerosene bars
  g.fillStyle(0x000000, 0.45);
  g.fillRect(30, 12, 146, 11); g.fillRect(30, 30, 146, 11);
  g.lineStyle(1, 0x8a7fa8, 0.8);
  g.strokeRect(30.5, 12.5, 145, 10); g.strokeRect(30.5, 30.5, 145, 10);
  g.fillStyle(0xd23b2f, 0.95);
  g.fillRect(32, 14, 142 * clamp(S.fear / 100, 0, 1), 7);
  const kf = S.kero < 25 ? 0.45 + 0.55 * Math.abs(Math.sin(S.t * 8)) : 0.95;
  g.fillStyle(0xe0a33b, kf);
  g.fillRect(32, 32, 142 * clamp(S.kero / 100, 0, 1), 7);
  // carried dogs pips
  for (let i = 0; i < 2; i++) {
    const px = 32 + i * 15;
    g.lineStyle(1, 0x8fd0e8, 0.8);
    g.strokeRect(px + 0.5, 44.5, 11, 8);
    if (i < S.dogs) {
      g.fillStyle(0x9fd8ff, 0.95);
      g.fillRect(px + 2, 46, 7, 5);
      g.fillRect(px + 3, 44, 2, 2);
    }
  }
  // Silbon state badge
  if (S.threat.near) {
    g.fillStyle(0x1a0508, 0.6);
    g.fillRoundedRect(W / 2 - 54, 4, 108, 22, 8);
    g.lineStyle(2, 0xff5545, 0.45 + 0.55 * Math.abs(Math.sin(S.t * 12)));
    g.strokeRoundedRect(W / 2 - 54, 4, 108, 22, 8);
    scene.tState.setText('¡ESTA ATRAS!').setColor('#ff6a55');
  } else {
    scene.tState.setText('SILBON LEJOS').setColor('#6f6a86');
  }

  // throttled texts
  S.hudT -= dt;
  if (S.hudT <= 0) {
    S.hudT = 0.1;
    scene.tScore.setText('PUNTOS ' + scoreTotal());
    scene.tBags.setText('BOLSAS x' + S.bags + ' · ' + Math.floor(S.dist) + ' m');
    scene.tHint.setText(S.hint.t > 0 ? S.hint.msg : '');
  }
}

/* ---------------- Boot ----------------------------------------------------------- */
if (typeof Phaser === 'undefined') {
  document.body.innerHTML = '<p style="color:#c9bde8;font-family:monospace">Se necesita internet para cargar Phaser 3.</p>';
} else {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    width: W,
    height: H,
    backgroundColor: '#040209',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [Main]
  });
}
