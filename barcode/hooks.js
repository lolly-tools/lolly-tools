/**
 * Barcode tool hooks.
 *
 * Four linear symbologies, encoded here from the published tables. No library,
 * no network, no DOM: the hook returns one SVG string the template renders.
 *
 *  - EAN-13 / UPC-A / EAN-8: the L / G / R seven-module digit patterns, the
 *    first-digit parity table (EAN-13 only) and the modulo-10 check digit.
 *    Only the L table is written out; R is its complement and G is R reversed,
 *    which is how the standard defines them, so there is one table to get right.
 *  - Code 128: the 107-symbol width table, code sets B and C (C is taken for a
 *    run of four or more digits, two while already in C) and the modulo-103
 *    check symbol.
 *
 * A value the symbology cannot hold renders an in-canvas error panel rather
 * than a blank canvas, and when the only fault is the check digit the panel
 * prints the number that would have worked.
 *
 * Everything the tests read is also an extra: bcModules (the module string of
 * the symbol, quiet zones excluded), bcSymbols (the Code 128 value sequence),
 * bcValue, bcSymbology, bcCheck, bcError, bcHint.
 */

// ─── EAN / UPC tables ────────────────────────────────────────────────────────

// Odd-parity left-hand digit patterns (EAN/UPC set A), seven modules each.
var L_CODES = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];

function _flip(pattern) {
  var out = '';
  for (var i = 0; i < pattern.length; i++) out += pattern.charAt(i) === '0' ? '1' : '0';
  return out;
}

function _reverse(pattern) {
  return pattern.split('').reverse().join('');
}

// Right-hand (set C) is the complement of set A; even-parity left (set B) is
// the right-hand pattern read backwards.
var R_CODES = L_CODES.map(_flip);
var G_CODES = R_CODES.map(_reverse);

// Which of the six left-hand digits use set B, keyed by the first digit. Only
// EAN-13 carries this: UPC-A is an EAN-13 whose first digit is 0, so it always
// takes the all-A row.
var PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

var GUARD_EDGE = '101';
var GUARD_MID = '01010';

// Modulo-10, weights 3 and 1 alternating from the RIGHTMOST body digit. One
// function covers EAN-13, EAN-8 and UPC-A because the alternation is anchored
// at the right, not at the left.
function eanCheckDigit(body) {
  var sum = 0;
  for (var i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(body.charAt(i)) * w;
  }
  return (10 - (sum % 10)) % 10;
}

// ─── Code 128 table ──────────────────────────────────────────────────────────

// Element widths, bar first, alternating. Values 0-105 are six elements summing
// to eleven modules; 106 is the stop pattern's seven elements summing to
// thirteen. Every row's bar widths sum to an even number, which is the
// symbology's own self-check and is asserted by tests/barcode.test.ts.
var C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

var C128_CODE_C = 99;
var C128_CODE_B = 100;
var C128_START_B = 104;
var C128_START_C = 105;
var C128_STOP = 106;

function _widthsToModules(widths) {
  var out = '';
  var dark = true;
  for (var i = 0; i < widths.length; i++) {
    var n = Number(widths.charAt(i));
    for (var k = 0; k < n; k++) out += dark ? '1' : '0';
    dark = !dark;
  }
  return out;
}

function _digitRun(text, from) {
  var n = 0;
  while (from + n < text.length) {
    var c = text.charCodeAt(from + n);
    if (c < 48 || c > 57) break;
    n++;
  }
  return n;
}

