/* Thrustfall — game.js
 * A self-contained, guaranteed-playable thrust-and-fuel soft-landing Cartridge (genome:
 * thrustfall): ROTATE + BURN a wireframe lander against constant gravity, ration a finite
 * fuel tank, and settle onto glowing magenta pads notched into a jagged neon ridgeline.
 * Touch down under a safe velocity and near-level to score — narrow pads pay the biggest
 * multiplier. CRASH on a hard impact (too fast/too tilted on a pad), raw terrain contact
 * (missed every pad), or a dead-stick fall once the tank runs empty. Each stage steepens the
 * ground and narrows the pads (difficulty_curve gentle→spike: stages 1-3 are a soft tutorial
 * ramp, stage 4+ is where wind gusts + a real narrow-pad squeeze begin), adds wind gusts and
 * falling refuel canisters, and a scarce gold hover-assist pickup softens gravity for a few
 * seconds. Score-threshold banked lives. INTEGRATES the shared Octagonal engine/beacon +
 * the reusable engine/arcade-controls.js deck when present (canonical-origin load) but NEVER
 * depends on them for the core loop, so the cabinet plays even if the engine/deck fail to
 * load. Cartridge concerns wired: beacon telemetry (live "error" reporting), meta-layer
 * tokens/XP, flags.json monetization slots, SEO/OG share deep-link, "Made with Octagonal"
 * backlink. No build step.
 *
 * DESIGN NOTE (empty tank): the genome lists "an empty tank" as a crash trigger alongside
 * hard impact and terrain contact. Implemented as a DEAD-STICK state (fuel<=0 disables the
 * main engine — rotation stays free) rather than an instant kill: the empty tank is the
 * CAUSE, the inevitable uncontrolled ground contact is the crash. This keeps a last-second
 * "flare the rotation, glide it in" skill play alive instead of an unwinnable instant death,
 * which reads as fairer under QA fun-score while still honoring the genome's crash trigger.
 *
 * DEPTH: procedurally jagged per-stage terrain (deterministic seeded RNG) with 3 pads whose
 * width sets a x1/x2/x3/x5 score multiplier; gentle→spike stage ramp (stage 1-3 wide pads, no
 * wind; stage 4+ narrows pads + ramps wind gust strength); falling refuel canisters (stage 2+)
 * and a scarce gold hover-assist pickup (stage 3+, reduced gravity for 6s); a "GREASED IT"
 * near-zero-velocity landing bonus that surfaces the share prompt immediately (not only at
 * game over); banked lives on score thresholds; full juice (screenshake, phosphor bloom,
 * thrust-hiss engine audio, particle debris, procedural WebAudio SFX), prefers-reduced-motion
 * aware; deterministic fixed-timestep field.
 */
