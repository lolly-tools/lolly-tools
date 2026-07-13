/* global onInit, onInput, onFrame, beforeExport, host */

/**
 * Filter: Voronoi Cells — shatter a photo (or live camera) into a Voronoi mesh.
 *
 * Sites are laid on a jittered grid (count = `cells`, `jitter` = regular→scattered,
 * `seed` = reroll), optionally Lloyd-relaxed toward equal-area cells, then each
 * site's Voronoi cell is computed by clipping the canvas box against every other
 * site's perpendicular bisector (half-plane intersection). Each cell is filled with
 * the NEAREST colour — the colour of the source image at that site — so the mesh
 * reads as a faceted, low-poly version of the photo, emitted as flat vector polygons.
 *
 * Recolour is shared with the sibling filters: Contrast + HSL grade the sampled
 * pixel grid (so the cell colours follow), and a Colour treatment blends over the
 * output, all BAKED into the vector fills so it survives SVG/PDF/raster/video export.
 * A "Go live" camera feed (host.media + onFrame) reshatters each frame; the cell
 * geometry is layout-only so it's cached across frames — only the fills re-sample.
 *
 * Needs a real browser <canvas>; headless shells (CLI/jsdom) degrade to a friendly
 * placeholder rather than throwing.
 *
 * Demo image: a plain catalog photo (resolved via host.assets.get — instant, no
 * nested compose render) so the tool opens fast on a real photo that shows off the
 * mesh. resolveDefault still branches on '://', so a tool URL would also work.
 */

var DEFAULT_IMAGE_ID = 'suse/photos/stock-1';
var _defaultUrl = null;

// Colour-sample resolution (longest edge). One decode feeds every cell's point
// sample; drawImage's downscale pre-averages, so a point sample reads as a clean
// local mean. High enough for fine meshes, cheap enough for live.
var DECODE_DETAIL = 340;
// Live caps `cells` so dragging the slider on camera can't trigger a huge one-off
// Voronoi recompute mid-stream (the per-frame cost is just re-sampling fills — the
// geometry is cached across frames — so this only bounds the recompute, not fps).
var LIVE_MAX_CELLS = 900;

// Caches (per render, survive slider drags; pruned to the active photo each compute).
var _imgCache = {};       // url -> Promise<Image>
var _sampleCache = {};    // url|cols x rows -> { lum, alpha, r, g, b, cols, rows }
var _cellCache = { key: null, sites: null, cells: null }; // layout-only cell geometry (palette-independent)
var _memoKey = null, _memoResult = null;
var _transparent = false, _paper = '#ffffff';

// ── small helpers (shared with the filter-* family) ───────────────────────────
function inputsFrom(model) { var o = {}; model.forEach(function (i) { o[i.id] = i.value; }); return o; }
function num(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
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
function color(v, fallback) {
  var s = (typeof v === 'string' ? v : '').trim();
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^(rgb|hsl)a?\([\d%.,\s/]+\)$/i.test(s) ? s : fallback;
}
function hex2(n) { var h = clamp(Math.round(n), 0, 255).toString(16); return h.length < 2 ? '0' + h : h; }
function rgbHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }

// ── HSL: luma-preserving hue∘saturation matrices (sRGB .213/.715/.072) + lightness ─
function _mul3(a, b) {
  var o = new Array(9);
  for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++)
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
function _hueSatMatrix(hueDeg, sat) {
  var h = hueDeg * Math.PI / 180, c = Math.cos(h), s = Math.sin(h);
  var hm = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  var sm = [
    0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat,
    0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat,
    0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat,
  ];
  return _mul3(sm, hm);
}
function hslIdentity(hueDeg, sat, light) { return hueDeg === 0 && sat === 1 && light === 0; }

