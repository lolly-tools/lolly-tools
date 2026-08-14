/**
 * D3 Chart Studio — hooks.
 *
 * The chart itself is drawn by D3 in the template <script> (it needs the DOM and
 * d3, which the sandboxed hook context has neither of). The hook's ONLY job is
 * pure, DOM-free data work: parse the user's pasted table into a normalised chart
 * model, fold every input into one config object, and hand both to the template
 * as a single JSON `_state` extra. Because it is a `_`-prefixed extra (not a
 * declared input id) the engine's annotateTemplate leaves it untouched, so it is
 * safe to read inside <script>. Same split as street-map / meeting-planner.
 *
 * One model shape feeds all 13 chart types:
 *   categories   – labels down column 0 (the x-axis / slice / row labels)
 *   series       – every OTHER numeric column, aligned to categories
 *   numericCols  – every numeric column in order (scatter x/y/size)
 * Charts pick what they need: bar/line/area/radar use categories×series; pie/
 * donut/treemap/pack use the first series; scatter uses numericCols; heatmap uses
 * the categories×series matrix; histogram bins the first numeric column.
 */

// ── table parsing ────────────────────────────────────────────────────────────

// RFC-4180-ish split of one delimited document into a grid of string cells.
// Honours "double quotes" with "" escaping (quoted cells may embed the delimiter
// and newlines), folds CRLF, tolerates a leading BOM. Works for any single-char
// delimiter (comma / tab / semicolon / pipe).
function splitTable(text, delim) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    // A quote only OPENS a quoted field at the field start (RFC 4180). A quote
    // mid-field (an inch/second mark like 6.1" or a foot-inch 5'6") is literal —
    // otherwise it would swallow the rest of the table into one cell.
    if (c === '"' && field === '') { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop wholly-blank rows (trailing newline, spacer lines).
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// Pick the delimiter by CONSISTENCY across the first several rows, not just the
// max column-count on line 1. A real separator splits every row into the same
// (>1) number of columns; stray punctuation in one line (e.g. "Region (EU|US)")
// does not recur, so it loses. Falls back to the old first-line-max heuristic
// when no candidate is fully consistent (e.g. genuinely ragged data).
function detectDelim(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 12);
  if (!lines.length) return ',';
  const cands = ['\t', ';', '|', ','];
  let fallback = ',', fbN = 1, consistent = null, consistentN = 1;
  for (const d of cands) {
    const counts = lines.map((l) => l.split(d).length);
    if (counts[0] > fbN) { fbN = counts[0]; fallback = d; }
    if (counts[0] > 1 && counts.every((n) => n === counts[0]) && counts[0] > consistentN) {
      consistentN = counts[0]; consistent = d;
    }
  }
  return consistent || fallback;
}

const DELIM_MAP = { comma: ',', tab: '\t', semicolon: ';', pipe: '|' };