// Code sets B and C only. Set A buys control characters nobody puts on a label
// and costs a second shift rule, so it is deliberately not implemented: the
// validator refuses anything outside printable ASCII before we get here.
function encodeCode128(text) {
  var values = [];
  var mode = '';
  var i = 0;
  while (i < text.length) {
    var run = _digitRun(text, i);
    var even = run - (run % 2);
    // Four digits pay for the switch symbol plus the switch back; once inside
    // code set C a further pair is free, so two is enough to stay.
    var wantC = mode === 'C' ? run >= 2 : even >= 4;
    if (wantC) {
      if (mode !== 'C') {
        values.push(mode === '' ? C128_START_C : C128_CODE_C);
        mode = 'C';
      }
      for (var k = 0; k + 1 < run; k += 2) {
        values.push(Number(text.charAt(i + k) + text.charAt(i + k + 1)));
      }
      i += even;
      continue;
    }
    if (mode !== 'B') {
      values.push(mode === '' ? C128_START_B : C128_CODE_B);
      mode = 'B';
    }
    values.push(text.charCodeAt(i) - 32);
    i++;
  }
  // Modulo 103 over the start symbol (weight 1) and each data symbol weighted
  // by its one-based position.
  var sum = values[0];
  for (var p = 1; p < values.length; p++) sum += values[p] * p;
  var check = sum % 103;
  var all = values.concat([check, C128_STOP]);
  var modules = '';
  for (var m = 0; m < all.length; m++) modules += _widthsToModules(C128[all[m]]);
  return {
    modules: modules,
    symbols: all,
    check: check,
    // No guard bars to make room for, so the text sits under the field.
    descend: [],
    labels: [{ x: modules.length / 2, anchor: 'middle', str: text }],
    textStyle: 'below',
  };
}

// ─── Symbology encoders ──────────────────────────────────────────────────────
//
// Each returns { modules, descend, labels, textStyle }. `descend` lists the
// module ranges whose bars run past the bottom of the field (the guards);
// `labels` places the human-readable digits in module coordinates, where module
// 0 is the first module of the symbol and a negative x sits in the quiet zone.

function _leftHalf(digits, parityRow) {
  var out = '';
  for (var i = 0; i < 6; i++) {
    var d = Number(digits.charAt(i));
    out += parityRow.charAt(i) === 'L' ? L_CODES[d] : G_CODES[d];
  }
  return out;
}

function _rightHalf(digits) {
  var out = '';
  for (var i = 0; i < digits.length; i++) out += R_CODES[Number(digits.charAt(i))];
  return out;
}

// One printed digit centred under each seven-module cell, starting at module
// `from`.
function _cells(from, digits) {
  var out = [];
  for (var i = 0; i < digits.length; i++) {
    out.push({ x: from + i * 7 + 3.5, anchor: 'middle', str: digits.charAt(i) });
  }
  return out;
}

function encodeEan13(value) {
  var modules = GUARD_EDGE + _leftHalf(value.slice(1, 7), PARITY[Number(value.charAt(0))])
    + GUARD_MID + _rightHalf(value.slice(7)) + GUARD_EDGE;
  var labels = [{ x: -1.5, anchor: 'end', str: value.charAt(0) }]
    .concat(_cells(3, value.slice(1, 7)), _cells(50, value.slice(7)));
  return { modules: modules, descend: [[0, 3], [45, 50], [92, 95]], labels: labels, textStyle: 'inline' };
}

// UPC-A is an EAN-13 with a leading zero. Only the printed digits differ: the
// number-system digit and the check digit sit outside the guards.
function encodeUpca(value) {
  var wide = '0' + value;
  var enc = encodeEan13(wide);
  // The number-system digit owns the first left-hand cell and the check digit
  // the last right-hand one, but both are printed outside the guards.
  var labels = [{ x: -1.5, anchor: 'end', str: value.charAt(0) }]
    .concat(_cells(10, value.slice(1, 6)), _cells(50, value.slice(6, 11)));
  labels.push({ x: 96.5, anchor: 'start', str: value.charAt(11) });
  return { modules: enc.modules, descend: enc.descend, labels: labels, textStyle: 'inline' };
}

function encodeEan8(value) {
  var left = '';
  for (var i = 0; i < 4; i++) left += L_CODES[Number(value.charAt(i))];
  var modules = GUARD_EDGE + left + GUARD_MID + _rightHalf(value.slice(4)) + GUARD_EDGE;
  var labels = _cells(3, value.slice(0, 4), 0).concat(_cells(36, value.slice(4), 0));
  return { modules: modules, descend: [[0, 3], [31, 36], [64, 67]], labels: labels, textStyle: 'inline' };
}

// ─── Validation ──────────────────────────────────────────────────────────────

