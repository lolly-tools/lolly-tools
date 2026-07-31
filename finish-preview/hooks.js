/**
 * Finish Preview — hooks.
 *
 * Simulates physical print finishes (foil, spot UV, emboss/deboss, soft-touch
 * matte) over the user's artwork, and — the actual deliverable — exports the
 * finish MASK PLATE as pure black shapes on white for the print house.
 *
 * The whole scene is emitted as one inline <svg> (extra `finishSvg`) so exports
 * take the verbatim SVG fast path: the artwork stays an <image> at native
 * resolution, the finish materials are real SVG gradients/filters, and the
 * plate view is a filter-free black-on-white raster inside the SVG (PDF-safe).
 *
 * The finish mask is computed per-pixel in OKLab — lightness thresholds use
 * OKLab L and the by-colour mode uses OKLab distance, never naive sRGB — via
 * the self-contained colour port below (Björn Ottosson's reference matrices).
 * Metallic foil ramps are interpolated in OKLab too; the holographic foil is
 * an OKLCH hue sweep.
 *
 * Pixel decoding needs a real <canvas> (browser only). In a headless shell
 * (CLI/jsdom) there's no 2D context, so the hook degrades to a friendly
 * placeholder instead of throwing — this is a browser-rendered tool.
 *
 * Deterministic by construction: no unseeded randomness anywhere (the grain
 * uses a fixed feTurbulence seed; the sheen is a fixed-period loop that stills
 * to its centred pose for stills / reduced motion).
 */

/* global onInit, onInput, beforeExport, host */

// The viewBox everything lives in — matches render.width/height (a square frame).
var VIEW = 1000;
// The default source image shown until the user picks one (a Lolly tool URL,
// resolved lazily via host.compose — same convention as the other filter tools).
var DEFAULT_IMAGE_ID = 'https://lolly.tools/tool/bag-video.png';

// Decoded-image cache (keyed by URL); holds the in-flight PROMISE so re-renders
// during the first decode share one load.
var _imgCache = { url: null, promise: null };
var _defaultUrl = null;
// One-entry memo of the last rendered SVG, keyed on every input that affects it.
var _memoKey = null;
var _memoResult = null;
// Remembered for beforeExport (which only gets format/opts): the export-margin fill.
var _bgColor = '#ffffff';

// ── small helpers ────────────────────────────────────────────────────────────

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
// === lolly:shared esc — generated from community/_shared/text.js; edit there and run npm run sync:shared ===
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// === /lolly:shared esc ===

// A valid CSS colour string, or a fallback. Keeps stray input out of the SVG.
function color(v, fallback) {
  var s = (typeof v === 'string' ? v : '').trim();
  return s ? s : fallback;
}

function svgOpen() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" '
    + 'viewBox="0 0 ' + VIEW + ' ' + VIEW + '" '
    + 'preserveAspectRatio="xMidYMid meet">';
}

function placeholder(message) {
  return svgOpen()
    + '<rect width="' + VIEW + '" height="' + VIEW + '" fill="#f4f4f5"/>'
    + '<text x="' + (VIEW / 2) + '" y="' + (VIEW / 2) + '" text-anchor="middle" '
    + 'dominant-baseline="middle" font-family="sans-serif" font-size="34" '
    + 'fill="#9ca3af">' + esc(message) + '</text>'
    + '</svg>';
}

// ── image decoding ───────────────────────────────────────────────────────────

// === lolly:shared loadImage — generated from community/_shared/raster.js; edit there and run npm run sync:shared ===
function loadImage(url) {
  return new Promise(function (resolve, reject) {
    if (typeof Image === 'undefined') { reject(new Error('no Image')); return; }
    var im = new Image();
    im.onload = function () { resolve(im); };
    im.onerror = function () { reject(new Error('image load failed')); };
    try { im.crossOrigin = 'anonymous'; } catch (e) { /* ignore */ }
    im.src = url;
  });
}
// === /lolly:shared loadImage ===