// Apply HSL (hue rotate ∘ saturation ∘ lightness) to a sample grid → a NEW grid, so
// the auto-sampled cell colours follow. Built fresh — the decoded cache stays raw.
function applyHslGrid(g, hueDeg, sat, light) {
  var m = _hueSatMatrix(hueDeg, sat);
  var m00=m[0],m01=m[1],m02=m[2],m10=m[3],m11=m[4],m12=m[5],m20=m[6],m21=m[7],m22=m[8];
  var nn = g.lum.length, r=new Uint8Array(nn), gg=new Uint8Array(nn), b=new Uint8Array(nn), lum=new Uint8Array(nn);
  for (var i=0;i<nn;i++){var R=g.r[i],G=g.g[i],B=g.b[i];var nr=m00*R+m01*G+m02*B,ng=m10*R+m11*G+m12*B,nb=m20*R+m21*G+m22*B;
    if(light>0){nr+=(255-nr)*light;ng+=(255-ng)*light;nb+=(255-nb)*light;}else if(light<0){var k=1+light;nr*=k;ng*=k;nb*=k;}
    R=nr<0?0:nr>255?255:nr;G=ng<0?0:ng>255?255:ng;B=nb<0?0:nb>255?255:nb;r[i]=R;gg[i]=G;b[i]=B;lum[i]=(0.299*R+0.587*G+0.114*B)|0;}
  return { lum:lum, alpha:g.alpha, r:r, g:gg, b:b, cols:g.cols, rows:g.rows };
}

// ── colour-treatment blend (separable modes; matches CSS/SVG feBlend keywords) ──
function _bl(mode, b, s) {
  switch (mode) {
    case 'multiply': return b * s;
    case 'screen': return b + s - b * s;
    case 'overlay': return b < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'hard-light': return s < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'soft-light': return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b)
      : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
    case 'darken': return b < s ? b : s;
    case 'lighten': return b > s ? b : s;
    case 'color-dodge': return s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'color-burn': return s <= 0 ? 0 : Math.max(0, 1 - (1 - b) / s);
    case 'difference': return b > s ? b - s : s - b;
    case 'exclusion': return b + s - 2 * b * s;
    default: return s; // normal
  }
}
function _hex2rgb(hex) {
  var s = (typeof hex === 'string' ? hex : '').trim().replace(/^#/, '');
  if (s.length === 3) s = s[0]+s[0]+s[1]+s[1]+s[2]+s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return { r: parseInt(s.slice(0,2),16), g: parseInt(s.slice(2,4),16), b: parseInt(s.slice(4,6),16) };
}
function _hx(v) { v = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); var h = v.toString(16); return h.length < 2 ? '0' + h : h; }
function treatmentFrom(inputs) {
  var ov = _hex2rgb(inputs.treatmentColor);
  var amt = clamp(num(inputs.treatmentIntensity, 20), 0, 100) / 100;
  var mode = typeof inputs.blendMode === 'string' ? inputs.blendMode : 'multiply';
  return { ov: ov, amt: amt, mode: mode, on: !!(ov && amt > 0) };
}
function _lum(c) { return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; }
function _clipColor(c) {
  var l = _lum(c), mn = Math.min(c[0], c[1], c[2]), mx = Math.max(c[0], c[1], c[2]), o = [c[0], c[1], c[2]], i;
  if (mn < 0) for (i = 0; i < 3; i++) o[i] = l + (o[i] - l) * l / (l - mn);
  if (mx > 1) for (i = 0; i < 3; i++) o[i] = l + (o[i] - l) * (1 - l) / (mx - l);
  return o;
}
function _setLum(c, l) { var d = l - _lum(c); return _clipColor([c[0] + d, c[1] + d, c[2] + d]); }
function _sat(c) { return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); }
function _setSat(c, s) {
  var ix = [0, 1, 2].sort(function (a, b) { return c[a] - c[b]; }), lo = ix[0], mid = ix[1], hi = ix[2], o = [0, 0, 0];
  if (c[hi] > c[lo]) { o[mid] = (c[mid] - c[lo]) * s / (c[hi] - c[lo]); o[hi] = s; }
  return o;
}
function _blendNonSep(mode, Cb, Cs) {
  switch (mode) {
    case 'hue':        return _setLum(_setSat(Cs, _sat(Cb)), _lum(Cb));
    case 'saturation': return _setLum(_setSat(Cb, _sat(Cs)), _lum(Cb));
    case 'color':      return _setLum(Cs, _lum(Cb));
    case 'luminosity': return _setLum(Cb, _lum(Cs));
    default:           return null;
  }
}
function treatHex(baseHex, t) {
  if (!t || !t.on) return baseHex;
  var b = _hex2rgb(baseHex); if (!b) return baseHex;
  var Cb = [b.r / 255, b.g / 255, b.b / 255], Cs = [t.ov.r / 255, t.ov.g / 255, t.ov.b / 255];
  var ns = _blendNonSep(t.mode, Cb, Cs), o = [0, 0, 0], i;
  for (i = 0; i < 3; i++) o[i] = Cb[i] * (1 - t.amt) + (ns ? ns[i] : _bl(t.mode, Cb[i], Cs[i])) * t.amt;
  return '#' + _hx(o[0] * 255) + _hx(o[1] * 255) + _hx(o[2] * 255);
}