var EAN_LEN = { ean13: 13, ean8: 8, upca: 12 };
var SYMBOLOGY_NAME = { ean13: 'EAN-13', ean8: 'EAN-8', upca: 'UPC-A', code128: 'Code 128' };

// Spaces and hyphens are how people write a printed number down, so they are
// stripped rather than refused.
function _digitsOnly(raw) {
  return String(raw == null ? '' : raw).replace(/[\s-]/g, '');
}

// 13 digits -> EAN-13, 12 -> UPC-A (the retail reading of twelve digits),
// 8 -> EAN-8, anything else -> Code 128, which holds any printable ASCII.
function pickSymbology(raw) {
  var digits = _digitsOnly(raw);
  if (/^[0-9]+$/.test(digits)) {
    if (digits.length === 13) return 'ean13';
    if (digits.length === 12) return 'upca';
    if (digits.length === 8) return 'ean8';
  }
  return 'code128';
}

// Returns { value } or { error, hint }. A body one digit short of the symbology
// gets its check digit computed, which is what people expect when they type the
// number off a spreadsheet.
function normalizeEan(raw, kind) {
  var name = SYMBOLOGY_NAME[kind];
  var full = EAN_LEN[kind];
  var digits = _digitsOnly(raw);
  if (!digits) return { error: 'Type the number this ' + name + ' should carry.' };
  if (!/^[0-9]+$/.test(digits)) {
    return { error: name + ' holds digits only. Code 128 takes letters too.' };
  }
  if (digits.length === full - 1) return { value: digits + eanCheckDigit(digits) };
  if (digits.length !== full) {
    return {
      error: name + ' needs ' + full + ' digits, or ' + (full - 1) + ' to have the check digit worked out. This one has '
        + digits.length + '.',
    };
  }
  var body = digits.slice(0, full - 1);
  var want = eanCheckDigit(body);
  if (want !== Number(digits.charAt(full - 1))) {
    return {
      // Not "the last digit of a EAN-13": the name is written into the sentence,
      // so the sentence carries no article.
      error: name + ' ends in a check digit, and this one does not match the rest of the number.',
      hint: 'Did you mean ' + body + want + '?',
    };
  }
  return { value: digits };
}

// Outer whitespace is trimmed, never encoded. A pasted cell carries a trailing
// newline or a stray space, and a space is a real Code 128 character: encoded,
// it would put an invisible character in the scanned string that the printed
// line under the bars does not show.
function normalizeCode128(raw) {
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return { error: 'Type the text this Code 128 should carry.' };
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c < 32 || c > 126) {
      var shown = c === 9 ? 'a tab' : c === 10 || c === 13 ? 'a line break' : '"' + text.charAt(i) + '"';
      return { error: 'Code 128 cannot hold ' + shown + ' (character ' + (i + 1) + '). Use plain ASCII text.' };
    }
  }
  return { value: text };
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Colour values arrive from URL params and land raw inside SVG attributes, so
// only a real hex form is accepted; anything else falls back.
function _hex(v, fb) {
  var s = (v == null ? '' : String(v)).trim().toLowerCase();
  var m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m3) return '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
  var m6 = /^#?([0-9a-f]{6})$/.exec(s);
  return m6 ? '#' + m6[1] : fb;
}

function _num(v, fb, lo, hi) {
  var n = Number(v);
  if (!Number.isFinite(n)) n = fb;
  return Math.min(hi, Math.max(lo, n));
}

function _r(n) {
  return String(Math.round(n * 100) / 100);
}

var MONO_STACK = 'ui-monospace, Menlo, Consolas, monospace';

// The panel is 600 units wide with a 40-unit margin each side, and its note is
// set at 17: about 61 characters of sans-serif fit on a line. Wrap at 56 so the
// estimate has room to be wrong.
var PANEL_W = 600;
var PANEL_CHARS = 56;
var PANEL_LINE = 26;

