/* global host */
/**
 * Colour Lab hooks.
 *
 * One colour, read properly. The sheet answers three questions the ordinary
 * picker cannot: what this colour IS on the perceptual axes, whether a display
 * can actually show it (and which display), and how much room is left at this
 * hue before the gamut runs out.
 *
 * Everything is computed through `host.color` (engine >= 1.69, which the
 * manifest's engineVersion range ENFORCES — loadTool refuses an older engine,
 * so there are no capability fallbacks to carry here):
 *
 *   oklch / fromOklch  the perceptual axes both ways
 *   gamut / maxChroma  which display can show it, and the ceiling at a hue
 *   gamutRegion        the in-gamut area as rings, for the chart's clip paths
 *   contrast / apca    WCAG 2.1 (compliance) and APCA (advisory)
 *   ramp               the perceptual tone ramp
 *
 * The chart is drawn as horizontal strips, each a linear gradient across its
 * own row, clipped to the real gamut boundary. That is what keeps the sheet
 * VECTOR: the brand studio's version of this chart paints pixels (see
 * shells/web/src/lib/oklch-slice.ts), which is right for a live canvas and
 * useless in an exported SVG or PDF. Same engine primitives underneath, so the
 * two cannot disagree about where sRGB ends.
 */

// Sheet geometry (matches the template's fixed viewBox).
var W = 1600;
var H = 1000;
var M = 56;

// The chart's box on the sheet.
var CH_X = 700;
var CH_Y = 190;
var CH_W = W - M - CH_X;
var CH_H = 560;

// Chart fidelity. STRIPS is the vertical resolution of the fill; STOPS the
// number of gradient stops across each strip. Both are a file-size trade:
// 72 x 11 keeps an exported SVG near 100KB while staying visually smooth,
// because the field is a slow gradient with no detail to lose.
var STRIPS = 72;
var STOPS = 11;
var C_MAX = 0.4; // the chroma axis ceiling — the same one the picker's C slider uses

// Kept short on purpose: the readout column is 314px of 19px monospace, which
// is about 27 characters before the value runs under the chart.
var GAMUT_LABEL = {
  srgb: 'sRGB — any screen',
  p3: 'Display-P3 screens only',
  rec2020: 'Rec.2020 — almost none',
  none: 'No display can show it',
};
var GAMUT_SHORT = { srgb: 'sRGB', p3: 'P3', rec2020: 'Rec.2020', none: '—' };

function _num(v, d) { var n = Number(v); return Number.isFinite(n) ? n : d; }
function _clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function _r2(n) { return Math.round(n * 100) / 100; }
function _r3(n) { return Math.round(n * 1000) / 1000; }

// Colour values arrive via URL params and land raw inside SVG attributes, so
// only a real hex form is ever emitted (an unresolved token alias flattens to
// the fallback rather than being interpolated).
function _hex(v, fb) {
  v = (v == null ? '' : String(v)).trim().toLowerCase();
  var m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m3) return '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
  var m6 = /^#?([0-9a-f]{6})$/.exec(v);
  if (m6) return '#' + m6[1];
  var m8 = /^#?([0-9a-f]{6})[0-9a-f]{2}$/.exec(v);
  if (m8) return '#' + m8[1]; // alpha is not a property of the colour being read
  return fb;
}

function _oneOf(v, allowed, fb) {
  v = String(v == null ? '' : v);
  for (var i = 0; i < allowed.length; i++) if (allowed[i] === v) return v;
  return fb;
}

