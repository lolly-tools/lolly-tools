/* global host */
/**
 * Print Sheet - hooks.
 *
 * Imposition: one piece of artwork repeated n-up on a physical sheet, with
 * crop marks in the margin so the stack can be guillotined or die-cut.
 *
 * The artwork is an ordinary `asset` input, which means a user can paste a
 * LOLLY TOOL LINK into it (docs/authoring-tools.md, "Use any tool as an
 * image"): the runtime recognises the link and re-renders that tool through
 * host.compose.renderUrl on every mount, so the cells always carry a live
 * render of the linked tool. That is the end-user compose path - no manifest
 * `composes` entry, which could only ever name ONE fixed child tool, and this
 * sheet has to impose ANY of them. A library asset or an upload works exactly
 * the same way; on a shell with no compose bridge the slot is simply empty and
 * the sheet still renders its grid.
 *
 * All geometry is computed in MILLIMETRES and the template's <svg> viewBox is
 * in millimetres too, so every number below is a real print measurement. The
 * pixel size the viewBox is drawn at mirrors engine/src/units.ts: CSS_DPI 96
 * and 25.4 mm to the inch (toCssPx), the same conversion the export path
 * applies for a physical width/height.
 *
 * The hook never throws: a failure becomes the `error` extra, which the sheet
 * shows in plain text instead of painting an invalid grid.
 */

// ─── Constants mirrored from engine/src/units.ts ─────────────────────────────
// CSS_DPI and the millimetres-per-inch divisor. toCssPx(dim) is
// value / PER_INCH[unit] * CSS_DPI; for mm that is value / 25.4 * 96.
var CSS_DPI = 96;
var MM_PER_INCH = 25.4;
var PX_PER_MM = CSS_DPI / MM_PER_INCH;

// ─── Sheet stock, in mm ──────────────────────────────────────────────────────
// Letter is 8.5 x 11 in expressed in mm, so one unit system covers every sheet.
var SHEETS = {
  a4: { w: 210, h: 297, label: 'A4 portrait' },
  a4l: { w: 297, h: 210, label: 'A4 landscape' },
  letter: { w: 215.9, h: 279.4, label: 'US Letter' },
  a3: { w: 297, h: 420, label: 'A3 portrait' },
};

// Most cells one sheet renders. Each cell is a separate placed render, so the
// cap is about render cost, not paper: past this a second sheet is cheaper.
var MAX_CELLS = 40;
// Nothing smaller than this is worth printing, and it keeps the fitting maths
// below away from zero- and negative-width cells.
var MIN_CELL = 6;

// Sheet lookup, own keys only. `SHEETS[v]` on its own is truthy for every
// Object.prototype key, so `?sheet=constructor` used to hand the geometry a
// size-less function and paint a NaN viewBox onto the whole sheet.
function _sheet(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SHEETS, v)
    ? SHEETS[v]
    : SHEETS.a4;
}

function _num(v, dflt, lo, hi) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function _int(v, dflt, lo, hi) {
  return Math.round(_num(v, dflt, lo, hi));
}

// Print measurements are quoted to a tenth of a millimetre; four decimals in
// the SVG keeps the arithmetic exact without writing float noise into exports.
function _r(n) {
  return Math.round(n * 10000) / 10000;
}

// Trim the gap first, then the margin, so a cell never drops below MIN_CELL. A
// URL can ask for 10 columns with a 30 mm gap on A4, which leaves no paper at
// all; both values are advisory once the sheet runs out.
function _fit(total, n, gap, margin) {
  var g = n > 1 ? Math.min(gap, Math.max(0, (total - 2 * margin - n * MIN_CELL) / (n - 1))) : gap;
  var m = Math.min(margin, Math.max(0, (total - (n - 1) * g - n * MIN_CELL) / 2));
  return { gap: g, margin: m };
}

function _toInputs(model) {
  var out = {};
  for (var i = 0; i < model.length; i++) out[model[i].id] = model[i].value;
  return out;
}

var _memoKey = null;
var _memoResult = null;

