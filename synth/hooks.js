// SPDX-License-Identifier: MPL-2.0
// `synth` tool hooks - pure, DOM-free. Fold the whole input model into one
// `_state` extra (the underscore keeps annotateTemplate away, so it stays valid
// JSON inside <script type="application/json">) which the template's WebGL2
// instrument reads. Mirrors community/3d/hooks.js.
//
// Every user-settable value is clamped HERE, not in the shader: the sim is fed
// straight from a URL, so a hostile `?intensity=1e9` has to die at the door.

function _safeJson(obj) {
  // Only < needs escaping for embedding in <script type="application/json">;
  // JSON.parse handles U+2028/U+2029 natively.
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function _num(v, fallback) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function _color(v, fallback) {
  var s = (v == null ? '' : String(v)).trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
}

// mulberry32 - the seeded PRNG the whole tool runs on. Never Math.random: a
// shared URL has to replay the same piece, on any machine, forever.
function _mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The scene's forcing table: where ink is injected, and how each emitter orbits.
 *
 * `turns` is a whole number of orbits per loop, which is what makes the loop
 * seamless - the forcing at loop phase 1 is identical to phase 0, so a field in
 * its periodic attractor arrives back where it started. Sampled positions are
 * part of the visual contract: change the draw order or the count and every
 * shared seed renders a different piece, so extend this append-only.
 */
function _emitters(seed, count) {
  var rnd = _mulberry32(seed);
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push({
      x: 0.18 + rnd() * 0.64,
      y: 0.18 + rnd() * 0.64,
      radius: 0.06 + rnd() * 0.14,
      phase: rnd(),
      turns: 1 + Math.floor(rnd() * 3),
      tone: rnd(),
      push: 320 + rnd() * 380
    });
  }
  return out;
}

var _SCENES = ['ink'];

/* ── Audio ───────────────────────────────────────────────────────────────────
 *
 * host.audio.analyse turns the picked clip into a per-frame track the scene
 * reads as its Signals record. It runs ONCE per clip: the result is cached in
 * module state (hooks share one module instance per mount, the pattern
 * audiogram uses for its analysed length), so dragging a slider re-folds the
 * state without re-decoding the audio.
 *
 * The call is async and the hook budget is real (onInit 5s, onInput 2s). A cold
 * decode can outrun it; the runtime then applies no patch now and LATE-APPLIES
 * the same patch when it lands (engine 1.146). So a miss costs a late frame,
 * never a hang - and a clip that cannot be decoded at all leaves the scene
 * un-reactive rather than failing the render.
 */
var AUDIO_BANDS = 32;      // the Signals contract's spectrum length - packed as-is
var AUDIO_FPS = 24;        // signal-track rate; the sim runs at 60 and reads nearest
var AUDIO_FPS_MIN = 1;     // the analyse contract's own floor
// Payload ceiling: 37 bytes a frame, so 1800 frames is ~67 KB raw (~89 KB after
// base64). Enforced on BOTH axes, which is what actually makes it a ceiling: past
// ~75 s the rate drops, and once even the floor rate would overrun (past
// AUDIO_MAX_FRAMES seconds) the analysed WINDOW is capped instead. Rate alone
// leaves the payload growing linearly again - an hour-long mix packed 14,400
// frames, eight times this, re-parsed and un-base64'd on every single paint.
var AUDIO_MAX_FRAMES = 1800;

var _track = null;    // { key, audio } - the packed analysis for the current clip
var _pending = null;  // { key, promise } - an analyse already in flight for it
var _dur = 0;         // analysed length in seconds; 0 when there is no clip

/** Identity of a picked asset, for the analysis cache. */
function _srcKey(src) {
  if (!src) return '';
  if (typeof src === 'string') return src;
  return String(src.id || src.url || '');
}

/** The analyse options for a clip of `sec` seconds - 0 when the length is not
 *  known yet, which plans the bounded first pass that finds it out. Never more
 *  than AUDIO_MAX_FRAMES frames: fps x window is the frame count. */
function _plan(sec) {
  var fps = sec > 0
    ? Math.max(AUDIO_FPS_MIN, Math.min(AUDIO_FPS, Math.floor(AUDIO_MAX_FRAMES / sec)))
    : AUDIO_FPS;
  var span = AUDIO_MAX_FRAMES / fps;
  return { fps: fps, bands: AUDIO_BANDS, window: sec > 0 ? Math.min(sec, span) : span };
}

function _byte(v) {
  var n = Math.round((Number.isFinite(v) ? v : 0) * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

var _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 a byte array by hand: hooks run in whatever realm the shell gives
 *  them (a browser window, a Node context under the CLI), and this is shorter
 *  than reasoning about which globals exist where. Same helper as audiogram. */
function _b64(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i];
    var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    var n = (a << 16) | (b << 8) | c;
    out += _B64[(n >> 18) & 63] + _B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? _B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? _B64[n & 63] : '=';
  }
  return out;
}

/**
 * Pack an AudioAnalysis into the track the lib unpacks.
 *
 * Section order is the contract with lib/synth.js unpackAudio():
 *   rms, bass, mid, treb, flux - `count` bytes each, then magnitude (count x bands).
 * Changing it here changes it there.
 *
 * `bpm: null` is carried through UNTOUCHED. Null is a real answer - speech,
 * ambience and pads have no tempo to find - and a visual built on a wrong beat
 * grid looks far worse than one built on none. Never substitute 120.
 */
