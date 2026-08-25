/* global host */
/**
 * Pricing Table hooks.
 *
 * Reads the `data` table into the lists the logic-less template prints: one
 * entry per plan column, one entry per feature row, and a resolved colour set.
 * DOM-free and memoized on the input values, so the CLI and the node tests run
 * the same path the web shell does. Nothing here throws: a table that cannot be
 * read comes back as an `error` note the template renders in place.
 *
 * The table convention, mirrored in the input help:
 *   column 0        feature names
 *   columns 1..n    one plan each
 *   row 0           the price line
 *   row 1           optional subtitle row, when its first cell reads
 *                   "Tagline" or "Subtitle"
 *   rows after that one feature each
 *
 * Cell grammar: yes / y / true / check / tick (or a check mark) draws a tick;
 * no / n / false / x / cross / - (or a cross mark) draws a cross; anything else
 * prints as text, with a leading > < ^ v run through the template's `arrow`
 * helper. Matching is case-folded, trimmed, and blind to emoji variation
 * selectors, so a mark pasted from a spreadsheet reads the same as a typed one.
 */

var TICK_WORDS = ['yes', 'y', 'true', 'check', 'tick', 'included', '✓', '✔', '✅', '☑'];
var CROSS_WORDS = ['no', 'n', 'false', 'x', 'cross', '-', '–', '—', '✗', '✘', '✕', '✖', '×', '☒', '❌', '❎'];

// Emoji presentation selectors. A check mark from a picker or a spreadsheet
// arrives as the glyph plus U+FE0F, so strip both selectors before matching or
// "✔️" reads as plain text while a bare "✔" reads as a tick.
var VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;

// Fallbacks for every colour input. A colour default is a token alias that
// resolves to '' on a brand with no tokens, so each one needs a literal here.
var INK_FALLBACK = '#17232b';
var PAPER_FALLBACK = '#f7f8fa';
var ACCENT_FALLBACK = '#2563eb';

function _str(v) {
  return String(v == null ? '' : v).trim();
}