/** sRGB bytes of a hex, for the rgb() readout. */
function _bytes(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Readable ink for a swatch — the sheet never prints unreadable labels. */
function _on(hex) {
  return host.color.contrast(hex, '#ffffff') >= 4.5 ? '#ffffff' : '#111111';
}

/** Which axes a plane uses. Mirrors engine SlicePlane: first letter = vertical. */
var PLANES = {
  lc: { y: 'l', x: 'c', fixed: 'h', title: 'Lightness × Chroma', xName: 'Chroma', yName: 'Lightness' },
  ch: { y: 'c', x: 'h', fixed: 'l', title: 'Chroma × Hue', xName: 'Hue', yName: 'Chroma' },
  lh: { y: 'l', x: 'h', fixed: 'c', title: 'Lightness × Hue', xName: 'Hue', yName: 'Lightness' },
};

var AXIS_MAX = { l: 1, c: C_MAX, h: 360 };

/** The OKLCH at a position on the plane (u,v in 0..1; v measured UPWARD). */
function _at(plane, u, v, fixed) {
  var ax = PLANES[plane];
  var o = { l: 0, c: 0, h: 0 };
  o[ax.x] = u * AXIS_MAX[ax.x];
  o[ax.y] = v * AXIS_MAX[ax.y];
  o[ax.fixed] = fixed;
  return o;
}

/** Rings (unit square, y DOWN) → an SVG path in chart pixels. */
function _ringsPath(rings) {
  var d = '';
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r];
    if (!ring || ring.length < 3) continue;
    for (var i = 0; i < ring.length; i++) {
      var x = CH_X + ring[i].x * CH_W;
      var y = CH_Y + ring[i].y * CH_H;
      d += (i ? 'L' : 'M') + _r2(x) + ' ' + _r2(y) + ' ';
    }
    d += 'Z ';
  }
  return d.trim();
}

/** An open boundary curve → a polyline path in chart pixels. */
function _edgePath(pts) {
  var d = '';
  for (var i = 0; i < pts.length; i++) {
    d += (i ? 'L' : 'M') + _r2(CH_X + pts[i].x * CH_W) + ' ' + _r2(CH_Y + pts[i].y * CH_H) + ' ';
  }
  return d.trim();
}

/**
 * The chart fill: one horizontal strip per row, each a gradient across the
 * plane's x axis. Strips are emitted for the FULL box and clipped to the gamut
 * region by the template — cheaper and smoother than trying to end each strip
 * at the boundary, and the clip is the exact curve rather than a staircase.
 */
function _strips(plane, fixed) {
  var out = [];
  var h = CH_H / STRIPS;
  for (var i = 0; i < STRIPS; i++) {
    var v = 1 - (i + 0.5) / STRIPS;      // row centre, measured upward
    var stops = [];
    for (var s = 0; s < STOPS; s++) {
      var u = s / (STOPS - 1);
      stops.push({
        o: _r3(u * 100) + '%',
        c: host.color.fromOklch(_at(plane, u, v, fixed)),
      });
    }
    out.push({
      id: 'cl-s' + i,
      y: _r2(CH_Y + i * h),
      // A hairline of overlap kills the seams antialiasing leaves between
      // abutting rects at fractional heights.
      h: _r2(h + 0.6),
      stops: stops,
    });
  }
  return out;
}

/** Axis ticks, as {at, label} in box fractions. */
function _ticks(ch) {
  var out = [];
  var i;
  if (ch === 'h') {
    for (i = 0; i <= 6; i++) out.push({ at: i / 6, label: (i * 60) + '°' });
  } else if (ch === 'l') {
    for (i = 0; i <= 4; i++) out.push({ at: i / 4, label: (i * 25) + '%' });
  } else {
    for (i = 0; i <= 4; i++) out.push({ at: i / 4, label: _r2(i / 4 * C_MAX).toFixed(2) });
  }
  return out;
}

