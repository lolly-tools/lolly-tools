/**
 * Imperfections Filter — hooks.
 *
 * Deliberate print imperfections for a photo: the artwork is split into ink
 * plates (CMY, two riso inks, or one mono ink) that recompose by multiply
 * blending over a tinted paper, then each plate drifts out of register with
 * seeded jitter, the whole print picks up ink bleed / photocopy wear through
 * SVG filter primitives (feTurbulence + feDisplacementMap + feGaussianBlur +
 * feComponentTransfer), and a paper-grain speckle sits on top.
 *
 * Everything is DECLARATIVE vector structure emitted as one inline <svg>
 * (extra `svgContent`): <image> plate layers + feColorMatrix separations +
 * filter primitives. The template is SVG-rooted, so the SVG export takes the
 * verbatim fast path — a true vector file with the source photo embedded, all
 * imperfections still live filter primitives, infinitely rescalable.
 *
 * Unlike the sampling filters (halftone/voronoi) the STILL path never decodes
 * pixels: the image is referenced by URL and every effect is an SVG filter, so
 * it renders in headless shells too. Only live camera (onFrame) needs a real
 * canvas, to turn the RGBA frame into a data URL the <image> layers can use.
 *
 * Determinism: feTurbulence carries an explicit seed and the plate jitter
 * comes from a mulberry32 PRNG seeded by the seed input — the same inputs
 * always produce byte-identical SVG. No unseeded Math.random anywhere.
 *
 * Paper colour is blended in OKLab (Björn Ottosson's matrices, ported from
 * engine/src/brand-derive.ts) — white → tint at mid strengths stays clean
 * instead of going muddy the way a naive sRGB lerp does. The grain fleck
 * colours are derived from the paper the same way.
 */

/* global onInit, onInput, onFrame, beforeExport, afterExport, host */

// Default viewBox edge when the tool has no explicit size yet (a square frame
// matching render.width/height). Once an image is picked the canvas takes the photo's
// own pixel size (see the auto-fit <script> in template.html); every render below works
// in the live width×height read from the export controls.
var VIEW = 1000;
var MAX_EDGE = 8000;   // upper bound on either canvas edge (matches width/height inputs' max)
// The default source image shown until the user picks one (a Lolly tool URL,
// resolved lazily via host.compose — same demo source as the sibling filters).
var DEFAULT_IMAGE_ID = 'https://lolly.tools/tool/bag-video.png';

var _defaultUrl = null;   // resolved demo-image URL, cached
var _memoKey = null;      // one-entry memo of the last rendered SVG
var _memoResult = null;
var _transparent = false; // remembered for beforeExport (which only gets format/opts)
var _paperColor = '#ffffff';
var _lastOv = null;       // most recent overlay params (compute()) — read by beforeExport
var _lastW = VIEW, _lastH = VIEW;  // most recent canvas size — read by beforeExport (overlay clock box)

// ── small helpers ────────────────────────────────────────────────────────────

// Live canvas size from the width/height inputs (synced from the export bar by the shell).
function dimW(inputs) { return clamp(Math.round(n(inputs.width, VIEW)), 1, MAX_EDGE); }
function dimH(inputs) { return clamp(Math.round(n(inputs.height, VIEW)), 1, MAX_EDGE); }