function compute(model) {
  var inputs = _toInputs(model);

  // The artwork ref: resolved by the runtime before this hook runs, so a tool
  // link has already become a rendered asset (or null, on a shell that cannot
  // compose - the sheet then shows its empty grid and says why).
  var art = inputs.image && typeof inputs.image === 'object' ? inputs.image : null;
  var hasArt = !!(art && typeof art.url === 'string' && art.url);

  var key = JSON.stringify([
    inputs.sheet, inputs.rows, inputs.cols, inputs.gap, inputs.margin,
    inputs.ticks, inputs.tickShape, hasArt,
  ]);
  if (key === _memoKey) return _memoResult;

  var sheet = _sheet(inputs.sheet);
  var W = sheet.w;
  var H = sheet.h;

  var rows = _int(inputs.rows, 2, 1, 10);
  var cols = _int(inputs.cols, 2, 1, 10);
  var notes = [];

  if (rows * cols > MAX_CELLS) {
    var keep = Math.max(1, Math.floor(MAX_CELLS / cols));
    notes.push(rows + ' x ' + cols + ' is ' + (rows * cols) + ' cells. One sheet carries ' +
      MAX_CELLS + ' at most, so this shows ' + keep + ' rows. Print a second sheet for the rest.');
    rows = keep;
  }

  var gapIn = _num(inputs.gap, 5, 0, 30);
  var marginIn = _num(inputs.margin, 10, 0, 30);
  var fx = _fit(W, cols, gapIn, marginIn);
  var fy = _fit(H, rows, gapIn, marginIn);
  // One gap and one margin for the whole sheet, so take whichever axis is tighter.
  var gap = Math.min(fx.gap, fy.gap);
  var margin = Math.min(fx.margin, fy.margin);
  if (gap < gapIn - 0.001 || margin < marginIn - 0.001) {
    notes.push('The gap and margin were trimmed to keep the cells printable at this grid.');
  }

  var cellW = (W - 2 * margin - (cols - 1) * gap) / cols;
  var cellH = (H - 2 * margin - (rows - 1) * gap) / rows;

  var isRound = inputs.tickShape === 'round-rect';
  var radius = isRound ? Math.max(1, Math.min(5, Math.min(cellW, cellH) * 0.12)) : 0;

  var cells = [];
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      cells.push({
        x: _r(margin + c * (cellW + gap)),
        y: _r(margin + r * (cellH + gap)),
        w: _r(cellW),
        h: _r(cellH),
        rx: _r(radius),
      });
    }
  }

  // Crop marks live in the SHEET MARGIN, never over a cell: one short line off
  // each column edge at the top and bottom, one off each row edge at the left
  // and right. That is how a real card sheet is marked, and it means a zero gap
  // (cells butted edge to edge) still gets usable guides.
  var wantTicks = inputs.ticks !== false;
  var tickLen = Math.min(4, margin * 0.7);
  var tickOff = Math.min(1.5, margin * 0.2);
  var ticks = [];
  if (wantTicks && tickLen >= 1.4) {
    for (var ci = 0; ci < cols; ci++) {
      var x0 = margin + ci * (cellW + gap);
      var edgesX = [x0, x0 + cellW];
      for (var xi = 0; xi < edgesX.length; xi++) {
        var x = _r(edgesX[xi]);
        ticks.push({ x1: x, y1: _r(margin - tickOff - tickLen), x2: x, y2: _r(margin - tickOff) });
        ticks.push({ x1: x, y1: _r(H - margin + tickOff), x2: x, y2: _r(H - margin + tickOff + tickLen) });
      }
    }
    for (var ri = 0; ri < rows; ri++) {
      var y0 = margin + ri * (cellH + gap);
      var edgesY = [y0, y0 + cellH];
      for (var yi = 0; yi < edgesY.length; yi++) {
        var y = _r(edgesY[yi]);
        ticks.push({ x1: _r(margin - tickOff - tickLen), y1: y, x2: _r(margin - tickOff), y2: y });
        ticks.push({ x1: _r(W - margin + tickOff), y1: y, x2: _r(W - margin + tickOff + tickLen), y2: y });
      }
    }
  } else if (wantTicks) {
    notes.push('Crop marks need a margin of about 2 mm or more; this sheet has no room for them.');
  }

  _memoKey = key;
  _memoResult = {
    // Extras ACCUMULATE across hook runs, so a success has to clear the error a
    // previous run left behind - otherwise one bad patch pins the sheet on its
    // error text for the rest of the session.
    error: '',
    sheetW: _r(W),
    sheetH: _r(H),
    // Intrinsic pixel size for the <svg> element - the viewBox stays in mm.
    sheetPxW: Math.round(W * PX_PER_MM),
    sheetPxH: Math.round(H * PX_PER_MM),
    rowsOut: rows,
    colsOut: cols,
    cellCount: cells.length,
    cellW: _r(cellW),
    cellH: _r(cellH),
    isRound: isRound,
    cells: cells,
    ticks: ticks,
    hasArt: hasArt,
    // Hairlines: 0.2 mm reads on paper and stays a hairline on screen.
    hairline: 0.2,
    hintSize: Math.max(3, Math.min(6, W * 0.028)),
    hintY: _r(H / 2),
    hintX: _r(W / 2),
    note: notes.join(' '),
    summary: sheet.label + ' - ' + rows + ' x ' + cols + ' at ' +
      (Math.round(cellW * 10) / 10) + ' x ' + (Math.round(cellH * 10) / 10) + ' mm',
  };
  return _memoResult;
}

// A hook must never throw: a failure becomes the `error` extra the sheet shows.
function _safe(ctx) {
  try {
    return compute(ctx.model);
  } catch (e) {
    if (host && host.log) host.log('warn', 'print-sheet: could not build the grid', { error: String(e) });
    // A4 dimensions ride along: without a viewBox the message has no coordinate
    // space to paint into, so the sheet would come out blank instead of saying
    // what went wrong.
    return {
      error: 'Could not lay out this sheet: ' + (e && e.message ? e.message : 'unknown error'),
      sheetW: SHEETS.a4.w, sheetH: SHEETS.a4.h,
      sheetPxW: Math.round(SHEETS.a4.w * PX_PER_MM), sheetPxH: Math.round(SHEETS.a4.h * PX_PER_MM),
    };
  }
}

function onInit(ctx) { return _safe(ctx); }
function onInput(ctx) { return _safe(ctx); }
