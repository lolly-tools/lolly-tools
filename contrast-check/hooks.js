/* global host */
/**
 * Contrast Checker hooks.
 *
 * Two modes, one sheet:
 *  - pair: one foreground on one background. WCAG 2.1 ratio, APCA Lc and its
 *    band, the five pass/fail cells, and a strip of the same pair as seen with
 *    protanopia, deuteranopia, tritanopia and in greyscale.
 *  - palette: every foreground x background combination of the active brand's
 *    colour tokens (host.tokens.colors, first 12 swatches) as a matrix.
 *
 * The readability maths comes from host.color (engine >= 1.40) with a local
 * WCAG fallback, exactly like community/color-palette: an older shell still
 * renders the sheet, just without APCA. Colour-vision simulation is local
 * (the shared `cvd` region), so it works on every shell.
 *
 * The hook never throws: any failure goes into the `error` extra, which the
 * template shows in plain text.
 */

// === lolly:shared cvd - generated from community/_shared/vision.js; edit there and run npm run sync:shared ===
// Colour-vision-deficiency simulation - Machado, Oliveira & Fernandes (2009),
// "A Physiologically-based Model for Simulation of Color Vision Deficiency",
// IEEE TVCG 15(6), pp. 1291-1298. Severity 1.0 only: protanopia, deuteranopia,
// tritanopia. Plus a Rec.709 greyscale and the WCAG level namer.
//
// This mirrors engine/src/color-vision.ts and must stay numerically identical
// to it. Two conventions carried over from there:
//  - the matrix multiplies the GAMMA-ENCODED sRGB channels, with no
//    linearisation, which is what the authors' own reference code does;
//  - channels are clamped to [0,1] after the multiply and rounded to 8 bits.
// Row-major 3x3, copied verbatim from the published table. Do not tidy them.
var CVD_MATRICES = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