function _pack(a) {
  var f = a.frames;
  var bands = f.bands > 0 ? f.bands | 0 : AUDIO_BANDS;
  var bytes = new Uint8Array(f.count * 5 + f.count * bands);
  var at = 0;
  var tracks = [f.rms, f.bass, f.mid, f.treb, f.flux];
  for (var t = 0; t < tracks.length; t++) {
    for (var i = 0; i < f.count; i++) bytes[at++] = _byte(tracks[t][i]);
  }
  for (var m = 0; m < f.count * bands; m++) bytes[at++] = _byte(f.magnitude[m]);
  return {
    fps: a.fps,
    count: f.count,
    bands: bands,
    dur: a.window,
    bpm: a.bpm === null || !Number.isFinite(a.bpm) ? null : a.bpm,
    beats: a.bpm === null || !a.beats ? [] : Array.prototype.map.call(a.beats, function (s) { return Math.round(s * 1000) / 1000; }),
    data: _b64(bytes)
  };
}

function _analyse(h, src, key) {
  if (_pending && _pending.key === key) return _pending.promise;
  // The rate has to be chosen BEFORE the analysis, so the clip length is guessed
  // from the asset's own metadata where it has any; with no hint the first pass is
  // window-capped, which bounds its cost and reports the real length.
  var hintMs = src && src.meta ? Number(src.meta.durationMs) : 0;
  var promise = Promise.resolve()
    .then(function () { return h.audio.analyse(src, _plan(hintMs > 0 ? hintMs / 1000 : 0)); })
    .then(function (a) {
      // `duration` is the whole source; `window` is what was actually read.
      var plan = _plan(a.duration > 0 ? a.duration : a.window);
      // A second decode is real work (audiogram's rule), so it only happens when
      // the first pass was badly wrong: the rate off by more than 2x, or a span
      // short of what the plan would have covered.
      var short = a.window + 0.05 < plan.window;
      return (plan.fps * 2 <= a.fps || short) ? h.audio.analyse(src, plan) : a;
    })
    .then(function (a) {
      var packed = _pack(a);
      _track = { key: key, audio: packed };
      return packed;
    })
    .catch(function (err) {
      // An undecodable clip is a normal outcome, not a bug - codec support really
      // does differ between browsers, and Node has almost none. Say so once and
      // leave the scene running un-reactive.
      if (h.log) h.log('info', 'synth: could not analyse the audio, playing un-reactive', { error: err && err.message ? err.message : String(err) });
      _track = { key: key, audio: null };
      return null;
    })
    .then(function (out) { if (_pending && _pending.key === key) _pending = null; return out; });
  _pending = { key: key, promise: promise };
  return promise;
}

function _compute(model, h) {
  var inp = {};
  for (var i = 0; i < model.length; i++) inp[model[i].id] = model[i].value;

  // indexOf over a literal list, never a lookup on an object: an enum read as a
  // map key lets `constructor`/`__proto__` through as a "valid" option.
  var scene = _SCENES.indexOf(inp.scene) >= 0 ? inp.scene : 'ink';
  var seed = Math.round(_clamp(_num(inp.seed, 7), 0, 999999));

  var cfg = {
    scene: scene,
    // The canvas backing store, and so the export resolution. Pinned to the
    // manifest's render.width/height - a hook cannot read the manifest, and
    // `width`/`height` are RESERVED url params that never become inputs.
    width: 1280,
    height: 720,
    // The manifest's render.video.duration, for the same reason: the scene needs a
    // loop length when the exporter renders frames without declaring one (gif,
    // apng, webp-anim), and a fixed guess in the lib plays the loop in slow motion.
    durationSec: 6,
    colors: [
      _color(inp.color1, '#30ba78'),
      _color(inp.color2, '#2453ff'),
      _color(inp.color3, '#efefef')
    ],
    intensity: _clamp(_num(inp.intensity, 1), 0, 2),
    speed: _clamp(_num(inp.speed, 1), 0.05, 4),
    seed: seed,
    live: inp.live === true,
    emitters: _emitters(seed, 5)
  };

  var key = _srcKey(inp.audio);
  var canAnalyse = key && h && h.audio && h.audio.isAvailable && h.audio.isAvailable();
  if (!canAnalyse) {
    _dur = 0;
    return { _state: _safeJson(cfg) };
  }
  var done = function (audio) {
    cfg.audio = audio || null;
    _dur = audio && audio.dur > 0 ? audio.dur : 0;
    return { _state: _safeJson(cfg) };
  };
  // Cache hit: fold synchronously, so no budget applies at all and a slider drag
  // never waits on audio that is already in hand.
  if (_track && _track.key === key) return done(_track.audio);
  return _analyse(h, inp.audio, key).then(done);
}

function _host(ctx) {
  return ctx.host || (typeof host !== 'undefined' ? host : null);
}

function onInit(ctx) { return _compute(ctx.model, _host(ctx)); }
function onInput(ctx) { return _compute(ctx.model, _host(ctx)); }

/**
 * Make the loop as long as the audio it is playing.
 *
 * The scene's own forcing is periodic, so without a clip any duration comes out
 * seamless and the manifest's default stands. With a clip the picture is walked
 * across the analysis, and the export's audio bed is that same clip - so a
 * duration that isn't the clip's length would drift the two apart by
 * construction. A duration the user typed is a deliberate instruction and wins.
 */
function beforeExport(ctx) {
  if (!ctx || !ctx.opts) return;
  var ANIMATED = { webm: 1, mp4: 1, gif: 1, apng: 1, 'webp-anim': 1 };
  if (!ANIMATED[ctx.format]) return;
  if (ctx.opts.durationUserSet) return;
  if (_dur > 0.5) ctx.opts.duration = Math.round(_dur * 100) / 100;
}
