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
  const series = colSeries((chosen.length ? chosen : range(width)).filter((c) => c !== labelIdx && c !== pivotIdx && numericFlag[c]));
  const numericCols = colSeries(range(width).filter((c) => numericFlag[c]));

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
  return { categories, series, numericCols, note };
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

function buildConfig(inp) {
  const W = clamp(Math.round(num(inp.width, 1280)), 100, 8000);
  const H = clamp(Math.round(num(inp.height, 800)), 100, 8000);
  const transparent = inp.transparentBg === true || inp.transparentBg === 'true';
  const background = isHex(inp.background) ? inp.background.trim() : '#ffffff';
  const textColor = isHex(inp.textColor) ? inp.textColor.trim() : '#111111';

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
    binCount:       clamp(Math.round(num(inp.binCount, 0)), 0, 60),
    sort:           String(inp.sort || 'none'),
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
    background,
    textColor,
    transparent,
    strokeWidth:    clamp(num(inp.strokeWidth, 0), 0, 12),
    strokeColor:    isHex(inp.strokeColor) ? inp.strokeColor.trim() : '#ffffff',
    heading:        String(inp.heading || ''),
    subheading:     String(inp.subheading || ''),
    showValues:     inp.showValues === true || inp.showValues === 'true',
    labelSize:      clamp(num(inp.labelSize, 22), 8, 56),
    titleWeight:    clamp(Math.round(num(inp.titleWeight, 700)), 100, 900),
    labelWeight:    clamp(Math.round(num(inp.labelWeight, 500)), 100, 900),
    showLegend:     inp.showLegend !== false && inp.showLegend !== 'false',
    legendPosition: String(inp.legendPosition || 'bottom'),
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

// ── brand-driven categorical palette (host.color, engine ≥ 1.40) ─────────────
// When the active brand's tokens carry a spectrum (color.spectrum.* — the
// categorical hues deriveBrandTokens designs for charts), the template's
// categorical option follows the brand instead of the shipped CATEGORICAL
// set; short spectrums top up with host.color.distinct() anchored on the
// brand primary. A brand whose tokens carry no spectrum keeps the shipped
// hand-tuned palette (this stays null). Resolved once in
// onInit (async), cached for onInput; rides cfg into `_state`.
let BRAND_SPECTRUM = null;

async function resolveBrandSpectrum() {
  try {
    const c = typeof host !== 'undefined' && host && host.color;
    if (!c || !host.tokens || !host.tokens.colors) return null;
    const swatches = (await host.tokens.colors()) || [];
    const spectrum = [];
    const seen = new Set();
    for (const s of swatches) {
      const v = typeof s.value === 'string' ? s.value.toLowerCase() : '';
      if (!/^#[0-9a-f]{6}$/.test(v) || seen.has(v)) continue;
      const path = String(s.path || '');
      const group = String(s.group || '');
      if (path.indexOf('color.spectrum.') !== 0 && group !== 'Spectrum') continue;
      seen.add(v);
      spectrum.push(v);
    }
    if (spectrum.length < 4) return null; // no real spectrum — shipped palette
    if (c.distinct && c.deltaE && spectrum.length < 10) {
      let anchor = null;
      try {
        const p = await host.tokens.resolve('{color.semantic.primary}');
        if (typeof p === 'string' && p) anchor = p;
      } catch (e) { /* no semantic slots — anchorless top-up */ }
      for (const g of c.distinct(20, anchor ? { anchorHex: anchor } : {})) {
        if (spectrum.length >= 10) break;
        if (spectrum.every(v => c.deltaE(v, g) >= 0.05)) spectrum.push(g);
      }
    }
    return spectrum;
  } catch (e) {
    return null; // tokens/host unavailable (older shell) — shipped palette
  }
}

function compute(model) {
  const inp = Object.fromEntries(model.map((i) => [i.id, i.value]));
  const cfg = buildConfig(inp);
  cfg.brandPalette = BRAND_SPECTRUM;
  const data = buildModel(inp.data, {
    delimiter: String(inp.delimiter || 'auto'),
    hasHeader: inp.hasHeader !== false && inp.hasHeader !== 'false',
    transpose: inp.transpose === true || inp.transpose === 'true',
    labelCol:  String(inp.labelColumn || ''),
    seriesCols: String(inp.seriesColumns || ''),
    pivotCol:  String(inp.pivotColumn || ''),
  });
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

async function onInit({ model }) {
  BRAND_SPECTRUM = await resolveBrandSpectrum();
  return compute(model);
}
function onInput({ model }) { return compute(model); }