// Greedy word wrap. The messages name a symbology and a length, so their length
// is not fixed, and an inline <svg> clips what runs past its viewBox: one long
// line loses its own beginning and end.
function _wrapLines(text, max) {
  var words = String(text).split(/\s+/);
  var lines = [];
  var line = '';
  for (var i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    var next = line ? line + ' ' + words[i] : words[i];
    if (line && next.length > max) {
      lines.push(line);
      line = words[i];
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// A visible placeholder when the value cannot be encoded. Without it the canvas
// blanks with nothing to read: onInit/onInput swallow hook errors.
function errorSvg(note, hint) {
  var lines = _wrapLines(note, PANEL_CHARS);
  var body = '';
  var y = 140;
  for (var i = 0; i < lines.length; i++) {
    body += '<text x="300" y="' + (y + i * PANEL_LINE) + '" text-anchor="middle" font-family="sans-serif" '
      + 'font-size="17" fill="#111111">' + _esc(lines[i]) + '</text>';
  }
  var last = y + (lines.length - 1) * PANEL_LINE;
  if (hint) {
    last += 36;
    body += '<text x="300" y="' + last + '" text-anchor="middle" font-family="' + MONO_STACK
      + '" font-size="17" fill="#111111">' + _esc(hint) + '</text>';
  }
  var h = Math.max(260, last + 60);
  return '<svg class="bc-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + PANEL_W + ' ' + h + '" '
    + 'preserveAspectRatio="xMidYMid meet" role="img" aria-label="Barcode unavailable">'
    + '<rect x="0" y="0" width="' + PANEL_W + '" height="' + h + '" rx="12" fill="#fff5f5"/>'
    + '<text x="300" y="96" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="#bd3314">Barcode unavailable</text>'
    + body
    + '</svg>';
}

function _inDescend(ranges, start) {
  for (var i = 0; i < ranges.length; i++) {
    if (start >= ranges[i][0] && start < ranges[i][1]) return true;
  }
  return false;
}

function buildSvg(enc, opts) {
  var mw = opts.moduleWidth;
  var quiet = opts.quiet;
  var n = enc.modules.length;
  var inline = enc.textStyle === 'inline';
  var showText = opts.showText && enc.labels.length > 0;

  var top = 2 * mw;
  var barBottom = top + opts.barHeight;
  // Guard bars run past the field so the printed digits sit in the gutter they
  // leave. Without the digits there is nothing for them to make room for.
  var descend = showText && inline ? 5 * mw : 0;
  var guardBottom = barBottom + descend;
  var fontPx = 6 * mw;
  var baseline;
  var height;
  if (!showText) {
    height = barBottom + 2 * mw;
  } else if (inline) {
    baseline = guardBottom;
    height = guardBottom + 1.5 * mw;
  } else {
    baseline = barBottom + 7 * mw;
    height = barBottom + 9 * mw;
    // One centred line under the bars: shrink it rather than let a long value
    // run out of the field.
    var natural = 0.62 * fontPx * enc.labels[0].str.length;
    var room = n * mw * 0.94;
    if (natural > room) fontPx = fontPx * (room / natural);
  }

  var bars = '';
  var i = 0;
  while (i < n) {
    if (enc.modules.charAt(i) !== '1') { i++; continue; }
    var run = 1;
    while (i + run < n && enc.modules.charAt(i + run) === '1') run++;
    var bottom = _inDescend(enc.descend, i) ? guardBottom : barBottom;
    bars += '<rect x="' + _r(i * mw) + '" y="' + _r(top) + '" width="' + _r(run * mw)
      + '" height="' + _r(bottom - top) + '"/>';
    i += run;
  }

  var texts = '';
  var minX = -quiet;
  var maxX = n + quiet;
  if (showText) {
    for (var k = 0; k < enc.labels.length; k++) {
      var lab = enc.labels[k];
      var wModules = 0.62 * (fontPx / mw) * lab.str.length;
      var from = lab.anchor === 'end' ? lab.x - wModules : lab.anchor === 'start' ? lab.x : lab.x - wModules / 2;
      if (from < minX) minX = from;
      if (from + wModules > maxX) maxX = from + wModules;
      texts += '<text x="' + _r(lab.x * mw) + '" y="' + _r(baseline) + '" text-anchor="' + lab.anchor + '">'
        + _esc(lab.str) + '</text>';
    }
  }

  var x0 = minX * mw;
  var width = (maxX - minX) * mw;
  return '<svg class="bc-svg" xmlns="http://www.w3.org/2000/svg" viewBox="' + _r(x0) + ' 0 ' + _r(width) + ' ' + _r(height)
    + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + _esc(opts.summary) + '">'
    + '<rect x="' + _r(x0) + '" y="0" width="' + _r(width) + '" height="' + _r(height) + '" fill="' + opts.background + '"/>'
    + '<g fill="' + opts.color + '" shape-rendering="crispEdges">' + bars + '</g>'
    + (texts ? '<g fill="' + opts.color + '" font-family="' + MONO_STACK + '" font-size="' + _r(fontPx) + '">' + texts + '</g>' : '')
    + '</svg>';
}

// ─── Hook plumbing ───────────────────────────────────────────────────────────

var SYMBOLOGIES = ['auto', 'ean13', 'ean8', 'upca', 'code128'];

function _fail(note, hint, kind) {
  return {
    svgContent: errorSvg(note, hint),
    bgHex: '#fff5f5',
    inkHex: '#111111',
    bcError: note,
    bcHint: hint || '',
    bcSymbology: kind,
    bcValue: '',
    bcModules: '',
    bcSymbols: '',
    bcCheck: '',
    bcSummary: 'nothing yet',
  };
}

function _summary(kind, value) {
  return SYMBOLOGY_NAME[kind] + ' ' + value;
}

// One-entry memo keyed on the whole args object: every input is covered by
// construction, so there is no per-input list to keep in step.
var _memoKey = null;
var _memoResult = null;

function compute(args) {
  var key = JSON.stringify(args);
  if (key === _memoKey) return _memoResult;

  var asked = SYMBOLOGIES.indexOf(args.symbology) >= 0 ? args.symbology : 'auto';
  var kind = asked === 'auto' ? pickSymbology(args.value) : asked;

  var norm = kind === 'code128' ? normalizeCode128(args.value) : normalizeEan(args.value, kind);
  var result;
  if (norm.error) {
    result = _fail(norm.error, norm.hint, kind);
  } else {
    var enc = kind === 'code128' ? encodeCode128(norm.value)
      : kind === 'ean13' ? encodeEan13(norm.value)
      : kind === 'upca' ? encodeUpca(norm.value)
      : encodeEan8(norm.value);
    var background = _hex(args.background, '#ffffff');
    var color = _hex(args.color, '#111111');
    var summary = _summary(kind, norm.value);
    result = {
      svgContent: buildSvg(enc, {
        moduleWidth: _num(args.moduleWidth, 3, 1, 10),
        barHeight: _num(args.barHeight, 160, 20, 400),
        // 11 modules: the widest quiet zone the four symbologies ask for (EAN-13
        // wants 11 on the left, Code 128 wants 10, UPC-A 9, EAN-8 7), so one
        // symmetric number satisfies all of them. Matches the manifest default.
        quiet: Math.round(_num(args.quiet, 11, 0, 24)),
        showText: args.showText !== false,
        background: background,
        color: color,
        summary: summary,
      }),
      bgHex: background,
      inkHex: color,
      bcError: '',
      bcHint: '',
      bcSymbology: kind,
      bcValue: norm.value,
      bcModules: enc.modules,
      bcSymbols: enc.symbols ? enc.symbols.join(',') : '',
      bcCheck: kind === 'code128' ? String(enc.check) : norm.value.slice(-1),
      bcSummary: summary,
    };
  }

  _memoKey = key;
  _memoResult = result;
  return _memoResult;
}

// A throw in an encoder must not reach the runtime: onInit/onInput swallow
// errors, so the canvas would go blank with nothing to read.
function _run(model) {
  var args = Object.fromEntries(model.map(function (i) { return [i.id, i.value]; }));
  try {
    return compute(args);
  } catch (err) {
    var msg = (err && err.message) ? err.message : 'Could not build this barcode';
    return _fail(msg, '', 'code128');
  }
}

function onInit({ model }) {
  return _run(model);
}

function onInput({ model }) {
  return _run(model);
}