function compute(v) {
  var hex = _hex(v.color, '#3b82f6');
  var plane = _oneOf(v.plane, ['lc', 'ch', 'lh'], 'lc');
  var limit = _oneOf(v.limit, ['srgb', 'p3', 'rec2020'], 'p3');
  var surface = _hex(v.surface, '#ffffff');
  var ink = _hex(v.ink, '#111111');
  var showRamp = v.ramp !== false && v.ramp !== 'false';

  var o = host.color.oklch(hex) || { l: 0.6, c: 0.15, h: 250 };
  var ax = PLANES[plane];
  var fixed = o[ax.fixed];

  // ── What this colour is, and whether anything can show it ────────────────
  var gamut = host.color.gamut(hex);
  var ceilingSrgb = host.color.maxChroma(o.l, o.h, 'srgb');
  var ceilingP3 = host.color.maxChroma(o.l, o.h, 'p3');
  var bytes = _bytes(hex);
  // The headroom line is the actionable number: how much more chroma this hue
  // and lightness could carry before sRGB runs out. Negative means the colour
  // is already past it and is being mapped down to render.
  var headroom = ceilingSrgb - o.c;

  var rowDefs = [
    { label: 'Hex', value: hex.toUpperCase() },
    { label: 'OKLCH', value: 'oklch(' + Math.round(o.l * 100) + '% ' + o.c.toFixed(3) + ' ' + Math.round(o.h) + ')' },
    { label: 'RGB', value: 'rgb(' + bytes[0] + ' ' + bytes[1] + ' ' + bytes[2] + ')' },
    { label: 'Gamut', value: GAMUT_LABEL[gamut] || GAMUT_LABEL.none },
    {
      label: 'Chroma headroom to sRGB',
      value: (headroom >= 0 ? '+' : '') + headroom.toFixed(3)
        + '  (max ' + ceilingSrgb.toFixed(3) + ')',
    },
    {
      label: 'Display-P3 would allow',
      value: ceilingP3.toFixed(3) + '  (+'
        + Math.round((ceilingP3 / (ceilingSrgb || 1) - 1) * 100) + '%)',
    },
  ];
  // Position every readout row here; the template is logic-less and owns no
  // coordinates of its own.
  var rows = rowDefs.map(function (r, i) {
    return { label: r.label, value: r.value, labelY: 212 + i * 62, valueY: 238 + i * 62 };
  });

  // ── Readability, both numbers ────────────────────────────────────────────
  var cOnSurface = host.color.contrast(hex, surface);
  var cInkOn = host.color.contrast(ink, hex);
  var badges = [
    {
      label: 'As text on the surface',
      ratio: cOnSurface.toFixed(2) + ':1',
      apca: 'Lc ' + Math.round(host.color.apca(hex, surface)),
      verdict: cOnSurface >= 4.5 ? 'Passes AA' : cOnSurface >= 3 ? 'Large text only' : 'Fails AA',
      ok: cOnSurface >= 4.5,
      fg: hex, bg: surface, y: 620,
    },
    {
      label: 'As a background under text',
      ratio: cInkOn.toFixed(2) + ':1',
      apca: 'Lc ' + Math.round(host.color.apca(ink, hex)),
      verdict: cInkOn >= 4.5 ? 'Passes AA' : cInkOn >= 3 ? 'Large text only' : 'Fails AA',
      ok: cInkOn >= 4.5,
      fg: ink, bg: hex, y: 720,
    },
  ];

  // ── The chart ────────────────────────────────────────────────────────────
  // Fill the whole box and clip to the region: the clip carries the exact
  // boundary curve, so the fill never has to approximate it with a staircase.
  var regionLimit = _ringsPath(host.color.gamutRegion(plane, fixed, limit, 128, C_MAX));
  var regionSrgb = _ringsPath(host.color.gamutRegion(plane, fixed, 'srgb', 128, C_MAX));
  var regionP3 = limit === 'srgb' ? '' : _ringsPath(host.color.gamutRegion(plane, fixed, 'p3', 128, C_MAX));

  // The wash sits over everything past sRGB, so "further out" reads as "held
  // back" — the same statement the studio's chart makes by draining chroma.
  // Even-odd against the sRGB ring cuts the in-gamut area back out of it.
  var washOuter = regionLimit && regionSrgb ? regionLimit + ' ' + regionSrgb : '';
  var washP3 = limit === 'rec2020' && regionP3 ? regionLimit + ' ' + regionP3 : '';

  // 'lh' has no single-valued edge to stroke (chroma is constant across it, so
  // the region is bounded above AND below); its clip already shows the shape.
  // The sRGB edge is the line you read a value off, so it is the heavier one;
  // P3 is dashed and quieter. Both carry a dark under-stroke in the template so
  // they stay legible over a pale top-left and a near-black bottom-left alike.
  var edges = [];
  if (plane !== 'lh') {
    edges.push({ d: _edgePath(_edge(plane, fixed, 'srgb')), strokeW: 3, dash: 'none', opacity: 0.95 });
    if (limit !== 'srgb') {
      edges.push({ d: _edgePath(_edge(plane, fixed, 'p3')), strokeW: 2, dash: '7 5', opacity: 0.7 });
    }
  }

  // Where the subject colour sits on this plane.
  var dotU = _clamp(o[ax.x] / AXIS_MAX[ax.x], 0, 1);
  var dotV = _clamp(o[ax.y] / AXIS_MAX[ax.y], 0, 1);

  var xTicks = _ticks(ax.x).map(function (t) {
    return { x: _r2(CH_X + t.at * CH_W), label: t.label };
  });
  var yTicks = _ticks(ax.y).map(function (t) {
    return { y: _r2(CH_Y + (1 - t.at) * CH_H), label: t.label };
  });

  // ── The tone ramp ────────────────────────────────────────────────────────
  var ramp = [];
  if (showRamp) {
    var steps = host.color.ramp(
      [host.color.fromOklch({ l: 0.97, c: o.c * 0.25, h: o.h }), hex,
        host.color.fromOklch({ l: 0.14, c: o.c * 0.5, h: o.h })],
      9, { correctLightness: true },
    );
    var rw = (W - 2 * M) / steps.length;
    for (var i = 0; i < steps.length; i++) {
      var g = host.color.gamut(steps[i]);
      ramp.push({
        x: _r2(M + i * rw), w: _r2(rw - 6), hex: steps[i],
        on: _on(steps[i]), gamut: GAMUT_SHORT[g] || '—',
        // Only flag what a viewer would actually lose; sRGB steps need no note.
        flag: g === 'srgb' ? '' : '!',
      });
    }
  }

  var csvRows = [['step', 'hex', 'oklch_l', 'oklch_c', 'oklch_h', 'gamut']];
  for (var k = 0; k < ramp.length; k++) {
    var ro = host.color.oklch(ramp[k].hex);
    csvRows.push([String(k + 1), ramp[k].hex, ro.l.toFixed(4), ro.c.toFixed(4), ro.h.toFixed(1), ramp[k].gamut]);
  }

  return {
    paper: surface,
    ink: ink,
    hairline: host.color.contrast(surface, '#000000') > 8 ? '#00000022' : '#ffffff33',
    swatchHex: hex,
    swatchOn: _on(hex),
    gamutShort: GAMUT_SHORT[gamut] || '—',
    // The one-line verdict, worth reading before anything else on the sheet.
    subtitle: PLANES[plane].title + ' · sliced at '
      + (ax.fixed === 'h' ? Math.round(fixed) + '° hue'
        : ax.fixed === 'l' ? Math.round(fixed * 100) + '% lightness'
          : fixed.toFixed(3) + ' chroma'),
    rows: rows,
    badges: badges,
    chart: {
      x: CH_X, y: CH_Y, w: CH_W, h: CH_H,
      title: PLANES[plane].title,
      xName: PLANES[plane].xName,
      yName: PLANES[plane].yName,
      xNameX: _r2(CH_X + CH_W / 2),
      xNameY: _r2(CH_Y + CH_H + 52),
      yNameX: _r2(CH_X - 54),
      yNameY: _r2(CH_Y + CH_H / 2),
      strips: _strips(plane, fixed),
      clip: regionLimit,
      washOuter: washOuter,
      washP3: washP3,
      edges: edges,
      xTicks: xTicks,
      yTicks: yTicks,
      tickY: _r2(CH_Y + CH_H + 24),
      dotX: _r2(CH_X + dotU * CH_W),
      dotY: _r2(CH_Y + (1 - dotV) * CH_H),
      dotOn: _on(hex),
    },
    ramp: ramp,
    rampY: 850,
    rampH: 110,
    hasRamp: ramp.length > 0,
    csvRows: csvRows,
  };
}

/** The open boundary curve for a plane, in unit-square points. */
function _edge(plane, fixed, limit) {
  var pts = [];
  var n = 128;
  var i;
  if (plane === 'lc') {
    for (i = 0; i <= n; i++) {
      var l = 1 - i / n;
      pts.push({ x: Math.min(1, host.color.maxChroma(l, fixed, limit) / C_MAX), y: i / n });
    }
  } else if (plane === 'ch') {
    for (i = 0; i <= n; i++) {
      var hh = (i / n) * 360;
      pts.push({ x: i / n, y: 1 - Math.min(1, host.color.maxChroma(fixed, hh, limit) / C_MAX) });
    }
  }
  return pts;
}

// `model` is an ARRAY of input items, not a keyed object — key it before use.
function _values(model) {
  var out = {};
  for (var i = 0; i < model.length; i++) out[model[i].id] = model[i].value;
  return out;
}

function onInit(ctx) { return compute(_values(ctx.model)); }
function onInput(ctx) { return compute(_values(ctx.model)); }
