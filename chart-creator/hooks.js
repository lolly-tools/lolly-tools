/* global onInit, onInput */

const PAD = 72;

// Shipped categorical fallback palette — hand-tuned, validated CVD-safe in
// both modes (see PALETTE & GUARD DESIGN). Rows with no explicit colour take a
// slot in order (SERIES[i % len]); the legibility guard below then keeps each
// visible on whatever surface it renders against.
const FALLBACK = ['#008657','#2453ff','#fe7c3f','#5d4f99','#00bda7','#bd3314','#3c8eef','#30ba78'];

// ── brand-driven series palette (host.color, engine ≥ 1.40) ──────────────────
// When the ACTIVE brand's tokens carry a spectrum (color.spectrum.* — the
// categorical hues deriveBrandTokens designs for exactly this), series colours
// follow the brand instead of the shipped palette; short spectrums top up with
// host.color.distinct() anchored on the brand primary. A brand whose tokens
// carry no spectrum group keeps FALLBACK — a hand-tuned set is deliberately
// never replaced by generated colours. Resolved once in onInit (async);
// onInput reuses the cached result.
let SERIES = FALLBACK;

async function resolveSeriesPalette() {
  try {
    const c = typeof host !== 'undefined' && host && host.color;
    if (!c || !host.tokens || !host.tokens.colors) return FALLBACK;
    const swatches = (await host.tokens.colors()) || [];
    const spectrum = [];
    const seen = new Set();
    for (const s of swatches) {
      const v = typeof s.value === 'string' ? s.value.toLowerCase() : '';
      if (!isValidHex(v) || seen.has(v)) continue;
      const path = String(s.path || '');
      const group = String(s.group || '');
      if (path.indexOf('color.spectrum.') !== 0 && group !== 'Spectrum') continue;
      seen.add(v);
      spectrum.push(v);
    }
    if (spectrum.length < 4) return FALLBACK; // no real spectrum — keep the tuned set
    if (c.distinct && c.deltaE && spectrum.length < FALLBACK.length) {
      let anchor = null;
      try {
        const p = await host.tokens.resolve('{color.semantic.primary}');
        if (typeof p === 'string' && p) anchor = p;
      } catch (e) { /* no semantic slots — anchorless top-up */ }
      for (const g of c.distinct(FALLBACK.length * 2, anchor ? { anchorHex: anchor } : {})) {
        if (spectrum.length >= FALLBACK.length) break;
        if (spectrum.every(v => c.deltaE(v, g) >= 0.05)) spectrum.push(g);
      }
    }
    return spectrum;
  } catch (e) {
    return FALLBACK; // tokens/host unavailable (older shell) — shipped palette
  }
}

// ── colour helpers ──────────────────────────────────────────────────────────

function lum(hex) {
  const c = hex.replace('#','');
  const r = parseInt(c.slice(0,2),16)/255;
  const g = parseInt(c.slice(2,4),16)/255;
  const b = parseInt(c.slice(4,6),16)/255;
  const l = v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  return 0.2126*l(r) + 0.7152*l(g) + 0.0722*l(b);
}

function autoText(hex) {
  return lum(hex) > 0.179 ? '#111111' : '#ffffff';
}

