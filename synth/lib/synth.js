// SPDX-License-Identifier: MPL-2.0
/* Lolly Synth - the WebGL2 harness and the `ink` scene, as one IIFE global.
 *
 * Ships as tool DATA under the tool's own lib/ (like tools/3d/lib/three.min.js),
 * loaded by a deduped dynamic <script> from the template. Hand-written, not
 * generated: there is no build step and no second copy of this source, so the
 * file that ships is the file that is reviewed.
 *
 * WebGL2, deliberately - NOT WebGPU. A WebGPU canvas has no
 * `preserveDrawingBuffer` equivalent, so every raster/video export off one comes
 * out blank; WebGL2 runs the whole existing export stack today.
 *
 * DETERMINISM. A fluid is a feedback simulation: frame N is a function of frame
 * N-1, so there is no seeking. The export clock therefore RESETS and replays
 * from a cleared field (the viz-tool-mount precedent), stepping a fixed timestep
 * with the forcing driven by loop phase alone - never wall-clock, never a live
 * meter. All variation comes from the seeded emitter table the hooks compute, so
 * a shared URL replays the same piece. Cross-GPU float divergence still means
 * "deterministic" is stable on one device/driver, not bit-identical everywhere.
 */
(function (global) {
  'use strict';

  // The emitters' phase is periodic over exactly one loop, so the forcing at the
  // end of a loop is the forcing at its start and a field in its periodic
  // attractor arrives back where it began - that is what closes the seam. The
  // loop is however many sim frames the EXPORT turns out to span (the frame
  // clock's clipSec), so a clip of any length is seamless rather than only the
  // one length the tool guessed; live preview falls back to LOOP frames.
  var LOOP = 120;
  var SIM_HZ = 60;
  // Frames replayed from a cleared field before frame 0, so the field is already
  // in its periodic attractor when the loop starts - about 4.5 time constants of
  // the dissipation below. Measured headlessly at 640x360: the wrap from the last
  // frame back to the first costs 1.7x a normal frame-to-frame step, against 9x
  // for two unrelated frames. Doubling this to 300 only reaches 1.4x - a forced
  // fluid is chaotic, so the seam narrows but never fully closes, and the extra
  // second of mount is not worth the difference.
  var WARMUP = 150;
  // A bigger forward jump than this replays from cleared instead. Stepping
  // forward is always CORRECT (it is the same simulation continuing), so this is
  // purely a cost bound - and the replay it falls back to costs WARMUP frames, so
  // anything smaller than WARMUP would buy the more expensive path. Low-frame-rate
  // exports of a long clip land squarely in that gap.
  var MAX_STEP = WARMUP;
  var FRAME_DT = 1 / 60;  // fixed sim timestep; `speed` scales it, never a clock
  var ITER = 14;          // pressure Jacobi iterations
  var MAX_POINTS = 8;     // splat points per pass (emitters + pointer impulses)
  var SPECTRUM = 32;      // bins in a Signals record's spectrum

  /* ── Signals: one contract, two sources ────────────────────────────────────
   *
   * A scene reads exactly one per-frame record:
   *
   *   { rms, bass, mid, treble, onset, beatPhase, spectrum[32] }   all 0..1
   *
   * DETERMINISTIC (what every export uses): the record is read out of the
   * host.audio analysis the hooks packed, indexed by the frame's own clip time.
   * The frame clock is the only clock - never a wall clock, never a live meter -
   * so the same clip and the same seed replay the same piece.
   *
   * LIVE: the same record, filled from whatever the browser realm is hearing.
   * Not wired in this build (see the tool's report): a hook patch rebuilds the
   * tool's DOM, which drops the WebGL context, so a per-sample level hook cannot
   * drive a GL canvas. Everything downstream of `signalsAt` is source-agnostic.
   *
   * IDLE is the record with no audio at all, and every reaction below is written
   * to be neutral at idle - a scene with no clip renders exactly as it did
   * before there was audio in the tool, including while an analysis is still
   * running.
   */
  var IDLE = {
    rms: 0, bass: 0, mid: 0, treble: 0, onset: 0, beatPhase: 0,
    spectrum: new Float32Array(SPECTRUM)
  };

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function unb64(s) {
    var clean = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
    var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    var at = 0, buf = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
      buf = (buf << 6) | B64.indexOf(clean.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out[at++] = (buf >> bits) & 255; }
    }
    return out.subarray(0, at);
  }

  /**
   * Decode the packed analysis the hooks put in the state. Section order is the
   * contract with hooks.js _pack(): the five scalar tracks, then the spectrum
   * rows. A payload that disagrees with its own header is a bug, not something
   * to animate around - it returns null and the scene plays un-reactive.
   */
  function unpackAudio(meta) {
    if (!meta || !(meta.count > 0) || !(meta.bands > 0) || !meta.data) return null;
    var count = meta.count | 0, bands = meta.bands | 0;
    var raw = unb64(meta.data);
    if (raw.length < count * 5 + count * bands) return null;
    var at = 0;
    var take = function (n) { var s = raw.subarray(at, at + n); at += n; return s; };
    var fps = meta.fps > 0 ? meta.fps : 24;
    return {
      fps: fps, count: count, bands: bands,
      dur: meta.dur > 0 ? meta.dur : count / fps,
      // A tempo is either found or it is not. `null` survives all the way to the
      // scene; nothing here invents one.
      bpm: typeof meta.bpm === 'number' && isFinite(meta.bpm) && meta.bpm > 0 ? meta.bpm : null,
      beats: Array.isArray(meta.beats) ? meta.beats : [],
      rms: take(count), bass: take(count), mid: take(count), treb: take(count), flux: take(count),
      mag: take(count * bands)
    };
  }

  /**
   * Where in the current beat `t` sits, 0 at the beat and rising to 1 just
   * before the next one.
   *
   * bpm === null means the clip holds too little rhythm to call a tempo, which
   * is the common answer for speech, ambience and pads. The phase then IDLES at
   * zero for the whole clip and the beat pulse never fires. Substituting a
   * default tempo (120 is the documented trap) would put every visual accent in
   * the wrong place, which reads far worse than no accent at all.
   */
  function beatPhase(track, t) {
    var b = track.beats;
    if (track.bpm === null || !b || b.length < 2) return 0;
    if (!(t >= b[0]) || t >= b[b.length - 1]) return 0;
    var lo = 0, hi = b.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (b[mid] <= t) lo = mid; else hi = mid; }
    var span = b[lo + 1] - b[lo];
    return span > 0 ? clampNum((t - b[lo]) / span, 0, 1) : 0;
  }

  /**
   * Clip time for sim frame `f` of a `period`-frame loop spanning `secs` seconds.
   *
   * PURE, and exported for the same reason signalsAt is. The frame count is
   * capped (a long clip runs the sim SLOWER rather than being cut short), so
   * `f / SIM_HZ` would stop at the cap and leave everything past it unheard: a
   * three-minute track would drive the picture from its first minute while the
   * bed played the whole thing. Loop phase always spans the whole clip.
   */
  function clipTime(f, period, secs) {
    if (!(period > 0) || !(secs > 0)) return f / SIM_HZ;
    return (f / period) * secs;
  }

  /**
   * The Signals record for clip time `tSec`. PURE: same track, same time, same
   * numbers, on any machine - which is what makes an export reproducible.
   *
   * Time indexes the track by nearest frame and clamps at both ends, so the
   * warm-up frames before t=0 read the clip's first frame and a picture longer
   * than its soundtrack holds on the last one rather than falling silent.
   */
  function signalsAt(track, tSec) {
    if (!track) return IDLE;
    var t = typeof tSec === 'number' && isFinite(tSec) && tSec > 0 ? tSec : 0;
    var i = Math.round(t * track.fps);
    if (i < 0) i = 0;
    if (i >= track.count) i = track.count - 1;
    var spectrum = new Float32Array(SPECTRUM);
    var row = i * track.bands;
    for (var b = 0; b < SPECTRUM; b++) {
      // MAX over the source bins, never a mean: a mean smears a narrow peak into
      // its neighbours and the field stops moving with the sound.
      var lo = Math.floor((b * track.bands) / SPECTRUM);
      var hi = Math.max(lo + 1, Math.floor(((b + 1) * track.bands) / SPECTRUM));
      var m = 0;
      for (var k = lo; k < hi && k < track.bands; k++) { var v = track.mag[row + k]; if (v > m) m = v; }
      spectrum[b] = m / 255;
    }
    return {
      rms: track.rms[i] / 255,
      bass: track.bass[i] / 255,
      mid: track.mid[i] / 255,
      treble: track.treb[i] / 255,
      onset: track.flux[i] / 255,
      beatPhase: beatPhase(track, t),
      spectrum: spectrum
    };
  }

  var VERT = [
    'in vec2 aPos;',
    'out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;',
    'uniform vec2 uTexel;',
    'void main(){',
    '  vUv = aPos * 0.5 + 0.5;',
    '  vL = vUv - vec2(uTexel.x, 0.0); vR = vUv + vec2(uTexel.x, 0.0);',
    '  vT = vUv + vec2(0.0, uTexel.y); vB = vUv - vec2(0.0, uTexel.y);',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  // OKLab in GLSL. The maths is Ottosson's, the same numbers engine/src/
  // brand-derive.ts carries - ported, not imported: a tool never reaches into
  // the engine. Every colour the scene paints is a ramp through this space, so
  // brand colours blend perceptually instead of through muddy linear RGB.
  var OKLAB = [
    'vec3 srgbToLinear(vec3 c){',
    '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));',
    '}',
    'vec3 linearToSrgb(vec3 c){',
    '  c = max(c, 0.0);',
    '  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));',
    '}',
    'vec3 srgbToOklab(vec3 s){',
    '  vec3 c = srgbToLinear(s);',
    '  vec3 lms = vec3(',
    '    0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b,',
    '    0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b,',
    '    0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);',
    '  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));',
    '  return vec3(',
    '    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,',
    '    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,',
    '    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);',
    '}',
    'vec3 oklabToSrgb(vec3 lab){',
    '  vec3 lms = vec3(',
    '    lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,',
    '    lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,',
    '    lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z);',
    '  lms = lms * lms * lms;',
    '  vec3 c = vec3(',
    '     4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,',
    '    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,',
    '    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z);',
    '  return clamp(linearToSrgb(c), 0.0, 1.0);',
    '}'
  ].join('\n');

  var HEAD = 'precision highp float;\nprecision highp sampler2D;\nin vec2 vUv;\nin vec2 vL;\nin vec2 vR;\nin vec2 vT;\nin vec2 vB;\nout vec4 fragColor;\n';

  var FRAG = {
    // Semi-Lagrangian advection. `uSource` is velocity or dye; both are stored
    // unencoded because the harness requires a float-renderable target.
    advect: [
      'uniform sampler2D uVelocity; uniform sampler2D uSource;',
      'uniform vec2 uTexel; uniform float uDt; uniform float uDissipation;',
      'void main(){',
      '  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;',
      '  fragColor = uDissipation * texture(uSource, coord);',
      '}'
    ].join('\n'),

    // Additive gaussian splats: the periodic emitters plus any pointer impulse.
    splat: [
      'uniform sampler2D uTarget; uniform vec2 uPoints[8]; uniform vec4 uValues[8];',
      'uniform float uRadius; uniform float uAspect; uniform int uCount;',
      'void main(){',
      '  vec4 acc = vec4(0.0);',
      '  for (int i = 0; i < 8; i++){',
      '    if (i >= uCount) break;',
      '    vec2 p = vUv - uPoints[i]; p.x *= uAspect;',
      '    acc += uValues[i] * exp(-dot(p, p) / uRadius);',
      '  }',
      '  fragColor = texture(uTarget, vUv) + acc;',
      '}'
    ].join('\n'),

    curl: [
      'uniform sampler2D uVelocity;',
      'void main(){',
      '  float l = texture(uVelocity, vL).y, r = texture(uVelocity, vR).y;',
      '  float t = texture(uVelocity, vT).x, b = texture(uVelocity, vB).x;',
      '  fragColor = vec4(r - l - (t - b), 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'),

    // Vorticity confinement - puts back the small eddies the grid eats, which is
    // what makes ink read as ink rather than as smoke.
    vorticity: [
      'uniform sampler2D uVelocity; uniform sampler2D uCurl;',
      'uniform float uStrength; uniform float uDt;',
      'void main(){',
      '  float l = texture(uCurl, vL).x, r = texture(uCurl, vR).x;',
      '  float t = texture(uCurl, vT).x, b = texture(uCurl, vB).x;',
      '  float c = texture(uCurl, vUv).x;',
      '  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));',
      '  force /= length(force) + 0.0001;',
      '  force *= uStrength * c;',
      '  force.y *= -1.0;',
      '  vec2 v = texture(uVelocity, vUv).xy + force * uDt;',
      '  fragColor = vec4(clamp(v, -4000.0, 4000.0), 0.0, 1.0);',
      '}'
    ].join('\n'),

    divergence: [
      'uniform sampler2D uVelocity;',
      'void main(){',
      '  float l = texture(uVelocity, vL).x, r = texture(uVelocity, vR).x;',
      '  float t = texture(uVelocity, vT).y, b = texture(uVelocity, vB).y;',
      '  fragColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'),

    clear: [
      'uniform sampler2D uTexture; uniform float uValue;',
      'void main(){ fragColor = uValue * texture(uTexture, vUv); }'
    ].join('\n'),

    pressure: [
      'uniform sampler2D uPressure; uniform sampler2D uDivergence;',
      'void main(){',
      '  float l = texture(uPressure, vL).x, r = texture(uPressure, vR).x;',
      '  float t = texture(uPressure, vT).x, b = texture(uPressure, vB).x;',
      '  float d = texture(uDivergence, vUv).x;',
      '  fragColor = vec4((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'),

    gradient: [
      'uniform sampler2D uPressure; uniform sampler2D uVelocity;',
      'void main(){',
      '  float l = texture(uPressure, vL).x, r = texture(uPressure, vR).x;',
      '  float t = texture(uPressure, vT).x, b = texture(uPressure, vB).x;',
      '  vec2 v = texture(uVelocity, vUv).xy - vec2(r - l, t - b);',
      '  fragColor = vec4(v, 0.0, 1.0);',
      '}'
    ].join('\n'),

    // Dye carries density in .r and density*tone in .g, so tone survives
    // advection as a ratio instead of bleeding to zero in the empty field.
    // Every colour on screen is that tone read through the OKLab ramp - the
    // scene has no palette of its own, which is what keeps it brand-locked.
    display: [
      OKLAB,
      'uniform sampler2D uDye; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3;',
      'void main(){',
      '  vec2 d = texture(uDye, vUv).rg;',
      '  float density = clamp(d.r, 0.0, 1.0);',
      '  float tone = clamp(d.g / max(d.r, 0.0001), 0.0, 1.0);',
      '  vec3 a = srgbToOklab(uC1), b = srgbToOklab(uC2), c = srgbToOklab(uC3);',
      '  vec3 lab = tone < 0.5 ? mix(a, b, tone * 2.0) : mix(b, c, tone * 2.0 - 1.0);',
      '  vec3 ground = oklabToSrgb(vec3(a.x * 0.12, a.y * 0.35, a.z * 0.35));',
      '  fragColor = vec4(mix(ground, oklabToSrgb(lab), density), 1.0);',
      '}'
    ].join('\n')
  };

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, '#version 300 es\n' + src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('synth shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function program(gl, vs, fragSrc) {
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    var fs = compile(gl, gl.FRAGMENT_SHADER, HEAD + fragSrc);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('synth link: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(fs);
    var u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p: p, u: u };
  }

  function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function hexToRgb(hex) {
    var s = String(hex || '').trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return [0.5, 0.5, 0.5];
    return [
      parseInt(s.slice(0, 2), 16) / 255,
      parseInt(s.slice(2, 4), 16) / 255,
      parseInt(s.slice(4, 6), 16) / 255
    ];
  }

  /**
   * Internal field resolutions for an output of W×H. Not an input, and not the
   * export resolution: velocity and pressure carry no detail worth resolving, so
   * they run coarse and the dye they push around runs fine. Never larger than the
   * output it will be drawn into.
   *
   * A PURE function of the output size, and of nothing else. It used to scale
   * both grids down when devicePixelRatio > 1.5, which is every Retina Mac as
   * well as every phone: a different grid is a different simulation, so the same
   * URL rendered a materially different piece on a laptop than on a desktop
   * monitor. The determinism claim at the top of this file outranks the thermal
   * saving.
   *
   * ponytail: one grid for every device, so a phone runs the full sim. If that
   * cooks one, the knob is a declared "Quality" input folded into `_state` - a
   * shared, reproducible value - never a device probe read at mount.
   */
  function fieldSizes(W, H) {
    var ar = W / H;
    var box = function (shortSide) {
      var s = Math.min(Math.min(W, H), Math.round(shortSide));
      return [Math.max(32, Math.round(ar > 1 ? s * ar : s)), Math.max(32, Math.round(ar > 1 ? s : s / ar))];
    };
    return { sim: box(192), dye: box(512) };
  }

  function create(canvas, cfg) {
    // preserveDrawingBuffer is THE load-bearing flag: the export path reads the
    // canvas after the frame has composited, and without it every raster and
    // video export is silently blank. It cannot be added by a later getContext -
    // the first call's attributes are the ones that stick.
    var gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This browser cannot render to floating-point textures.');
    }

    var W = cfg.width, H = cfg.height;
    canvas.width = W;
    canvas.height = H;

    var sizes = fieldSizes(W, H);
    var aspect = W / H;

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var prog = {};
    var names = ['advect', 'splat', 'curl', 'vorticity', 'divergence', 'clear', 'pressure', 'gradient', 'display'];
    for (var i = 0; i < names.length; i++) prog[names[i]] = program(gl, vs, FRAG[names[i]]);
    gl.deleteShader(vs);   // linked into every program already; freed with the last one

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    var fbos = [];
    function makeFbo(w, h, filter) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      var o = {
        tex: tex, fbo: fbo, w: w, h: h, texel: [1 / w, 1 / h],
        bind: function (unit) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); return unit; }
      };
      fbos.push(o);
      return o;
    }
    function makeDouble(w, h, filter) {
      var a = makeFbo(w, h, filter), b = makeFbo(w, h, filter);
      return {
        get read() { return a; }, get write() { return b; },
        swap: function () { var t = a; a = b; b = t; }
      };
    }

    var velocity = makeDouble(sizes.sim[0], sizes.sim[1], gl.LINEAR);
    var pressure = makeDouble(sizes.sim[0], sizes.sim[1], gl.NEAREST);
    var divergence = makeFbo(sizes.sim[0], sizes.sim[1], gl.NEAREST);
    var curl = makeFbo(sizes.sim[0], sizes.sim[1], gl.NEAREST);
    var dye = makeDouble(sizes.dye[0], sizes.dye[1], gl.LINEAR);
    var screen = { w: W, h: H, texel: [1 / W, 1 / H] };

    // The texel a pass works in is the TARGET's own, not one global: dye runs at
    // a finer grid than velocity, so an advection step that used the velocity
    // texel would displace the dye by the wrong distance.
    function use(pr, target) {
      var t = target || screen;
      gl.useProgram(pr.p);
      if (pr.u.uTexel) gl.uniform2f(pr.u.uTexel, t.texel[0], t.texel[1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, t.w, t.h);
    }
    function draw() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

    var intensity = clampNum(cfg.intensity, 0, 2);
    var speed = clampNum(cfg.speed, 0.05, 4);
    // The manifest's declared animated-export length, carried in the state
    // because a lib cannot read a manifest. Only used when the exporter renders
    // frames without telling the tool how long the clip is.
    var defaultSecs = clampNum(cfg.durationSec > 0 ? cfg.durationSec : LOOP / SIM_HZ, 0.5, 3600);
    var emitters = cfg.emitters || [];
    var cols = cfg.colors || [];
    var c1 = hexToRgb(cols[0]), c2 = hexToRgb(cols[1]), c3 = hexToRgb(cols[2]);

    // Pointer impulses, consumed by the next sim step. Bounded so a fast drag
    // can never grow the queue without limit.
    var impulses = [];

    var track = unpackAudio(cfg.audio);

    /**
     * The Signals for sim frame `f`. The export loop spans the WHOLE clip, so a
     * frame's own time is its position in the loop times the clip's length - the
     * picture cannot drift against its soundtrack at any clip length. Warm-up
     * frames (f < 0) clamp to the clip's first frame.
     *
     * Live preview has no transport to follow and no loop length declared to it,
     * so it runs at sim rate and wraps the track - the piece keeps moving instead
     * of freezing on the last frame.
     */
    function signalsFor(f, live) {
      if (!track) return IDLE;
      var t = live ? f / SIM_HZ : clipTime(f, period, loopSecs);
      if (!(t > 0)) t = 0;
      if (live && track.dur > 0) t = t % track.dur;
      return signalsAt(track, t);
    }

    // The forcing for sim frame `f`, as splat points. Phase is a function of the
    // frame index alone (never a clock), and each emitter's orbit completes a
    // whole number of turns per loop - that periodicity is what closes the loop.
    function forcing(f, period, sig) {
      var phase = (((f % period) + period) % period) / period;
      // Every audio term below is written so that IDLE (all zeros) leaves the
      // forcing exactly as it was before the tool had audio: a clip lifts the
      // piece, it does not replace it.
      var beat = sig.beatPhase > 0 ? (1 - sig.beatPhase) : 0;
      var pulse = 1 + 0.6 * beat * beat * beat;
      var pts = [], dyeVals = [], velVals = [];
      for (var i = 0; i < emitters.length && pts.length < MAX_POINTS - 1; i++) {
        var e = emitters[i];
        var a = 2 * Math.PI * (e.turns * phase + e.phase);
        var x = e.x + e.radius * Math.cos(a);
        var y = e.y + e.radius * Math.sin(a);
        var tx = -Math.sin(a), ty = Math.cos(a);
        // Each source listens to its own part of the spectrum, picked by its
        // seeded tone - so the sources answer the music separately instead of
        // all pumping together, and which one answers what is part of the seed.
        var bandE = sig.spectrum[Math.min(SPECTRUM - 1, Math.floor(e.tone * SPECTRUM))];
        var lift = 1 + 1.2 * sig.bass + 0.8 * bandE;
        var amp = 0.35 * intensity * (0.65 + 0.35 * Math.cos(2 * Math.PI * (e.turns * phase + e.phase * 2))) * lift * pulse;
        // Treble slides the ink up the ramp toward the third colour.
        var tone = clampNum(e.tone + 0.2 * sig.treble, 0, 1);
        var push = e.push * intensity * (1 + 0.8 * sig.rms);
        pts.push([x, y]);
        dyeVals.push([amp, amp * tone, 0, 0]);
        velVals.push([tx * push, ty * push, 0, 0]);
      }
      for (var k = 0; k < impulses.length && pts.length < MAX_POINTS; k++) {
        var im = impulses[k];
        pts.push([im.x, im.y]);
        dyeVals.push([0.5 * intensity, 0.5 * intensity * im.tone, 0, 0]);
        velVals.push([im.dx, im.dy, 0, 0]);
      }
      impulses.length = 0;
      return { pts: pts, dye: dyeVals, vel: velVals };
    }

    function splat(target, source, pts, values, radius) {
      var pr = prog.splat;
      use(pr, target);
      gl.uniform1i(pr.u.uTarget, source.bind(0));
      gl.uniform1f(pr.u.uRadius, radius);
      gl.uniform1f(pr.u.uAspect, aspect);
      gl.uniform1i(pr.u.uCount, pts.length);
      var flatP = new Float32Array(MAX_POINTS * 2), flatV = new Float32Array(MAX_POINTS * 4);
      for (var i = 0; i < pts.length; i++) {
        flatP[i * 2] = pts[i][0]; flatP[i * 2 + 1] = pts[i][1];
        flatV[i * 4] = values[i][0]; flatV[i * 4 + 1] = values[i][1];
        flatV[i * 4 + 2] = values[i][2]; flatV[i * 4 + 3] = values[i][3];
      }
      gl.uniform2fv(pr.u.uPoints, flatP);
      gl.uniform4fv(pr.u.uValues, flatV);
      draw();
    }

    function step(f, period, live) {
      var dt = FRAME_DT * speed;
      var sig = signalsFor(f, live);
      var force = forcing(f, period, sig);
      if (force.pts.length) {
        splat(velocity.write, velocity.read, force.pts, force.vel, 0.0035); velocity.swap();
        splat(dye.write, dye.read, force.pts, force.dye, 0.0022); dye.swap();
      }

      use(prog.curl, curl);
      gl.uniform1i(prog.curl.u.uVelocity, velocity.read.bind(0));
      draw();

      use(prog.vorticity, velocity.write);
      gl.uniform1i(prog.vorticity.u.uVelocity, velocity.read.bind(0));
      gl.uniform1i(prog.vorticity.u.uCurl, curl.bind(1));
      // An onset is an attack - a struck note, a beat, a consonant. Confinement
      // is what turns one into a visible curl, so that is where it lands.
      gl.uniform1f(prog.vorticity.u.uStrength, 24.0 * (1 + 1.6 * sig.onset));
      gl.uniform1f(prog.vorticity.u.uDt, dt);
      draw();
      velocity.swap();

      use(prog.divergence, divergence);
      gl.uniform1i(prog.divergence.u.uVelocity, velocity.read.bind(0));
      draw();

      use(prog.clear, pressure.write);
      gl.uniform1i(prog.clear.u.uTexture, pressure.read.bind(0));
      gl.uniform1f(prog.clear.u.uValue, 0.8);
      draw();
      pressure.swap();

      for (var i = 0; i < ITER; i++) {
        use(prog.pressure, pressure.write);
        gl.uniform1i(prog.pressure.u.uPressure, pressure.read.bind(0));
        gl.uniform1i(prog.pressure.u.uDivergence, divergence.bind(1));
        draw();
        pressure.swap();
      }

      use(prog.gradient, velocity.write);
      gl.uniform1i(prog.gradient.u.uPressure, pressure.read.bind(0));
      gl.uniform1i(prog.gradient.u.uVelocity, velocity.read.bind(1));
      draw();
      velocity.swap();

      // Dissipation is the loop's tuning knob, not just a look: it sets how long
      // the field remembers, and a memory that outlasts the loop is a seam. Both
      // constants are short enough that WARMUP frames wipe the start transient.
      use(prog.advect, velocity.write);
      gl.uniform1i(prog.advect.u.uVelocity, velocity.read.bind(0));
      gl.uniform1i(prog.advect.u.uSource, velocity.read.bind(0));
      gl.uniform1f(prog.advect.u.uDt, dt);
      gl.uniform1f(prog.advect.u.uDissipation, 0.970);
      draw();
      velocity.swap();

      use(prog.advect, dye.write);
      gl.uniform1i(prog.advect.u.uVelocity, velocity.read.bind(0));
      gl.uniform1i(prog.advect.u.uSource, dye.read.bind(1));
      gl.uniform1f(prog.advect.u.uDt, dt);
      gl.uniform1f(prog.advect.u.uDissipation, 0.960);
      draw();
      dye.swap();
    }

    function paint() {
      var pr = prog.display;
      use(pr, null);
      gl.uniform1i(pr.u.uDye, dye.read.bind(0));
      gl.uniform3f(pr.u.uC1, c1[0], c1[1], c1[2]);
      gl.uniform3f(pr.u.uC2, c2[0], c2[1], c2[2]);
      gl.uniform3f(pr.u.uC3, c3[0], c3[1], c3[2]);
      draw();
      gl.flush();
    }

    function clearField() {
      var targets = [velocity.read, velocity.write, dye.read, dye.write, pressure.read, pressure.write, divergence, curl];
      for (var i = 0; i < targets.length; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[i].fbo);
        gl.viewport(0, 0, targets[i].w, targets[i].h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      impulses.length = 0;
    }

    var cursor = -1;      // last sim frame the export clock rendered
    var period = 0;       // sim frames in the loop the export clock is walking
    var loopSecs = 0;     // clip seconds that loop spans
    var liveFrame = 0;
    var acc = 0;
    var lastTs = 0;
    var resumeOwed = false;
    var raf = 0;
    var disposed = false;

    /**
     * The deterministic export clock. t is normalised clip time in [0,1);
     * clipSec is the clip's real length, which the export decides after a frame
     * plan the tool never sees - so the loop is sized from it rather than from a
     * span guessed here, and a clip of any length closes seamlessly.
     *
     * A jump backwards, a jump further than MAX_STEP, a change of clip length,
     * or t === 0 replays the field from cleared. Without that an export would
     * inherit whatever the live preview had built up, and the same URL would
     * export differently depending on how long it had been on screen.
     */
    function renderLoopFrame(t01, clipSec) {
      if (disposed) return;
      // A live pointer impulse must never leak into a driven replay, or the same
      // URL exports differently depending on where the cursor happened to be.
      impulses.length = 0;
      var t = clampNum(typeof t01 === 'number' && isFinite(t01) ? t01 : 0, 0, 0.999999);
      // Only the video path passes clipSec; gif/apng/webp-anim and the export's
      // own static-chrome probe repaint call with the phase alone. Falling back to
      // a fixed guess there played the loop at a fraction of speed (a 6 s GIF of
      // 2 s of sim) and read only the head of the analysis, so: the last length
      // the exporter declared, else the clip's own, else the manifest's default.
      var secs = typeof clipSec === 'number' && isFinite(clipSec) && clipSec > 0
        ? clipSec
        : (loopSecs || (track && track.dur > 0 ? track.dur : defaultSecs));
      var frames = Math.max(24, Math.min(3600, Math.round(secs * SIM_HZ)));
      var target = Math.floor(t * frames);
      var jumped = cursor < 0 || frames !== period || secs !== loopSecs
        || target < cursor || target - cursor > MAX_STEP || t01 === 0;
      var f = jumped ? -WARMUP : cursor + 1;
      if (jumped) clearField();
      // Both BEFORE stepping: signalsFor reads them to place each frame in the clip.
      period = frames;
      loopSecs = secs;
      for (; f <= target; f++) step(f, frames, false);
      cursor = target;
      resumeOwed = true;   // the live clock owes itself one swallowed delta
      paint();
    }

    function disposeAll() {
      if (disposed) return;
      disposed = true;
      if (raf) global.cancelAnimationFrame(raf);
      if (pointerHandlers) pointerHandlers();
      for (var i = 0; i < fbos.length; i++) {
        gl.deleteTexture(fbos[i].tex);
        gl.deleteFramebuffer(fbos[i].fbo);
      }
      for (var k in prog) if (Object.prototype.hasOwnProperty.call(prog, k)) gl.deleteProgram(prog[k].p);
      gl.deleteBuffer(quad);
      // Contexts are capped around 16 per tab and are not collected promptly,
      // so a paint that leaks one is a tool that stops rendering after a while.
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }

    function loop(ts) {
      if (disposed) return;
      // A detached canvas is a dead instrument. The tool view's teardown has no
      // hook for a disposer a template registered, and only the NEXT paint of this
      // same tool calls dispose() - so without this, navigating away leaves the
      // full solve running at 60fps, and its GL context pinned (they cap around
      // 16 a tab), for the rest of the session. Same guard audiogram uses.
      if (!canvas.isConnected) { disposeAll(); return; }
      raf = global.requestAnimationFrame(loop);
      // The exporter is driving exact frames: stop advancing on wall-clock (a
      // stray repaint would clobber the phase between paint and capture), but
      // keep the loop armed so it resumes when the flag clears.
      if (canvas.__lollyFrameDriven) { resumeOwed = true; return; }
      if (global.document && global.document.hidden) return;
      if (resumeOwed) { lastTs = ts; resumeOwed = false; return; }
      var dt = lastTs ? (ts - lastTs) / 1000 : FRAME_DT;
      lastTs = ts;
      if (!(dt > 0)) dt = FRAME_DT;
      acc += Math.min(dt, 0.25);
      var n = 0;
      while (acc >= FRAME_DT && n < 4) { acc -= FRAME_DT; step(liveFrame++, LOOP, true); n++; }
      if (n) paint();
    }

    var pointerHandlers = null;
    function wirePointer() {
      var last = null;
      var down = function (e) { last = { x: e.clientX, y: e.clientY }; };
      var move = function (e) {
        var r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var px = last ? e.clientX - last.x : 0;
        var py = last ? e.clientY - last.y : 0;
        last = { x: e.clientX, y: e.clientY };
        if (impulses.length >= MAX_POINTS) return;
        impulses.push({
          x: clampNum((e.clientX - r.left) / r.width, 0, 1),
          y: clampNum(1 - (e.clientY - r.top) / r.height, 0, 1),
          dx: clampNum(px * 12, -2500, 2500),
          dy: clampNum(-py * 12, -2500, 2500),
          tone: clampNum((e.clientX - r.left) / r.width, 0, 1)
        });
      };
      var up = function () { last = null; };
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointerleave', up);
      pointerHandlers = function () {
        canvas.removeEventListener('pointerdown', down);
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointerleave', up);
      };
    }
    if (cfg.live) wirePointer();

    // One synchronous frame now: a headless or hidden-tab host may never fire a
    // rAF, and the export path would then capture an empty canvas.
    renderLoopFrame(0);
    raf = global.requestAnimationFrame(loop);

    return {
      renderLoopFrame: renderLoopFrame,
      sizes: sizes,
      dispose: disposeAll
    };
  }

  // signalsAt/unpackAudio are exported for the same reason fieldSizes is: they
  // are pure and testable without a GL context, and the signals mapping is the
  // part an export's reproducibility actually rests on.
  global.LollySynth = {
    create: create, fieldSizes: fieldSizes, LOOP: LOOP, SIM_HZ: SIM_HZ, SPECTRUM: SPECTRUM,
    unpackAudio: unpackAudio, signalsAt: signalsAt, clipTime: clipTime, IDLE: IDLE
  };
})(typeof window !== 'undefined' ? window : this);