// ══════════════════════════════════════════════════════════════════════════════
// Brand overlay — optional SUSE logo + gently-animated "lower third" name card.
// Synced from community/_shared/overlay.js (npm run sync:shared). Emits SVG children
// so it survives raster + motion + vector export. Everything OFF by default → ''.
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
// === /lolly:shared overlay ===

// ── decode ────────────────────────────────────────────────────────────────────
// === lolly:shared canRaster — generated from community/_shared/raster.js; edit there and run npm run sync:shared ===
function canRaster() {
  if (typeof document === 'undefined' || !document.createElement) return false;
  try { var c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d')); }
  catch (e) { return false; }
}
// === /lolly:shared canRaster ===
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
  if (_imgCache[url]) return _imgCache[url];
  var p = loadImage(url);
  _imgCache[url] = p;
  p.catch(function () { if (_imgCache[url] === p) delete _imgCache[url]; });
  return p;
}
function sampleRGBA(url, img, cols, rows) {
  var key = url + '|' + cols + 'x' + rows;
  if (_sampleCache[key]) return _sampleCache[key];
  if (typeof document === 'undefined' || !document.createElement) return null;
  var c = document.createElement('canvas');
  c.width = cols; c.height = rows;
  var ctx = c.getContext && c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
  var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  ctx.clearRect(0, 0, cols, rows);
  ctx.drawImage(img, 0, 0, cols, rows);
  var data;
  try { data = ctx.getImageData(0, 0, cols, rows).data; }
  catch (e) { return null; } // tainted canvas (cross-origin asset)
  var n = cols * rows;
  var lum = new Uint8Array(n), alpha = new Uint8Array(n);
  var r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (var i = 0, p = 0; i < n; i++, p += 4) {
    r[i] = data[p]; g[i] = data[p + 1]; b[i] = data[p + 2];
    lum[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
    alpha[i] = data[p + 3];
  }
  var out = { lum: lum, alpha: alpha, r: r, g: g, b: b, cols: cols, rows: rows };
  _sampleCache[key] = out;
  return out;
}
function gridSizeFor(img, detail) {
  var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  var cols, rows;
  if (iw >= ih) { cols = detail; rows = Math.max(1, Math.round(detail * ih / iw)); }
  else { rows = detail; cols = Math.max(1, Math.round(detail * iw / ih)); }
  return { cols: cols, rows: rows };
}

// ── tone (contrast) ───────────────────────────────────────────────────────────
function toneLUT(brightness, contrast) {
  var b = clamp(num(brightness, 0), -100, 100) * 2.55;
  var c = clamp(num(contrast, 0), -100, 100);
  var f = Math.tan(clamp(c / 100 + 1, 0, 1.98) * Math.PI / 4);
  var lut = new Uint8Array(256);
  for (var i = 0; i < 256; i++) {
    var v = (i - 128) * f + 128 + b;
    lut[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return lut;
}
function applyTone(g, lut) {
  var n = g.lum.length;
  var r = new Uint8Array(n), gg = new Uint8Array(n), b = new Uint8Array(n), lum = new Uint8Array(n);
  for (var i = 0; i < n; i++) {
    var R = lut[g.r[i]], G = lut[g.g[i]], B = lut[g.b[i]];
    r[i] = R; gg[i] = G; b[i] = B;
    lum[i] = (0.299 * R + 0.587 * G + 0.114 * B) | 0;
  }
  return { lum: lum, alpha: g.alpha, r: r, g: gg, b: b, cols: g.cols, rows: g.rows };
}

// ── Voronoi ───────────────────────────────────────────────────────────────────

// Deterministic PRNG (mulberry32) — same seed ⇒ same cell layout.
function rng(seed) {
  var s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sites on a jittered grid sized to `count` over the W×H canvas. jitter 0 = regular,
// 1 = each site anywhere within its cell.
function makeSites(W, H, count, jitter, seed) {
  var rand = rng((seed * 2654435761) >>> 0);
  var aspect = W / H;
  var rows = Math.max(1, Math.round(Math.sqrt(count / aspect)));
  var cols = Math.max(1, Math.round(count / rows));
  var cw = W / cols, ch = H / rows, jx = jitter * cw * 0.5, jy = jitter * ch * 0.5, sites = [];
  for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
    var x = (c + 0.5) * cw + (rand() - 0.5) * 2 * jx;
    var y = (r + 0.5) * ch + (rand() - 0.5) * 2 * jy;
    sites.push([clamp(x, 0, W), clamp(y, 0, H)]);
  }
  return sites;
}

// Clip a convex polygon to the half-plane of points closer to A than B (the Voronoi
// bisector): keep p where (B-A)·p <= (B-A)·midpoint. Sutherland–Hodgman.
function clipHalfPlane(poly, A, B) {
  var nx = B[0] - A[0], ny = B[1] - A[1];
  var c = nx * (A[0] + B[0]) / 2 + ny * (A[1] + B[1]) / 2;
  var out = [], n = poly.length;
  for (var k = 0; k < n; k++) {
    var cur = poly[k], nxt = poly[(k + 1) % n];
    var dc = nx * cur[0] + ny * cur[1] - c, dn = nx * nxt[0] + ny * nxt[1] - c;
    if (dc <= 0) out.push(cur);
    if ((dc < 0 && dn > 0) || (dc > 0 && dn < 0)) {
      var t = dc / (dc - dn);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return out;
}

function polyCentroid(poly) {
  var a = 0, cx = 0, cy = 0, n = poly.length;
  for (var i = 0; i < n; i++) {
    var p = poly[i], q = poly[(i + 1) % n], cr = p[0] * q[1] - q[0] * p[1];
    a += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    var sx = 0, sy = 0; for (var j = 0; j < n; j++) { sx += poly[j][0]; sy += poly[j][1]; }
    return [sx / n, sy / n];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

// Each site's Voronoi cell = the canvas box clipped by every other site's bisector.
// O(n²) but the clips are cheap; `cells` is capped (2000 still / 900 live) so a worst
// case stays well under the onInit budget, and the geometry is cached across frames.
function voronoiCells(sites, W, H) {
  var n = sites.length, cells = new Array(n);
  for (var i = 0; i < n; i++) {
    var poly = [[0, 0], [W, 0], [W, H], [0, H]], A = sites[i];
    for (var j = 0; j < n; j++) {
      if (j === i) continue;
      poly = clipHalfPlane(poly, A, sites[j]);
      if (poly.length < 3) break;
    }
    cells[i] = poly;
  }
  return cells;
}

// Lloyd relaxation: move each site to its cell centroid, recompute — evens the mesh.
function lloyd(sites, W, H, iters) {
  for (var k = 0; k < iters; k++) {
    var cs = voronoiCells(sites, W, H), ns = new Array(sites.length);
    for (var i = 0; i < sites.length; i++) {
      var p = (cs[i] && cs[i].length >= 3) ? polyCentroid(cs[i]) : sites[i];
      ns[i] = [clamp(p[0], 0, W), clamp(p[1], 0, H)];
    }
    sites = ns;
  }
  return sites;
}

// ── compose the mesh SVG ──────────────────────────────────────────────────────
function placeholder(msg) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">'
    + '<rect width="100%" height="100%" fill="#f3f5f4"/>'
    + '<text x="540" y="540" text-anchor="middle" font-family="SUSE, system-ui, sans-serif" '
    + 'font-size="34" fill="#6b7c77">' + esc(msg) + '</text></svg>';
}

function buildVoronoi(W, H, gEff, sites, cells, edgeWidth, edgeColor, t, ov, rawSrc) {
  // No-filter bypass: show the raw source (still photo or live frame) + overlay.
  if (ov && ov.noFilter) {
    _paper = color(edgeColor, '#ffffff');
    var onf = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" '
      + 'width="' + W + '" height="' + H + '" style="width:100%;height:auto;display:block;">';
    if (!_transparent) onf += '<rect width="100%" height="100%" fill="' + esc(_paper) + '"/>';
    if (rawSrc) onf += '<image href="' + esc(rawSrc) + '" x="0" y="0" width="' + W + '" height="' + H + '" preserveAspectRatio="xMidYMid slice"/>';
    onf += buildOverlaySvg(W, H, ov) + '</svg>';
    return onf;
  }

  _paper = color(edgeColor, '#ffffff');
  // COVER-fit the colour grid into the canvas, centred — the same framing the mesh
  // (built over the full W×H box) uses, so each cell samples the pixel under its site.
  var gscale = Math.max(W / gEff.cols, H / gEff.rows);
  var gtx = (W - gEff.cols * gscale) / 2, gty = (H - gEff.rows * gscale) / 2;
  function sampleHex(x, y) {
    var gx = Math.floor((x - gtx) / gscale), gy = Math.floor((y - gty) / gscale);
    gx = gx < 0 ? 0 : gx >= gEff.cols ? gEff.cols - 1 : gx;
    gy = gy < 0 ? 0 : gy >= gEff.rows ? gEff.rows - 1 : gy;
    var idx = gy * gEff.cols + gx;
    return rgbHex(gEff.r[idx], gEff.g[idx], gEff.b[idx]);
  }

  var out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" '
    + 'width="' + W + '" height="' + H + '" style="width:100%;height:auto;display:block;">';
  if (!_transparent) out += '<rect width="100%" height="100%" fill="' + esc(_paper) + '"/>';

  var edged = edgeWidth > 0;
  if (edged) out += '<g stroke="' + esc(color(edgeColor, '#ffffff')) + '" stroke-width="' + f2(edgeWidth) + '" stroke-linejoin="round">';
  for (var i = 0; i < cells.length; i++) {
    var poly = cells[i];
    if (!poly || poly.length < 3) continue;
    var hex = treatHex(sampleHex(sites[i][0], sites[i][1]), t);
    var pts = '';
    for (var v = 0; v < poly.length; v++) pts += (v ? ' ' : '') + f2(poly[v][0]) + ',' + f2(poly[v][1]);
    // With no explicit edge, self-stroke each cell 1px in its own fill to seal the
    // hairline anti-aliasing gaps between neighbours (a seamless colour mesh).
    out += edged
      ? '<polygon points="' + pts + '" fill="' + esc(hex) + '"/>'
      : '<polygon points="' + pts + '" fill="' + esc(hex) + '" stroke="' + esc(hex) + '" stroke-width="1" stroke-linejoin="round"/>';
  }
  if (edged) out += '</g>';

  out += buildOverlaySvg(W, H, ov || {}) + '</svg>';
  return out;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
async function resolveDefault() {
  if (_defaultUrl) return _defaultUrl;
  try {
    var def = (DEFAULT_IMAGE_ID.indexOf('://') !== -1)
      ? (host.compose && host.compose.renderUrl ? await host.compose.renderUrl(DEFAULT_IMAGE_ID) : null)
      : await host.assets.get(DEFAULT_IMAGE_ID);
    _defaultUrl = def && def.url;
  } catch (e) { if (host.log) host.log('warn', 'filter-voronoi: default image unavailable', { error: String(e) }); }
  return _defaultUrl;
}

// Read the layout + colour params from a flat inputs object (shared by still + live).
function readParams(inputs, maxCells) {
  return {
    cells: clamp(Math.round(num(inputs.cells, 700)), 40, maxCells),
    jitter: clamp(num(inputs.jitter, 70), 0, 100) / 100,
    relax: clamp(Math.round(num(inputs.relax, 1)), 0, 3),
    seed: clamp(Math.round(num(inputs.seed, 7)), 1, 999),
    edgeWidth: clamp(num(inputs.edgeWidth, 0), 0, 8),
    edgeColor: color(inputs.edgeColor, '#ffffff'),
    contrast: clamp(Math.round(num(inputs.contrast, 0)), -100, 100),
    hueDeg: clamp(num(inputs.hue, 0), -180, 180),
    sat: clamp(num(inputs.saturation, 100), 0, 200) / 100,
    light: clamp(num(inputs.lightness, 0), -100, 100) / 100,
    W: clamp(Math.round(num(inputs.width, 1080)), 1, 8000),
    H: clamp(Math.round(num(inputs.height, 1080)), 1, 8000),
  };
}

// Build (or reuse) the cell geometry for a set of layout params. Layout is pixel-
// independent, so a live camera reuses this across every frame.
function meshFor(pr) {
  var key = pr.cells + '|' + f2(pr.jitter) + '|' + pr.relax + '|' + pr.seed + '|' + pr.W + 'x' + pr.H;
  if (_cellCache.key === key) return _cellCache;
  var sites = makeSites(pr.W, pr.H, pr.cells, pr.jitter, pr.seed);
  if (pr.relax > 0) sites = lloyd(sites, pr.W, pr.H, pr.relax);
  var cells = voronoiCells(sites, pr.W, pr.H);
  _cellCache = { key: key, sites: sites, cells: cells };
  return _cellCache;
}

// Grade the decoded grid (contrast → HSL) so cell colours carry the recolour.
function gradeGrid(g, pr) {
  var gTone = pr.contrast ? applyTone(g, toneLUT(0, pr.contrast)) : g;
  return hslIdentity(pr.hueDeg, pr.sat, pr.light) ? gTone : applyHslGrid(gTone, pr.hueDeg, pr.sat, pr.light);
}

async function compute(model) {
  var inputs = inputsFrom(model);
  _transparent = Boolean(inputs.transparentBg);
  var pr = readParams(inputs, 2000);
  var _t = treatmentFrom(inputs);

  var ref = inputs.image;
  var url = (ref && ref.url) ? ref.url : await resolveDefault();
  if (!url) return { voronoiSvg: placeholder('Pick a photo to mosaic.') };
  if (!canRaster()) return { voronoiSvg: placeholder('Voronoi renders in the browser.') };

  Object.keys(_imgCache).forEach(function (u) { if (u !== url) delete _imgCache[u]; });
  Object.keys(_sampleCache).forEach(function (key) { if (key.slice(0, key.indexOf('|')) !== url) delete _sampleCache[key]; });

  var img = await getImage(url).catch(function () { return null; });
  if (!img) return { voronoiSvg: placeholder('Could not load that image.') };
  var gs = gridSizeFor(img, DECODE_DETAIL);
  if (!gs) return { voronoiSvg: placeholder('Could not read that image.') };
  var g = sampleRGBA(url, img, gs.cols, gs.rows);
  if (!g) return { voronoiSvg: placeholder('Could not read that image (cross-origin).') };

  var gEff = gradeGrid(g, pr);
  var mesh = meshFor(pr);

  var ovi = overlayInputs(inputs);
  if (ovi.showLogo) await resolveLogoUrl(ovi.logoStyle);
  var headUrl = (inputs.ltHeadshot && inputs.ltHeadshot.url) || '';
  if (ovi.lowerThird && !headUrl) headUrl = (await resolveProfileHeadshot()) || '';
  var ov = Object.assign({}, ovi, { logoUrl: cachedLogoUrl(ovi.logoStyle), headshotUrl: headUrl, mode: 'still' });

  var memoKey = JSON.stringify({
    url: url, c: pr.cells, j: f2(pr.jitter), rl: pr.relax, sd: pr.seed, ew: f2(pr.edgeWidth), ec: pr.edgeColor,
    con: pr.contrast, h: pr.hueDeg, s: pr.sat, l: pr.light, W: pr.W, H: pr.H, t: _transparent,
    tc: (_t.on ? _t.ov : null), tm: _t.mode, ti: _t.amt, ov: ov,
  });
  if (memoKey === _memoKey) return { voronoiSvg: _memoResult };

  var svg;
  try { svg = buildVoronoi(pr.W, pr.H, gEff, mesh.sites, mesh.cells, pr.edgeWidth, pr.edgeColor, _t, ov, url); }
  catch (e) {
    if (host.log) host.log('warn', 'filter-voronoi: build failed', { error: String(e) });
    svg = placeholder('Could not mosaic this photo.');
  }
  _memoKey = memoKey; _memoResult = svg;
  return { voronoiSvg: svg };
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }

// ── live camera (engine v1.4) ──────────────────────────────────────────────────
function gridFromFrame(frame, maxDetail) {
  var fw = frame.width, fh = frame.height;
  var scale = Math.min(1, maxDetail / Math.max(fw, fh));
  var cols = Math.max(1, Math.round(fw * scale)), rows = Math.max(1, Math.round(fh * scale));
  var src = document.createElement('canvas'); src.width = fw; src.height = fh;
  src.getContext('2d').putImageData(new ImageData(frame.data, fw, fh), 0, 0);
  var c = document.createElement('canvas'); c.width = cols; c.height = rows;
  var ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, cols, rows);
  var data = ctx.getImageData(0, 0, cols, rows).data;
  var n = cols * rows;
  var lum = new Uint8Array(n), alpha = new Uint8Array(n), r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (var i = 0, p = 0; i < n; i++, p += 4) {
    r[i] = data[p]; g[i] = data[p + 1]; b[i] = data[p + 2];
    lum[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
    alpha[i] = data[p + 3];
  }
  return { lum: lum, alpha: alpha, r: r, g: g, b: b, cols: cols, rows: rows };
}

function onFrame(ctx) {
  var frame = ctx.frame;
  if (!frame || !frame.data || !frame.width || !frame.height) return null;
  if (!canRaster() || typeof ImageData === 'undefined') return null;
  var inputs = inputsFrom(ctx.model);
  _transparent = Boolean(inputs.transparentBg);
  var pr = readParams(inputs, LIVE_MAX_CELLS);
  var _t = treatmentFrom(inputs);

  var g;
  try { g = gridFromFrame(frame, DECODE_DETAIL); } catch (e) { return null; }
  var gEff = gradeGrid(g, pr);
  var mesh = meshFor(pr);   // layout-only → cached across frames; only fills re-sample

  // Brand overlay (live): warm caches without awaiting; drive the intro from camera time.
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

  var rawSrc = null;
  if (ovi.noFilter) {
    try {
      var fc = document.createElement('canvas'); fc.width = frame.width; fc.height = frame.height;
      fc.getContext('2d').putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
      rawSrc = fc.toDataURL('image/jpeg', 0.85);
    } catch (e) { rawSrc = null; }
  }

  var svg;
  try { svg = buildVoronoi(pr.W, pr.H, gEff, mesh.sites, mesh.cells, pr.edgeWidth, pr.edgeColor, _t, ov, rawSrc); }
  catch (e) { return null; }
  _memoKey = null;   // supersede the still memo so stopping live re-renders cleanly
  return { voronoiSvg: svg };
}

function beforeExport(ctx) {
  var alpha = ['png', 'webp'];
  if (alpha.indexOf(ctx.format) !== -1) ctx.opts.background = _transparent ? 'transparent' : _paper;
  else if (ctx.format === 'jpg' || ctx.format === 'jpeg') ctx.opts.background = _paper;
}