function isValidHex(s) {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

// ── legibility guard ─────────────────────────────────────────────────────────
// Pure — no host/DOM; reuses lum(), esc(), isValidHex(), clamp() (hoisted).

// WCAG contrast ratio between two hex colours (reuses lum()).
function contrastRatio(a, b) {
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

function toRgb(hex) {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
}

function toHex(rgb) {
  return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

// (a) Mark-vs-background guard. If a fill would vanish into the surface
// (WCAG < FLOOR) step its lightness AWAY from the surface — darker on a light
// surface, lighter on a dark one — until it clears FLOOR. The hue is preserved,
// so a rescued mark is just a lighter/darker step of the same colour family.
// FLOOR (1.9) sits just BELOW the palette's lightest intentional mark
// (Teal #00bda7 ≈ 2.38:1 on white), so the guard NEVER "corrects" a deliberate
// palette colour — it only rescues marks that would otherwise disappear
// (e.g. legacy Mint #90ebcd 1.40:1 on white, or a dark ink on its own dark tile).
function legibleFill(hex, bg) {
  if (!isValidHex(hex) || !isValidHex(bg)) return hex;
  const FLOOR = 1.9;
  if (contrastRatio(hex, bg) >= FLOOR) return hex;
  const target = lum(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255]; // light bg → darken; dark bg → lighten
  const rgb = toRgb(hex);
  for (let t = 0.15; t < 1; t += 0.15) {
    const cand = toHex(rgb.map((v, i) => v + (target[i] - v) * t));
    if (contrastRatio(cand, bg) >= FLOOR) return cand;
  }
  return toHex(target); // extreme fallback (bg ~ mid-grey)
}

// (b) Fill + 2px surface ring so adjacent equal-ish marks stay separated
// (dataviz mark spec). The stroke is the SURFACE colour, so it reads as a
// hairline gap, not an outline. A plain stroke attr — vector export ignores it.
function markFill(color, surface) {
  return `fill="${esc(color)}" stroke="${esc(surface)}" stroke-width="2"`;
}

// ── utils ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function fmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n/1e9).toFixed(1).replace(/\.0$/,'') + 'B';
  if (abs >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'') + 'M';
  if (abs >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'') + 'K';
  return String(Number.isInteger(n) ? n : n.toFixed(1));
}

function niceMax(v) {
  if (v <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * mag;
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Returns a formatted data value (raw number or percentage).
function fmtValue(value, total, format) {
  if (format === 'value') return fmt(value);
  return Math.round(Math.abs(value) / total * 100) + '%';
}

// Returns y coordinate of text within a segment based on alignment.
function alignedY(segY, segH, textSize, align) {
  if (align === 'top')    return segY + textSize * 1.2;
  if (align === 'center') return segY + segH / 2 + textSize * 0.35;
  return segY + segH - textSize * 0.4; // bottom
}

// ── data parsing ─────────────────────────────────────────────────────────────

function resolveItems(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((row, i) => {
    const r      = row || {};
    const rawLabel = (r.label || '').trim();
    const value    = parseFloat(r.value) || 0;
    const rawCol   = (r.color || '').trim();
    const color    = isValidHex(rawCol) ? rawCol : SERIES[i % SERIES.length];
    return { rawLabel, value, color };
  })
    // Drop entirely-empty rows BEFORE defaulting the label, otherwise an unfilled
    // block always passes the filter and renders a phantom "Item N" segment.
    .filter(r => r.rawLabel || r.value)
    .map((r, i) => ({ label: r.rawLabel || `Item ${i+1}`, value: r.value, color: r.color }));
}

// ── layout ───────────────────────────────────────────────────────────────────

function computeLayout(W, H, title, subtitle) {
  let headerH = 0;
  if (title && subtitle) headerH = 120;
  else if (title)        headerH = 84;
  return { x: PAD, y: PAD + headerH, w: W - 2*PAD, h: H - 2*PAD - headerH };
}

// ── title ────────────────────────────────────────────────────────────────────

function titleSvg(title, subtitle, textColor) {
  if (!title) return '';
  const tc = esc(textColor);
  let out = `<text x="${PAD}" y="${PAD+52}" font-size="52" font-weight="700" fill="${tc}" data-canvas-input="heading">${esc(title)}</text>`;
  if (subtitle) {
    out += `<text x="${PAD}" y="${PAD+90}" font-size="28" font-weight="300" fill="${tc}" opacity="0.65" data-canvas-input="subheading">${esc(subtitle)}</text>`;
  }
  return out;
}

// ── legend dot ───────────────────────────────────────────────────────────────

function legendDot(lx, ly, size, color, shape, surface) {
  const sw = size * 0.9;
  if (shape === 'circle') {
    const cr = sw / 2;
    return `<circle cx="${lx + cr}" cy="${ly + 2 + cr}" r="${cr}" ${markFill(color, surface)}/>`;
  }
  return `<rect x="${lx}" y="${ly+2}" width="${sw}" height="${sw}" ${markFill(color, surface)} rx="3"/>`;
}

// ── vertical bars ─────────────────────────────────────────────────────────────

function verticalBars(items, lay, cfg) {
  if (!items.length) return '';
  const { textColor, showLabels, dataLabels, labelSize, valueSize,
          labelWeight, valueWeight, labelPosition, valuePosition, valueFormat,
          labelAlign, valueAlign,
          labelOffsetX, labelOffsetY, valueOffsetX, valueOffsetY,
          labelGap, valueGap, labelMaxChars } = cfg;

  const total  = items.reduce((s, i) => s + Math.abs(i.value), 0) || 1;
  // Scale bars by magnitude so all-negative (or mixed-sign) data renders at true
  // size rather than collapsing to the niceMax(<=0)=10 floor as 2px stub bars.
  const max    = niceMax(Math.max(...items.map(i => Math.abs(i.value)), 0));
  const axisW  = 56;
  const chartX = lay.x + axisW;
  const chartW = lay.w - axisW;
  const chartY = lay.y + 16;
  const chartH = lay.h - 16;
  const barW   = Math.min(chartW / items.length * 0.6, 120);
  const gap    = chartW / items.length;

  let out = '';

  for (let t = 0; t <= 5; t++) {
    const v     = max * (t / 5);
    const y     = chartY + chartH - (v / max) * chartH;
    const alpha = t === 0 ? '0.15' : '0.08';
    out += `<line x1="${chartX}" y1="${y}" x2="${chartX+chartW}" y2="${y}" stroke="${textColor}" stroke-width="1" opacity="${alpha}"/>`;
    out += `<text x="${chartX-8}" y="${y + labelSize*0.4}" font-size="${labelSize*0.8}" fill="${textColor}" opacity="0.4" text-anchor="end">${fmt(v)}</text>`;
  }

  items.forEach((item, i) => {
    const bh  = Math.max(2, (Math.abs(item.value) / max) * chartH);
    const bx  = chartX + gap*i + (gap - barW)/2;
    const by  = chartY + chartH - bh;
    const cx  = bx + barW/2;
    const tc  = autoText(item.color);

    out += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" ${markFill(item.color, cfg.surface)} rx="4" ry="4"/>`;

    const roomForBoth = bh >= valueSize + labelSize + 12;
    const roomForOne  = bh >= valueSize + 8;
    const vLabel = fmtValue(item.value, total, valueFormat);

    if (dataLabels) {
      const vx = cx + valueOffsetX;
      if (valuePosition === 'outside') {
        const vy = by - 6 - valueGap + valueOffsetY;
        out += `<text x="${vx}" y="${vy}" font-size="${valueSize}" font-weight="${valueWeight}" fill="${esc(textColor)}" text-anchor="middle" opacity="0.75">${vLabel}</text>`;
      } else if (roomForOne) {
        const vy = alignedY(by, bh, valueSize, valueAlign) + valueOffsetY;
        out += `<text x="${vx}" y="${vy}" font-size="${valueSize}" font-weight="${valueWeight}" fill="${esc(tc)}" text-anchor="middle">${vLabel}</text>`;
      } else {
        const vy = by - 6 - valueGap + valueOffsetY;
        out += `<text x="${vx}" y="${vy}" font-size="${valueSize}" font-weight="${valueWeight}" fill="${esc(textColor)}" text-anchor="middle" opacity="0.75">${vLabel}</text>`;
      }
    }

    if (showLabels) {
      const lx = cx + labelOffsetX;
      if (labelPosition === 'outside') {
        const ly = chartY + chartH + labelSize*1.2 + labelGap + labelOffsetY;
        out += `<text x="${lx}" y="${ly}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${esc(textColor)}" text-anchor="middle" opacity="0.65">${esc(trunc(item.label, labelMaxChars || 10))}</text>`;
      } else if (roomForBoth || (!dataLabels && roomForOne)) {
        const ly = alignedY(by, bh, labelSize, labelAlign) + labelOffsetY;
        out += `<text x="${lx}" y="${ly}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${esc(tc)}" text-anchor="middle">${esc(trunc(item.label, labelMaxChars || 10))}</text>`;
      } else {
        const ly = chartY + chartH + labelSize*1.2 + labelGap + labelOffsetY;
        out += `<text x="${lx}" y="${ly}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${esc(textColor)}" text-anchor="middle" opacity="0.65">${esc(trunc(item.label, labelMaxChars || 10))}</text>`;
      }
    }
  });

  return out;
}

// ── horizontal bars ───────────────────────────────────────────────────────────

function horizontalBars(items, lay, cfg) {
  if (!items.length) return '';
  const { textColor, showLabels, dataLabels, labelSize, valueSize,
          labelWeight, valueWeight, labelPosition, valuePosition, valueFormat,
          labelAlign, valueAlign,
          labelOffsetX, labelOffsetY, valueOffsetX, valueOffsetY,
          labelGap, valueGap, labelMaxChars } = cfg;

  const total   = items.reduce((s, i) => s + Math.abs(i.value), 0) || 1;
  // Scale by magnitude (see verticalBars) so negative values render at true size.
  const max     = niceMax(Math.max(...items.map(i => Math.abs(i.value)), 0));
  const rowH    = Math.min(lay.h / items.length, 120);
  const barH    = rowH * 0.55;
  const chartX  = lay.x;
  const chartW  = lay.w;

  let out = '';

  for (let t = 0; t <= 5; t++) {
    const v     = max * (t / 5);
    const x     = chartX + (v / max) * chartW;
    const alpha = t === 0 ? '0.15' : '0.08';
    out += `<line x1="${x}" y1="${lay.y}" x2="${x}" y2="${lay.y + lay.h}" stroke="${textColor}" stroke-width="1" opacity="${alpha}"/>`;
  }

  items.forEach((item, i) => {
    const bw  = Math.max(2, (Math.abs(item.value) / max) * chartW);
    const by  = lay.y + i*rowH + (rowH - barH)/2;
    const tc  = autoText(item.color);
    const pad = 10;

    out += `<rect x="${chartX}" y="${by}" width="${bw}" height="${barH}" ${markFill(item.color, cfg.surface)} rx="4" ry="4"/>`;

    const minWBoth   = labelSize * 4;
    const minWSingle = labelSize * 2.5;
    const outsideX   = chartX + bw + pad;
    const anchorX    = chartX + pad;

    const labelInside = labelPosition !== 'outside' && bw >= minWSingle;
    const valueInside = valuePosition !== 'outside' && bw >= minWBoth;

    if (showLabels) {
      const lx      = (labelInside ? anchorX : outsideX + labelGap) + labelOffsetX;
      const ly      = alignedY(by, barH, labelSize, labelAlign) + labelOffsetY;
      const fill    = labelInside ? esc(tc) : esc(textColor);
      const opacity = labelInside ? '1' : '0.75';
      out += `<text x="${lx}" y="${ly}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${fill}" text-anchor="start" opacity="${opacity}">${esc(trunc(item.label, labelMaxChars || 16))}</text>`;
    }

    if (dataLabels) {
      const vLabel  = fmtValue(item.value, total, valueFormat);
      const vx      = (valueInside ? anchorX : outsideX + valueGap) + valueOffsetX;
      const vy      = alignedY(by, barH, valueSize, valueAlign) + valueOffsetY;
      const fill    = valueInside ? esc(tc) : esc(textColor);
      const opacity = valueInside ? '1' : '0.75';
      out += `<text x="${vx}" y="${vy}" font-size="${valueSize}" font-weight="${valueWeight}" fill="${fill}" text-anchor="start" opacity="${opacity}">${vLabel}</text>`;
    }
  });

  return out;
}

// ── pie / donut geometry ───────────────────────────────────────────────────

function polar(cx, cy, r, a) {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// Full disc (pie) or ring (donut) — used when a single slice fills the whole
// circle, where a gap and rounded corners have nothing to act on.
function ringPath(cx, cy, R, ri) {
  let d = `M ${cx - R} ${cy} A ${R} ${R} 0 1 0 ${cx + R} ${cy} A ${R} ${R} 0 1 0 ${cx - R} ${cy} Z`;
  if (ri > 0) {
    d += ` M ${cx - ri} ${cy} A ${ri} ${ri} 0 1 1 ${cx + ri} ${cy} A ${ri} ${ri} 0 1 1 ${cx - ri} ${cy} Z`;
  }
  return d;
}

// One pie (ri=0) or donut (ri>0) segment from a1→a2 (a2>a1), outer radius R,
// inner radius ri, with corner radius cr rounded where the geometry allows.
// cr is clamped so adjacent fillets never cross; the caller applies the slice
// gap by insetting a1/a2 before calling. Fillet arcs bake into `d`, so rounded
// corners survive every vector export (SVG/PDF/EMF), not just raster.
function segmentPath(cx, cy, R, ri, a1, a2, cr) {
  const sweep  = a2 - a1;
  const largeO = sweep > Math.PI ? 1 : 0;

  if (!(cr > 0)) {
    const [ox1, oy1] = polar(cx, cy, R, a1);
    const [ox2, oy2] = polar(cx, cy, R, a2);
    if (ri > 0) {
      const [ix1, iy1] = polar(cx, cy, ri, a1);
      const [ix2, iy2] = polar(cx, cy, ri, a2);
      return `M ${ox1} ${oy1} A ${R} ${R} 0 ${largeO} 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${ri} ${ri} 0 ${largeO} 0 ${ix1} ${iy1} Z`;
    }
    return `M ${cx} ${cy} L ${ox1} ${oy1} A ${R} ${R} 0 ${largeO} 1 ${ox2} ${oy2} Z`;
  }

  // Clamp the corner radius so fillets stay inside the segment: never wider than
  // half the ring thickness, and never so wide that the two corners on one arc
  // would overlap (a1+φ must stay left of a2−φ).
  const s = Math.sin(Math.min(sweep, Math.PI) / 2);
  let rc = Math.min(cr, R / 2 - 1);
  if (sweep < Math.PI) rc = Math.min(rc, (R * s) / (1 + s));
  if (ri > 0) {
    rc = Math.min(rc, (R - ri) / 2 - 1);
    if (sweep < Math.PI && s < 0.999) rc = Math.min(rc, (ri * s) / (1 - s));
  }
  if (!(rc > 0)) return segmentPath(cx, cy, R, ri, a1, a2, 0);

  const phiO   = Math.asin(rc / (R - rc));
  const osr    = polar(cx, cy, (R - rc) * Math.cos(phiO), a1);
  const osa    = polar(cx, cy, R, a1 + phiO);
  const oea    = polar(cx, cy, R, a2 - phiO);
  const oer    = polar(cx, cy, (R - rc) * Math.cos(phiO), a2);
  const largeOc = (a2 - phiO) - (a1 + phiO) > Math.PI ? 1 : 0;

  if (ri > 0) {
    const phiI    = Math.asin(rc / (ri + rc));
    const isr     = polar(cx, cy, (ri + rc) * Math.cos(phiI), a1);
    const isa     = polar(cx, cy, ri, a1 + phiI);
    const iea     = polar(cx, cy, ri, a2 - phiI);
    const ier     = polar(cx, cy, (ri + rc) * Math.cos(phiI), a2);
    const largeIc = (a2 - phiI) - (a1 + phiI) > Math.PI ? 1 : 0;
    return `M ${osr[0]} ${osr[1]}`
      + ` A ${rc} ${rc} 0 0 1 ${osa[0]} ${osa[1]}`
      + ` A ${R} ${R} 0 ${largeOc} 1 ${oea[0]} ${oea[1]}`
      + ` A ${rc} ${rc} 0 0 1 ${oer[0]} ${oer[1]}`
      + ` L ${ier[0]} ${ier[1]}`
      + ` A ${rc} ${rc} 0 0 1 ${iea[0]} ${iea[1]}`
      + ` A ${ri} ${ri} 0 ${largeIc} 0 ${isa[0]} ${isa[1]}`
      + ` A ${rc} ${rc} 0 0 1 ${isr[0]} ${isr[1]}`
      + ` Z`;
  }

  return `M ${cx} ${cy}`
    + ` L ${osr[0]} ${osr[1]}`
    + ` A ${rc} ${rc} 0 0 1 ${osa[0]} ${osa[1]}`
    + ` A ${R} ${R} 0 ${largeOc} 1 ${oea[0]} ${oea[1]}`
    + ` A ${rc} ${rc} 0 0 1 ${oer[0]} ${oer[1]}`
    + ` Z`;
}

// Fill + optional user outline for a pie/donut slice. Default width 0 → a clean
// fill with no outline (no surface hairline). stroke-linejoin keeps a rounded
// outline flush with rounded corners.
function sliceAttrs(color, cfg) {
  if (cfg.strokeWidth > 0) {
    return `fill="${esc(color)}" stroke="${esc(cfg.strokeColor)}" stroke-width="${cfg.strokeWidth}" stroke-linejoin="round"`;
  }
  return `fill="${esc(color)}"`;
}

// ── pie / donut ───────────────────────────────────────────────────────────────

function pieDonut(items, lay, isDonut, cfg) {
  if (!items.length) return '';
  const { textColor, showLabels, showLegend, dataLabels, labelSize, valueSize,
          labelWeight, valueWeight, legendFontWeight, legendSize, legendDotShape, legendPosition,
          labelPosition, valuePosition, valueFormat,
          labelOffsetX, labelOffsetY, valueOffsetX, valueOffsetY,
          labelGap, valueGap, labelMaxChars, legendMaxChars } = cfg;

  const total      = items.reduce((s, i) => s + Math.abs(i.value), 0) || 1;
  const legendRowH = legendSize * 1.6;

  const isSideLeft  = showLegend && legendPosition === 'left';
  const isSideRight = showLegend && legendPosition === 'right';
  const isSide      = isSideLeft || isSideRight;
  const legendH     = (showLegend && !isSide) ? Math.min(items.length * legendRowH + 16, 220) : 0;

  let cx, cy, r, legendTop, legendX;

  if (isSide) {
    const legendW = lay.w * (cfg.legendWidth / 100);
    const circleW = lay.w - legendW;
    cx       = isSideLeft ? lay.x + legendW + circleW / 2 : lay.x + circleW / 2;
    cy       = lay.y + lay.h / 2;
    r        = Math.min(circleW / 2, lay.h / 2) * 0.92;
    legendX  = isSideLeft ? lay.x : lay.x + lay.w - legendW;
    legendTop = Math.max(lay.y, cy - (items.length * legendRowH) / 2);
  } else if (legendPosition === 'top' && showLegend) {
    legendTop = lay.y;
    cy        = lay.y + legendH + (lay.h - legendH) / 2;
    cx        = lay.x + lay.w / 2;
    r         = Math.min(lay.w / 2, (lay.h - legendH) / 2);
    legendX   = lay.x;
  } else {
    cy        = lay.y + (lay.h - legendH) / 2;
    legendTop = lay.y + (lay.h - legendH) + 8;
    cx        = lay.x + lay.w / 2;
    r         = Math.min(lay.w / 2, (lay.h - legendH) / 2);
    legendX   = lay.x;
  }

  const ri = isDonut ? r * (cfg.donutRadius ?? 0.55) : 0;

  let out  = '';
  let angle = -Math.PI / 2;

  const lmrInside = isDonut ? (r + ri) / 2 : r * 0.62;

  // Gap between slices (px at the outer edge) → a pad angle inset off each side.
  const nSlices  = items.filter(it => Math.abs(it.value) > 0).length;
  const gapAngle = cfg.sliceGap > 0 && r > 0 ? cfg.sliceGap / r : 0;

  items.forEach(item => {
    const slice = (Math.abs(item.value) / total) * 2 * Math.PI;
    if (slice <= 0) return;
    const tc  = autoText(item.color);

    let d;
    if (nSlices <= 1 || slice >= 2 * Math.PI - 1e-6) {
      // A single slice is the whole circle — no sides to gap or round.
      d = ringPath(cx, cy, r, ri);
    } else {
      const pad = Math.min(gapAngle, slice * 0.8) / 2; // keep a sliver even at max gap
      const a1  = angle + pad, a2 = angle + slice - pad;
      d = a2 > a1 ? segmentPath(cx, cy, r, ri, a1, a2, cfg.cornerRadius) : '';
    }
    if (d) out += `<path d="${d}" ${sliceAttrs(item.color, cfg)}/>`;

    if (slice > 0.22) {
      const mid  = angle + slice / 2;
      const cosM = Math.cos(mid);
      const sinM = Math.sin(mid);

      const lmrLabelOut = r + labelSize * 1.4 + labelGap;
      const lmrValueOut = r + labelSize * 1.4 + valueSize * 1.5 + valueGap;

      const lmrLabel = labelPosition === 'outside' ? lmrLabelOut : lmrInside;
      const lmrValue = valuePosition === 'outside' ? lmrValueOut : lmrInside;

      const lxLabel = cx + lmrLabel * cosM + labelOffsetX;
      const lyLabel = cy + lmrLabel * sinM + labelOffsetY;
      const lxValue = cx + lmrValue * cosM + valueOffsetX;
      const lyValue = cy + lmrValue * sinM + valueOffsetY;

      const anchorLabel = labelPosition === 'outside'
        ? (cosM > 0.1 ? 'start' : cosM < -0.1 ? 'end' : 'middle') : 'middle';
      const anchorValue = valuePosition === 'outside'
        ? (cosM > 0.1 ? 'start' : cosM < -0.1 ? 'end' : 'middle') : 'middle';

      const bothInside = labelPosition !== 'outside' && valuePosition !== 'outside';
      const showBoth   = showLabels && dataLabels && !showLegend;

      if (dataLabels) {
        const vLabel = fmtValue(item.value, total, valueFormat);
        const vy = (showBoth && bothInside) ? lyValue + valueSize*1.1 : lyValue + valueSize*0.35;
        const fill = valuePosition === 'outside' ? esc(textColor) : esc(tc);
        out += `<text x="${lxValue}" y="${vy}" font-size="${valueSize}" font-weight="${valueWeight}" fill="${fill}" text-anchor="${anchorValue}">${vLabel}</text>`;
      }

      if (showLabels && !showLegend) {
        const lblY = (showBoth && bothInside) ? lyLabel - labelSize*0.9 : lyLabel + labelSize*0.35;
        const fill = labelPosition === 'outside' ? esc(textColor) : esc(tc);
        out += `<text x="${lxLabel}" y="${lblY}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${fill}" text-anchor="${anchorLabel}">${esc(trunc(item.label, labelMaxChars || 10))}</text>`;
      }
    }

    angle += slice;
  });

  if (showLegend) {
    if (isSide) {
      const legendW    = lay.w * (cfg.legendWidth / 100);
      const dotW       = legendSize * 0.9 + 8;
      const maxChars   = Math.max(8, Math.floor((legendW - dotW) / (legendSize * 0.52)));
      items.forEach((item, i) => {
        const lx = legendX;
        const ly = legendTop + i * legendRowH;
        out += legendDot(lx, ly, legendSize, item.color, legendDotShape, cfg.surface);
        if (showLabels) {
          const sw = legendSize * 0.9;
          out += `<text x="${lx+sw+8}" y="${ly+legendSize*0.85}" font-size="${legendSize}" font-weight="${legendFontWeight}" fill="${esc(textColor)}" opacity="0.85">${esc(trunc(item.label, legendMaxChars || maxChars))}</text>`;
        }
      });
    } else {
      const cols = Math.min(items.length, 4);
      const colW = lay.w / cols;
      items.forEach((item, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const lx  = lay.x + col * colW;
        const ly  = legendTop + row * legendRowH;
        out += legendDot(lx, ly, legendSize, item.color, legendDotShape, cfg.surface);
        if (showLabels) {
          const sw = legendSize * 0.9;
          out += `<text x="${lx+sw+8}" y="${ly+legendSize*0.85}" font-size="${legendSize}" font-weight="${legendFontWeight}" fill="${esc(textColor)}" opacity="0.85">${esc(trunc(item.label, legendMaxChars || 18))}</text>`;
        }
      });
    }
  }

  return out;
}

// ── stacked bar ───────────────────────────────────────────────────────────────

function stackedBar(items, lay, cfg) {
  if (!items.length) return '';
  const { textColor, showLabels, showLegend, dataLabels, labelSize, valueSize,
          labelWeight, valueWeight, legendFontWeight, legendSize, legendDotShape, legendPosition,
          valueFormat, stackMax,
          labelAlign, valueAlign,
          labelOffsetX, labelOffsetY, valueOffsetX, valueOffsetY, labelMaxChars, legendMaxChars } = cfg;

  const total      = items.reduce((s, i) => s + Math.abs(i.value), 0) || 1;
  // The bar is a COMPOSITE of the values. By default it fits their total (denom = total,
  // so it spans the full width). A Scale max GREATER than the total scales the composite
  // against that maximum — the segments fill only their share and the rest is an empty
  // remainder track. A max ≤ total is ignored (would overflow the bar).
  const denom      = stackMax > total ? stackMax : total;
  const legendRowH = legendSize * 1.6;
  const legendH    = showLegend ? Math.min(items.length * legendRowH + 16, 220) : 0;

  const chartH = lay.h - legendH - 32;
  const barH   = Math.min(chartH * 0.45, 96);

  let legendTop, barY;
  if (legendPosition === 'top' && showLegend) {
    legendTop = lay.y;
    barY = lay.y + legendH + 16 + (chartH - barH) / 2;
  } else {
    barY = lay.y + chartH / 2 - barH / 2;
    legendTop = barY + barH + 32;
  }

  const barX = lay.x;
  const barW = lay.w;

  let out  = '';
  let curX = barX;

  // Empty remainder track behind the segments, shown only when a Scale max leaves the
  // composite short of the full width (unused capacity up to the max).
  if (denom > total) {
    out += `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="${esc(textColor)}" opacity="0.08"/>`;
  }

  items.forEach(item => {
    const sw  = (Math.abs(item.value) / denom) * barW;
    const tc  = autoText(item.color);
    out += `<rect x="${curX}" y="${barY}" width="${sw}" height="${barH}" ${markFill(item.color, cfg.surface)}/>`;

    // A legend already lists each segment's label (and value), so also stamping
    // them inside the segment is redundant AND collides — the label and value
    // share one segment and land on top of each other. When a legend is shown,
    // keep the segments as clean colour blocks and let the legend carry the text.
    if (!showLegend && sw > labelSize * 2.5) {
      if (dataLabels) {
        const vLabel = fmtValue(item.value, total, valueFormat);
        const vx = curX + sw / 2 + valueOffsetX;
        const vy = alignedY(barY, barH, valueSize, valueAlign) + valueOffsetY;
        out += `<text x="${vx}" y="${vy}" font-size="${valueSize}" font-weight="${valueWeight}" fill="${esc(tc)}" text-anchor="middle">${vLabel}</text>`;
      }
      if (showLabels) {
        const lx = curX + sw / 2 + labelOffsetX;
        const ly = alignedY(barY, barH, labelSize, labelAlign) + labelOffsetY;
        out += `<text x="${lx}" y="${ly}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${esc(tc)}" text-anchor="middle">${esc(trunc(item.label, labelMaxChars || Math.floor(sw / (labelSize*0.55))))}</text>`;
      }
    }
    curX += sw;
  });

  if (showLegend) {
    const cols = Math.min(items.length, 4);
    const colW = lay.w / cols;
    items.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const lx  = lay.x + col * colW;
      const ly  = legendTop + row * legendRowH;
      out += legendDot(lx, ly, legendSize, item.color, legendDotShape, cfg.surface);
      if (showLabels) {
        const sw  = legendSize * 0.9;
        const val = dataLabels ? ` (${fmtValue(item.value, total, valueFormat)})` : '';
        out += `<text x="${lx+sw+8}" y="${ly+legendSize*0.85}" font-size="${legendSize}" font-weight="${legendFontWeight}" fill="${esc(textColor)}" opacity="0.85">${esc(trunc(item.label, legendMaxChars || 18)+val)}</text>`;
      }
    });
  }

  return out;
}

// ── main build ────────────────────────────────────────────────────────────────

function buildChart(inputs) {
  const W         = Math.max(100, parseInt(inputs.width,  10) || 1080);
  const H         = Math.max(100, parseInt(inputs.height, 10) || 1080);
  const chartType = inputs.chartType  || 'donut';
  const title     = (inputs.heading    || '').trim();
  const subtitle  = (inputs.subheading || '').trim();
  const textColor = isValidHex(inputs.color) ? inputs.color : '#111111';
  const bgColor   = isValidHex(inputs.background) ? inputs.background : '#ffffff';
  // Transparent → the chart composites onto the theme surface; assume white
  // (the common light-theme surface) for the legibility guard.
  const guardBg   = inputs.transparentBg ? '#ffffff' : bgColor;
  const items     = resolveItems(inputs.data)
                      .map(it => ({ ...it, color: legibleFill(it.color, guardBg) }));

  const rawFormat = inputs.valueFormat || 'auto';
  const isBar     = chartType === 'vertical-bar' || chartType === 'horizontal-bar';
  // Stacked is a COMPOSITE of the actual values (not a forced 100%), so it defaults to
  // showing real numbers like the bar charts; pie/donut still default to percentages.
  const resolvedValueFormat = rawFormat === 'auto' ? ((isBar || chartType === 'stacked') ? 'value' : 'percent') : rawFormat;

  const cfg = {
    chartType,
    title,
    subtitle,
    textColor,
    showLabels:      inputs.showLabels !== false,
    showLegend:      inputs.showLegend === true,
    dataLabels:      inputs.dataLabels === true,
    labelSize:       Math.max(8,  parseInt(inputs.labelSize,  10) || 22),
    valueSize:       Math.max(8,  parseInt(inputs.valueSize,  10) || 24),
    labelWeight:     clamp(parseInt(inputs.labelWeight,      10) || 500, 100, 900),
    valueWeight:     clamp(parseInt(inputs.valueWeight,      10) || 700, 100, 900),
    legendFontWeight:clamp(parseInt(inputs.legendFontWeight, 10) || 500, 100, 900),
    legendSize:      Math.max(8,  parseInt(inputs.legendSize, 10) || 22),
    legendDotShape:  inputs.legendDotShape  || 'square',
    legendPosition:  inputs.legendPosition  || 'bottom',
    labelPosition:   inputs.labelPosition   || 'inside',
    valuePosition:   inputs.valuePosition   || 'inside',
    labelAlign:      inputs.labelAlign      || 'bottom',
    valueAlign:      inputs.valueAlign      || 'top',
    labelOffsetX:    parseInt(inputs.labelOffset?.x, 10) || 0,
    labelOffsetY:    parseInt(inputs.labelOffset?.y, 10) || 0,
    valueOffsetX:    parseInt(inputs.valueOffset?.x, 10) || 0,
    valueOffsetY:    parseInt(inputs.valueOffset?.y, 10) || 0,
    labelGap:        Math.max(0, parseInt(inputs.labelGap,  10) || 0),
    valueGap:        Math.max(0, parseInt(inputs.valueGap,  10) || 0),
    labelMaxChars:   Math.max(0, parseInt(inputs.labelMaxChars, 10) || 0),
    legendMaxChars:  Math.max(0, parseInt(inputs.legendMaxChars, 10) || 0),
    valueFormat:     resolvedValueFormat,
    donutRadius:     parseFloat(inputs.donutRadius) || 0.55,
    legendWidth:     clamp(parseInt(inputs.legendWidth, 10) || 40, 15, 65),
    stackMax:        Math.max(0, parseFloat(inputs.stackMax) || 0),
    sliceGap:        Math.max(0, parseFloat(inputs.sliceGap) || 0),
    cornerRadius:    Math.max(0, parseFloat(inputs.cornerRadius) || 0),
    strokeWidth:     Math.max(0, parseFloat(inputs.strokeWidth) || 0),
    strokeColor:     isValidHex(inputs.strokeColor) ? inputs.strokeColor : '#ffffff',
    surface:         guardBg,
  };

  const lay = computeLayout(W, H, title, subtitle);
  const chartBgFill = inputs.transparentBg ? 'none' : bgColor;

  let body = '';
  if      (chartType === 'vertical-bar')   body = verticalBars(items, lay, cfg);
  else if (chartType === 'horizontal-bar') body = horizontalBars(items, lay, cfg);
  else if (chartType === 'donut')          body = pieDonut(items, lay, true,  cfg);
  else if (chartType === 'pie')            body = pieDonut(items, lay, false, cfg);
  else if (chartType === 'stacked')        body = stackedBar(items, lay, cfg);

  // Wrap the chart body so a click on any mark/label/legend jumps to the data blocks.
  return { chartSvg: titleSvg(title, subtitle, textColor) + '<g data-canvas-input="data">' + body + '</g>', chartBgFill, mdSource: chartMd(title, subtitle, items) };
}

// The `md` export: heading/subheading + the chart's data as a Markdown table.
function mdCell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function chartMd(title, subtitle, items) {
  const out = [];
  if (title) out.push('# ' + title);
  if (subtitle) out.push('_' + subtitle + '_');
  if (items && items.length) {
    const lines = ['| Label | Value |', '| --- | ---: |'];
    for (const it of items) lines.push('| ' + mdCell(it.label) + ' | ' + mdCell(fmt(it.value)) + ' |');
    out.push(lines.join('\n'));
  }
  return out.join('\n\n') + '\n';
}

// ── hooks ─────────────────────────────────────────────────────────────────────

function getInputs(model) {
  return Object.fromEntries(model.map(i => [i.id, i.value]));
}

async function onInit({ model }) {
  SERIES = await resolveSeriesPalette();
  return buildChart(getInputs(model));
}
function onInput({ model }) { return buildChart(getInputs(model)); }
