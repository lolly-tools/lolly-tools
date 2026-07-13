/**
 * Shared hook helpers — the filter-* brand overlay (logo + lower-third).
 *
 * CANONICAL SOURCE for the `overlay` region below. Tool hooks.js ship as
 * self-contained data (no imports), so each consumer carries a byte-for-byte
 * copy of this region between `lolly:shared` marker comments. Edit the region
 * HERE, then run `npm run sync:shared` to rewrite every consumer;
 * `npm run validate:catalog` fails if any consumer drifts from this file.
 *
 * The region depends on `host` (host.assets.get / host.profile.get) being in
 * scope — true inside any hooks.js — and declares its own module state
 * (_logoCache, _profileHeadshotUrl, _liveOvStart).
 */

// === lolly:shared overlay — canonical source; edit here and run npm run sync:shared ===
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