// '#abc' / '#aabbcc' / '#aabbccdd' (alpha dropped) -> [r,g,b] 0..255, or null.
function cvdHexToRgb(hex) {
  var s = String(hex == null ? '' : hex).trim();
  var m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m3) s = '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
  var m6 = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
  if (!m6) return null;
  var n = parseInt(m6[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function cvdRgbToHex(rgb) {
  var out = '#';
  for (var i = 0; i < 3; i++) {
    var v = Math.round(rgb[i]);
    v = v < 0 ? 0 : (v > 255 ? 255 : v);
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

// Hex in, hex out. `type` is 'protan' | 'deutan' | 'tritan'. Null on bad input.
function cvdSimulateHex(hex, type) {
  var m = CVD_MATRICES[type];
  var rgb = cvdHexToRgb(hex);
  if (!m || !rgb) return null;
  var r = rgb[0] / 255;
  var g = rgb[1] / 255;
  var b = rgb[2] / 255;
  var ch = function (a, bb, c) {
    var v = a * r + bb * g + c * b;
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    return Math.round(v * 255);
  };
  return cvdRgbToHex([ch(m[0], m[1], m[2]), ch(m[3], m[4], m[5]), ch(m[6], m[7], m[8])]);
}

// Rec.709 luma (0.2126 / 0.7152 / 0.0722) of the gamma-encoded channels.
function cvdGreyscaleHex(hex) {
  var rgb = cvdHexToRgb(hex);
  if (!rgb) return null;
  var y = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  y = y < 0 ? 0 : (y > 1 ? 1 : y);
  var v = Math.round(y * 255);
  return cvdRgbToHex([v, v, v]);
}

// The best WCAG 2.1 level a ratio reaches. Normal text: AA 4.5, AAA 7. Large
// text (18pt, or 14pt bold): AA 3, AAA 4.5. Below the AA bar for normal text,
// 3:1 still carries UI components and graphical objects, reported as 'UI'.
function cvdWcagLevel(ratio, large) {
  if (!(ratio >= 1)) return 'Fail';
  if (ratio >= (large ? 4.5 : 7)) return 'AAA';
  if (ratio >= (large ? 3 : 4.5)) return 'AA';
  return ratio >= 3 ? 'UI' : 'Fail';
}
// === /lolly:shared cvd ===

// Sheet geometry (matches the template's fixed viewBox).
var GRID_X = 250;      // palette matrix: first cell column
var GRID_RIGHT = 1540;
var GRID_TOP = 232;
var GRID_BOTTOM = 952;
var MAX_SWATCHES = 12; // an N x N matrix past this is unreadable at 1600px

// APCA band table: the smallest |Lc| each use still carries, richest first.
// Copied from APCA_BANDS in engine/src/color-tools.ts, whose whole point is that
// every surface showing an Lc words it the same way. Keep the floors AND the
// labels identical to the engine's; do not invent a band below 30 (APCA has no
// published use down there) and do not word it as a pass or a fail (APCA trades
// contrast against size, so pass/fail is not meaningful without a size).
var APCA_BANDS = [
  [90, 'Body text, comfortably'],
  [75, 'Body text, minimum'],
  [60, 'Large text - 24px, or 16px bold'],
  [45, 'Headlines - 36px, or 24px bold'],
  [30, 'Icons and borders only'],
  [0, 'Not usable'],
];

var TICK = 'M3 9.5 L7 13.5 L15 4.5';
var CROSS = 'M4 4 L14 14 M14 4 L4 14';

// Verdict chips: a solid fill with white ink, so a fail reads as a fail from
// across the room and never depends on the pair under test. Fixed literals
// (not brand slots) for the same reason the sheet chrome is neutral: a
// brand-tinted verdict would bias the judgement. White ink on each fill is
// 5:1 or better. Ticks for the text-passing levels, crosses for the rest: UI
// (3:1) is a pass for icons and borders but a fail for the text being judged.
var CHIP_PASS = '#137333';
var CHIP_WARN = '#b45309';
var CHIP_FAIL = '#b3261e';
var CHIP_INK = '#ffffff';

function _chip(level) {
  if (level === 'AAA' || level === 'AA') return { chipFill: CHIP_PASS, chipInk: CHIP_INK, chipMark: TICK, chipWord: level, chipPass: true };
  if (level === 'UI') return { chipFill: CHIP_WARN, chipInk: CHIP_INK, chipMark: CROSS, chipWord: 'UI only', chipPass: false };
  return { chipFill: CHIP_FAIL, chipInk: CHIP_INK, chipMark: CROSS, chipWord: 'Fail', chipPass: false };
}

// Chip geometry: an 18-unit tick/cross scaled to the chip height, then the
// word. The width is estimated from the word length (SUSE Sans, 600 weight),
// which is what an SVG with no text measurement can do.
function _chipGeom(x, y, h, word, font) {
  var s = (h - 6) / 18;
  var textW = word.length * font * 0.6;
  var w = 4 + 18 * s + 5 + textW + 8;
  return {
    chipX: _r1(x), chipY: _r1(y), chipW: _r1(w), chipH: _r1(h), chipR: _r1(h / 2), chipS: _r1(s),
    chipIconX: _r1(x + 4), chipIconY: _r1(y + 3),
    chipTextX: _r1(x + 4 + 18 * s + 5), chipTextY: _r1(y + h / 2 + font * 0.36),
    chipFont: _r1(font),
    chipAfterX: _r1(x + w + 14),
  };
}
function _assign(target, src) {
  for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
  return target;
}

function _clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function _r1(n) { return Math.round(n * 10) / 10; }

// Colour values arrive via URL params and land raw inside SVG attributes, so
// only a real hex form is accepted (an unresolved token alias flattens to '').
function _hex(v, fb) {
  v = (v == null ? '' : String(v)).trim().toLowerCase();
  var m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m3) return '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
  var m6 = /^#?([0-9a-f]{6})$/.exec(v);
  return m6 ? '#' + m6[1] : fb;
}

function _cut(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}

// ── host.color with graceful degradation ─────────────────────────────────────

function _api() {
  return typeof host !== 'undefined' && host && host.color ? host.color : null;
}
function _lum(hex) {
  var rgb = cvdHexToRgb(hex) || [0, 0, 0];
  var c = rgb.map(function (v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function _contrast(a, b) {
  var c = _api();
  if (c && c.contrast) {
    var r = c.contrast(a, b);
    if (Number.isFinite(r)) return r;
  }
  var x = _lum(a) + 0.05;
  var y = _lum(b) + 0.05;
  return x > y ? x / y : y / x;
}
function _apca(text, bg) {
  var c = _api();
  if (c && c.apca) {
    var r = c.apca(text, bg);
    if (Number.isFinite(r)) return Math.abs(r);
  }
  return null; // no local APCA - the sheet just omits Lc on older shells
}
// The template prints this after the words "APCA: ", so the no-Lc case must not
// repeat them.
function _band(lc) {
  if (lc == null) return 'not available on this shell';
  for (var i = 0; i < APCA_BANDS.length; i++) {
    if (lc >= APCA_BANDS[i][0]) return APCA_BANDS[i][1];
  }
  return APCA_BANDS[APCA_BANDS.length - 1][1];
}

// ── the sheet ────────────────────────────────────────────────────────────────

function _pairRow(fg, bg, large) {
  var ratio = _contrast(fg, bg);
  var lc = _apca(fg, bg);
  var level = cvdWcagLevel(ratio, large);
  return _assign({
    fg: fg,
    bg: bg,
    ratio: ratio,
    ratioText: ratio.toFixed(2) + ':1',
    level: level,
    lc: lc,
    lcText: lc == null ? '' : String(Math.round(lc)),
    band: _band(lc),
  }, _chip(level));
}

// The five WCAG cells. `large` marks the row the chosen text size is judged by,
// so the sheet says which line the user actually asked about.
function _checks(ratio, large) {
  var defs = [
    ['aa-normal', 'AA normal text', 4.5, !large],
    ['aaa-normal', 'AAA normal text', 7, !large],
    ['aa-large', 'AA large text', 3, large],
    ['aaa-large', 'AAA large text', 4.5, large],
    ['ui', 'UI and graphics', 3, false],
  ];
  return defs.map(function (d, i) {
    var pass = ratio >= d[2];
    var word = pass ? 'Pass' : 'Fail';
    return _assign({
      key: d[0],
      label: d[1] + (d[3] ? ' (current size)' : ''),
      need: d[2].toFixed(1) + ':1',
      pass: pass,
      result: word,
      mark: pass ? TICK : CROSS,
      chipFill: pass ? CHIP_PASS : CHIP_FAIL,
      chipInk: CHIP_INK,
      chipMark: pass ? TICK : CROSS,
      chipWord: word,
      y: 404 + i * 54,
      markY: 390 + i * 54,
    }, _chipGeom(980, 386 + i * 54, 28, word, 15));
  });
}

// The pair as five viewers see it. Normal first, then the three Machado
// dichromacies, then Rec.709 greyscale (the print and low-vision check).
function _sims(fg, bg, large) {
  var defs = [
    ['normal', 'Normal vision', null],
    ['protan', 'Protanopia', 'protan'],
    ['deutan', 'Deuteranopia', 'deutan'],
    ['tritan', 'Tritanopia', 'tritan'],
    ['grey', 'Greyscale', 'grey'],
  ];
  return defs.map(function (d, i) {
    var sf = fg;
    var sb = bg;
    if (d[2] === 'grey') {
      sf = cvdGreyscaleHex(fg) || fg;
      sb = cvdGreyscaleHex(bg) || bg;
    } else if (d[2]) {
      sf = cvdSimulateHex(fg, d[2]) || fg;
      sb = cvdSimulateHex(bg, d[2]) || bg;
    }
    var row = _pairRow(sf, sb, large);
    row.key = d[0];
    row.name = d[1];
    row.x = 60 + i * 298;
    row.textX = 80 + i * 298;
    row.cx = 200 + i * 298;
    // The tile is 280 x 210 from y 740; the chip sits on its bottom edge.
    _assign(row, _chipGeom(row.textX, 910, 26, row.chipWord, 14));
    return row;
  });
}

async function _swatches() {
  var t = (typeof host !== 'undefined' && host && host.tokens) ? host.tokens : null;
  if (!t || !t.colors) return [];
  var list;
  try {
    list = await t.colors();
  } catch (e) {
    return [];
  }
  if (!list || !list.length) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < list.length && out.length < MAX_SWATCHES; i++) {
    var s = list[i] || {};
    var hex = _hex(s.value, '');
    if (!hex || seen[hex]) continue;
    seen[hex] = 1;
    out.push({ name: String(s.name || s.path || hex), hex: hex });
  }
  return out;
}

// Foreground rows x background columns. Every cell paints the row colour on the
// column colour and carries its own ratio and level, so a cell is readable (or
// visibly is not) on its own terms.
function _matrix(swatches, large) {
  var n = swatches.length;
  var cellW = (GRID_RIGHT - GRID_X) / n;
  var cellH = (GRID_BOTTOM - GRID_TOP) / n;
  var rSize = _clamp(Math.min(cellW / 6, cellH / 4), 10, 26);
  var lSize = _clamp(rSize * 0.68, 9, 17);
  // The verdict chip under the ratio: tall enough to read, never past the
  // cell's lower half (a 12 x 12 matrix leaves 60px per cell).
  var chipH = _clamp(Math.round(lSize * 1.5), 14, Math.min(24, cellH / 2 - 8));
  var nameChars = Math.max(4, Math.floor((cellW - 30) / 6.2)); // chip + gap, at 11px

  var cells = [];
  var rowHeads = [];
  var colHeads = [];
  swatches.forEach(function (col, j) {
    colHeads.push({
      x: _r1(GRID_X + j * cellW + 6),
      textX: _r1(GRID_X + j * cellW + 30),
      hex: col.hex,
      name: _cut(col.name, nameChars),
    });
  });
  swatches.forEach(function (row, i) {
    var cy = GRID_TOP + i * cellH + cellH / 2;
    rowHeads.push({
      y: _r1(cy - 13),
      textY: _r1(cy + 5),
      hex: row.hex,
      // The row-header gutter is x 96..250 at 14px, so about 19 characters.
      name: _cut(row.name, 19),
    });
    swatches.forEach(function (col, j) {
      var cell = _pairRow(row.hex, col.hex, large);
      cell.x = _r1(GRID_X + j * cellW);
      cell.y = _r1(GRID_TOP + i * cellH);
      cell.w = _r1(cellW - 3);
      cell.h = _r1(cellH - 3);
      cell.cx = _r1(GRID_X + j * cellW + cellW / 2);
      cell.ratioY = _r1(cy - 3);
      cell.levelY = _r1(cy + lSize + 6);
      cell.rSize = _r1(rSize);
      cell.lSize = _r1(lSize);
      // Centre the chip under the ratio; its width comes from the word, so
      // measure once at x 0 and place it from that.
      var chipW = _chipGeom(0, 0, chipH, cell.chipWord, lSize).chipW;
      _assign(cell, _chipGeom(GRID_X + j * cellW + cellW / 2 - chipW / 2, cy + 3, chipH, cell.chipWord, lSize));
      cells.push(cell);
    });
  });
  return { cells: cells, rowHeads: rowHeads, colHeads: colHeads };
}

var _memoKey = null;
var _memoResult = null;

async function compute(model) {
  var a = Object.fromEntries(model.map(function (i) { return [i.id, i.value]; }));

  // Neutral ink-on-paper fallback: the {color.semantic.*} aliases flatten to ''
  // on a brand with no tokens.
  var fg = _hex(a.color, '#111827');
  var bg = _hex(a.background, '#ffffff');
  var large = a.textSize === 'large';
  var wantPalette = a.mode === 'palette';
  var sample = String(a.sample == null ? '' : a.sample).trim() || 'The quick brown fox jumps over the lazy dog.';

  // Read the swatches BEFORE the memo check, and key on them: the brand's tokens
  // can change under a mounted tool, and a matrix keyed only on the inputs would
  // keep showing the old brand's colours. The read is a token lookup, and only
  // palette mode makes it, so pair-mode keystrokes still short-circuit here.
  var swatches = wantPalette ? await _swatches() : [];
  var key = JSON.stringify([fg, bg, large, wantPalette, sample, swatches]);
  if (key === _memoKey) return _memoResult;

  var isPalette = swatches.length > 0;
  var note = '';
  if (wantPalette && !isPalette) {
    note = 'This brand has no colour tokens to check, so the single pair is shown instead.';
  }

  var pair = _pairRow(fg, bg, large);
  var sims = _sims(fg, bg, large);
  var grid = isPalette ? _matrix(swatches, large) : { cells: [], rowHeads: [], colHeads: [] };

  var sizeWord = large ? 'large text' : 'normal text';
  var csvSource = isPalette ? grid.cells : sims;
  var csvRows = csvSource.map(function (r) {
    return {
      fg: r.fg,
      bg: r.bg,
      ratio: r.ratio.toFixed(2),
      level: r.level,
      lc: r.lcText,
      band: r.band,
    };
  });

  var report = {
    mode: isPalette ? 'palette' : 'pair',
    textSize: large ? 'large' : 'normal',
    pair: { fg: fg, bg: bg, ratio: Number(pair.ratio.toFixed(2)), wcag: pair.ratioText, level: pair.level, apcaLc: pair.lc, apcaBand: pair.band },
    checks: _checks(pair.ratio, large).map(function (c) { return { id: c.key, need: c.need, pass: c.pass }; }),
    pairs: csvRows,
  };

  _memoKey = key;
  _memoResult = {
    isPalette: isPalette,
    note: note,
    error: '',
    fgHex: fg,
    bgHex: bg,
    // Three caps, one per size in the sample panel: the panel is 840px wide, so
    // a long sample pasted through a URL param is trimmed rather than run off it.
    sampleShort: _cut(sample, 26),
    sampleMid: _cut(sample, 52),
    sample: _cut(sample, 90),
    subtitle: isPalette
      ? swatches.length + ' brand colours, every pairing, judged at ' + sizeWord
      : fg + ' on ' + bg + ', judged at ' + sizeWord,
    ratioText: pair.ratioText,
    ratioValue: pair.ratio.toFixed(2),
    lcText: pair.lc == null ? 'Lc not available' : 'Lc ' + Math.round(pair.lc),
    lcValue: pair.lcText,
    band: pair.band,
    verdict: (large ? 'Large text: ' : 'Normal text: ') + pair.level,
    // The headline chip on the sample panel: the same verdict, in the same
    // colours as the matrix and the check rows.
    verdictChip: _assign(_chipGeom(100, 614, 34, pair.chipWord, 17), _chip(pair.level)),
    checks: _checks(pair.ratio, large),
    sims: sims,
    cells: grid.cells,
    rowHeads: grid.rowHeads,
    colHeads: grid.colHeads,
    csvRows: csvRows,
    reportJson: JSON.stringify(report, null, 2),
  };
  return _memoResult;
}

// A hook must never throw: a failure becomes the `error` extra the sheet shows.
async function _safe(ctx) {
  try {
    return await compute(ctx.model);
  } catch (e) {
    return { isPalette: false, error: 'Could not check this pair: ' + (e && e.message ? e.message : 'unknown error') };
  }
}

function onInit(ctx) { return _safe(ctx); }
function onInput(ctx) { return _safe(ctx); }