function getImage(url) {
  if (_imgCache.url === url && _imgCache.promise) return _imgCache.promise;
  var promise = loadImage(url);
  _imgCache = { url: url, promise: promise };
  promise.catch(function () { if (_imgCache.url === url) _imgCache = { url: null, promise: null }; });
  return promise;
}

// === lolly:shared canRaster — generated from community/_shared/raster.js; edit there and run npm run sync:shared ===
function canRaster() {
  if (typeof document === 'undefined' || !document.createElement) return false;
  try { var c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d')); }
  catch (e) { return false; }
}
// === /lolly:shared canRaster ===

// ── OKLab colour port (Björn Ottosson's reference matrices) ──────────────────
// sRGB <-> OKLab, plus OKLCH construction. Used for the mask (perceptual
// lightness thresholds + colour distance) and the metallic foil ramps
// (perceptual interpolation — no muddy sRGB lerps).

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

function hexToRgb(hex) {
  var h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex(r, g, b) {
  function hx(v) { v = clamp(Math.round(v), 0, 255); var s = v.toString(16); return s.length < 2 ? '0' + s : s; }
  return '#' + hx(r) + hx(g) + hx(b);
}

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
  var lin = oklabToLinearSrgb(lab[0], lab[1], lab[2]);
  return rgbToHex(
    clamp(linearToSrgb(clamp(lin[0], 0, 1)), 0, 1) * 255,
    clamp(linearToSrgb(clamp(lin[1], 0, 1)), 0, 1) * 255,
    clamp(linearToSrgb(clamp(lin[2], 0, 1)), 0, 1) * 255
  );
}
// Perceptual lerp between two OKLab triples.
function lerpLab(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
// OKLCH → hex (the holographic hue sweep). h in degrees.
function oklchToHex(L, C, h) {
  var rad = h * Math.PI / 180;
  return oklabToHex([L, C * Math.cos(rad), C * Math.sin(rad)]);
}

// Expand a list of anchor hexes into a smooth stop list ((anchors-1)*perSeg + 1
// stops), interpolated in OKLab so metallic banding blends perceptually.
function rampStops(anchors, perSeg) {
  var labs = [];
  for (var i = 0; i < anchors.length; i++) labs.push(hexToOklab(anchors[i]));
  var out = [];
  var total = (anchors.length - 1) * perSeg;
  for (var k = 0; k <= total; k++) {
    var pos = k / total;
    var seg = Math.min(anchors.length - 2, Math.floor(pos * (anchors.length - 1)));
    var t = pos * (anchors.length - 1) - seg;
    out.push({ offset: pos, hex: oklabToHex(lerpLab(labs[seg], labs[seg + 1], t)) });
  }
  return out;
}

// ── finish material definitions ──────────────────────────────────────────────

// Foil anchor colours: dark → bright banding pairs so the OKLab ramp reads as
// rolled metal, not a flat tint.
var FOIL_ANCHORS = {
  'foil-gold': ['#6b4e0e', '#d9ab2e', '#fff2bf', '#a8791a', '#f3d96d', '#7d5c12'],
  'foil-silver': ['#5f6670', '#e8ecf1', '#ffffff', '#9aa2ad', '#f2f5f8', '#6e757f'],
};
// Holographic: an OKLCH hue sweep at constant perceptual lightness/chroma.
function holoStops() {
  var out = [];
  var steps = 12;
  for (var i = 0; i <= steps; i++) {
    out.push({ offset: i / steps, hex: oklchToHex(0.82, 0.13, (i * 360 / steps) % 360) });
  }
  return out;
}

var FINISH_LABELS = {
  'foil-gold': 'Foil — gold',
  'foil-silver': 'Foil — silver',
  'foil-holographic': 'Foil — holographic',
  'spot-uv-gloss': 'Spot UV gloss',
  'emboss': 'Emboss',
  'deboss': 'Deboss',
  'soft-touch-matte': 'Soft-touch matte',
};
function finishKind(finish) {
  if (finish === 'spot-uv-gloss') return 'uv';
  if (finish === 'emboss' || finish === 'deboss') return 'bevel';
  if (finish === 'soft-touch-matte') return 'matte';
  return 'foil';
}

// ── mask computation (per-pixel OKLab) ───────────────────────────────────────

function sstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  var t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Rasterise the artwork into the mask working grid and derive two data-URI PNGs:
//   maskUrl  — white with per-pixel ALPHA = mask coverage (luminance×alpha in an
//              SVG <mask> ⇒ soft, feathered finish edges in the preview);
//   plateUrl — the printer plate: hard-thresholded pure black on white (opaque,
//              filter-free, so the plate view survives every export path).
// Returns null when pixels can't be read (headless / tainted canvas).
function computeMasks(img, cw, ch, fit, source, thr, soft, maskLab) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  var c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  var ctx = c.getContext && c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';

  var iw = img.naturalWidth || img.width;
  var ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  if (fit === 'cover') {
    var s = Math.max(cw / iw, ch / ih);
    ctx.drawImage(img, (cw - iw * s) / 2, (ch - ih * s) / 2, iw * s, ih * s);
  } else {
    // 'contain': the grid already carries the image's aspect ratio.
    ctx.drawImage(img, 0, 0, cw, ch);
  }

  var data;
  try { data = ctx.getImageData(0, 0, cw, ch).data; }
  catch (e) { return null; } // tainted canvas (cross-origin asset)

  var maskPx = ctx.createImageData(cw, ch);
  var m = maskPx.data;
  var platePx = ctx.createImageData(cw, ch);
  var q = platePx.data;

  // Threshold semantics: light/dark compare OKLab L (0..1, scaled to 0..100)
  // with a smoothstep of ±softness L-units around it; by-colour compares OKLab
  // DISTANCE to the target with radius thr/100·0.5 and feather soft/100·0.25.
  var tL = thr;               // OKLab L × 100
  var featherL = soft;        // in L × 100 units
  var radius = (thr / 100) * 0.5;
  var featherD = (soft / 100) * 0.25;

  for (var i = 0, p = 0; p < data.length; i++, p += 4) {
    var a = data[p + 3] / 255;
    var R = data[p] / 255, G = data[p + 1] / 255, B = data[p + 2] / 255;
    // Composite transparency onto white so cut-out PNGs don't read as black.
    if (a < 1) { R = R * a + (1 - a); G = G * a + (1 - a); B = B * a + (1 - a); }
    var lab = linearSrgbToOklab(srgbToLinear(R), srgbToLinear(G), srgbToLinear(B));
    var v;
    if (source === 'light') {
      v = sstep(tL - featherL, tL + featherL, lab[0] * 100);
    } else if (source === 'dark') {
      v = 1 - sstep(tL - featherL, tL + featherL, lab[0] * 100);
    } else { // 'colour'
      var dL = lab[0] - maskLab[0], dA = lab[1] - maskLab[1], dB = lab[2] - maskLab[2];
      var d = Math.sqrt(dL * dL + dA * dA + dB * dB);
      v = 1 - sstep(radius - featherD, radius + featherD, d);
    }
    // Preview mask: white, alpha = coverage (soft edges survive).
    m[p] = 255; m[p + 1] = 255; m[p + 2] = 255; m[p + 3] = Math.round(v * 255);
    // Plate: hard 1-bit — black where the finish prints, white elsewhere.
    var ink = v >= 0.5 ? 0 : 255;
    q[p] = ink; q[p + 1] = ink; q[p + 2] = ink; q[p + 3] = 255;
  }

  ctx.putImageData(maskPx, 0, 0);
  var maskUrl = c.toDataURL('image/png');
  ctx.putImageData(platePx, 0, 0);
  var plateUrl = c.toDataURL('image/png');
  return { maskUrl: maskUrl, plateUrl: plateUrl };
}

// ── SVG construction ─────────────────────────────────────────────────────────

function gradientStopsMarkup(stops) {
  var out = '';
  for (var i = 0; i < stops.length; i++) {
    out += '<stop offset="' + f2(stops[i].offset * 100) + '%" stop-color="' + stops[i].hex + '"'
      + (stops[i].opacity != null ? ' stop-opacity="' + f2(stops[i].opacity) + '"' : '') + '/>';
  }
  return out;
}

// The sheen sweep gradient: a soft light band across the finish, rotated to the
// sweep angle. Animated with SMIL (additive translate along the gradient axis)
// only when `animate` is true; otherwise it rests, centred — a still or a
// reduced-motion preview never shows a mid-sweep pose.
function sheenGradient(id, angle, opacity, sharp, animate) {
  var stops = sharp
    ? [{ offset: 0, hex: '#ffffff', opacity: 0 }, { offset: 0.46, hex: '#ffffff', opacity: 0 },
       { offset: 0.5, hex: '#ffffff', opacity: opacity }, { offset: 0.54, hex: '#ffffff', opacity: 0 },
       { offset: 1, hex: '#ffffff', opacity: 0 }]
    : [{ offset: 0, hex: '#ffffff', opacity: 0 }, { offset: 0.38, hex: '#ffffff', opacity: 0 },
       { offset: 0.5, hex: '#ffffff', opacity: opacity }, { offset: 0.62, hex: '#ffffff', opacity: 0 },
       { offset: 1, hex: '#ffffff', opacity: 0 }];
  return '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + VIEW + '" y2="0" '
    + 'gradientTransform="rotate(' + f2(angle) + ' ' + (VIEW / 2) + ' ' + (VIEW / 2) + ')">'
    + gradientStopsMarkup(stops)
    + (animate
      ? '<animateTransform attributeName="gradientTransform" type="translate" additive="sum" '
        + 'from="-' + VIEW + ' 0" to="' + VIEW + ' 0" dur="5s" repeatCount="indefinite"/>'
      : '')
    + '</linearGradient>';
}

function buildSvg(args) {
  var region = args.region;
  var rx = f2(region.x), ry = f2(region.y), rw = f2(region.w), rh = f2(region.h);
  var label = FINISH_LABELS[args.finish] || args.finish;

  // ── plate view: the printer deliverable — pure black mask on white + label ──
  // Filter-free by construction (the plate PNG is already black-on-white), so
  // it survives PDF export and any strict vector path unchanged.
  if (args.plate) {
    var pl = svgOpen();
    pl += '<rect width="' + VIEW + '" height="' + VIEW + '" fill="#ffffff"/>';
    if (args.wholeMask) {
      pl += '<rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" fill="#000000"/>';
    } else {
      pl += '<image href="' + esc(args.plateUrl) + '" x="' + rx + '" y="' + ry + '" width="' + rw
        + '" height="' + rh + '" preserveAspectRatio="none" image-rendering="optimizeQuality"/>';
    }
    pl += '<text x="24" y="' + (VIEW - 20) + '" font-family="system-ui, sans-serif" font-size="22" fill="#111111" '
      + 'style="paint-order:stroke;stroke:#ffffff;stroke-width:6px;stroke-linejoin:round">'
      + esc(label + ' · prints as spot plate — overprint') + '</text>';
    pl += '</svg>';
    return pl;
  }

  // ── preview ─────────────────────────────────────────────────────────────────
  var k = clamp(n(args.strength, 80), 0, 100) / 100;
  var kind = finishKind(args.finish);
  var angle = clamp(n(args.angle, 35), 0, 360);
  var animate = !!args.animate && (kind === 'foil' || kind === 'uv');

  var artHref = esc(args.url);
  var artImg = args.cover
    ? '<image href="' + artHref + '" x="0" y="0" width="' + VIEW + '" height="' + VIEW + '" preserveAspectRatio="xMidYMid slice"/>'
    : '<image href="' + artHref + '" x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" preserveAspectRatio="none"/>';
  var maskImg = args.wholeMask ? null
    : '<image href="' + esc(args.maskUrl) + '" x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" preserveAspectRatio="none"/>';
  var regionRect = function (fill, extra) {
    return '<rect x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" fill="' + fill + '"' + (extra || '') + '/>';
  };

  var defs = '';
  // The finish mask (luminance × alpha of the white/alpha mask PNG).
  defs += '<mask id="fp-m" maskUnits="userSpaceOnUse" x="0" y="0" width="' + VIEW + '" height="' + VIEW + '">'
    + (args.wholeMask ? regionRect('#ffffff') : maskImg)
    + '</mask>';

  if (kind === 'matte') {
    // Inverse mask: everything in the region EXCEPT the finish areas. Built by
    // painting the mask black (fp-black keeps alpha, zeroes RGB) over white.
    defs += '<filter id="fp-black"><feColorMatrix type="matrix" '
      + 'values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>';
    defs += '<mask id="fp-mi" maskUnits="userSpaceOnUse" x="0" y="0" width="' + VIEW + '" height="' + VIEW + '">'
      + regionRect('#ffffff')
      + (args.wholeMask ? regionRect('#000000')
        : '<g filter="url(#fp-black)">' + maskImg + '</g>')
      + '</mask>';
    // Soft-touch look: gentle desaturate, softened tone with a slight lift, and
    // a fine deterministic grain (fixed feTurbulence seed) blended on top.
    var slope = 1 - 0.14 * k;
    var icpt = f2(0.5 - 0.5 * slope + 0.04 * k);
    slope = f2(slope);
    defs += '<filter id="fp-matte" x="-2%" y="-2%" width="104%" height="104%">'
      + '<feColorMatrix in="SourceGraphic" type="saturate" values="' + f2(1 - 0.4 * k) + '" result="des"/>'
      + '<feComponentTransfer in="des" result="tone">'
      + '<feFuncR type="linear" slope="' + slope + '" intercept="' + icpt + '"/>'
      + '<feFuncG type="linear" slope="' + slope + '" intercept="' + icpt + '"/>'
      + '<feFuncB type="linear" slope="' + slope + '" intercept="' + icpt + '"/>'
      + '</feComponentTransfer>'
      + '<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="7" result="noise"/>'
      + '<feColorMatrix in="noise" type="matrix" '
      + 'values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 ' + f2(0.08 + 0.14 * k) + ' 0" result="grain"/>'
      + '<feBlend in="grain" in2="tone" mode="overlay" result="blended"/>'
      + '<feComposite in="blended" in2="SourceAlpha" operator="in"/>'
      + '</filter>';
  }

  if (kind === 'foil') {
    var stops = args.finish === 'foil-holographic'
      ? holoStops()
      : rampStops(FOIL_ANCHORS[args.finish] || FOIL_ANCHORS['foil-gold'], 4);
    defs += '<linearGradient id="fp-metal" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + VIEW + '" y2="0" '
      + 'gradientTransform="rotate(' + f2(angle) + ' ' + (VIEW / 2) + ' ' + (VIEW / 2) + ')">'
      + gradientStopsMarkup(stops) + '</linearGradient>';
    defs += sheenGradient('fp-sheen', angle, 0.1 + 0.45 * k, false, animate);
  }

  if (kind === 'uv') {
    // Spot UV: the masked artwork itself, gloss-boosted, plus a sharp specular band.
    defs += '<filter id="fp-gloss">'
      + '<feColorMatrix type="saturate" values="' + f2(1 + 0.15 * k) + '"/>'
      + '<feComponentTransfer>'
      + '<feFuncR type="linear" slope="' + f2(1 + 0.1 * k) + '" intercept="' + f2(-0.04 * k) + '"/>'
      + '<feFuncG type="linear" slope="' + f2(1 + 0.1 * k) + '" intercept="' + f2(-0.04 * k) + '"/>'
      + '<feFuncB type="linear" slope="' + f2(1 + 0.1 * k) + '" intercept="' + f2(-0.04 * k) + '"/>'
      + '</feComponentTransfer></filter>';
    defs += sheenGradient('fp-sheen', angle, 0.15 + 0.35 * k, true, animate);
  }

  if (kind === 'bevel') {
    // Emboss/deboss: light + dark edge bands from the mask's own alpha,
    // offset in opposite directions (the classic paper-relief illusion).
    var e = f2(2 + 2 * k);
    var eo = f2(0.3 + 0.55 * k);
    var raised = args.finish === 'emboss';
    var liteD = raised ? -e : e;   // light from top-left when raised
    var darkD = raised ? e : -e;
    defs += '<filter id="fp-bevel" x="-5%" y="-5%" width="110%" height="110%">'
      + '<feOffset in="SourceAlpha" dx="' + liteD + '" dy="' + liteD + '" result="oL"/>'
      + '<feComposite in="oL" in2="SourceAlpha" operator="out" result="bandL"/>'
      + '<feFlood flood-color="#ffffff" flood-opacity="' + eo + '" result="fw"/>'
      + '<feComposite in="fw" in2="bandL" operator="in" result="lite"/>'
      + '<feOffset in="SourceAlpha" dx="' + darkD + '" dy="' + darkD + '" result="oD"/>'
      + '<feComposite in="oD" in2="SourceAlpha" operator="out" result="bandD"/>'
      + '<feFlood flood-color="#000000" flood-opacity="' + eo + '" result="fb"/>'
      + '<feComposite in="fb" in2="bandD" operator="in" result="dark"/>'
      + '<feMerge><feMergeNode in="lite"/><feMergeNode in="dark"/></feMerge>'
      + '</filter>';
  }

  var out = svgOpen();
  out += '<defs>' + defs + '</defs>';
  out += '<rect width="' + VIEW + '" height="' + VIEW + '" fill="' + esc(args.bg) + '"/>';
  out += artImg;

  if (kind === 'matte') {
    out += '<g mask="url(#fp-mi)"><g filter="url(#fp-matte)">' + artImg + '</g></g>';
  } else if (kind === 'foil') {
    out += '<g mask="url(#fp-m)" opacity="' + f2(0.25 + 0.7 * k) + '">'
      + regionRect('url(#fp-metal)')
      + regionRect('url(#fp-sheen)')
      + '</g>';
  } else if (kind === 'uv') {
    out += '<g mask="url(#fp-m)"><g filter="url(#fp-gloss)">' + artImg + '</g>'
      + regionRect('url(#fp-sheen)')
      + '</g>';
  } else if (kind === 'bevel') {
    out += args.wholeMask
      ? '<g filter="url(#fp-bevel)">' + regionRect('#ffffff') + '</g>'
      : '<g filter="url(#fp-bevel)">' + maskImg + '</g>';
  }

  out += '</svg>';
  return out;
}

// ── reduced-motion (chrome pref OR the OS media query, like the shell's own
// prefersReducedMotion) — when it holds, the sheen rests instead of sweeping. ──
function prefersReducedMotion() {
  try {
    if (typeof document !== 'undefined' && document.documentElement
      && document.documentElement.getAttribute('data-a11y-motion') === 'reduce') return true;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  } catch (e) { /* ignore */ }
  return false;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async function compute(model) {
  var inputs = inputsFrom(model);
  var plate = Boolean(inputs.plateView);
  var bg = color(inputs.bgColor, '#ffffff');
  // Export-margin fill for beforeExport: the plate is always on white.
  _bgColor = plate ? '#ffffff' : bg;

  if (!canRaster()) return { finishSvg: placeholder('Preview renders in the browser') };

  // Resolve the artwork URL: the user's pick, else the demo default (cached).
  var ref = inputs.image;
  var url = ref && typeof ref === 'object' ? ref.url : null;
  if (!url) {
    if (!_defaultUrl) {
      try {
        var def = (DEFAULT_IMAGE_ID.indexOf('://') !== -1)
          ? (host.compose && host.compose.renderUrl ? await host.compose.renderUrl(DEFAULT_IMAGE_ID) : null)
          : await host.assets.get(DEFAULT_IMAGE_ID);
        _defaultUrl = def && def.url;
      } catch (e) {
        if (host.log) host.log('warn', 'finish-preview: default image unavailable', { error: String(e) });
      }
    }
    url = _defaultUrl;
  }
  if (!url) return { finishSvg: placeholder('Choose artwork to preview a finish') };

  var maskSource = ['whole', 'light', 'dark', 'colour'].indexOf(inputs.maskSource) !== -1
    ? inputs.maskSource : 'light';
  var maskColorHex = color(inputs.maskColor, '#30ba78');
  var animate = Boolean(inputs.sheen) && !plate && !prefersReducedMotion();

  var params = {
    url: url, plate: plate, bg: bg,
    finish: inputs.finish, strength: inputs.strength, animate: animate,
    angle: inputs.angle, maskSource: maskSource, maskColor: maskColorHex,
    threshold: inputs.threshold, softness: inputs.softness, fit: inputs.fit,
  };
  var memoKey = JSON.stringify(params);
  if (memoKey === _memoKey) return _memoResult;

  var finishSvg;
  try {
    var img = await getImage(url);
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih) throw new Error('image has no size');

    // Region the artwork occupies in the square viewBox: 'contain' letterboxes
    // to the image's aspect; 'cover' fills the frame (centre crop).
    var cover = inputs.fit === 'cover';
    var region;
    if (cover) region = { x: 0, y: 0, w: VIEW, h: VIEW };
    else if (iw >= ih) region = { x: 0, y: (VIEW - VIEW * ih / iw) / 2, w: VIEW, h: VIEW * ih / iw };
    else region = { x: (VIEW - VIEW * iw / ih) / 2, y: 0, w: VIEW * iw / ih, h: VIEW };

    var wholeMask = maskSource === 'whole';
    var masks = null;
    if (!wholeMask) {
      var maskLab = hexToOklab(maskColorHex) || hexToOklab('#30ba78');
      masks = computeMasks(
        img,
        Math.max(1, Math.round(region.w)), Math.max(1, Math.round(region.h)),
        cover ? 'cover' : 'contain', maskSource,
        clamp(n(inputs.threshold, 60), 0, 100), clamp(n(inputs.softness, 4), 0, 20),
        maskLab
      );
      if (!masks) throw new Error('cannot read pixels');
    }

    finishSvg = buildSvg({
      url: url, plate: plate, bg: bg, cover: cover, region: region,
      wholeMask: wholeMask,
      maskUrl: masks && masks.maskUrl, plateUrl: masks && masks.plateUrl,
      finish: inputs.finish, strength: inputs.strength,
      animate: animate, angle: inputs.angle,
    });
  } catch (e) {
    if (host.log) host.log('warn', 'finish-preview: render failed', { error: String(e) });
    finishSvg = placeholder('Could not read this image');
  }

  _memoKey = memoKey;
  _memoResult = { finishSvg: finishSvg };
  return _memoResult;
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }

function beforeExport(ctx) {
  // Alpha-capable raster formats: fill the exported frame's margins with the
  // canvas background (white in plate view) so a non-square export has no
  // transparent gutter around the square scene.
  var alpha = ['png', 'webp', 'avif'];
  if (alpha.indexOf(ctx.format) !== -1) {
    ctx.opts.background = _bgColor;
  }
}