function _int(v, fallback) {
  var n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

// Accept #rgb or #rrggbb (with or without the hash); anything else takes the
// fallback, so a blank token alias can never paint a transparent sheet.
function _hex(v, fallback) {
  var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(_str(v));
  if (!m) return fallback;
  var h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return '#' + h;
}

function _rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// Straight 8-bit blend. Not perceptual, but these are hairlines and panel
// washes derived from the user's own two colours, so a plain mix reads right
// on a light paper and on a dark one.
function _mix(a, b, t) {
  var A = _rgb(a);
  var B = _rgb(b);
  var out = '#';
  for (var i = 0; i < 3; i++) {
    var v = Math.max(0, Math.min(255, Math.round(A[i] + (B[i] - A[i]) * t)));
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

// Which of the two chip inks reads better on `hex`. APCA's Lc is a function of
// the two screen luminances alone, so the crossover between the dark ink and
// white is a single constant on APCA's own 2.4-gamma Y. 0.3441 is that
// crossover, solved against the engine's apcaContrast (color-tools.ts): it
// picks the same side as the engine on 99.7% of the sRGB cube, where a plain
// 8-bit brightness test misses 4% of it by as much as 16 Lc.
var ON_DARK = '#111417';
var ON_LIGHT = '#ffffff';
var APCA_POLARITY_Y = 0.3441;

function _onColor(hex) {
  var c = _rgb(hex);
  var y = 0.2126729 * Math.pow(c[0] / 255, 2.4)
    + 0.7151522 * Math.pow(c[1] / 255, 2.4)
    + 0.0721750 * Math.pow(c[2] / 255, 2.4);
  return y > APCA_POLARITY_Y ? ON_DARK : ON_LIGHT;
}

function _kindOf(raw) {
  var s = _str(raw).replace(VARIATION_SELECTORS, '');
  if (s === '') return 'text';
  var k = s.toLowerCase();
  if (TICK_WORDS.indexOf(k) >= 0) return 'tick';
  if (CROSS_WORDS.indexOf(k) >= 0) return 'cross';
  return 'text';
}

function _palette(args) {
  var ink = _hex(args.color, INK_FALLBACK);
  var paper = _hex(args.background, PAPER_FALLBACK);
  var accent = _hex(args.accent, ACCENT_FALLBACK);
  // transparentBg only clears the outer sheet; card/edge/tint mixes below still
  // derive from the chosen paper colour so the plan panels keep their design.
  var transparent = args.transparentBg === true || args.transparentBg === 'true';
  return {
    inkColor: ink,
    paperColor: transparent ? 'transparent' : paper,
    accentColor: accent,
    onAccentColor: _onColor(accent),
    cardColor: _mix(paper, ink, 0.05),
    edgeColor: _mix(paper, ink, 0.18),
    mutedColor: _mix(ink, paper, 0.42),
    tintColor: _mix(paper, accent, 0.1),
  };
}

function _blank(args, note) {
  var out = _palette(args);
  out.error = note;
  out.ctaText = _str(args.cta);
  out.tiers = [];
  out.rows = [];
  out.tierCount = 0;
  out.featureCount = 0;
  out.gridCols = '1fr';
  return out;
}

function _build(args) {
  var table = args.data && typeof args.data === 'object' && !Array.isArray(args.data) ? args.data : null;
  var columns = table && Array.isArray(table.columns) ? table.columns.map(_str) : [];
  var rawRows = table && Array.isArray(table.rows) ? table.rows : [];

  if (columns.length < 2) {
    return _blank(args, 'Add at least two columns: feature names in the first one, then a column per plan.');
  }
  if (rawRows.length === 0) {
    return _blank(args, 'Add a first row with each plan price, then one row per feature.');
  }

  // Square the grid off. The engine normalizes a table on the way in, but a
  // hook is also driven straight from test state and from a hand-written URL,
  // so pad short rows here too: a missing cell is empty text, never a cross.
  var rows = rawRows.map(function (r) {
    var cells = [];
    for (var i = 0; i < columns.length; i++) cells.push(_str(Array.isArray(r) ? r[i] : ''));
    return cells;
  });

  var priceRow = rows[0];
  var second = rows[1];
  var hasTagline = !!second && /^(tagline|subtitle)$/i.test(second[0]);
  var featureRows = rows.slice(hasTagline ? 2 : 1);

  var pal = _palette(args);
  var highlight = _int(args.highlight, 0);
  var label = _str(args.highlightLabel);
  var ctaText = _str(args.cta);
  var lastIndex = featureRows.length - 1;

  var tiers = [];
  for (var col = 1; col < columns.length; col++) {
    var featured = highlight >= 1 && highlight === col;
    var cells = featureRows.map(function (r, k) {
      var text = r[col];
      var kind = _kindOf(text);
      return {
        kind: kind,
        tick: kind === 'tick',
        cross: kind === 'cross',
        isText: kind === 'text',
        text: kind === 'text' ? text : '',
        glyph: kind === 'tick' ? pal.accentColor : pal.mutedColor,
        highlighted: featured,
        first: k === 0,
        last: k === lastIndex,
      };
    });
    tiers.push({
      name: columns[col],
      price: priceRow[col],
      tagline: hasTagline ? second[col] : '',
      highlighted: featured,
      badge: featured ? label : '',
      ctaText: ctaText,
      cells: cells,
    });
  }

  // The same cells again, walked by feature row, for the flat grid layout.
  var featureLines = featureRows.map(function (r, k) {
    return {
      name: r[0],
      first: k === 0,
      last: k === lastIndex,
      cells: tiers.map(function (t) { return t.cells[k]; }),
    };
  });

  var out = pal;
  out.error = '';
  out.ctaText = ctaText;
  out.tiers = tiers;
  out.rows = featureLines;
  out.tierCount = tiers.length;
  out.featureCount = featureRows.length;
  out.gridCols = '1.5fr repeat(' + tiers.length + ', minmax(0, 1fr))';
  return out;
}

var _memoKey = null;
var _memoResult = null;

function compute(args) {
  var key;
  try {
    key = JSON.stringify(args);
  } catch (e) {
    key = null;
  }
  if (key !== null && key === _memoKey) return _memoResult;

  var result;
  try {
    result = _build(args);
  } catch (err) {
    result = _blank(args, 'Could not read this table. Check the pasted grid and try again.');
  }
  _memoKey = key;
  _memoResult = result;
  return result;
}

function _args(model) {
  return Object.fromEntries(model.map(function (i) { return [i.id, i.value]; }));
}

function onInit({ model }) {
  return compute(_args(model));
}

function onInput({ model }) {
  return compute(_args(model));
}