// Blank / not-a-number tokens that must count as a GAP, not as text — otherwise a
// few "N/A"s or a spreadsheet error cell would drag a real number column below the
// numeric threshold and drop it. Covers dashes, Excel errors, and common fillers.
function isBlankToken(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return true;
  return /^(-{1,2}|–|—|\.|\?|nil|none|null|nan|na|n\/?a|tbd|#n\/?a|#ref!?|#div\/0!?|#value!?|#name\??!?|#null!?|#num!?)$/i.test(t);
}

// Parse one cell, tolerating how spreadsheets/locales actually write numbers:
// currency & %, grouping by comma / dot / apostrophe / (thin/nbsp) space, EU
// decimal comma, (1,234) accounting negatives, a Unicode minus, and k/m/b/t
// magnitude suffixes. A cell must be WHOLLY numeric after cleaning, so "Q1"/"Mar"
// stay text. `commaDecimal` (per column) says whether comma is the decimal mark.
function parseNum(raw, commaDecimal) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (isBlankToken(s)) return NaN;
  let sign = 1;
  const paren = /^\((.+)\)$/.exec(s);                       // (1,234) accounting negative
  if (paren) { sign = -1; s = paren[1].trim(); }
  s = s.replace(/^[−‒–—]/, '-');        // unicode minus / dashes
  s = s.replace(/[€$£¥%\s' ]/g, '');    // currency / % / apostrophe & space grouping
  let mult = 1;
  const suf = /[kmbt]$/i.exec(s);                           // 1.2M, 850k, 3.4B, 5T
  if (suf && /\d/.test(s)) { mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[suf[0].toLowerCase()]; s = s.slice(0, -1); }
  if (commaDecimal) s = s.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  else s = s.replace(/,(?=\d{3}\b)/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
  return sign * parseFloat(s) * mult;
}

// Does a column use a comma as its DECIMAL separator (EU locale)? Decides the
// comma-vs-dot ambiguity per column by content, so "copy cells from Excel" (which
// arrives TAB-separated, never ';') still reads "1.234,50" / "4,6" correctly.
// "1,234" stays ambiguous → left as thousands; a lone comma+3-digits is not proof.
function columnCommaDecimal(cells) {
  let seen = 0, dec = 0;
  for (const raw of cells) {
    const s = String(raw == null ? '' : raw).replace(/[€$£¥%\s]/g, '').trim();
    if (!s) continue;
    seen++;
    if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(s) || /^[+-]?\d+,\d{1,2}$/.test(s) || /^[+-]?\d+,\d{4,}$/.test(s)) dec++;
  }
  return seen > 0 && dec / seen >= 0.5;
}

// A column is numeric when most of its non-blank cells parse as numbers. Blank /
// error tokens ("N/A", "#DIV/0!", "-") are skipped, not counted against it.
function columnIsNumeric(grid, col, commaDecimal) {
  let seen = 0, num = 0;
  for (let r = 0; r < grid.length; r++) {
    const cell = grid[r][col];
    if (isBlankToken(cell)) continue;
    seen++;
    if (Number.isFinite(parseNum(cell, commaDecimal))) num++;
  }
  return seen > 0 && num / seen >= 0.6;
}

function transposeGrid(grid) {
  const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const out = [];
  for (let c = 0; c < cols; c++) out.push(grid.map((r) => (r[c] == null ? '' : r[c])));
  return out;
}

// Parse the raw pasted text into { categories, series, numericCols, note }.
function buildModel(text, opts) {
  const raw = String(text || '').trim();
  if (!raw) return { categories: [], series: [], numericCols: [], note: 'Paste a table to draw a chart.' };

  const delim = opts.delimiter === 'auto' ? detectDelim(raw) : (DELIM_MAP[opts.delimiter] || ',');
  const semicolon = delim === ';';
  let grid = splitTable(raw, delim);
  if (opts.transpose) grid = transposeGrid(grid);
  if (!grid.length) return { categories: [], series: [], numericCols: [], note: 'No rows found.' };

  // Normalise ragged rows to a common width. reduce() (not Math.max(...spread))
  // so a huge paste can't overflow the argument-count limit and throw. Bound the
  // column and (below) row counts so an oversized table can't freeze the render.
  const width = Math.min(MAX_COLS, grid.reduce((m, r) => Math.max(m, r.length), 0));
  grid = grid.map((r) => { const c = r.slice(0, width); while (c.length < width) c.push(''); return c; });

  let header, body;
  if (opts.hasHeader && grid.length > 1) {
    header = grid[0].map((h, i) => String(h).trim() || `Column ${i + 1}`);
    body = grid.slice(1);
  } else {
    header = grid[0].map((_, i) => (i === 0 ? 'Category' : `Series ${i}`));
    body = grid;
  }
  if (!body.length) return { categories: [], series: [], numericCols: [], note: 'No data rows found.' };
  let note = '';
  if (body.length > MAX_ROWS) { note = `Showing the first ${MAX_ROWS} of ${body.length} rows.`; body = body.slice(0, MAX_ROWS); }

  // Decide comma-vs-dot decimals per column (EU sheets), then which are numeric.
  const commaDecCol = [];
  for (let c = 0; c < width; c++) commaDecCol[c] = semicolon || columnCommaDecimal(body.map((r) => r[c]));
  const numericFlag = [];
  for (let c = 0; c < width; c++) numericFlag[c] = columnIsNumeric(body, c, commaDecCol[c]);

  // ── column roles (explicit overrides fall back to auto-detection) ──────────
  const labelIdx = orDefault(resolveColRef(opts.labelCol, header), 0);
  const pivotIdx = resolveColRef(opts.pivotCol, header);
  const errIdx   = resolveColRef(opts.errorCol, header);   // ± error per value (not plotted as a series)
  const chosen   = resolveColList(opts.seriesCols, header);

  // Category / label column (col 0 by default; a numeric label like a Year still
  // names the x-axis rather than being plotted).
  const categories = body.map((r, i) => {
    const v = String(r[labelIdx] == null ? '' : r[labelIdx]).trim();
    return v || `Item ${i + 1}`;
  });

  // Series = the user's chosen columns (numeric only), else every numeric column
  // other than the label. numericCols keeps ALL numeric columns (scatter x/y/size).
  const colSeries = (cols) => cols.map((c) => ({ name: header[c], values: body.map((r) => nOrNull(parseNum(r[c], commaDecCol[c]))) }));
  const series = colSeries((chosen.length ? chosen : range(width)).filter((c) => c !== labelIdx && c !== pivotIdx && c !== errIdx && numericFlag[c]));
  const numericCols = colSeries(range(width).filter((c) => numericFlag[c]));
  // ± error column → magnitudes aligned to rows (whiskers in the template). Only the
  // standard wide path carries it; pivot/single-col reshapes return before this.
  const errorValues = errIdx >= 0 && errIdx !== labelIdx
    ? body.map((r) => { const e = nOrNull(parseNum(r[errIdx], commaDecCol[errIdx])); return e == null ? null : Math.abs(e); })
    : null;

  // ── reshape: long/tidy → wide ──────────────────────────────────────────────
  // Explicit pivot (a column the user chose) OR auto (a REPEATED label column + a
  // text "key" column + a numeric value column → one series per key) — the most
  // common "my data won't chart" case for pasted spreadsheet extracts.
  const wantPivot = pivotIdx >= 0 && pivotIdx !== labelIdx;
  if (wantPivot || new Set(categories).size < categories.length) {
    const keyCol = wantPivot ? pivotIdx : firstIndex(width, (c) => c !== labelIdx && !numericFlag[c]);
    const valCol = (chosen.find((c) => numericFlag[c] && c !== labelIdx && c !== keyCol)) ??
                   firstIndex(width, (c) => c !== labelIdx && c !== keyCol && numericFlag[c]);
    if (keyCol != null && keyCol >= 0 && valCol != null && valCol >= 0) {
      const p = pivotRows(body, labelIdx, keyCol, valCol, commaDecCol);
      if (p) return { categories: p.categories, series: p.series, numericCols,
        note: appendNote(note, `Pivoted long-format data by “${header[keyCol]}” into ${p.series.length} series.`) };
    }
  }

  // A single value column (the only numeric column is the label) → chart it against
  // row numbers instead of treating the numbers as labels and finding "no series".
  if (!series.length && numericFlag[labelIdx]) {
    const only = { name: header[labelIdx] === 'Category' ? 'Value' : header[labelIdx],
      values: body.map((r) => nOrNull(parseNum(r[labelIdx], commaDecCol[labelIdx]))) };
    return { categories: body.map((_, i) => String(i + 1)), series: [only], numericCols,
      note: appendNote(note, 'Charted a single value column with row numbers as labels.') };
  }

  // Diagnostics — turn silent mis-parses into a nudge the user can act on.
  if (!series.length && !numericCols.length) {
    note = appendNote(note, 'No numeric columns found — is the first row a header, and are the values numbers?');
  } else if (!series.length) {
    note = appendNote(note, 'The only numeric column is the label — pick a Series column, or add data columns.');
  } else if (opts.hasHeader && headerLooksNumeric(header, numericFlag)) {
    note = appendNote(note, 'First row looks like data — turn off “First row is a header” if a row is missing.');
  } else if (!opts.hasHeader && firstRowLooksLikeHeader(body, numericFlag)) {
    note = appendNote(note, 'First row looks like column names — turn on “First row is a header”.');
  }
  return { categories, series, numericCols, errorValues, note };
}

function range(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; }
function orDefault(i, d) { return i >= 0 ? i : d; }
// Resolve a column reference — a 1-based number OR a case-insensitive header name —
// to a 0-based index, or -1 when blank / unknown.
function resolveColRef(ref, header) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return -1;
  if (/^\d+$/.test(s)) { const n = parseInt(s, 10) - 1; return (n >= 0 && n < header.length) ? n : -1; }
  const lc = s.toLowerCase();
  return header.findIndex((h) => String(h).trim().toLowerCase() === lc);
}
function resolveColList(ref, header) {
  return String(ref == null ? '' : ref).split(',').map((s) => resolveColRef(s, header)).filter((i) => i >= 0);
}
// Pivot long rows into wide: category = labelIdx column, one series per unique
// keyCol value, cell = valCol. null when the result has <2 or >40 series.
function pivotRows(body, labelIdx, keyCol, valCol, commaDecCol) {
  const catOf = (r) => String(r[labelIdx] == null ? '' : r[labelIdx]).trim() || 'Item';
  const keyOf = (r) => String(r[keyCol] == null ? '' : r[keyCol]).trim() || '—';
  const cats = uniqueInOrder(body.map(catOf));
  const keys = uniqueInOrder(body.map(keyOf));
  if (keys.length < 2 || keys.length > 40) return null;
  const ci = new Map(cats.map((c, i) => [c, i]));
  const ki = new Map(keys.map((k, i) => [k, i]));
  const series = keys.map((k) => ({ name: k, values: cats.map(() => null) }));
  body.forEach((r) => {
    const ii = ci.get(catOf(r)), jj = ki.get(keyOf(r));
    if (ii != null && jj != null) series[jj].values[ii] = nOrNull(parseNum(r[valCol], commaDecCol[valCol]));
  });
  return { categories: cats, series };
}

function firstIndex(n, pred) { for (let i = 0; i < n; i++) if (pred(i)) return i; return null; }
function uniqueInOrder(arr) { const seen = new Set(), out = []; for (const v of arr) if (!seen.has(v)) { seen.add(v); out.push(v); } return out; }
function appendNote(a, b) { return a ? `${a} ${b}` : b; }
// The "header" cells sitting over numeric columns are themselves numeric → the
// first row is probably data, not headers.
function headerLooksNumeric(header, numericFlag) {
  let checked = 0, numeric = 0;
  for (let c = 1; c < header.length; c++) {
    if (!numericFlag[c]) continue;
    checked++;
    if (Number.isFinite(parseNum(header[c], false))) numeric++;
  }
  return checked > 0 && numeric === checked;
}
// The inverse: header is off but the first DATA row is text over numeric columns
// → it is probably a header the user forgot to flag.
function firstRowLooksLikeHeader(body, numericFlag) {
  if (body.length < 2) return false;
  let checked = 0, textish = 0;
  for (let c = 1; c < numericFlag.length; c++) {
    if (!numericFlag[c]) continue;
    checked++;
    if (!Number.isFinite(parseNum(body[0][c], false))) textish++;
  }
  return checked > 0 && textish === checked;
}

// Bounds so an oversized paste can't overflow argument limits or freeze the render.
const MAX_ROWS = 4000, MAX_COLS = 256;

// null (not 0) for a blank/unparseable cell so gaps stay gaps in a line chart.
function nOrNull(n) { return Number.isFinite(n) ? n : null; }

// ── config normalisation ─────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function isHex(s) { return typeof s === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s.trim()); }

// Legend position: a 2-char side+alignment code (tl/tc/tr/bl/bc/br/lt/lc/lb/rt/rc/rb).
// Old single-word values (bottom/top/left/right) map to their centred forms.
const LEGEND_POS = new Set(['tl', 'tc', 'tr', 'bl', 'bc', 'br', 'lt', 'lc', 'lb', 'rt', 'rc', 'rb']);
function normLegendPos(v) {
  v = String(v == null ? '' : v).toLowerCase().trim();
  const legacy = { bottom: 'bc', top: 'tc', left: 'lc', right: 'rc' };
  if (legacy[v]) return legacy[v];
  return LEGEND_POS.has(v) ? v : 'bc';
}

function buildConfig(inp) {
  const W = clamp(Math.round(num(inp.width, 1280)), 100, 8000);
  const H = clamp(Math.round(num(inp.height, 800)), 100, 8000);
  const transparent = inp.transparentBg === true || inp.transparentBg === 'true';
  const background = isHex(inp.background) ? inp.background.trim() : '#ffffff';
  // Blank text colour → 'auto': the template contrasts it against the background,
  // so titles/axes/labels/legend/gridlines stay legible on any background without
  // the user colouring each one. A real hex overrides.
  const textColor = isHex(inp.textColor) ? inp.textColor.trim() : 'auto';
  // Manual categorical palette slots (Colour 1..6) — blank = brand palette there.
  const paletteSlots = ['palette1', 'palette2', 'palette3', 'palette4', 'palette5', 'palette6']
    .map((k) => (isHex(inp[k]) ? inp[k].trim().toLowerCase() : null));

  return {
    chartType:      String(inp.chartType || 'bar'),
    stackMode:      String(inp.stackMode || 'grouped'),
    curve:          String(inp.curve || 'monotone'),
    showPoints:     inp.showPoints === true || inp.showPoints === 'true',
    pointSize:      clamp(num(inp.pointSize, 10), 2, 48),
    sizeBy:         String(inp.sizeBy || 'uniform'),
    lineWidth:      clamp(num(inp.lineWidth, 3), 1, 16),
    fillOpacity:    clamp(num(inp.fillOpacity, 85), 0, 100) / 100,
    donutRadius:    clamp(num(inp.donutRadius, 0.55), 0, 0.9),
    sliceGap:       clamp(num(inp.sliceGap, 1), 0, 24),
    cornerRadius:   clamp(num(inp.cornerRadius, 3), 0, 40),
    barPadding:     clamp(num(inp.barPadding, 0.2), 0, 0.9),
    barGap:         clamp(num(inp.barGap, 0.08), 0, 0.8),
    paletteSlots,
    binCount:       clamp(Math.round(num(inp.binCount, 0)), 0, 60),
    sort:           String(inp.sort || 'none'),
    labelLayout:    String(inp.labelLayout || 'auto'),
    labelReserve:   clamp(num(inp.labelReserve, 0), 0, 60),
    labelLines:     clamp(Math.round(num(inp.labelLines, 2)), 1, 4),
    barThickness:   clamp(num(inp.barThickness, 0), 0, 400),
    barStyle:       String(inp.barStyle || 'flat'),
    pieStyle:       String(inp.pieStyle || 'flat'),
    depth3d:        clamp(num(inp.depth3d, 0), 0, 160),
    reference:      String(inp.reference || ''),          // reference lines & bands (one per line)
    trend:          String(inp.trend || 'none'),          // none/linear/poly2/exp/log/power/movavg — fitted trend line
    errorColumn:    String(inp.errorColumn || ''),        // column name/number holding the ± error per value
    frameColumn:    String(inp.frameColumn || ''),        // column whose distinct values become animation keyframes
    animSpeed:      clamp(num(inp.animSpeed, 1.5), 0.3, 8),// seconds each keyframe holds before morphing
    frameLabelShow: inp.frameLabelShow !== false && inp.frameLabelShow !== 'false',
    animEase:       String(inp.animEase || 'smooth'),      // smooth / linear / steps
    animDirection:  String(inp.animDirection || 'loop'),   // loop / bounce (ping-pong)
    timeAxis:       String(inp.timeAxis || 'auto'),        // auto / on / off — parse the label column as dates
    yScaleType:     String(inp.yScaleType || 'linear'),
    yZero:          inp.yZero !== false && inp.yZero !== 'false',
    yMax:           Math.max(0, num(inp.yMax, 0)),
    showGrid:       inp.showGrid !== false && inp.showGrid !== 'false',
    showAxes:       inp.showAxes !== false && inp.showAxes !== 'false',
    tickCount:      clamp(Math.round(num(inp.tickCount, 5)), 2, 12),
    numberFormat:   String(inp.numberFormat || 'auto'),
    xTitle:         String(inp.xTitle || ''),
    yTitle:         String(inp.yTitle || ''),
    palette:        String(inp.palette || 'suse'),
    colorBy:        String(inp.colorBy || 'series'),
    shadow:         String(inp.shadow || 'none'),          // none / soft / medium / strong / glow
    differentiate:  String(inp.differentiate || 'auto'),   // colour / pattern / both
    colorOverrides: String(inp.colorOverrides || ''),       // JSON map: value → hex (click-to-recolour)
    annotations:    String(inp.annotations || ''),          // JSON map: category → {i,t,fg,bg} (click a data label)
    background,
    textColor,
    transparent,
    strokeWidth:    clamp(num(inp.strokeWidth, 0), 0, 12),
    strokeColor:    isHex(inp.strokeColor) ? inp.strokeColor.trim() : '#ffffff',
    heading:        String(inp.heading || ''),
    subheading:     String(inp.subheading || ''),
    showValues:     inp.showValues === true || inp.showValues === 'true',
    valueSize:      clamp(num(inp.valueSize, 0), 0, 80),         // data-label font size (0 = auto)
    valueOffset:    clamp(num(inp.valueOffset, 0), -40, 160),    // extra gap from the mark
    valueWeight:    clamp(Math.round(num(inp.valueWeight, 600)), 100, 900),
    valueColor:     isHex(inp.valueColor) ? inp.valueColor.trim() : '',   // blank = auto-contrast
    labelSize:      clamp(num(inp.labelSize, 22), 8, 56),
    titleSize:      clamp(num(inp.titleSize, 34), 14, 72),
    titleAlign:     String(inp.titleAlign || 'left'),
    titlePosition:  String(inp.titlePosition || 'top'),
    titleWeight:    clamp(Math.round(num(inp.titleWeight, 700)), 100, 900),
    labelWeight:    clamp(Math.round(num(inp.labelWeight, 500)), 100, 900),
    showLegend:     inp.showLegend !== false && inp.showLegend !== 'false',
    legendPosition: normLegendPos(inp.legendPosition),
    legendTextSize: clamp(num(inp.legendTextSize, 0), 0, 48),
    legendSwatchSize: clamp(num(inp.legendSwatchSize, 0), 0, 48),
    legendGap:      clamp(num(inp.legendGap, 24), 0, 80),
    legendRadius:   clamp(num(inp.legendRadius, 3), 0, 24),
    legendMono:     inp.legendMono === true || inp.legendMono === 'true',
    legendBold:     inp.legendBold === true || inp.legendBold === 'true',
    legendItalic:   inp.legendItalic === true || inp.legendItalic === 'true',
    width:          W,
    height:         H,
  };
}

// ── assemble ─────────────────────────────────────────────────────────────────

// JSON safe to drop verbatim into <script type="application/json">…</script>:
// the only special sequence is a literal "</script", killed by escaping "<".
// Also escape the JS line terminators U+2028/U+2029 for good measure.
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ── brand-driven palettes (host.color/host.tokens, engine ≥ 1.40) ────────────
// Resolves the ACTIVE brand's colours ONCE in onInit so every palette feels
// native to the brand instead of the shipped SUSE hues:
//   • spectrum   – categorical hues (color.spectrum.*), topped up via distinct()
//   • ramps      – sequential/diverging/mono ramps built from the brand's
//                  primary/secondary with host.color.ramp()/mix() (variations of
//                  one brand hue + combinations of two) — light→dark anchor stops
//                  the template feeds to d3 exactly like the shipped RAMPS
//   • swatches   – a curated brand-swatch list for the click-to-recolour picker
//   • monochrome – fewer than 4 spectrum hues → the template auto-adds patterns
// A brand/host that can't supply a piece leaves it null and the template falls
// back to its shipped hand-tuned palette (older shells stay byte-identical).
let BRAND = null;

function normHex(x) {
  return typeof x === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(x.trim()) ? x.trim().toLowerCase() : null;
}

async function resolveBrandColors() {
  try {
    const c = typeof host !== 'undefined' && host && host.color;
    if (!c || !host.tokens || !host.tokens.colors) return null;
    const swatchesRaw = (await host.tokens.colors()) || [];

    // host.color accepts hex OR oklch()/lch() strings; mix(x,x,0) normalises any
    // resolvable colour to hex (blank/mono brands write oklch() semantic values).
    const toHex = (x) => x ? (normHex(x) || (c.mix ? normHex(c.mix(x, x, 0)) : null)) : null;
    const chroma = (col) => { try { const o = c.oklch && c.oklch(col); return o ? o.c : 0; } catch (e) { return 0; } };
    async function sem(name) {
      try { const v = await host.tokens.resolve('{color.semantic.' + name + '}'); return (typeof v === 'string' && v) ? v : null; }
      catch (e) { return null; }
    }

    // ── categorical spectrum (as before; .value is already resolved hex) ────
    const spectrum = [], seen = new Set();
    for (const s of swatchesRaw) {
      const v = normHex(s.value);
      if (!v || seen.has(v)) continue;
      const path = String(s.path || ''), group = String(s.group || '');
      if (path.indexOf('color.spectrum.') !== 0 && group !== 'Spectrum') continue;
      seen.add(v); spectrum.push(v);
    }
    const primary = await sem('primary');
    const surface = (await sem('surface')) || '#ffffff';
    const text    = (await sem('text')) || '#111111';
    let secondary = await sem('secondary');
    if (spectrum.length >= 4 && c.distinct && c.deltaE && spectrum.length < 10) {
      const anchor = toHex(primary);
      for (const g of c.distinct(20, anchor ? { anchorHex: anchor } : {})) {
        if (spectrum.length >= 10) break;
        const gh = normHex(g);
        if (gh && spectrum.every(v => c.deltaE(v, gh) >= 0.05)) spectrum.push(gh);
      }
    }

    // ── sequential / diverging / mono ramps from the brand ─────────────────
    // Needs ramp()+mix(); without them the template keeps the shipped ramps.
    let ramps = null;
    if (c.ramp && c.mix && primary) {
      const mix = (a, b, t) => c.mix(a, b, t) || a;
      if (!secondary && c.schemes) { const acc = c.schemes(primary, 'complement'); if (acc && acc[0] && acc[0].hex) secondary = acc[0].hex; }
      if (!secondary && spectrum[1]) secondary = spectrum[1];
      if (!secondary) secondary = primary;
      // The "vibrant" brand hue leads the sequential ramps — the more chromatic of
      // primary/secondary. (SUSE's primary is a near-black ink and its Pine green
      // lives in secondary, so this keeps charts feeling Pine-green, not grey.)
      const vib = chroma(secondary) > chroma(primary) ? secondary : primary;
      // A SECOND, distinct hue for the alternate + diverging ramps: the other
      // semantic hue, or — when that's near-neutral / too close — the most
      // chromatic spectrum hue that's far from vib.
      let second = (vib === secondary) ? primary : secondary;
      if (chroma(second) < 0.04 || (c.deltaE && c.deltaE(second, vib) < 0.12)) {
        let best = null, bestScore = -1;
        for (const s of (spectrum || [])) {
          if (c.deltaE && c.deltaE(s, vib) < 0.12) continue;
          const sc = chroma(s) + (c.deltaE ? c.deltaE(s, vib) : 0);
          if (sc > bestScore) { bestScore = sc; best = s; }
        }
        if (best) second = best;
      }
      // a light→dark ramp of ONE brand hue (5 OKLab-even anchors = variations)
      const seq = (hue) => c.ramp([mix(hue, surface, 0.88), mix(hue, surface, 0.42), hue, mix(hue, text, 0.42), mix(hue, text, 0.72)], 5, { correctLightness: true });
      ramps = {
        suse:      seq(vib),
        pine:      seq(vib),
        waterhole: seq(second),
        warm:      seq(mix(vib, '#f47a34', 0.5)),   // brand hue biased warm
        cool:      seq(mix(vib, '#2f6bff', 0.5)),   // brand hue biased cool
        mono:      seq(vib),
        // diverging = a COMBINATION of two brand hues through a neutral middle
        diverging: c.ramp([second, mix(second, surface, 0.5), mix(surface, text, 0.05), mix(vib, surface, 0.5), vib], 5, { correctLightness: false }),
      };
      for (const k of Object.keys(ramps)) {
        const r = (ramps[k] || []).map(normHex).filter(Boolean);
        if (r.length >= 3) ramps[k] = r; else { ramps = null; break; }   // junk → shipped ramps
      }
    }

    // ── click-to-recolour swatches ─────────────────────────────────────────
    // Order = "start with the primary set, then the brand's other colours":
    // primary → secondary → the brand's chromatic hues (spectrum/brand palette) →
    // tints & shades of the two lead hues (variations) → a few neutrals for
    // emphasis last. Near-greys are held back so brand HUES lead the picker.
    // The FULL brand palette for the pickers: primary/secondary lead, then EVERY
    // brand swatch (spectrum, brand hues, ramp steps) — chromatic hues first, then
    // the neutral ramp steps — then tint/shade variations of the lead hues, then a
    // few semantic neutrals. Generous cap so the whole palette is selectable.
    const swatches = [], sseen = new Set();
    const pushSwatch = (name, value, path) => {
      const v = toHex(value);
      if (!v || sseen.has(v) || /^#[0-9a-f]{6}00$/i.test(v) || swatches.length >= 64) return;
      sseen.add(v); swatches.push({ name: String(name || v), value: v, path: String(path || '') });
    };
    const primaryHex = toHex(primary), secondaryHex = toHex(secondary);
    const surfaceHex = toHex(surface) || '#ffffff', textHex = toHex(text) || '#111111';
    pushSwatch('Primary', primaryHex, 'color.semantic.primary');
    pushSwatch('Secondary', secondaryHex, 'color.semantic.secondary');
    for (const s of swatchesRaw) { const hx = toHex(s.value); if (hx && chroma(hx) >= 0.03) pushSwatch(s.name, s.value, s.path); }   // brand hues
    if (c.mix) {                                    // tints + shades = variations of the lead hues
      for (const base of [primaryHex, secondaryHex]) {
        if (!base) continue;
        pushSwatch('Light', c.mix(base, surfaceHex, 0.5));
        pushSwatch('Lighter', c.mix(base, surfaceHex, 0.76));
        pushSwatch('Dark', c.mix(base, textHex, 0.45));
      }
    }
    for (const s of swatchesRaw) { const hx = toHex(s.value); if (hx && chroma(hx) < 0.03) pushSwatch(s.name, s.value, s.path); }   // neutral ramp steps last
    pushSwatch('Muted', toHex(await sem('muted')), 'color.semantic.muted');
    pushSwatch('Ink', textHex, 'color.semantic.text');
    pushSwatch('Paper', surfaceHex, 'color.semantic.surface');

    return {
      spectrum: spectrum.length ? spectrum : null,
      ramps, swatches,
      monochrome: spectrum.length < 4,
      primary: primaryHex, secondary: secondaryHex,
    };
  } catch (e) {
    return null; // tokens/host unavailable (older shell) — shipped palette
  }
}

// Split the pasted table into animation keyframes by a frame/time column. Each
// distinct frame value (first-seen order) yields one keyframe of series aligned to
// the UNION of category labels across all frames — so a bar/line morphs between
// them. Returns null when there's no frame column, <2 frames, or no numeric series.
// (Only built for the tweenable chart types; scatter/pie fall back to buildModel.)
function buildFrames(text, opts) {
  const raw = String(text || '').trim(); if (!raw) return null;
  const delim = opts.delimiter === 'auto' ? detectDelim(raw) : (DELIM_MAP[opts.delimiter] || ',');
  const semicolon = delim === ';';
  let grid = splitTable(raw, delim);
  if (opts.transpose) grid = transposeGrid(grid);
  if (grid.length < 2) return null;
  const width = Math.min(MAX_COLS, grid.reduce((m, r) => Math.max(m, r.length), 0));
  grid = grid.map((r) => { const c = r.slice(0, width); while (c.length < width) c.push(''); return c; });
  let header, body;
  if (opts.hasHeader) { header = grid[0].map((h, i) => String(h).trim() || `Column ${i + 1}`); body = grid.slice(1); }
  else { header = grid[0].map((_, i) => (i === 0 ? 'Category' : `Series ${i}`)); body = grid; }
  if (!body.length) return null;
  if (body.length > MAX_ROWS) body = body.slice(0, MAX_ROWS);
  const commaDecCol = [], numericFlag = [];
  for (let c = 0; c < width; c++) { commaDecCol[c] = semicolon || columnCommaDecimal(body.map((r) => r[c])); numericFlag[c] = columnIsNumeric(body, c, commaDecCol[c]); }
  const frameIdx = resolveColRef(opts.frameCol, header);
  if (frameIdx < 0) return null;
  const labelIdx = orDefault(resolveColRef(opts.labelCol, header), (frameIdx === 0 ? 1 : 0));
  const chosen = resolveColList(opts.seriesCols, header);
  const seriesCols = (chosen.length ? chosen : range(width)).filter((c) => c !== labelIdx && c !== frameIdx && numericFlag[c]);
  if (!seriesCols.length) return null;
  const cell = (r, i) => String(r[i] == null ? '' : r[i]).trim();
  const frameOrder = [], frameRows = {};
  body.forEach((r) => { const f = cell(r, frameIdx) || '—'; if (!(f in frameRows)) { frameRows[f] = []; frameOrder.push(f); } frameRows[f].push(r); });
  if (frameOrder.length < 2) return null;
  const catOrder = [], seen = {};
  body.forEach((r) => { const c = cell(r, labelIdx) || '?'; if (!(c in seen)) { seen[c] = 1; catOrder.push(c); } });
  const frames = frameOrder.map((f) => {
    const byCat = {}; frameRows[f].forEach((r) => { byCat[cell(r, labelIdx) || '?'] = r; });
    return seriesCols.map((c) => ({ name: header[c],
      values: catOrder.map((cat) => { const r = byCat[cat]; return r ? nOrNull(parseNum(r[c], commaDecCol[c])) : null; }) }));
  });
  return { labels: frameOrder, categories: catOrder, frames };
}

const ANIMATABLE = ['bar', 'bar-horizontal', 'line', 'area', 'pie', 'donut', 'scatter'];

function compute(model) {
  const inp = Object.fromEntries(model.map((i) => [i.id, i.value]));
  const cfg = buildConfig(inp);
  cfg.brandPalette  = BRAND && BRAND.spectrum;     // categorical (existing name)
  cfg.brandRamps    = BRAND && BRAND.ramps;        // sequential/diverging/mono ramps
  cfg.brandSwatches = (BRAND && BRAND.swatches) || null;  // click-to-recolour picker
  cfg.brandMono     = !!(BRAND && BRAND.monochrome);      // few hues → auto patterns
  const parseOpts = {
    delimiter: String(inp.delimiter || 'auto'),
    hasHeader: inp.hasHeader !== false && inp.hasHeader !== 'false',
    transpose: inp.transpose === true || inp.transpose === 'true',
    labelCol:  String(inp.labelColumn || ''),
    seriesCols: String(inp.seriesColumns || ''),
    pivotCol:  String(inp.pivotColumn || ''),
    errorCol:  String(inp.errorColumn || ''),
  };
  // Keyframe animation: only for the tweenable chart types + a frame column set.
  const frameData = (cfg.frameColumn && ANIMATABLE.indexOf(cfg.chartType) >= 0)
    ? buildFrames(inp.data, Object.assign({ frameCol: cfg.frameColumn }, parseOpts)) : null;
  let data;
  if (frameData && frameData.frames.length >= 2) {
    // Fixed axis extent(s) over ALL frames so the gridlines/axes hold still while the
    // marks animate within them (else they rescale every frame → jerky).
    const cats = frameData.categories, frs = frameData.frames;
    const ext = (pick) => { let mn = Infinity, mx = -Infinity; frs.forEach((fr) => pick(fr, (v) => { const n = Number(v); if (Number.isFinite(n)) { if (n < mn) mn = n; if (n > mx) mx = n; } })); return [Number.isFinite(mn) ? mn : 0, Number.isFinite(mx) ? mx : 1]; };
    if (cfg.chartType === 'scatter') {
      // scatter: series[0]=X, series[1]=Y — fix BOTH axes independently.
      cfg.animExtentX = ext((fr, add) => (fr[0] ? fr[0].values : []).forEach(add));
      cfg.animExtent  = ext((fr, add) => (fr[1] ? fr[1].values : []).forEach(add));
    } else {
      // bar/line/area: stacked per-category sum when stacking, else the max single value.
      const stacked = frs[0].length > 1 && cfg.stackMode !== 'grouped'
        && (cfg.chartType === 'area' || cfg.chartType === 'bar' || cfg.chartType === 'bar-horizontal');
      cfg.animExtent = ext((fr, add) => {
        for (let c = 0; c < cats.length; c++) {
          if (stacked) { let pos = 0, neg = 0; fr.forEach((s) => { const v = Number(s.values[c]); if (Number.isFinite(v)) { if (v >= 0) pos += v; else neg += v; } }); add(pos); add(neg); }
          else fr.forEach((s) => add(s.values[c]));
        }
      });
    }
    // scatter reads numericCols (x/y cols); bar/line/pie read series — populate the one each needs from frame 0.
    data = { categories: frameData.categories, series: frameData.frames[0],
      numericCols: cfg.chartType === 'scatter' ? frameData.frames[0] : [], errorValues: null,
      frames: frameData.frames, frameLabels: frameData.labels,
      note: `Animating ${frameData.frames.length} frames by “${cfg.frameColumn}”.` };
  } else {
    data = buildModel(inp.data, parseOpts);
  }
  return {
    _state:  safeJson({ data, cfg }),
    _bgFill: cfg.transparent ? 'none' : cfg.background,
    mdSource: d3Md(inp),
  };
}

// The `md` export: heading/subheading + the pasted data re-emitted as a GFM table
// (reusing the same delimiter detection + grid parser the chart uses).
function d3Md(inp) {
  const raw = String(inp.data || '').trim();
  const out = [];
  if (String(inp.heading || '').trim()) out.push('# ' + String(inp.heading).trim());
  if (String(inp.subheading || '').trim()) out.push('_' + String(inp.subheading).trim() + '_');
  if (raw) {
    const delim = String(inp.delimiter || 'auto') === 'auto' ? detectDelim(raw) : (DELIM_MAP[inp.delimiter] || ',');
    let grid = splitTable(raw, delim);
    if (inp.transpose === true || inp.transpose === 'true') grid = transposeGrid(grid);
    const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
    if (grid.length && cols) {
      const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
      const lines = [];
      grid.forEach((r, ri) => {
        const cs = []; for (let c = 0; c < cols; c++) cs.push(cell(r[c]));
        lines.push('| ' + cs.join(' | ') + ' |');
        if (ri === 0) lines.push('| ' + Array(cols).fill('---').join(' | ') + ' |');
      });
      out.push(lines.join('\n'));
    }
  }
  return out.join('\n\n') + '\n';
}

// A brand result is "degraded" when tokens weren't ready at resolve time (no
// primary / spectrum / ramps) — e.g. a cold first paint before the brand pack
// loads. Re-attempt on the next input so the chart picks the brand up rather than
// being stuck on the shipped fallback palette for the session.
function brandDegraded(b) { return !b || (!b.primary && !b.spectrum && !b.ramps); }

async function onInit({ model }) {
  BRAND = await resolveBrandColors();
  return compute(model);
}
async function onInput({ model }) {
  if (brandDegraded(BRAND)) { try { const b = await resolveBrandColors(); if (!brandDegraded(b)) BRAND = b; } catch (e) { /* keep prior */ } }
  return compute(model);
}

// Animated-SVG export: for an ANIMATED chart, swap a self-contained SMIL flipbook into
// #d3-plot before an SVG export (the template owns the build; renderSvg clones the <svg>
// verbatim so the <animate> survive), then restore the live render after. Presence-keyed
// on window functions the template exposes, so a static chart / CLI (no window) is a
// no-op and every other format is untouched.
function beforeExport(ctx) {
  try {
    const w = (typeof window !== 'undefined') ? window : null;
    if (w && (ctx.format === 'svg' || ctx.format === 'svgz') && typeof w.__d3BuildSmil === 'function') w.__d3BuildSmil();
  } catch (e) { /* fall through to the normal static SVG */ }
}
function afterExport() {
  try {
    const w = (typeof window !== 'undefined') ? window : null;
    if (w && typeof w.__d3RestoreLive === 'function') w.__d3RestoreLive();
  } catch (e) { /* no-op */ }
}