function inputsFrom(model) {
  var o = {};
  model.forEach(function (i) { o[i.id] = i.value; });
  return o;
}
function n(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
// === lolly:shared clamp — generated from community/_shared/math.js; edit there and run npm run sync:shared ===
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
// === /lolly:shared clamp ===
function f2(v) { return Math.round(v * 100) / 100; }
function f4(v) { return Math.round(v * 10000) / 10000; }
// FNV-1a → base36. Used to derive a CONTENT-DERIVED prefix for every SVG def id
// this tool emits, so two instances of the tool mounted in ONE document (the
// /multi view, a composed board, "render everything") can't cross-wire their
// url(#…) references to whichever defs happen to come first in document order.
// Content-derived rather than a counter: a per-module counter restarts at 1 in
// every runtime (each mount gets its own hooks module scope, so it would still
// collide), and hashing the defs-affecting inputs keeps the SVG byte-stable for
// identical inputs — two instances that hash the same emit identical defs, so
// sharing them is a no-op.
function hash32(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
// === lolly:shared esc — generated from community/_shared/text.js; edit there and run npm run sync:shared ===
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// === /lolly:shared esc ===

// Only needed by the LIVE path (frame → canvas → data URL); stills are pure SVG.
// === lolly:shared canRaster — generated from community/_shared/raster.js; edit there and run npm run sync:shared ===
function canRaster() {
  if (typeof document === 'undefined' || !document.createElement) return false;
  try { var c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d')); }
  catch (e) { return false; }
}
// === /lolly:shared canRaster ===

// `extra` is an attribute string appended to the root <svg> — used to stamp the
// auto-fit anchor (data-img-key) that the template.html <script> reads. The single
// root <svg> is deliberate (CLI vector export), so the anchor lives ON the root
// rather than a sibling element.
function svgOpen(W, H, extra) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" '
    + 'width="' + W + '" height="' + H + '" style="width:100%;height:auto;display:block;"'
    + (extra || '') + '>';
}

function placeholder(message, W, H) {
  W = W || VIEW; H = H || VIEW;
  return svgOpen(W, H)
    + '<rect width="' + W + '" height="' + H + '" fill="#f4f4f5"/>'
    + '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" '
    + 'dominant-baseline="middle" font-family="sans-serif" font-size="34" '
    + 'fill="#9ca3af">' + esc(message) + '</text>'
    + '</svg>';
}

// Deterministic PRNG (mulberry32) — drives the per-plate registration jitter.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── OKLab colour port ────────────────────────────────────────────────────────
// Ported from engine/src/brand-derive.ts (Björn Ottosson's reference matrices).
// Used for the paper-tint blend and the grain fleck colours: perceptual
// interpolation instead of a naive sRGB lerp, so a 50% tint reads as "half way"
// to the eye and never goes muddy. Tools can't import from the engine, so the
// maths lives here (plain JS, no host.* needed).

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

// '#rgb' / '#rrggbb' → [r,g,b] 0..255, or null when unparseable.
function hexToRgb(hex) {
  var h = (typeof hex === 'string' ? hex : '').trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex(r, g, b) {
  var cl = function (v) { return Math.max(0, Math.min(255, Math.round(v))); };
  var hx = function (v) { var s = cl(v).toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + hx(r) + hx(g) + hx(b);
}

// Linear sRGB → OKLab.
function linearSrgbToOklab(r, g, b) {
  var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// OKLab → linear sRGB (may fall outside [0,1] — rgbToHex clamps).
function oklabToLinearSrgb(L, a, b) {
  var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  var s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function hexToOklab(hex) {
  var rgb = hexToRgb(hex);
  if (!rgb) return null;
  return linearSrgbToOklab(srgbToLinear(rgb[0] / 255), srgbToLinear(rgb[1] / 255), srgbToLinear(rgb[2] / 255));
}
function oklabToHex(lab) {
  var rgb = oklabToLinearSrgb(lab[0], lab[1], lab[2]).map(function (c) { return linearToSrgb(c) * 255; });
  return rgbToHex(rgb[0], rgb[1], rgb[2]);
}

// Perceptual lerp: t=0 → hexA, t=1 → hexB, interpolated in OKLab.
function lerpOklab(hexA, hexB, t) {
  var a = hexToOklab(hexA), b = hexToOklab(hexB);
  if (!a || !b) return hexA;
  return oklabToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

// ══════════════════════════════════════════════════════════════════════════════
// Brand overlay — optional SUSE logo + gently-animated "lower third" name card.
//
// Synced from community/_shared/overlay.js (npm run sync:shared). Emits SVG children
// so the overlay survives ALL export paths — raster (png/webp/jpg), motion
// (gif/webm/mp4) AND vector (svg/pdf). Everything is OFF by default → overlayActive()
// is false → buildOverlaySvg() returns '' (zero markup / zero cost).
//
// Animation is ATTRIBUTE-BAKED (computed transform/opacity per render), never CSS
// @keyframes or SMIL: the tool's whole SVG is replaced on every paint / every live
// camera frame, which would reset a CSS/SMIL animation to t=0 each frame. Baking the
// pose means it looks identical in the live preview, in each captured video frame,
// and in a static vector snapshot. In live mode the gentle intro is driven by the
// camera clock (elapsed since the overlay first appeared).
//
// Module state used: _logoCache, _profileHeadshotUrl, _liveOvStart. Depends on `host`
// (host.assets.get / host.profile.get) being in scope.
// ══════════════════════════════════════════════════════════════════════════════
// === lolly:shared overlay — generated from community/_shared/overlay.js; edit there and run npm run sync:shared ===
var LOGO_ASPECT = 210.179 / 37.666;   // SUSE horizontal lockup, from its own viewBox
var _logoCache = {};                  // variantId -> url | null (resolved once per variant)
var _profileHeadshotUrl;              // undefined = not looked up; null = none; string = url
var _liveOvStart = null;              // frame.t when the overlay first became active while live

function ovEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
  });
}
function ovNum(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
function ovClamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function ovF2(v) { return Math.round(v * 100) / 100; }
function ovEaseOut(p) { p = ovClamp(p, 0, 1); return 1 - Math.pow(1 - p, 3); }

// Normalise the overlay-related inputs into one flat object (reused by still + live).
function overlayInputs(inp) {
  return {
    noFilter: !!inp.noFilter,
    showLogo: !!inp.showLogo,
    logoPosition: inp.logoPosition || 'top-right',
    logoStyle: inp.logoStyle || 'white',
    logoScale: inp.logoScale,
    lowerThird: !!inp.lowerThird,
    ltTheme: inp.ltTheme || 'bar',
    ltPosition: inp.ltPosition || 'left',
    firstname: inp.firstname,
    lastname: inp.lastname,
    title: inp.title,
    nameWeight: inp.nameWeight,
    subtitleWeight: inp.subtitleWeight,
  };
}
function overlayActive(o) { return !!(o.showLogo || o.lowerThird); }

// One of the 8 shipped SUSE logo ids. white → on-dark mono, green → on-dark colour,
// black → on-light mono. Horizontal lockup only (reads best over a strip/corner).
function logoVariantId(style) {
  return style === 'green' ? 'suse/logo/hor-neg-green'
    : style === 'black' ? 'suse/logo/hor-pos-black'
      : 'suse/logo/hor-neg-white';
}
// Resolve the chosen logo variant to a URL, cached per-variant. Safe to await in
// compute/onInit; call WITHOUT await from onFrame — it just warms the cache.
function resolveLogoUrl(style) {
  var id = logoVariantId(style);
  if (_logoCache[id] !== undefined) return Promise.resolve(_logoCache[id]);
  return host.assets.get(id)
    .then(function (r) { return (_logoCache[id] = (r && r.url) || null); })
    .catch(function () { return (_logoCache[id] = null); });
}
function cachedLogoUrl(style) { return _logoCache[logoVariantId(style)] || ''; }

// Resolve the user's PROFILE headshot to a URL once (async). Used as the auto default
// for the lower-third chip when the headshot input is empty. null = none / unavailable.
function resolveProfileHeadshot() {
  if (_profileHeadshotUrl !== undefined) return Promise.resolve(_profileHeadshotUrl);
  _profileHeadshotUrl = null;
  if (!host.profile || !host.profile.get) return Promise.resolve(null);
  return host.profile.get().then(function (p) {
    if (p && p.headshot && p.headshot.id) {
      return host.assets.get(p.headshot.id).then(function (r) { _profileHeadshotUrl = (r && r.url) || null; });
    }
  }).catch(function () { }).then(function () { return _profileHeadshotUrl; });
}

// Build the overlay SVG children. OW/OH = the output coordinate box (viewBox units).
// o = normalised overlay inputs + { logoUrl, headshotUrl, mode:'still'|'live', elapsed }.
function buildOverlaySvg(OW, OH, o) {
  if (!overlayActive(o)) return '';
  var live = o.mode === 'live';
  var elapsed = live ? ovNum(o.elapsed, 1e9) : 1e9;
  var out = '';

  // ── SUSE logo ──────────────────────────────────────────────────────────────
  if (o.showLogo && o.logoUrl) {
    var pos = o.logoPosition || 'top-right';
    var m = OW * 0.045;
    var scale = ovClamp(ovNum(o.logoScale, 1), 0.25, 3);
    var w = pos === 'full' ? ovClamp(OW * 0.72 * scale, 40, OW)
      : ovClamp(OW * 0.2 * scale, 24, OW - m * 2);
    var h = w / LOGO_ASPECT;
    var x = (pos === 'top-left' || pos === 'bottom-left') ? m
      : (pos === 'top-right' || pos === 'bottom-right') ? OW - m - w
        : (OW - w) / 2;
    var y = (pos === 'top-left' || pos === 'top-right' || pos === 'top') ? m
      : (pos === 'bottom-left' || pos === 'bottom-right' || pos === 'bottom') ? OH - m - h
        : (OH - h) / 2;
    var lop = live ? ovEaseOut(elapsed / 460) : 1;
    out += '<image href="' + ovEsc(o.logoUrl) + '" x="' + ovF2(x) + '" y="' + ovF2(y)
      + '" width="' + ovF2(w) + '" height="' + ovF2(h) + '" preserveAspectRatio="xMidYMid meet"'
      + (lop < 1 ? ' opacity="' + ovF2(lop) + '"' : '') + '/>';
  }

  // ── lower-third name card ────────────────────────────────────────────────────
  if (o.lowerThird) {
    var name = [String(o.firstname || '').trim(), String(o.lastname || '').trim()].filter(Boolean).join(' ') || 'Your name';
    var title = String(o.title || '').trim();
    var theme = o.ltTheme || 'bar';
    var lp = o.ltPosition || 'left';
    var hasShot = !!o.headshotUrl;

    var p = live ? ovEaseOut(elapsed / 560) : 1;
    var mg = OW * 0.045;
    var padX = OH * 0.032, padY = OH * 0.028;
    var nameSize = OH * 0.045, titleSize = OH * 0.028;
    var lineH = nameSize + (title ? titleSize * 1.5 : 0);
    var cardH = lineH + padY * 2;
    var chip = hasShot ? cardH - padY * 0.9 : 0;
    var gap = hasShot ? padX * 0.7 : 0;
    var nameW = name.length * nameSize * 0.6;
    var titleW = title.length * titleSize * 0.58;
    var textW = Math.max(nameW, titleW, OW * 0.14);
    var cardW = ovClamp(padX + (hasShot ? chip + gap : 0) + textW + padX, OW * 0.22, OW - mg * 2);

    var cx = lp === 'center' ? (OW - cardW) / 2 : lp === 'right' ? OW - mg - cardW : mg;
    var cy = OH - mg - cardH;
    var dy = (1 - p) * (OH * 0.035);

    var accent = '#30ba78';
    var r = Math.min(cardH * 0.2, 22);
    var g = '<g transform="translate(' + ovF2(cx) + ' ' + ovF2(cy + dy) + ')"'
      + (p < 1 ? ' opacity="' + ovF2(p) + '"' : '') + '>';

    if (theme === 'bar') {
      g += ovRRect(0, 0, cardW, cardH, r, '#111111', 0.97);
    } else if (theme === 'glass') {
      g += ovRRect(0, 0, cardW, cardH, r, '#0b1512', 0.34);
      g += '<rect x="0.75" y="0.75" width="' + ovF2(cardW - 1.5) + '" height="' + ovF2(cardH - 1.5)
        + '" rx="' + ovF2(r) + '" ry="' + ovF2(r) + '" fill="none" stroke="#ffffff" stroke-opacity="0.3" stroke-width="1.4"/>';
    } // 'minimal' → no plate; text carries a soft outline for legibility

    var textX = padX + (hasShot ? chip + gap : 0);
    var blockTop = (cardH - lineH) / 2;
    var nameY = blockTop + nameSize * 0.82;
    var titleY = nameY + titleSize * 1.4;
    var titleColor = theme === 'bar' ? '#a9e3c8' : '#e6f0ec';
    var shadow = theme === 'minimal'
      ? ' style="paint-order:stroke;stroke:#0b1512;stroke-opacity:0.55;stroke-width:' + ovF2(nameSize * 0.14) + 'px;stroke-linejoin:round"'
      : '';
    var titleShadow = theme === 'minimal'
      ? ' style="paint-order:stroke;stroke:#0b1512;stroke-opacity:0.55;stroke-width:' + ovF2(titleSize * 0.16) + 'px;stroke-linejoin:round"'
      : '';
    var FONT = 'SUSE, system-ui, -apple-system, sans-serif';

    if (hasShot) {
      var cxs = padX + chip / 2, cys = cardH / 2, rad = chip / 2;
      g += '<clipPath id="lollyShot"><circle cx="' + ovF2(cxs) + '" cy="' + ovF2(cys) + '" r="' + ovF2(rad) + '"/></clipPath>';
      g += '<image href="' + ovEsc(o.headshotUrl) + '" x="' + ovF2(padX) + '" y="' + ovF2(cys - rad)
        + '" width="' + ovF2(chip) + '" height="' + ovF2(chip) + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#lollyShot)"/>';
      g += '<circle cx="' + ovF2(cxs) + '" cy="' + ovF2(cys) + '" r="' + ovF2(rad) + '" fill="none" stroke="' + accent + '" stroke-width="' + ovF2(rad * 0.09) + '"/>';
    }

    g += '<text x="' + ovF2(textX) + '" y="' + ovF2(nameY) + '" font-family="' + FONT + '" font-size="' + ovF2(nameSize)
      + '" font-weight="' + ovClamp(Math.round(ovNum(o.nameWeight, 700)), 100, 900) + '" fill="#ffffff"' + shadow + '>' + ovEsc(name) + '</text>';
    if (title) {
      g += '<text x="' + ovF2(textX) + '" y="' + ovF2(titleY) + '" font-family="' + FONT + '" font-size="' + ovF2(titleSize)
        + '" font-weight="' + ovClamp(Math.round(ovNum(o.subtitleWeight, 500)), 100, 900) + '" fill="' + titleColor + '"' + titleShadow + '>' + ovEsc(title) + '</text>';
    }
    var ulY = (title ? titleY : nameY) + (title ? titleSize * 0.55 : nameSize * 0.4);
    var ulW = Math.min(nameW, cardW - textX - padX) * (live ? p : 1);
    g += '<rect x="' + ovF2(textX) + '" y="' + ovF2(ulY) + '" width="' + ovF2(Math.max(0, ulW)) + '" height="' + ovF2(Math.max(2, nameSize * 0.08)) + '" rx="' + ovF2(nameSize * 0.04) + '" fill="' + accent + '"/>';

    g += '</g>';
    out += g;
  }

  return out;
}
// A rounded rect (rx clamped) shared by the overlay themes.
function ovRRect(x, y, w, h, r, fill, op) {
  r = Math.min(r, w / 2, h / 2);
  return '<rect x="' + ovF2(x) + '" y="' + ovF2(y) + '" width="' + ovF2(w) + '" height="' + ovF2(h)
    + '" rx="' + ovF2(r) + '" ry="' + ovF2(r) + '" fill="' + fill + '"'
    + (op != null && op < 1 ? ' fill-opacity="' + ovF2(op) + '"' : '') + '/>';
}

// ── Export frame clock (motion formats only) ─────────────────────────────────
// A still export always renders the overlay at rest (mode:'still' → fully faded
// in, no offset) — correct for png/svg/pdf/etc. But a gif/webm/mp4 export of a
// STILL photo previously held that same resting pose for the whole clip: the
// intro ease-in buildOverlaySvg already does for 'live' (camera) mode never
// played, because nothing called it with mode:'live' + an advancing elapsed.
// armOverlayClock wires that up: register __lollyFrameRender on the tool's
// inert clock-anchor canvas (see docs on <canvas data-ov-clock> in template.html
// — the same anchor-element convention as the slides tool, required because the
// capture loop only drives a t through a <canvas> carrying that property), and
// on each captured frame rebuild JUST the overlay markup (via the untouched
// buildOverlaySvg) at that frame's elapsed ms, splicing it into a stable slot
// (`<g id="lolly-ov-slot">`, wrapped once around every buildOverlaySvg() call
// site in the tool's buildSvg()). The expensive filtered-image content is never
// touched — only the overlay's own small SVG fragment is rebuilt per frame.
// getOv(t) returns a full overlay-input object (mode:'live', elapsed: t*clipMs) —
// callers build it from their own cached _lastOv (see armFilterOverlayExport).
// W/H are the SAME viewBox-units box the tool's own buildOverlaySvg(W, H, …) call
// used for the still render — a fixed VIEW constant for the square-canvas tools,
// or the tool's own current width/height for the ones with dynamic W/H inputs.
function armOverlayClock(root, W, H, getOv) {
  var canvas = root && root.querySelector && root.querySelector('[data-ov-clock]');
  var slot = root && root.querySelector && root.querySelector('#lolly-ov-slot');
  if (!canvas || !slot) return null;
  canvas.__lollyFrameRender = function (t) {
    try {
      var ov = getOv(t);
      slot.innerHTML = ov ? buildOverlaySvg(W, H, ov) : '';
    } catch (e) { /* leave the last good frame in place */ }
  };
  return canvas;
}
function disarmOverlayClock(canvas) {
  if (!canvas) return;
  try { delete canvas.__lollyFrameRender; } catch (e) { canvas.__lollyFrameRender = undefined; }
}
// Formats the clock should arm for — every other export (png/svg/pdf/jpg/webp/…)
// captures the still, at-rest overlay exactly as before.
var OV_MOTION_FORMATS = { gif: 1, apng: 1, webm: 1, mp4: 1 };
// Shared beforeExport/afterExport glue: arms the clock for a motion export using
// the tool's own _lastOv/_lastW/_lastH (module state set at the end of compute())
// and disarms it afterwards. Tools with their own beforeExport logic (e.g. alpha
// background) call this from inside it rather than using it as their whole hook.
var _ovClock = null;
function armFilterOverlayExport(ctx, W, H, lastOv) {
  if (!lastOv || !overlayActive(lastOv) || !OV_MOTION_FORMATS[ctx.format]) return;
  var clipMs = ((ctx.opts && ctx.opts.duration) || 5) * 1000;
  _ovClock = armOverlayClock(ctx.node, W, H, function (t) {
    return Object.assign({}, lastOv, { mode: 'live', elapsed: t * clipMs });
  });
}
function disarmFilterOverlayExport() {
  disarmOverlayClock(_ovClock);
  _ovClock = null;
}
// === /lolly:shared overlay ===

// ── effect recipe ────────────────────────────────────────────────────────────

// Resolve the preset + strength + custom sliders into one effect recipe.
// Amounts: misreg in viewBox units, bleed 0..8, degrade 0..1, grain 0..1.
function effectParams(inputs) {
  var preset = typeof inputs.preset === 'string' ? inputs.preset : 'subtle';
  var k = clamp(n(inputs.strength, 100), 0, 100) / 100;
  var p;
  if (preset === 'riso') p = { plates: 'duo', misreg: 5, bleed: 2.2, degrade: 0 };
  else if (preset === 'photocopy') p = { plates: 'mono', misreg: 0, bleed: 0.9, degrade: 70 };
  else if (preset === 'worn') p = { plates: 'cmy', misreg: 3.4, bleed: 3.2, degrade: 32 };
  else if (preset === 'custom') p = {
    plates: inputs.plates === 'duo' ? 'duo' : inputs.plates === 'mono' ? 'mono' : 'cmy',
    misreg: clamp(n(inputs.misregAmount, 2), 0, 12),
    bleed: clamp(n(inputs.bleedAmount, 1.5), 0, 8),
    degrade: clamp(n(inputs.degradeAmount, 0), 0, 100),
  };
  else p = { plates: 'cmy', misreg: 2, bleed: 1.2, degrade: 0 };
  return {
    plates: p.plates,
    misreg: p.misreg * k,
    bleed: p.bleed * k,
    degrade: (p.degrade / 100) * k,
    grain: (clamp(n(inputs.grainAmount, 25), 0, 100) / 100) * k,
    seed: clamp(Math.round(n(inputs.seed, 7)), 1, 9999),
  };
}

// Rec.709 luma coefficients — used by the luminance-driven plate separations.
var LUM_R = 0.2126, LUM_G = 0.7152, LUM_B = 0.0722;

// A feColorMatrix row for "ink over white by luminance": out = ink + (1-ink)*(a*L + b)
// (values outside 0..1 clamp inside the filter, which is exactly the coverage clip
// a real duotone curve needs). ink is the channel value 0..1.
function inkRow(ink, a, b) {
  var w = 1 - ink;
  return f4(w * a * LUM_R) + ' ' + f4(w * a * LUM_G) + ' ' + f4(w * a * LUM_B) + ' 0 ' + f4(ink + w * b);
}

// The per-plate separation matrices (20 values each). Multiplying the plates
// back together over white reproduces the artwork; over tinted paper it prints.
function plateMatrices(mode, ink1, ink2) {
  if (mode === 'duo') {
    var i1 = hexToRgb(ink1) || [0, 120, 191];
    var i2 = hexToRgb(ink2) || [255, 72, 176];
    var a1 = [i1[0] / 255, i1[1] / 255, i1[2] / 255];
    var a2 = [i2[0] / 255, i2[1] / 255, i2[2] / 255];
    return [
      // Shadow ink: heavy coverage in the darks, clipped out of the highlights.
      inkRow(a1[0], 1.4, 0) + ' ' + inkRow(a1[1], 1.4, 0) + ' ' + inkRow(a1[2], 1.4, 0) + ' 0 0 0 1 0',
      // Highlight/mid ink: gentler curve, a little ink even in the lights.
      inkRow(a2[0], 0.9, 0.1) + ' ' + inkRow(a2[1], 0.9, 0.1) + ' ' + inkRow(a2[2], 0.9, 0.1) + ' 0 0 0 1 0',
    ];
  }
  if (mode === 'mono') {
    var lum = f4(LUM_R) + ' ' + f4(LUM_G) + ' ' + f4(LUM_B) + ' 0 0';
    return [lum + ' ' + lum + ' ' + lum + ' 0 0 0 1 0'];
  }
  // CMY: each plate keeps one subtractive ink (its own channel) and floods the
  // other two channels to 1 (no ink there) — multiply recomposes the original.
  return [
    '1 0 0 0 0 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0', // cyan plate: keeps R
    '0 0 0 0 1 0 1 0 0 0 0 0 0 0 1 0 0 0 1 0', // magenta plate: keeps G
    '0 0 0 0 1 0 0 0 0 1 0 0 1 0 0 0 0 0 1 0', // yellow plate: keeps B
  ];
}

// The bleed/degrade filter chain — pure SVG filter primitives, applied to the
// whole plate group so the composed print soaks as one.
function fxFilter(e, U) {
  if (e.bleed <= 0.01 && e.degrade <= 0.01) return '';
  var f = '<filter id="' + U + 'fx" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">';
  // Noise sources first (feTurbulence takes no input, so it can't sit mid-chain).
  f += '<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="' + e.seed + '" result="impN1"/>';
  if (e.degrade > 0.01) {
    // Long horizontal streak field for copier drag.
    f += '<feTurbulence type="fractalNoise" baseFrequency="0.003 0.12" numOctaves="1" seed="' + (e.seed + 7) + '" result="impN2"/>';
  }
  var first = true;
  function inAttr() { var s = first ? ' in="SourceGraphic"' : ''; first = false; return s; }
  if (e.degrade > 0.01) {
    // Photocopy: wash the colour out, then a harsh linear tone snap.
    f += '<feColorMatrix' + inAttr() + ' type="saturate" values="' + f4(1 - 0.85 * e.degrade) + '"/>';
    var sl = 1 + 2.6 * e.degrade;
    var ic = -(sl - 1) * 0.5;
    f += '<feComponentTransfer' + inAttr() + '>'
      + '<feFuncR type="linear" slope="' + f4(sl) + '" intercept="' + f4(ic) + '"/>'
      + '<feFuncG type="linear" slope="' + f4(sl) + '" intercept="' + f4(ic) + '"/>'
      + '<feFuncB type="linear" slope="' + f4(sl) + '" intercept="' + f4(ic) + '"/>'
      + '</feComponentTransfer>';
  }
  if (e.bleed > 0.01) {
    // Ink bleed: soften, then push contrast back up so edges rough rather than blur.
    f += '<feGaussianBlur' + inAttr() + ' stdDev="' + f4(0.55 * e.bleed) + '"/>';
    var bs = 1 + 0.18 * e.bleed;
    var bi = -(bs - 1) * 0.5;
    f += '<feComponentTransfer>'
      + '<feFuncR type="linear" slope="' + f4(bs) + '" intercept="' + f4(bi) + '"/>'
      + '<feFuncG type="linear" slope="' + f4(bs) + '" intercept="' + f4(bi) + '"/>'
      + '<feFuncB type="linear" slope="' + f4(bs) + '" intercept="' + f4(bi) + '"/>'
      + '</feComponentTransfer>';
  }
  // Edge roughening: displace the composed print through the fine noise field.
  var disp = 2.4 * e.bleed + 4 * e.degrade;
  if (disp > 0.01) {
    f += '<feDisplacementMap' + inAttr() + ' in2="impN1" scale="' + f4(disp) + '" xChannelSelector="R" yChannelSelector="G"/>';
  }
  if (e.degrade > 0.01) {
    f += '<feDisplacementMap in2="impN2" scale="' + f4(9 * e.degrade) + '" xChannelSelector="R" yChannelSelector="G"/>';
  }
  f += '</filter>';
  return f;
}

// Grain: constant-colour speckle whose alpha comes from seeded turbulence. Two
// passes — dark flecks multiply (ink sitting down into the tooth), light flecks
// screen (ink missing off the tooth peaks). Fleck colours derive from the paper
// in OKLab so the speckle always belongs to the stock.
function grainDefs(e, paper, U) {
  if (e.grain <= 0.005) return '';
  var dark = hexToRgb(lerpOklab(paper, '#221a10', 0.85)) || [34, 26, 16];
  var light = hexToRgb(lerpOklab(paper, '#ffffff', 0.7)) || [255, 255, 255];
  function speckle(id, rgb, seed) {
    return '<filter id="' + id + '" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">'
      + '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="' + seed + '"/>'
      + '<feColorMatrix type="matrix" values="'
      + '0 0 0 0 ' + f4(rgb[0] / 255) + ' '
      + '0 0 0 0 ' + f4(rgb[1] / 255) + ' '
      + '0 0 0 0 ' + f4(rgb[2] / 255) + ' '
      + '0.6 0.6 0.6 0 -0.55"/>'
      + '</filter>';
  }
  return speckle(U + 'grain-d', dark, e.seed + 13) + speckle(U + 'grain-l', light, e.seed + 29);
}
function grainRects(e, U) {
  if (e.grain <= 0.005) return '';
  return '<rect width="100%" height="100%" filter="url(#' + U + 'grain-d)" opacity="' + f4(0.55 * e.grain) + '" style="mix-blend-mode:multiply"/>'
    + '<rect width="100%" height="100%" filter="url(#' + U + 'grain-l)" opacity="' + f4(0.45 * e.grain) + '" style="mix-blend-mode:screen"/>';
}

// Colour-section grade (hue/saturation/lightness) as a filter on the result group.
function hslFilter(hueDeg, sat, light, U) {
  if (hueDeg === 0 && sat === 1 && light === 0) return '';
  var f = '<filter id="' + U + 'hsl" color-interpolation-filters="sRGB">';
  var first = true;
  function inAttr() { var s = first ? ' in="SourceGraphic"' : ''; first = false; return s; }
  if (hueDeg !== 0) f += '<feColorMatrix' + inAttr() + ' type="hueRotate" values="' + f4(hueDeg) + '"/>';
  if (sat !== 1) f += '<feColorMatrix' + inAttr() + ' type="saturate" values="' + f4(sat) + '"/>';
  if (light !== 0) {
    var sl = light > 0 ? 1 - light : 1 + light;
    var ic = light > 0 ? light : 0;
    f += '<feComponentTransfer' + inAttr() + '>'
      + '<feFuncR type="linear" slope="' + f4(sl) + '" intercept="' + f4(ic) + '"/>'
      + '<feFuncG type="linear" slope="' + f4(sl) + '" intercept="' + f4(ic) + '"/>'
      + '<feFuncB type="linear" slope="' + f4(sl) + '" intercept="' + f4(ic) + '"/>'
      + '</feComponentTransfer>';
  }
  return f + '</filter>';
}

var BLEND_MODES = {
  normal: 1, multiply: 1, screen: 1, overlay: 1, darken: 1, lighten: 1,
  'color-dodge': 1, 'color-burn': 1, 'hard-light': 1, 'soft-light': 1,
  difference: 1, exclusion: 1, hue: 1, saturation: 1, color: 1, luminosity: 1,
};

// ── the SVG ──────────────────────────────────────────────────────────────────

// A per-render prefix for every def id, derived from exactly the inputs that
// shape the defs (NOT the image URL, which can be a multi-megabyte live-camera
// data URI — hashing it once a frame would cost more than the render). Two
// instances whose defs would be byte-identical share a prefix, which is
// harmless; any difference in separation matrices, bleed/degrade chain, grain
// seed or colour grade gives a different prefix, so /multi, composed boards and
// "render everything" never cross-wire url(#…) to the first instance's defs.
function defsPrefix(args) {
  var e = args.effect;
  return 'imp' + hash32(JSON.stringify([
    e.plates, e.misreg, e.bleed, e.degrade, e.grain, e.seed,
    args.ink1, args.ink2, args.paper, args.hueDeg, args.sat, args.light,
  ])) + '-';
}

function buildSvg(args) {
  var W = args.W || VIEW, H = args.H || VIEW;
  var par = args.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice';
  // Auto-fit anchor stamped on the root <svg> — the demo default carries an empty key
  // (never resizes); a live camera frame passes no key at all. See template.html.
  var rootExtra = args.imgKey != null ? ' data-img-key="' + esc(args.imgKey) + '"' : '';

  // No-filter bypass: raw source + overlay, no press simulation at all. Honours
  // the SAME fit as the filtered path — toggling "No filter" must change the
  // effect only, never the framing, or it is useless as an A/B compare.
  if (args.noFilter) {
    var bgnf = args.transparent ? null : args.paper;
    var onf = svgOpen(W, H, rootExtra);
    if (bgnf) onf += '<rect width="100%" height="100%" fill="' + esc(bgnf) + '"/>';
    if (args.url) onf += '<image href="' + ovEsc(args.url) + '" x="0" y="0" width="100%" height="100%" preserveAspectRatio="' + par + '"/>';
    onf += '<g id="lolly-ov-slot">' + buildOverlaySvg(W, H, args._ov || {}) + '</g>';
    onf += '</svg>';
    return onf;
  }

  var e = args.effect;
  var U = defsPrefix(args);
  var matrices = plateMatrices(e.plates, args.ink1, args.ink2);
  var rng = mulberry32(e.seed);

  var defs = '<defs>';
  for (var i = 0; i < matrices.length; i++) {
    defs += '<filter id="' + U + 'p' + i + '" color-interpolation-filters="sRGB">'
      + '<feColorMatrix type="matrix" values="' + matrices[i] + '"/></filter>';
  }
  var fx = fxFilter(e, U);
  defs += fx;
  defs += grainDefs(e, args.paper, U);
  var hsl = hslFilter(args.hueDeg, args.sat, args.light, U);
  defs += hsl;
  defs += '</defs>';

  var out = svgOpen(W, H, rootExtra) + defs;

  // Everything the Colour grade applies to (paper + print + grain).
  out += '<g' + (hsl ? ' filter="url(#' + U + 'hsl)"' : '') + '>';

  // Paper.
  if (!args.transparent) {
    out += '<rect width="100%" height="100%" fill="' + esc(args.paper) + '"/>';
  }

  // The print: one <image> per ink plate, separated by its matrix, multiplied
  // down onto the paper, each drifting out of register with seeded jitter.
  //
  // The GROUP carries mix-blend-mode:multiply, not just the plates. A filter on
  // a group makes it an ISOLATED group (css-compositing-1 §5.1), so the plates'
  // own multiply would blend against a transparent backdrop and the composed
  // print would then land source-over on the paper rect — the paper tint was
  // invisible in every setting that produced a filter (i.e. all of them but
  // strength 0). Multiplying at the group level composites the finished print
  // down onto the paper regardless of isolation, and multiplication is
  // associative, so the unfiltered case renders exactly as before.
  out += '<g style="mix-blend-mode:multiply"' + (fx ? ' filter="url(#' + U + 'fx)"' : '') + '>';
  for (var pI = 0; pI < matrices.length; pI++) {
    var dx = (rng() * 2 - 1) * e.misreg;
    var dy = (rng() * 2 - 1) * e.misreg;
    var density = 0.94 + rng() * 0.06; // uneven ink take-up, per plate
    out += '<image href="' + ovEsc(args.url) + '" x="0" y="0" width="100%" height="100%"'
      + ' preserveAspectRatio="' + par + '"'
      + ' filter="url(#' + U + 'p' + pI + ')"'
      + (e.misreg > 0.01 ? ' transform="translate(' + f2(dx) + ' ' + f2(dy) + ')"' : '')
      + ' opacity="' + f4(density) + '"'
      + ' style="mix-blend-mode:multiply"/>';
  }
  out += '</g>';

  // Paper grain over the print (tooth shows through the ink).
  out += grainRects(e, U);

  out += '</g>';

  // Colour treatment over the whole result.
  if (args.treat && args.treatAmt > 0) {
    var mode = BLEND_MODES[args.treatMode] ? args.treatMode : 'multiply';
    out += '<rect width="100%" height="100%" fill="' + esc(args.treat) + '"'
      + ' opacity="' + f4(args.treatAmt) + '" style="mix-blend-mode:' + mode + '"/>';
  }

  out += '<g id="lolly-ov-slot">' + buildOverlaySvg(W, H, args._ov || {}) + '</g>';
  out += '</svg>';
  return out;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

// Assemble the render args shared by the still + live paths.
function renderArgs(inputs, url, ov) {
  var effect = effectParams(inputs);
  var tintHex = hexToRgb(inputs.paperTint) ? inputs.paperTint : '#f2ead9';
  var tintK = clamp(n(inputs.paperTintStrength, 60), 0, 100) / 100;
  var paper = lerpOklab('#ffffff', tintHex, tintK); // perceptual, not sRGB
  var treat = hexToRgb(inputs.treatmentColor) ? inputs.treatmentColor : null;
  return {
    url: url,
    W: dimW(inputs), H: dimH(inputs),
    noFilter: !!(ov && ov.noFilter),
    effect: effect,
    ink1: inputs.ink1,
    ink2: inputs.ink2,
    fit: inputs.fit === 'contain' ? 'contain' : 'cover',
    paper: paper,
    transparent: _transparent,
    hueDeg: clamp(n(inputs.hue, 0), -180, 180),
    sat: clamp(n(inputs.saturation, 100), 0, 200) / 100,
    light: clamp(n(inputs.lightness, 0), -100, 100) / 100,
    treat: treat,
    treatMode: typeof inputs.blendMode === 'string' ? inputs.blendMode : 'multiply',
    treatAmt: treat ? clamp(n(inputs.treatmentIntensity, 20), 0, 100) / 100 : 0,
    _ov: ov,
  };
}

async function compute(model) {
  var inputs = inputsFrom(model);
  _transparent = Boolean(inputs.transparentBg);

  // Resolve the image URL: the user's pick, else the demo default (cached).
  var ref = inputs.image;
  var url = ref && typeof ref === 'object' ? ref.url : null;
  // Only a user-chosen image drives the auto-fit (template.html); the demo default
  // must never resize the canvas on first load.
  var isUserPick = !!url;
  if (!url) {
    if (!_defaultUrl) {
      try {
        var def = (DEFAULT_IMAGE_ID.indexOf('://') !== -1)
          ? (host.compose && host.compose.renderUrl ? await host.compose.renderUrl(DEFAULT_IMAGE_ID) : null)
          : await host.assets.get(DEFAULT_IMAGE_ID);
        _defaultUrl = def && def.url;
      } catch (e) {
        if (host.log) host.log('warn', 'filter-imperfections: default image unavailable', { error: String(e) });
      }
    }
    url = _defaultUrl;
  }
  if (!url) return { svgContent: placeholder('Choose an image to misprint') };

  // Brand overlay — resolve logo + headshot URLs (cached) before building.
  var ovi = overlayInputs(inputs);
  if (ovi.showLogo) await resolveLogoUrl(ovi.logoStyle);
  var headUrl = (inputs.ltHeadshot && inputs.ltHeadshot.url) || '';
  if (ovi.lowerThird && !headUrl) headUrl = (await resolveProfileHeadshot()) || '';
  var ov = Object.assign({}, ovi, { logoUrl: cachedLogoUrl(ovi.logoStyle), headshotUrl: headUrl, mode: 'still' });
  _lastOv = ov; // read by beforeExport to arm the motion-export overlay clock

  var args = renderArgs(inputs, url, ov);
  args.imgKey = isUserPick ? url : '';  // stamped on the root <svg> for the auto-fit script
  _paperColor = args.paper; // beforeExport fills non-square export margins with the paper
  _lastW = args.W; _lastH = args.H;

  // The args object is the single source of truth for both the memo key and the
  // render, so a render-affecting input can never drift out of the memo.
  var memoKey = JSON.stringify(args);
  if (memoKey === _memoKey) return _memoResult;

  var svgContent = buildSvg(args);
  _memoKey = memoKey;
  _memoResult = { svgContent: svgContent };
  return _memoResult;
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }

// Live camera (engine v1.4): the runtime drives this once per frame with raw
// RGBA pixels. The declarative filter pipeline needs an href, so the frame goes
// through a canvas → JPEG data URL; the SAME buildSvg then misprints it. This is
// the only place the tool touches a canvas — stills stay fully declarative.
// Degrades to null (no patch, last frame stays) on a headless shell.
function onFrame(ctx) {
  var frame = ctx.frame;
  if (!frame || !frame.data || !frame.width || !frame.height) return null;
  if (!canRaster() || typeof ImageData === 'undefined') return null;
  var inputs = inputsFrom(ctx.model);
  _transparent = Boolean(inputs.transparentBg);

  var url;
  try {
    var src = document.createElement('canvas');
    src.width = frame.width;
    src.height = frame.height;
    var sctx = src.getContext('2d');
    sctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    url = src.toDataURL('image/jpeg', 0.85);
  } catch (e) { return null; }

  // Brand overlay (live): warm caches without awaiting; intro runs on camera time.
  var ovi = overlayInputs(inputs);
  if (overlayActive(ovi)) { if (_liveOvStart == null) _liveOvStart = frame.t; }
  else _liveOvStart = null;
  if (ovi.showLogo && _logoCache[logoVariantId(ovi.logoStyle)] === undefined) resolveLogoUrl(ovi.logoStyle);
  if (ovi.lowerThird && _profileHeadshotUrl === undefined) resolveProfileHeadshot();
  var headUrl = (inputs.ltHeadshot && inputs.ltHeadshot.url) || _profileHeadshotUrl || '';
  var ov = Object.assign({}, ovi, {
    logoUrl: cachedLogoUrl(ovi.logoStyle), headshotUrl: headUrl,
    mode: 'live', elapsed: frame.t - (_liveOvStart == null ? frame.t : _liveOvStart),
  });

  var args = renderArgs(inputs, url, ov);
  _paperColor = args.paper;
  _lastW = args.W; _lastH = args.H;
  // A live frame supersedes the still memo, so a later still re-render recomputes.
  _memoKey = null;
  return { svgContent: buildSvg(args) };
}

// ── Export frame-clock anchor, mounted on demand ─────────────────────────────
// Not in template.html on purpose (see the comment there). armOverlayClock only
// needs SOME [data-ov-clock] element inside ctx.node, and ctx.node is exactly the
// node the capture loop later scans (engine runtime passes one node to both
// beforeExport and host.export.render). Width/height MUST be forced to 0: a fresh
// <canvas> defaults to 300x150, and a canvas with a backing store is treated as a
// LIVE painting canvas by the web shell's static-chrome fast path, which would blit
// a blank rectangle over every frame.
var _ovClockEl = null;   // NB: _ovClock (no El) belongs to the shared region
function mountOvClockAnchor(node) {
  if (!node || !node.ownerDocument || !node.appendChild) return null;
  var el = node.querySelector && node.querySelector('[data-ov-clock]');
  if (el) return el;
  el = node.ownerDocument.createElement('canvas');
  el.setAttribute('data-ov-clock', '');
  el.setAttribute('aria-hidden', 'true');
  el.width = 0; el.height = 0;
  node.appendChild(el);
  return (_ovClockEl = el);
}
function unmountOvClockAnchor() {
  if (_ovClockEl && _ovClockEl.parentNode) _ovClockEl.parentNode.removeChild(_ovClockEl);
  _ovClockEl = null;
}

function beforeExport(ctx) {
  // Alpha-capable raster formats: "No BG" exports real transparency (the SVG
  // omits its paper rect); otherwise fill the whole exported frame with the
  // paper colour so a non-square export has no transparent margins around the
  // square print (the SVG's own paper rect only covers its square viewBox).
  var alpha = ['png', 'webp', 'avif'];
  if (alpha.indexOf(ctx.format) !== -1) {
    ctx.opts.background = _transparent ? 'transparent' : _paperColor;
  } else if (ctx.format === 'jpg' || ctx.format === 'jpeg') {
    // JPEG carries no alpha: without this the transparent margins of a
    // non-square export encode as BLACK bars, not paper. "No BG" cannot be
    // honoured here, so paper is the only sane fill.
    ctx.opts.background = _paperColor;
  }
  // gif/apng/webm/mp4 only: replay the overlay's intro deterministically.
  if (_lastOv && overlayActive(_lastOv) && OV_MOTION_FORMATS[ctx.format]) mountOvClockAnchor(ctx.node);
  armFilterOverlayExport(ctx, _lastW, _lastH, _lastOv);
}
function afterExport() { disarmFilterOverlayExport(); unmountOvClockAnchor(); }