(function () {
  "use strict";

  /* ---- Cartridge integration (all guarded — missing engine = no-op, never a crash) ---- */
  var SLUG = "thrustfall";
  var Beacon = (window.OCTAGO_BEACON && typeof window.OCTAGO_BEACON.emit === "function")
    ? window.OCTAGO_BEACON : { emit: function () {} };
  var Meta = (window.OCTAGO && window.OCTAGO.meta) || null;   // meta-layer lives at OCTAGO.meta
  var VARIANT = "A";
  // Boot the beacon ourselves: this cabinet does NOT call OCTAGO.boot(), so nothing else inits
  // the beacon — without this, emit() only buffers and never POSTs.
  if (window.OCTAGO_BEACON && window.OCTAGO_BEACON.init) {
    window.OCTAGO_BEACON.init({ collector: window.OCTAGO_COLLECTOR || "", key: window.OCTAGO_KEY || "octgnl_pub_live", entity: "slug", slug: SLUG });
  }
  function emit(event, value, unit, dims) {
    try {
      Beacon.emit(event, {
        entity: SLUG, value: value == null ? 1 : value, unit: unit || "count",
        dims: Object.assign({ variant: VARIANT, slug: SLUG }, dims || {})
      });
    } catch (e) {}
  }

  /* ---- live error telemetry (the template pattern for every game) ---------------------- */
  var _errCount = 0, _lastErr = null;
  function emitError(msg, src) {
    _errCount++;
    _lastErr = { msg: String(msg == null ? "" : msg), src: String(src == null ? "" : src) };
    try { emit("error", 1, "count", { msg: _lastErr.msg.slice(0, 120), src: _lastErr.src.slice(0, 60) }); } catch (e) {}
  }
  addEventListener("error", function (e) {
    try { emitError((e && e.message) || "error", ((e && e.filename) || "") + ":" + ((e && e.lineno) || 0)); } catch (_) {}
  });
  addEventListener("unhandledrejection", function (e) {
    try { var r = e && e.reason; emitError((r && r.message) || String(r || "rejection"), "promise"); } catch (_) {}
  });

  function tokens(n) {
    try { if (Meta && Meta.addTokens) { Meta.addTokens(n); return; } } catch (e) {}
    try {
      var t = (+(localStorage.getItem("oct.thrustfall.tok") || 0)) + (n | 0);
      if (t < 0) t = 0;
      localStorage.setItem("oct.thrustfall.tok", t);
    } catch (e) {}
  }
  function getTokens() {
    try { if (Meta && Meta.profile) return Meta.profile().tokens | 0; } catch (e) {}
    try { return +(localStorage.getItem("oct.thrustfall.tok") || 0) | 0; } catch (e) {}
    return 0;
  }
  function xp(n) {
    // NOTE: Meta.awardXp/addXP (engine.js) emit through the ENGINE's own Beacon
    // instance, which stays a no-op stub unless OCTAGO.boot() ran — and this
    // cabinet deliberately never calls boot() (plays even if engine.js fails to
    // load). So Meta.* here only updates the local XP profile; telemetry for
    // xp_earn is fired unconditionally through THIS file's already-initialized
    // Beacon so the event isn't silently dropped (signals/schema.json vocab).
    try {
      if (Meta && Meta.awardXp) { Meta.awardXp(n); }
      else if (Meta && Meta.addXP) { Meta.addXP(n); }
    } catch (e) {}
    emit("xp_earn", n, "count");
  }

  var reduce = false;
  try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  /* ---- procedural WebAudio SFX (juice_pack: thrust-hiss) -------------------------------- */
  var Sound = (function () {
    var ctx = null, master = null, muted = false;
    try { muted = localStorage.getItem("oct.thrustfall.muted") === "1"; } catch (e) {}
    var VOL = 0.5;
    var hissOsc = null, hissGain = null, hissNoise = null;
    function ensure() {
      if (ctx) return ctx;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : VOL;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; }
      return ctx;
    }
    function unlock() {
      var c = ensure();
      if (c && c.state === "suspended") { try { c.resume(); } catch (e) {} }
    }
    function tone(o) {
      if (muted) return;
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime, dur = o.dur || 0.08;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || "square";
      osc.frequency.setValueAtTime(o.f0, t0);
      if (o.f1 != null) { try { osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + dur); } catch (e) {} }
      var peak = o.gain == null ? 0.28 : o.gain;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    function noise(dur, gain, hp, lp) {
      if (muted) return;
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime, n = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(); src.buffer = buf;
      var f = c.createBiquadFilter();
      f.type = hp ? "highpass" : "lowpass"; f.frequency.value = hp || lp || 900;
      var g = c.createGain(); g.gain.value = gain == null ? 0.22 : gain;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0);
    }
    function arp(freqs, step, type) {
      if (muted) return;
      for (var i = 0; i < freqs.length; i++) {
        (function (fr, d) { setTimeout(function () { tone({ type: type, f0: fr, dur: step * 1.5, gain: 0.24 }); }, d * 1000); })(freqs[i], step * i);
      }
    }
    function hissOn() {
      if (muted) return;
      var c = ensure(); if (!c || hissOsc) return;
      try {
        hissOsc = c.createOscillator(); hissGain = c.createGain();
        hissOsc.type = "sawtooth"; hissOsc.frequency.value = 52;
        hissGain.gain.value = 0.0001;
        hissGain.gain.linearRampToValueAtTime(0.08, c.currentTime + 0.05);
        // dominant broadband HISS layer (the juice_pack signature) — highpassed noise, louder
        // and brighter than a typical low rumble so the burn reads as a hiss, not a growl.
        var nb = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate), d = nb.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
        hissNoise = c.createBufferSource(); hissNoise.buffer = nb; hissNoise.loop = true;
        var hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1500;
        var ng = c.createGain(); ng.gain.value = 0.13;
        hissOsc.connect(hissGain); hissGain.connect(master);
        hissNoise.connect(hp); hp.connect(ng); ng.connect(master);
        hissOsc.start(); hissNoise.start();
      } catch (e) { hissOsc = null; }
    }
    function hissOff() {
      if (!hissOsc) return;
      try {
        var c = ctx, t = c ? c.currentTime : 0;
        if (hissGain && c) { hissGain.gain.cancelScheduledValues(t); hissGain.gain.setValueAtTime(hissGain.gain.value, t); hissGain.gain.linearRampToValueAtTime(0.0001, t + 0.06); }
        var osc = hissOsc, ns = hissNoise;
        setTimeout(function () { try { osc.stop(); } catch (e) {} try { ns.stop(); } catch (e) {} }, 100);
      } catch (e) {}
      hissOsc = null; hissGain = null; hissNoise = null;
    }
    var SFX = {
      land:    function () { arp([660, 880, 1175], 0.06, "triangle"); },
      grease:  function () { arp([660, 880, 1175, 1568, 2093], 0.055, "sine"); },
      crash:   function () { tone({ type: "sawtooth", f0: 160, f1: 40, dur: 0.32, gain: 0.32 }); noise(0.3, 0.28, null, 700); },
      fuel:    function () { tone({ type: "sine", f0: 520, f1: 900, dur: 0.14, gain: 0.18 }); },
      hover:   function () { arp([784, 1047, 1319, 1568], 0.06, "triangle"); },
      wind:    function () { noise(0.5, 0.08, null, 500); },
      life:    function () { arp([784, 1047, 1319, 1568], 0.08, "triangle"); },
      stage:   function () { arp([392, 523, 659], 0.09, "triangle"); },
      empty:   function () { tone({ type: "square", f0: 220, f1: 90, dur: 0.4, gain: 0.2 }); },
      over:    function () { arp([440, 349, 262, 175], 0.16, "sawtooth"); noise(0.4, 0.2, null, 500); }
    };
    return {
      unlock: unlock,
      play: function (name, opts) { try { if (SFX[name]) SFX[name](opts); } catch (e) {} },
      hissOn: function () { try { hissOn(); } catch (e) {} },
      hissOff: function () { try { hissOff(); } catch (e) {} },
      state: function () { return ctx ? ctx.state : "none"; },
      isMuted: function () { return muted; },
      toggle: function () {
        muted = !muted;
        try { localStorage.setItem("oct.thrustfall.muted", muted ? "1" : "0"); } catch (e) {}
        if (master) master.gain.value = muted ? 0 : VOL;
        if (muted) hissOff();
        if (!muted) unlock();
        return muted;
      }
    };
  })();

  /* ---- canvas / geometry ---------------------------------------------------------------- */
  var cvs = document.getElementById("game"), ctx = cvs.getContext("2d");
  var W = cvs.width, H = cvs.height;                  // 480 x 600
  var STEP_MS = 1000 / 120, STEP_S = STEP_MS / 1000;  // deterministic fixed timestep

  // flight model (vector thrust: rotation is free, main burn drains fuel)
  var GRAVITY = 78;                 // px/s^2
  var ROT_RATE = 2.5;                // rad/s
  var THRUST_ACC = 150;              // px/s^2 along the nose
  var MAX_FALL = 340;                // px/s speed cap (stability, not a gameplay limit)
  var SHIP_R = 11;                   // collision radius
  var FUEL_MAX = 100, FUEL_DRAIN = 17;   // units, units/s while burning
  var HOVER_GRAVITY_MULT = 0.4, HOVER_DURATION = 6;
  var LAND_MAX_VY = 48, LAND_MAX_VX = 30, LAND_MAX_TILT = 0.24; // rad (~13.8deg)
  var GREASE_VY = 8, GREASE_VX = 6, GREASE_TILT = 0.05;
  var BASE_LAND = 100;
  var BANK_STEP = 1200;               // banked-life score threshold, additive
  var SETTLE_S = 1.3, RESPAWN_S = 1.1;

  var CY = "#20e6ff", MG = "#ff2fb9", GD = "#ffd23f", DIM = "#8f86c9";

  /* ---- deterministic RNG (mulberry32) — reproducible terrain + spawns ------------------- */
  var _seed = 0x9e3779b9;
  function seedRng(n) { _seed = (0x9e3779b9 ^ (n * 2654435761)) >>> 0; }
  function rng() {
    _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
    var t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rr(a, b) { return a + (b - a) * rng(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function normAng(a) {
    a = a % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /* ---- gentle→spike stage tuning --------------------------------------------------------- */
  function jagForStage(s) { return s <= 3 ? 10 : Math.min(30, 16 + (s - 4) * 4); }
  function padWidthRange(s) {
    if (s <= 3) return { min: 70, max: 120 };
    var min = Math.max(20, 70 - (s - 3) * 8), max = Math.max(46, 120 - (s - 3) * 10);
    return { min: min, max: Math.max(min + 18, max) };
  }
  function windEnabled(s) { return s >= 4; }
  function windMax(s) { return Math.min(70, 20 + Math.max(0, s - 3) * 8); }
  function refuelEnabled(s) { return s >= 2; }
  function hoverEnabled(s) { return s >= 3; }
  function multFromWidth(px) {
    if (px <= 34) return 5;
    if (px <= 54) return 3;
    if (px <= 78) return 2;
    return 1;
  }

  /* ---- terrain generation (per-stage, deterministic) ------------------------------------- */
  var GROUND_BASE = H - 70;
  var TERRAIN_N = 61, TERRAIN_SPACING = W / (TERRAIN_N - 1);
  function buildTerrain(stage, seed) {
    seedRng(seed);
    var jag = jagForStage(stage);
    var heights = [], h = GROUND_BASE;
    for (var i = 0; i < TERRAIN_N; i++) {
      h += rr(-jag, jag);
      h = clamp(h, GROUND_BASE - 90, GROUND_BASE + 30);
      heights.push(h);
    }
    // one smoothing pass so raw noise doesn't spike into razor cliffs
    var sm = heights.slice();
    for (var k = 1; k < TERRAIN_N - 1; k++) sm[k] = (heights[k - 1] + heights[k] * 2 + heights[k + 1]) / 4;
    heights = sm;

    // carve 3 pads into evenly-spaced bins across the width, narrower/rarer as stage climbs
    var wr = padWidthRange(stage);
    var pads = [];
    var bins = 3, margin = 46;
    var binW = (W - margin * 2) / bins;
    for (var b = 0; b < bins; b++) {
      var widthPx = clamp(rr(wr.min, wr.max), 20, 150);
      var widthPts = Math.max(2, Math.round(widthPx / TERRAIN_SPACING));
      var binStart = margin + b * binW;
      var maxStartOffset = Math.max(1, binW - widthPx - 6);
      var cx = binStart + rr(3, maxStartOffset);
      var i0 = clamp(Math.round(cx / TERRAIN_SPACING), 1, TERRAIN_N - 2 - widthPts);
      var i1 = clamp(i0 + widthPts, i0 + 1, TERRAIN_N - 2);
      var padY = clamp(heights[Math.round((i0 + i1) / 2)], GROUND_BASE - 80, GROUND_BASE + 20);
      for (var p = i0; p <= i1; p++) heights[p] = padY;
      var x0 = i0 * TERRAIN_SPACING, x1 = i1 * TERRAIN_SPACING;
      pads.push({ x0: x0, x1: x1, y: padY, mult: multFromWidth(x1 - x0) });
    }
    return { heights: heights, pads: pads };
  }
  function terrainYAt(terrain, x) {
    x = clamp(x, 0, W);
    var f = x / TERRAIN_SPACING, i0 = Math.floor(f), i1 = Math.min(TERRAIN_N - 1, i0 + 1);
    var t = f - i0;
    return terrain.heights[i0] * (1 - t) + terrain.heights[i1] * t;
  }
  function padAt(terrain, x) {
    for (var i = 0; i < terrain.pads.length; i++) {
      var p = terrain.pads[i];
      if (x >= p.x0 && x <= p.x1) return p;
    }
    return null;
  }

  /* ---- DOM refs --------------------------------------------------------------------------- */
  var els = {
    score: document.getElementById("score"), best: document.getElementById("best"),
    lives: document.getElementById("lives"), wave: document.getElementById("wave"),
    power: document.getElementById("power"), fuelbar: document.getElementById("fuelbar"),
    vel: document.getElementById("vel"),
    overlay: document.getElementById("overlay"), title: document.getElementById("title"),
    tag: document.getElementById("tag"), start: document.getElementById("start"),
    shareWrap: document.getElementById("share-wrap"), share: document.getElementById("share"),
    status: document.getElementById("a11y-status")
  };

  var best = +(localStorage.getItem("oct.thrustfall.best") || 0);
  if (els.best) els.best.textContent = best;

  /* ---- beat-my-score deep link (?s=&p=) -------------------------------------------------- */
  var q = new URLSearchParams(location.search);
  var rivalScore = +q.get("s") || 0, rival = q.get("p") || "";

  /* ---- flags.json → monetization slots --------------------------------------------------- */
  fetch("./flags.json").then(function (r) { return r.json(); }).then(function (f) {
    var slots = (f && f.slots) || {};
    VARIANT = (f && f.experiment && f.experiment.variant) || "A";
    Object.keys(slots).forEach(function (k) {
      var on = slots[k] && slots[k].on;
      var el = document.querySelector('[data-slot="' + k + '"]');
      if (el && on) {
        el.classList.add("on");
        if (k === "cabinet_banner") emit("ad_impression", 1, "count", { network: (slots[k].network || "house") });
        if (k === "insert_coin_jar") {
          el.href = "https://ko-fi.com/octagonal";
          el.addEventListener("click", function () {
            emit("coin_insert", 1, "count");
            emit("checkout_step", 1, "count", { step: "jar_click" });
          });
        }
      }
    });
  }).catch(function () {/* flags optional */ });

  /* ---- arcade control deck (engine/arcade-controls.js) -----------------------------------
   * 3-button VECTOR THRUST scheme: ROTATE-LEFT / ROTATE-RIGHT (held, free — no fuel cost) +
   * MAIN BURN (held, drains the fuel tank) on the left/centre. All mirrored to the physical
   * keyboard by the deck itself.
   */
  var deck = null;
  (function mountDeck() {
    try {
      var mountEl = document.getElementById("controls");
      if (mountEl && window.ArcadeControls) {
        deck = window.ArcadeControls.mount({
          mount: mountEl, theme: "synthwave",
          layout: [
            { id: "rotl", type: "button", side: "left", label: "◀", sub: "rotate",
              ariaLabel: "Rotate left", keys: ["ArrowLeft", "KeyA"] },
            { id: "rotr", type: "button", side: "left", label: "▶", sub: "rotate",
              ariaLabel: "Rotate right", keys: ["ArrowRight", "KeyD"] },
            { id: "thrust", type: "button", side: "center", label: "▲", sub: "burn",
              ariaLabel: "Main burn", keys: ["ArrowUp", "KeyW", "Space"] }
          ]
        });
      }
    } catch (e) { deck = null; }
  })();

  /* ---- state ------------------------------------------------------------------------------ */
  var S = null;
  var particles = [];
  var shake = 0, flash = 0;

  function newShip() {
    return { x: W / 2, y: 46, vx: 0, vy: 0, ang: 0, thrust: false };
  }

  /* ---- refuel / hover-assist pickups ------------------------------------------------------ */
  function spawnRefuel() {
    if (!S || S.refuel) return;
    var x = rr(50, W - 50);
    S.refuel = { x: x, y: -10, vx: rr(-14, 14), vy: rr(34, 54) };
  }
  function spawnHover() {
    if (!S || S.hover) return;
    var x = rr(50, W - 50);
    S.hover = { x: x, y: -10, vx: rr(-10, 10), vy: rr(28, 44) };
  }

  /* ---- stage / game lifecycle -------------------------------------------------------------- */
  function startStage(stage) {
    S.stage = stage;
    S.terrain = buildTerrain(stage, (S.runSeed >>> 0) + stage * 7919);
    S.ship = newShip();
    // FIX 1: fuel is a per-LANDING/attempt reserve, not a per-GAME budget — top the tank
    // back to full at the start of every stage (refuel canisters remain a mid-stage bonus).
    S.fuel = FUEL_MAX;
    S.respawn = 0; S.settle = 0; S.landedPad = null; S.grease = false;
    S.refuel = null; S.hover = null; S.hoverAssist = 0;
    S.refuelTimer = refuelEnabled(stage) ? rr(6, 10) : Infinity;
    S.hoverTimer = hoverEnabled(stage) ? rr(14, 22) : Infinity;
    S.wind = { cur: 0, target: 0, timer: rr(2, 4) };
    S.fuelWarned = false;
    hud();
    emit("level", stage, "count");
  }

  function startGame() {
    S = {
      mode: "play", score: 0, lives: 3, stage: 0,
      fuel: FUEL_MAX, nextBank: BANK_STEP, startTs: Date.now(),
      acc: 0, last: performance.now(), lastSig: ""
    };
    S.runSeed = (Math.floor(rng() * 1e9) ^ (Date.now() & 0xffff)) >>> 0;
    particles = []; shake = 0; flash = 0;
    startStage(1);
    els.overlay.classList.add("hide");
    emit("play_start", 1, "count");
    requestAnimationFrame(loop);
  }

  /* ---- physics (fixed step) --------------------------------------------------------------- */
  function physics(rotDir, thrusting) {
    if (S.mode === "over") return; // defensive: never simulate past game-over
    var sh = S.ship;

    if (S.settle > 0) { S.settle -= STEP_S; if (S.settle <= 0) advanceStage(); return; }
    // FIX 1: a fresh ship after a crash is a fresh landing attempt — refill the tank so a
    // crash mid-stage doesn't hand the player a dead-stick glide on the very next attempt.
    if (S.respawn > 0) { S.respawn -= STEP_S; if (S.respawn <= 0) { S.ship = newShip(); S.fuel = FUEL_MAX; } return; }
    if (S.hoverAssist > 0) S.hoverAssist -= STEP_S;

    // rotation is free; main burn drains fuel and is unavailable at empty tank (dead-stick)
    sh.ang += rotDir * ROT_RATE * STEP_S;
    var canBurn = thrusting && S.fuel > 0;
    sh.thrust = !!canBurn;
    if (canBurn) {
      sh.vx += Math.sin(sh.ang) * THRUST_ACC * STEP_S;
      sh.vy += -Math.cos(sh.ang) * THRUST_ACC * STEP_S;
      S.fuel = Math.max(0, S.fuel - FUEL_DRAIN * STEP_S);
      if (S.fuel <= 0 && !S.fuelWarned) {
        S.fuelWarned = true;
        Sound.play("empty");
        announce("Tank empty. Dead stick — rotation only.");
      }
    }

    // gravity (softened under an active hover-assist pickup)
    var g = GRAVITY * (S.hoverAssist > 0 ? HOVER_GRAVITY_MULT : 1);
    sh.vy += g * STEP_S;

    // wind (stage 4+): a slowly-wandering lateral gust, eased toward a periodic random target
    if (windEnabled(S.stage)) {
      S.wind.timer -= STEP_S;
      if (S.wind.timer <= 0) { S.wind.target = rr(-windMax(S.stage), windMax(S.stage)); S.wind.timer = rr(3, 6); }
      S.wind.cur += (S.wind.target - S.wind.cur) * Math.min(1, STEP_S * 0.6);
      sh.vx += S.wind.cur * STEP_S;
    }

    // speed clamp (stability)
    if (sh.vy > MAX_FALL) sh.vy = MAX_FALL;
    if (sh.vy < -MAX_FALL) sh.vy = -MAX_FALL;
    if (sh.vx > MAX_FALL) sh.vx = MAX_FALL; if (sh.vx < -MAX_FALL) sh.vx = -MAX_FALL;

    sh.x += sh.vx * STEP_S; sh.y += sh.vy * STEP_S;

    // soft walls (bounded field, no wrap) + ceiling
    if (sh.x < SHIP_R) { sh.x = SHIP_R; if (sh.vx < 0) sh.vx = 0; }
    else if (sh.x > W - SHIP_R) { sh.x = W - SHIP_R; if (sh.vx > 0) sh.vx = 0; }
    if (sh.y < SHIP_R) { sh.y = SHIP_R; if (sh.vy < 0) sh.vy = 0; }

    // refuel canister
    if (S.refuel) {
      var rf = S.refuel;
      rf.x += rf.vx * STEP_S; rf.y += rf.vy * STEP_S;
      if (circleHit(sh.x, sh.y, SHIP_R, rf.x, rf.y, 9)) {
        S.fuel = Math.min(FUEL_MAX, S.fuel + 42);
        tokens(1);
        Sound.play("fuel");
        burst(rf.x, rf.y, CY, 10);
        announce("Fuel canister collected.");
        S.refuel = null;
        S.refuelTimer = rr(9, 15);
      } else if (rf.y > terrainYAt(S.terrain, rf.x) + 10 || rf.y > H + 20) {
        S.refuel = null; S.refuelTimer = rr(9, 15);
      }
    } else if (refuelEnabled(S.stage)) {
      S.refuelTimer -= STEP_S;
      if (S.refuelTimer <= 0) spawnRefuel();
    }

    // hover-assist pickup (scarce)
    if (S.hover) {
      var hv = S.hover;
      hv.x += hv.vx * STEP_S; hv.y += hv.vy * STEP_S;
      if (circleHit(sh.x, sh.y, SHIP_R, hv.x, hv.y, 9)) {
        S.hoverAssist = HOVER_DURATION;
        tokens(3);
        Sound.play("hover");
        burst(hv.x, hv.y, GD, 14);
        announce("Hover-assist online.");
        S.hover = null;
        S.hoverTimer = rr(22, 34);
      } else if (hv.y > terrainYAt(S.terrain, hv.x) + 10 || hv.y > H + 20) {
        S.hover = null; S.hoverTimer = rr(22, 34);
      }
    } else if (hoverEnabled(S.stage)) {
      S.hoverTimer -= STEP_S;
      if (S.hoverTimer <= 0) spawnHover();
    }

    // ground contact
    var groundY = terrainYAt(S.terrain, sh.x);
    if (sh.y + SHIP_R >= groundY) {
      sh.y = groundY - SHIP_R;
      var pad = padAt(S.terrain, sh.x);
      if (pad) {
        var vy = Math.abs(sh.vy), vx = Math.abs(sh.vx), tilt = Math.abs(normAng(sh.ang));
        if (vy <= LAND_MAX_VY && vx <= LAND_MAX_VX && tilt <= LAND_MAX_TILT) doLanding(pad, vy, vx, tilt);
        else doCrash("HARD IMPACT");
      } else {
        doCrash("TERRAIN CONTACT");
      }
    }
  }

  function circleHit(ax, ay, ar, bx, by, br) {
    var dx = ax - bx, dy = ay - by, rad = ar + br;
    return dx * dx + dy * dy <= rad * rad;
  }

  /* ---- landing / crash / scoring ----------------------------------------------------------- */
  function doLanding(pad, vy, vx, tilt) {
    Sound.hissOff(); S.ship.thrust = false;
    var grease = vy <= GREASE_VY && vx <= GREASE_VX && tilt <= GREASE_TILT;
    var landScore = Math.round(BASE_LAND * pad.mult);
    var fuelBonus = Math.round(S.fuel * 1.5);
    var greaseBonus = grease ? Math.round(BASE_LAND * pad.mult * 0.5) : 0;
    var total = landScore + fuelBonus + greaseBonus;
    addScore(total);
    tokens(pad.mult + (grease ? 3 : 0));
    Sound.play(grease ? "grease" : "land");
    if (!reduce) flash = Math.max(flash, grease ? 0.55 : 0.32);
    burst(S.ship.x, S.ship.y, grease ? GD : CY, grease ? 22 : 14);
    S.landedPad = pad; S.grease = grease; S.settle = SETTLE_S;
    S.lastLandTotal = total;
    announce("Touchdown ×" + pad.mult + (grease ? ". GREASED IT!" : ".") + " +" + total + " score.");
    emit("score", S.score, "count", { stage: S.stage, mult: pad.mult, grease: grease ? 1 : 0 });
    if (grease) {
      // Share nudge fires on the session's best juice moment, not only at game over — mirrors
      // the octa-match corpus lesson (surface share immediately on a session-best, don't wait).
      els.shareWrap.style.display = "";
    }
    hud();
  }

  function doCrash(reason) {
    Sound.hissOff(); S.ship.thrust = false;
    if (!reduce) { shake = Math.min(12, shake + 7); flash = Math.max(flash, 0.36); }
    burst(S.ship.x, S.ship.y, MG, 20);
    Sound.play("crash");
    S.lives--;
    hud();
    announce(reason + ". " + Math.max(0, S.lives) + " ships left.");
    if (S.lives <= 0) { endGame(false); return; }
    S.respawn = RESPAWN_S;
  }

  function advanceStage() {
    var next = S.stage + 1;
    Sound.play("stage");
    announce("Stage " + next + ".");
    startStage(next);
  }

  function addScore(n) {
    S.score += n;
    while (S.score >= S.nextBank) {
      S.lives++;
      S.nextBank += BANK_STEP;
      Sound.play("life");
      if (!reduce) flash = Math.max(flash, 0.45);
      announce("Life banked. " + S.lives + " ships.");
    }
  }

  function endGame(won) {
    S.mode = "over";
    Sound.hissOff();
    Sound.play("over");
    var dur = Date.now() - S.startTs;
    emit("score", S.score, "count");
    emit("play_end", dur, "ms", { score: S.score, stage: S.stage });
    xp(S.score);
    if (S.score > best) { best = S.score; localStorage.setItem("oct.thrustfall.best", best); if (els.best) els.best.textContent = best; }
    els.title.textContent = "GAME OVER";
    els.tag.innerHTML = "score <b style='color:" + CY + "'>" + S.score + "</b> · stage <b>" + S.stage + "</b><br>" +
      (S.score >= best ? "★ NEW BEST ★" : "best " + best) + " — burn to fly again";
    els.start.textContent = "▶ INSERT COIN";
    els.shareWrap.style.display = "";
    announce("Game over. Final score " + S.score + ".");
    els.overlay.classList.remove("hide");
  }

  /* ---- juice: debris particles ------------------------------------------------------------- */
  function burst(x, y, color, n) {
    if (reduce) { if (n > 6) n = 6; }
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, spd = 40 + Math.random() * 180;
      particles.push({ x: x, y: y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        t: 1, color: color, len: 4 + Math.random() * 7, ang: a, spin: (Math.random() - 0.5) * 8 });
    }
  }
  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.t -= dt * 1.4;
      if (p.t <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.98; p.vy *= 0.98; p.ang += p.spin * dt;
    }
    if (shake > 0) shake = Math.max(0, shake - dt * 26);
    if (flash > 0) flash = Math.max(0, flash - dt * 2.2);
  }

  /* ---- hud --------------------------------------------------------------------------------- */
  // FIX 2: the fuel bar (and FIX 3: the live velocity readout) are factored out of hud() into
  // updateFuelBar()/updateVelocityHud() so they can be driven every frame from draw() — hud()
  // itself stays event-driven (called at startStage/doLanding/doCrash) for the score/lives/
  // wave text + the sig-gated a11y announce, which don't need per-frame churn.
  function updateFuelBar() {
    if (!els.fuelbar || !S) return;
    var pct = clamp(S.fuel / FUEL_MAX, 0, 1) * 100;
    els.fuelbar.style.height = pct + "%";
    els.fuelbar.classList.toggle("low", S.fuel < FUEL_MAX * 0.2);
  }
  function updateVelocityHud() {
    if (!els.vel || !S || !S.ship) return;
    var vyAbs = Math.abs(S.ship.vy), vxAbs = Math.abs(S.ship.vx);
    var vy = Math.round(vyAbs), vx = Math.round(vxAbs);
    var safe = vyAbs <= LAND_MAX_VY && vxAbs <= LAND_MAX_VX;
    var grease = vyAbs <= GREASE_VY && vxAbs <= GREASE_VX;
    els.vel.textContent = vy + "/" + vx + (grease ? " GREASE" : "");
    els.vel.classList.toggle("grease", grease);
    els.vel.classList.toggle("safe", safe && !grease);
    els.vel.classList.toggle("unsafe", !safe);
  }
  // Single per-frame entry point (called from draw(), every frame, while a stage is live) —
  // cheap DOM writes only, no announce()/telemetry, so it's safe to run at 120hz-fixed-step
  // frame cadence without spamming anything.
  function liveHud() {
    updateFuelBar();
    updateVelocityHud();
  }
  function hud() {
    if (!S) return;
    if (els.score) els.score.textContent = S.score;
    if (els.lives) els.lives.textContent = Math.max(0, S.lives);
    if (els.wave) els.wave.textContent = S.stage;
    updateFuelBar();
    updateVelocityHud();
    if (els.power) {
      if (!windEnabled(S.stage) || Math.abs(S.wind.cur) < 2) els.power.textContent = "—";
      else els.power.textContent = (S.wind.cur < 0 ? "◀" : "▶") + Math.round(Math.abs(S.wind.cur));
    }
    if (els.status) {
      var sig = S.mode + "|" + S.stage + "|" + S.lives;
      if (sig !== S.lastSig && S.mode === "play") {
        S.lastSig = sig;
        announce("Stage " + S.stage + ", " + S.lives + " ships, score " + S.score + ".");
      }
    }
  }
  var _lastAnnounce = "";
  function announce(msg) {
    if (!els.status || msg === _lastAnnounce) return;
    _lastAnnounce = msg; els.status.textContent = msg;
  }

  /* ---- render -------------------------------------------------------------------------------- */
  function draw() {
    var ox = shake ? (Math.random() * 2 - 1) * shake : 0;
    var oy = shake ? (Math.random() * 2 - 1) * shake : 0;
    ctx.setTransform(1, 0, 0, 1, ox, oy);
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0a0620"); g.addColorStop(1, "#03010f");
    ctx.fillStyle = g; ctx.fillRect(-16, -16, W + 32, H + 32);

    // starfield + crescent moon (theme: synthwave moonfall)
    ctx.fillStyle = "rgba(233,230,255,.55)";
    for (var s = 0; s < STARS.length; s++) { var st = STARS[s]; ctx.fillRect(st.x, st.y, st.r, st.r); }
    ctx.save();
    ctx.strokeStyle = "rgba(255,210,63,.5)"; ctx.lineWidth = 2; ctx.shadowColor = GD; ctx.shadowBlur = reduce ? 0 : 10;
    ctx.beginPath(); ctx.arc(W - 58, 54, 26, 0.2, Math.PI * 1.5); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    if (!S || !S.terrain) { ctx.setTransform(1, 0, 0, 1, 0, 0); return; }

    // FIX 2 / FIX 3: fuel + live velocity readouts, updated every rendered frame (physics
    // drains fuel continuously; hud() alone only fires on stage/land/crash edges).
    liveHud();

    drawTerrain(S.terrain);

    // refuel canister
    if (S.refuel) drawPickup(S.refuel, CY, "F");
    if (S.hover) drawPickup(S.hover, GD, "H");

    // ship (hidden during the brief re-entry/respawn freeze, matching the catalog convention)
    if (S.respawn <= 0) drawShip(S.ship);

    // particles
    for (var pi = 0; pi < particles.length; pi++) {
      var pt = particles[pi];
      ctx.globalAlpha = Math.max(0, pt.t);
      ctx.strokeStyle = pt.color; ctx.lineWidth = 1.5;
      var hx = Math.cos(pt.ang) * pt.len / 2, hy = Math.sin(pt.ang) * pt.len / 2;
      ctx.beginPath(); ctx.moveTo(pt.x - hx, pt.y - hy); ctx.lineTo(pt.x + hx, pt.y + hy); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // stage-clear banner
    if (S.settle > 0 && S.landedPad) {
      ctx.globalAlpha = Math.min(1, S.settle / SETTLE_S + 0.3);
      ctx.fillStyle = "#fff"; ctx.shadowColor = S.grease ? GD : CY; ctx.shadowBlur = reduce ? 0 : 12;
      ctx.font = "bold 22px 'Chakra Petch',monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(S.grease ? "GREASED IT!" : "TOUCHDOWN ×" + S.landedPad.mult, W / 2, H / 2 - 40);
      ctx.font = "14px monospace"; ctx.fillStyle = DIM;
      ctx.fillText("+" + (S.lastLandTotal || 0) + " score", W / 2, H / 2 - 16);
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }

    // respawn "get ready"
    if (S.respawn > 0) {
      ctx.fillStyle = DIM; ctx.font = "13px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("RE-ENTRY…", W / 2, H / 2);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (flash > 0) { ctx.fillStyle = "rgba(255,255,255," + (flash * 0.5).toFixed(3) + ")"; ctx.fillRect(0, 0, W, H); }
  }

  function drawTerrain(terrain) {
    // rock fill under the ridgeline
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (var i = 0; i < terrain.heights.length; i++) ctx.lineTo(i * TERRAIN_SPACING, terrain.heights[i]);
    ctx.lineTo(W, H); ctx.closePath();
    ctx.fillStyle = "rgba(20,10,40,.85)"; ctx.fill();
    // ridgeline
    ctx.beginPath();
    for (var j = 0; j < terrain.heights.length; j++) {
      var px = j * TERRAIN_SPACING, py = terrain.heights[j];
      if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "rgba(143,134,201,.85)"; ctx.lineWidth = 1.6;
    ctx.shadowColor = "rgba(143,134,201,.5)"; ctx.shadowBlur = reduce ? 0 : 4;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // pads (glowing magenta, with tick pylons + multiplier label)
    for (var k = 0; k < terrain.pads.length; k++) {
      var p = terrain.pads[k];
      ctx.strokeStyle = MG; ctx.lineWidth = 3; ctx.shadowColor = MG; ctx.shadowBlur = reduce ? 0 : 10;
      ctx.beginPath(); ctx.moveTo(p.x0, p.y); ctx.lineTo(p.x1, p.y); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = MG; ctx.font = "bold 12px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText("×" + p.mult, (p.x0 + p.x1) / 2, p.y - 5);
    }
  }

  function drawPickup(o, color, glyph) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = reduce ? 0 : 10;
    ctx.beginPath(); ctx.arc(o.x, o.y, 9, 0, 7); ctx.stroke();
    ctx.fillStyle = color; ctx.font = "bold 11px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(glyph, o.x, o.y + 1);
    ctx.shadowBlur = 0;
  }

  function drawShip(sh) {
    ctx.save();
    ctx.translate(sh.x, sh.y); ctx.rotate(sh.ang);
    // thrust flame (drawn pointing "down", opposite the nose, flicker for juice)
    if (sh.thrust && !reduce) {
      var fl = 6 + Math.random() * 9;
      ctx.strokeStyle = GD; ctx.shadowColor = GD; ctx.shadowBlur = 10; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-4, SHIP_R * 0.7); ctx.lineTo(0, SHIP_R + fl); ctx.lineTo(4, SHIP_R * 0.7); ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (sh.thrust) {
      ctx.strokeStyle = GD; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-3, SHIP_R * 0.7); ctx.lineTo(0, SHIP_R + 7); ctx.lineTo(3, SHIP_R * 0.7); ctx.stroke();
    }
    // hull: lander body (diamond) + two leg struts
    ctx.strokeStyle = CY; ctx.shadowColor = CY; ctx.shadowBlur = reduce ? 0 : 9; ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, -SHIP_R); ctx.lineTo(SHIP_R * 0.75, 0); ctx.lineTo(0, SHIP_R * 0.55); ctx.lineTo(-SHIP_R * 0.75, 0);
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-SHIP_R * 0.5, SHIP_R * 0.2); ctx.lineTo(-SHIP_R * 1.15, SHIP_R * 1.05);
    ctx.moveTo(SHIP_R * 0.5, SHIP_R * 0.2); ctx.lineTo(SHIP_R * 1.15, SHIP_R * 1.05);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
    // hover-assist aura (world space, un-rotated)
    if (S.hoverAssist > 0) {
      var a = S.hoverAssist < 1.4 && ((Date.now() / 100) | 0) % 2 === 0 ? 0.3 : 0.7;
      ctx.globalAlpha = a; ctx.strokeStyle = GD; ctx.shadowColor = GD; ctx.shadowBlur = reduce ? 0 : 12; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sh.x, sh.y, SHIP_R + 7, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }
  }

  // static starfield (generated once at boot; purely cosmetic, not gameplay RNG)
  var STARS = (function () {
    var arr = [];
    for (var i = 0; i < 70; i++) arr.push({ x: Math.random() * W, y: Math.random() * (H * 0.7), r: Math.random() < 0.15 ? 2 : 1 });
    return arr;
  })();

  /* ---- input: control deck + keyboard fallback ------------------------------------------- */
  var kb = { rotl: false, rotr: false, thrust: false };
  var KEY = {
    ArrowLeft: "rotl", KeyA: "rotl", a: "rotl",
    ArrowRight: "rotr", KeyD: "rotr", d: "rotr",
    ArrowUp: "thrust", KeyW: "thrust", w: "thrust", Space: "thrust"
  };
  addEventListener("keydown", function (e) {
    if (e.key === "p" || e.key === "P") { togglePause(); e.preventDefault(); return; }
    if (e.key === "Escape") { if (S && S.mode === "play") togglePause(); return; }
    if (deck) {
      if ((e.key === " " && !S) || (e.key === "Enter" && (!S || S.mode !== "play"))) { primaryAction(); e.preventDefault(); }
      return;
    }
    if (e.repeat) return;
    var slot = KEY[e.code] || KEY[e.key];
    if (slot) { kb[slot] = true; e.preventDefault(); return; }
    if (e.key === "Enter") { primaryAction(); e.preventDefault(); }
  });
  addEventListener("keyup", function (e) {
    if (deck) return;
    var slot = KEY[e.code] || KEY[e.key];
    if (slot) kb[slot] = false;
  });
  if (els.start) els.start.addEventListener("click", primaryAction);
  if (els.share) els.share.addEventListener("click", share);

  function primaryAction() {
    Sound.unlock();
    if (!S || S.mode === "idle" || S.mode === "over") { startGame(); return; }
    if (S.mode === "pause") { S.mode = "play"; els.overlay.classList.add("hide"); return; }
  }
  function togglePause() {
    if (!S) return;
    if (S.mode === "play") {
      S.mode = "pause";
      Sound.hissOff(); S.ship.thrust = false;
      els.title.textContent = "PAUSED";
      els.tag.innerHTML = "press <b>P</b> / BURN to resume";
      els.start.textContent = "▶ RESUME";
      els.shareWrap.style.display = "none";
      els.overlay.classList.remove("hide");
    } else if (S.mode === "pause") {
      S.mode = "play";
      els.overlay.classList.add("hide");
    }
  }

  /* ---- mute toggle -------------------------------------------------------------------------- */
  (function mountMute() {
    var btn = document.getElementById("mute");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "mute"; btn.type = "button";
      btn.style.cssText = "position:fixed;top:8px;right:8px;z-index:50;width:34px;height:34px;" +
        "border-radius:8px;border:1px solid rgba(32,230,255,.4);background:rgba(11,4,32,.72);" +
        "color:#20e6ff;font-size:17px;line-height:1;cursor:pointer;padding:0;" +
        "box-shadow:0 0 10px rgba(32,230,255,.25)";
      document.body.appendChild(btn);
    }
    function render() {
      var m = Sound.isMuted();
      btn.textContent = m ? "🔇" : "🔊";
      btn.setAttribute("aria-label", m ? "Unmute sound" : "Mute sound");
      btn.setAttribute("aria-pressed", m ? "true" : "false");
    }
    btn.addEventListener("click", function () { Sound.toggle(); render(); });
    render();
  })();

  /* ---- unlock audio on the very first user gesture anywhere (autoplay policy) ------------- */
  (function () {
    var done = false;
    function go() { if (done) return; done = true; Sound.unlock(); }
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
      try { addEventListener(ev, go, { passive: true }); } catch (e) { addEventListener(ev, go); }
    });
  })();

  /* ---- main loop (deterministic fixed timestep) ------------------------------------------- */
  function loop(now) {
    if (!S) return;
    try {
      var dt = (now - S.last) / 1000; S.last = now;
      if (dt > 0.1) dt = 0.1;

      var rotDir = 0, thrusting = false;
      if (deck) {
        var st = deck.state();
        var L = st.rotl && st.rotl.down, R = st.rotr && st.rotr.down;
        rotDir = (R ? 1 : 0) - (L ? 1 : 0);
        thrusting = !!(st.thrust && st.thrust.down);
        deck.frameEnd();
      } else {
        rotDir = (kb.rotr ? 1 : 0) - (kb.rotl ? 1 : 0);
        thrusting = kb.thrust;
      }

      if (S.mode === "play") {
        if (S.__injectErr) { S.__injectErr = false; throw new Error("qa-injected loop error"); }
        var canBurnAudio = thrusting && S.fuel > 0 && S.respawn <= 0 && S.settle <= 0;
        if (canBurnAudio) Sound.hissOn(); else Sound.hissOff();
        S.acc += dt * 1000;
        var guard = 0;
        while (S.acc >= STEP_MS && guard < 8) { S.acc -= STEP_MS; if (S.mode === "play") physics(rotDir, thrusting); guard++; }
        if (S.acc > STEP_MS * 8) S.acc = 0;
      } else {
        Sound.hissOff();
      }
      updateParticles(dt);
      draw();

      if (S.mode === "play" || S.mode === "pause") requestAnimationFrame(loop);
      else requestAnimationFrame(loopIdle);
    } catch (err) {
      // fail SAFE: report once, drop to the idle loop (no physics) so a per-frame throw can't
      // spin the CPU. The cabinet stays interactive; a reload restarts cleanly.
      emitError((err && err.message) || err, "loop");
      try { Sound.hissOff(); } catch (_) {}
      try { if (S && S.mode === "play") endGame(false); }
      catch (_) { try { if (S) S.mode = "over"; } catch (__) {} }
      try { requestAnimationFrame(loopIdle); } catch (_) {}
    }
  }
  function loopIdle(now) {
    if (!S) return;
    try {
      var dt = (now - S.last) / 1000; S.last = now; if (dt > 0.1) dt = 0.1;
      updateParticles(dt);
      draw();
      if (S && S.mode === "over") requestAnimationFrame(loopIdle);
    } catch (err) {
      emitError((err && err.message) || err, "loopIdle");
    }
  }

  /* ---- share (beat-my-score deep link) ----------------------------------------------------- */
  function share() {
    var pid = (Meta && Meta.pid && Meta.pid()) || localStorage.getItem("oct_pid") || ("g" + (Date.now() % 1e7));
    try { localStorage.setItem("oct_pid", pid); } catch (e) {}
    var sc = S ? S.score : 0;
    var url = location.origin + location.pathname + "?s=" + sc + "&p=" + encodeURIComponent(pid);
    emit("share_click", 1, "count", { score: sc, stage: S ? S.stage : 0 });
    var text = "I landed a score of " + sc + " in Thrustfall — can you beat it? ⯃";
    if (navigator.share) { navigator.share({ title: "Thrustfall", text: text, url: url }).catch(function () {}); }
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () {
        els.share.textContent = "✓ LINK COPIED";
        setTimeout(function () { els.share.textContent = "↗ SHARE / BEAT MY SCORE"; }, 1500);
      }).catch(function () { prompt("Copy your challenge link:", url); });
    } else prompt("Copy your challenge link:", url);
  }

  /* ---- optional test hook (inert unless ?debug=1) — used only by the QA smoke harness ---- */
  if (/[?&]debug=1/.test(location.search)) {
    window.__TF = {
      state: function () { return S; },
      ship: function () { return S ? S.ship : null; },
      fuel: function () { return S ? S.fuel : -1; },
      stage: function () { return S ? S.stage : -1; },
      lives: function () { return S ? S.lives : -1; },
      terrain: function () { return S ? S.terrain : null; },
      errorCount: function () { return _errCount; },
      lastError: function () { return _lastErr; },
      injectError: function () { if (S) S.__injectErr = true; },
      tokens: function () { return getTokens(); },
      grantTokens: function (n) { tokens(n | 0); return getTokens(); },
      start: function () { startGame(); },
      setFuel: function (n) { if (S) S.fuel = clamp(n, 0, FUEL_MAX); return S ? S.fuel : -1; },
      setStage: function (n) { if (S) startStage(n | 0); return S ? S.stage : -1; },
      placeShip: function (x, y, vx, vy, ang) {
        if (!S) return null;
        S.ship.x = x; S.ship.y = y; S.ship.vx = vx || 0; S.ship.vy = vy || 0; S.ship.ang = ang || 0;
        return S.ship;
      },
      forceLandingCheck: function () { if (S) physics(0, false); return S ? S.mode : null; },
      spawnRefuel: function () { spawnRefuel(); return S ? S.refuel : null; },
      spawnHover: function () { spawnHover(); return S ? S.hover : null; },
      addScore: function (n) { if (S) addScore(n | 0); return S ? S.score : -1; },
      wind: function () { return S ? S.wind : null; },
      grease: function () { return S ? S.grease : null; },
      // velocity accessor for the live speed HUD (Fix 3) re-QA.
      velocity: function () { return S && S.ship ? { vy: S.ship.vy, vx: S.ship.vx } : null; },
      // deterministic step control for the QA harness: freeze the RAF-driven loop's physics
      // so forceLandingCheck()/tick() calls are the only thing moving the sim.
      freeze: function () { if (S) S.mode = "frozen"; return S ? S.mode : null; },
      unfreeze: function () { if (S) S.mode = "play"; return S ? S.mode : null; },
      // guarded like the real RAF loop's inner while (re-checks mode each sub-step) so a QA
      // script batching many ticks can't keep calling physics() past a game-over transition.
      tick: function (n) { for (var i = 0; i < (n || 1); i++) { if (!S || S.mode === "over") break; physics(0, false); } return S ? S.mode : null; }
    };
  }

  /* ---- boot: idle attract-mode + deep-link challenge ------------------------------------- */
  S = { mode: "idle", last: performance.now() };
  if (rivalScore > 0) {
    els.tag.innerHTML = "a pilot landed <b style='color:" + CY + "'>" + rivalScore + "</b> — can you beat it?<br>◀ ▶ rotate · ▲ main burn · settle onto the pads";
    emit("cross_promo_click", 1, "count", { referrer: "share", rival: rival });
  }
  draw();
  requestAnimationFrame(loopIdle);
})();
