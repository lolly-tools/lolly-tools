/**
 * Slides — hooks.
 *
 * Each slide (a Lolly "blocks" item) is one absolutely-positioned, full-frame
 * [data-pdf-page] layer. The slides share ONE timeline: a later slide animates IN
 * over the one before it (a cover transition — no blank gaps), and the last one
 * rests as the end card. The hook generates the per-slide @keyframes + the
 * animation bindings as a <style> string ({{{animCss}}}) inside the template,
 * because the timeline depends on the slide count.
 *
 * The deck is ONE DOM shape serving two contradictory export families, reconciled
 * by a class swap in beforeExport (the digi-ad idiom):
 *
 *   pdf / pptx  →  .sl-static — every stacked slide opaque and motionless. Both
 *       walkers measure a page against its OWN rect and descend only its OWN
 *       subtree, so overlapping siblings can't contaminate a page; but a slide left
 *       hidden is DROPPED, and pptx still emits it — blank. So: all of them, shown.
 *   gif / mp4 / webm  →  .sl-anim — the deck plays, and the clip is timed off the
 *       authored timeline (see beforeExport).
 *
 * All motion is the parent's own CSS: the export bridge freezes every <video> to a
 * still for the whole capture, and a gif/Lottie in an <img> exports as a still, so
 * a composed child NEVER animates inside the deck's clip.
 *
 * The template ships no client-side JS — the animation is pure CSS, identical
 * across the live preview and frame-by-frame capture. The one script-ish thing is
 * the export frame clock, which is registered ONLY for the duration of a motion
 * export (see armFrameClock).
 */

var MAX_SLIDES = 40;   // soft cap — each slide is a layer + a keyframe block
var MAX_BOXES = 120;   // per freeform slide — bounds the DOM a single slide can add
// The freeform box coordinate space: px on the tool's NATIVE render canvas. This is
// the exact canvas the on-slide overlay (deck-editor.ts) manipulates —
// manifest.render.width × render.height = 1920 × 1920 — so a box authored at (x,y)
// with size (w,h) in that space renders here at the SAME fraction of the slide. The
// two must stay in lock-step; the overlay divides by these same numbers.
var NATIVE_W = 1920;
var NATIVE_H = 1920;
var GIF_FPS = 15;      // the gif encoder's own fixed rate — it ignores opts.fps
var MAX_FRAMES = 595;  // the bridge truncates past 600 frames with only a warning
// How long opacity takes to arrive WHEN A TRANSFORM IS CARRYING THE ENTRANCE
// (slide/zoom). Kept short ON PURPOSE: a long opacity ramp leaves many muddy
// semi-transparent frames in gif/video exports, while translate/scale can take their
// time because they don't blend pixels. A plain fade has no transform, so opacity IS
// the transition and takes the whole length instead — see the split keyframes in
// buildAnimCss.
var OPACITY_SEC = 0.13;

// Layout value → the slot sub-fields it renders, in order.
var SLOTS_FOR = {
  title:  [],
  full:   ['media1'],
  hero:   ['media1'],
  split:  ['media1', 'media2'],
  stack:  ['media1', 'media2'],
  golden: ['media1', 'media2'],
  cols3:  ['media1', 'media2', 'media3'],
  grid4:  ['media1', 'media2', 'media3', 'media4']
};

var PAGED = { pdf: 1, pptx: 1 };            // one slide per [data-pdf-page], all shown
var CLIP  = { mp4: 1, webm: 1, gif: 1 };    // the deck plays and is captured frame by frame

// Entrance TRANSFORMS (opacity is decoupled — always a brief fade). Each value is
// the starting transform that eases to none over the transition length.
var DEFAULT_EASE = 'cubic-bezier(.22,.61,.36,1)';
var ENTER = {
  // 'none' = animation OFF (the default). For the timeline it behaves like a cut (no motion),
  // so a video export is still a plain held-slide slideshow; the STILLNESS of the preview comes
  // from the resting rootClass being sl-frozen (see compute), not from an empty timeline.
  none:  { from: 'none', cut: true },
  cut:   { from: 'none', cut: true },
  fade:  { from: 'none' },
  slide: { from: 'translateX(6%)' },
  zoom:  { from: 'scale(1.04)' }
};
function entrance(kind) {
  var e = ENTER[kind] || ENTER.fade;
  return { from: e.from, ease: e.ease || DEFAULT_EASE, cut: !!e.cut };
}

// Shared with beforeExport/afterExport, which only receive format/opts/node.
var _totalDuration = 6;   // the authored timeline, in wall-clock seconds
var _clipMs = 0;          // the exported clip's length in ms — what the frame clock seeks across
var _loop = 'loop';
var _savedClass = null;
var _clock = null;
var _theme = null;   // resolved brand tokens (readBrandTheme) — cached across onInput
var _logos = null;   // resolved logo variants (resolveLogos) — cached across onInput

// ── helpers ──────────────────────────────────────────────────────────────────

function toInputs(model) {
  var o = {};
  model.forEach(function (i) { o[i.id] = i.value; });
  return o;
}
function num(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
// === lolly:shared clamp — generated from community/_shared/math.js; edit there and run npm run sync:shared ===
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
// === /lolly:shared clamp ===
// === lolly:shared safeColor — generated from community/_shared/math.js; edit there and run npm run sync:shared ===
function safeColor(v, fallback) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i.test(s)) return s;
  if (/^[a-zA-Z]+$/.test(s)) return s; // named colour (e.g. "transparent", "tomato")
  return fallback;
}
// === /lolly:shared safeColor ===
function str(v) { return (typeof v === 'string') ? v : (v == null ? '' : String(v)); }
function f4(x) { return Math.round(x * 10000) / 10000; }
// HTML-escape any text reaching the template (logic-less Handlebars won't escape
// {{{ }}}, so the hook owns the escaping).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A resolved asset ref → its URL. The runtime resolves every block asset field
// before onInit, INCLUDING the tool-URL path (a Lolly tool link picked in the
// asset picker's Tools tab is rendered to an image and handed back here), so a
// slot is just a url. An unresolvable slot arrives empty and renders as a panel.
function refUrl(r) { return (r && typeof r === 'object' && typeof r.url === 'string') ? r.url : ''; }

// WCAG-ish luminance of a #hex, to pick a contrasting ink. A colour we can't
// measure (a hand-written URL can name one) is assumed dark, which is what most
// colour names are.
function relLum(hex) {
  var s = str(hex).replace('#', '');
  if (!/^[0-9a-fA-F]{3,8}$/.test(s)) return 0;
  var h = s.length === 3 ? s.replace(/(.)/g, '$1$1') : (s + '000000').slice(0, 6);
  function lin(i) { var v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}
function idealInk(hex) { return relLum(hex) < 0.5 ? '#ffffff' : '#141b2d'; }

// ── markdown → safe HTML ───────────────────────────────────────────────────────
// The content field is a plain markdown STRING. We NEVER hand raw HTML to the
// logic-less template: every text run is esc()'d FIRST, then only a fixed set of
// tags is introduced by operating on the already-escaped text — the doc-studio
// inline() discipline. This escape-first order is the entire security model: no
// piece of user text (cell, link text, list item, heading) can ever emit a live
// tag, so a `javascript:` URL or an `<img onerror>` in a cell is inert.
//
// Both slide modes (mdToParts for LAYOUT, mdBox for FREEFORM) share ONE block
// parser (renderBlocks) so they can't drift — they differ only in a class map and
// whether the first heading is lifted out as the slide title.

// A URL is safe only if it names an allowed scheme (http/https/mailto) or names no
// scheme at all (relative / scheme-relative / fragment / query). Everything else —
// javascript:, data:, vbscript:, file:, … — is dropped (the link renders as plain
// text). The probe strips control/whitespace chars first, so `java\tscript:` and
// friends can't smuggle a scheme past the test.
function safeUrl(u) {
  var s = str(u).trim();
  if (!s) return '';
  var probe = s.replace(/&amp;/g, '&').replace(/[\u0000-\u0020]+/g, '');
  // No scheme, or begins with a path/anchor/query → relative-ish, allowed.
  if (/^(\/\/|\/|\.|#|\?)/.test(probe) || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(probe)) return s;
  // Has an explicit scheme → only the three safe ones survive.
  return /^(https?|mailto):/i.test(probe) ? s : '';
}

// Inline markdown on ONE run of already-user text. esc() runs first; every tag we
// add wraps escaped content, so nothing executable can appear. Order: pull code
// spans out to placeholders (their content stays literal), drop image markup to its
// alt text (media is a slot/box field, not inline), linkify with the URL allowlist,
// then emphasis, then restore the code spans.
function inlineMd(s) {
  var e = esc(s);
  var codes = [];
  e = e.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  e = e.replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1');   // ![alt](url) → alt (images are fields, not inline)
  e = e.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, text, url) {
    var safe = safeUrl(url);
    return safe ? '<a href="' + safe + '">' + text + '</a>' : text;   // unsafe scheme → text only, no href
  });
  e = e.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  e = e.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  e = e.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[+i] + '</code>'; });
  return e;
}

// ── table + list block helpers (shared by both modes) ──────────────────────────
// Split a pipe row into trimmed cells, stripping the optional outer pipes.
function splitRow(line) {
  return str(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
}
// A separator row: `| :--- | ---: |`. Must contain a pipe (so a bare `---` HR/slide
// rule is never mistaken for one) and every cell is dashes with optional `:` ends.
function isSepRow(line) {
  var t = str(line).trim();
  if (t.indexOf('|') < 0) return false;
  var cells = splitRow(t);
  return cells.length > 0 && cells.every(function (c) { return /^:?-{1,}:?$/.test(c.trim()); });
}
// A separator cell → its column alignment. `:--`=left, `--:`=right, `:-:`=center,
// `--`=none (natural left, no inline style emitted).
function alignOf(c) {
  c = str(c).trim();
  var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
  return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
}
// Read a table starting at `start` (header row; start+1 is the separator). Returns
// the HTML and the index of the LAST consumed line. Every cell goes through
// inlineMd (escaped). Ragged body rows are padded/truncated to the header's columns.
function readTable(lines, start, cls) {
  var header = splitRow(lines[start]);
  var seps = splitRow(lines[start + 1]);
  var ncol = header.length, aligns = [];
  for (var c = 0; c < ncol; c++) aligns.push(alignOf(seps[c] || ''));
  function cellRow(cells, tag) {
    var s = '<tr>';
    for (var k = 0; k < ncol; k++) {
      var a = aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '';
      s += '<' + tag + a + '>' + inlineMd(cells[k] != null ? cells[k] : '') + '</' + tag + '>';
    }
    return s + '</tr>';
  }
  var html = '<table' + cls.table + '><thead>' + cellRow(header, 'th') + '</thead><tbody>';
  var j = start + 2;
  for (; j < lines.length; j++) {
    var t = lines[j].trim();
    if (!t || t.indexOf('|') < 0) break;   // table ends at a blank / non-pipe line
    html += cellRow(splitRow(t), 'td');
  }
  return { html: html + '</tbody></table>', next: j - 1 };
}
// A list-item line (indentation preserved for nesting). A tab counts as one level
// (== 2 spaces). Returns null for a non-item line.
function listItem(raw) {
  var m = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(raw);
  if (!m) return null;
  return { width: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] };
}
// Render a run of list items into nested <ul>/<ol> using an indent stack: a deeper
// item opens a list INSIDE the still-open previous <li>; a shallower one pops back.
// Absolute indent is only ever compared relatively, so 2- and 4-space (and ragged)
// indentation both nest sensibly and it never throws.
function renderList(items, cls) {
  var out = '', stack = [];   // stack: { width, tag }
  for (var i = 0; i < items.length; i++) {
    var it = items[i], tag = it.ordered ? 'ol' : 'ul', open = it.ordered ? cls.ol : cls.ul;
    if (!stack.length) {
      out += '<' + tag + open + '>'; stack.push({ width: it.width, tag: tag });
    } else if (it.width > stack[stack.length - 1].width) {
      out += '<' + tag + open + '>'; stack.push({ width: it.width, tag: tag });   // deeper → nest
    } else {
      out += '</li>';                                                             // close previous item
      while (stack.length > 1 && it.width < stack[stack.length - 1].width) {
        out += '</' + stack.pop().tag + '></li>';                                 // pop deeper levels
      }
    }
    out += '<li>' + inlineMd(it.text);   // <li> left open — closed on dedent or at the end
  }
  while (stack.length) out += '</li></' + stack.pop().tag + '>';
  return out;
}

// The one block parser. `cls` supplies the class attribute for each block; `cls.h`
// is a function of the heading level. When `extractTitle` is set the first heading
// (any level) is lifted out as the slide title instead of emitted inline. Blocks:
// pipe tables, headings, ordered/unordered (nested) lists, and paragraphs.
function renderBlocks(md, cls, extractTitle) {
  var lines = str(md).replace(/\r/g, '').split('\n');
  var out = '', title = '', paraBuf = [], listBuf = [];
  function flushPara() {
    if (paraBuf.length) { out += '<p' + cls.p + '>' + paraBuf.map(inlineMd).join('<br>') + '</p>'; paraBuf = []; }
  }
  function flushList() { if (listBuf.length) { out += renderList(listBuf, cls); listBuf = []; } }
  function flush() { flushPara(); flushList(); }
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i], t = raw.trim();
    if (!t) { flush(); continue; }

    // Table: a pipe header immediately followed by a separator row.
    if (t.indexOf('|') >= 0 && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      flush();
      var tbl = readTable(lines, i, cls);
      out += tbl.html; i = tbl.next; continue;
    }
    // Heading (# / ## / ###). The first, when extracting, becomes the title.
    var h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      var lvl = h[1].length, txt = inlineMd(h[2].replace(/\s+#+\s*$/, ''));
      if (extractTitle && !title) { title = txt; continue; }
      out += '<h' + lvl + cls.h(lvl) + '>' + txt + '</h' + lvl + '>';
      continue;
    }
    // List item (indentation preserved — buffered so a whole run nests together).
    var li = listItem(raw);
    if (li) { flushPara(); listBuf.push(li); continue; }
    // Anything else is paragraph text.
    flushList();
    paraBuf.push(t);
  }
  flush();
  return { title: title, body: out };
}

// LAYOUT slides carry the sl-* classes (cqmin scale); the first heading is the
// title. FREEFORM boxes use bare tags styled off .sl-box-text (em scale) with every
// heading kept inline. Both run the identical parser above.
var CLS_LAYOUT = {
  p: ' class="sl-p"', ul: ' class="sl-ul"', ol: ' class="sl-ol"', table: ' class="sl-table"',
  h: function (lvl) { return ' class="sl-h sl-h' + lvl + '"'; }
};
var CLS_BOX = { p: '', ul: '', ol: '', table: '', h: function () { return ''; } };
function mdToParts(md) {
  var r = renderBlocks(md, CLS_LAYOUT, true);
  return { titleHtml: r.title, bodyHtml: r.body };
}
function mdBox(md) { return renderBlocks(md, CLS_BOX, false).body; }

// ── freeform boxes ──────────────────────────────────────────────────────────────
// A freeform slide carries a `boxes` array — the flat records the overlay drags
// around. The value arrives EITHER as a real array (overlay set it in-memory) OR as
// a JSON string (the declared `text` sub-field, so it round-trips through URL/session
// state). Tolerate both; anything malformed renders as an empty canvas, never throws.
function parseBoxes(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    var s = v.trim();
    if (!s) return [];
    try { var p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch (e) { return []; }
  }
  return [];
}
// A box `src` is a resolved URL string, or a {url} asset ref (the engine does NOT
// auto-resolve refs nested inside a box — only DECLARED asset sub-fields — so the
// overlay hands us a URL). Only known-safe schemes reach an <img src>.
function boxUrl(src) {
  var s = (src && typeof src === 'object') ? refUrl(src) : str(src);
  s = s.trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return '';   // reject any other scheme (javascript:, etc.)
  return s;                                              // scheme-less: relative / same-origin path
}
// px on the 1920² native canvas → a % of the slide (which always fills the canvas).
function pctW(v) { return f4(num(v, 0) / NATIVE_W * 100) + '%'; }
function pctH(v) { return f4(num(v, 0) / NATIVE_H * 100) + '%'; }
var BOX_ALIGN = { l: 'left', left: 'left', c: 'center', center: 'center', centre: 'center', r: 'right', right: 'right' };
function boxAlign(v) { return BOX_ALIGN[str(v).toLowerCase()] || 'left'; }
// A kind:"box" is a plain filled shape (no text/image of its own). Its corner
// rounding and border MUST scale with the slide (the box is sized in % of the frame),
// so we express both in slide-relative units — cqw against the deck query container,
// exactly like box.fontSize — NOT fixed px. `radius` is authored in NATIVE px.
var BOX_SHAPES = { rect: 1, round: 1, pill: 1, ellipse: 1 };
function boxShape(v) { var s = str(v).toLowerCase(); return BOX_SHAPES[s] ? s : 'rect'; }
function boxRadiusCss(b) {
  var shape = boxShape(b.shape);
  if (shape === 'pill') return '9999px';               // stadium ends, size-independent
  if (shape === 'ellipse') return '50%';               // border-radius:50% draws an ellipse
  if (shape === 'round') {
    var r = Math.max(0, num(b.radius, 0));             // native px → slide-relative cqw
    return 'calc(' + f4(r / NATIVE_W * 100) + 'cqw)';
  }
  return '0';                                          // rect / absent → square corners
}
function boxBorderCss(b) {
  var lw = num(b.lineWidth, 0);
  var lc = safeColor(b.lineColor, '');
  // Border only when BOTH a valid colour and a positive width are given; width in cqw
  // so the stroke scales with the slide like everything else.
  if (lc && lw > 0) return 'border: ' + f4(lw / NATIVE_W * 100) + 'cqw solid ' + lc;
  return '';
}
function renderBoxes(raw) {
  var boxes = parseBoxes(raw).slice(0, MAX_BOXES);
  var out = [];
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i] || {};
    var kind = str(b.kind);
    var isBox = kind === 'box';
    var isImage = kind === 'image';
    var rot = num(b.rot, 0);
    var box = {
      isBox: isBox,
      isImage: isImage,
      kind: isBox ? 'box' : (isImage ? 'image' : 'text'),
      left: pctW(b.x), top: pctH(b.y), width: pctW(b.w), height: pctH(b.h),
      transform: (rot && isFinite(rot)) ? 'rotate(' + f4(rot) + 'deg)' : ''
    };
    if (isBox) {
      // A plain shape: solid fill (empty = transparent), slide-relative radius + border.
      // No markdown, no image — text/image layer as separate boxes above it (array
      // order is z-order). Every value is sanitised (safeColor / numeric coercion), so
      // nothing raw reaches the style attribute.
      box.fill = safeColor(b.fill, '');
      box.radiusCss = boxRadiusCss(b);
      box.borderCss = boxBorderCss(b);
      box.clipShape = (boxShape(b.shape) === 'ellipse');
    } else if (isImage) {
      box.url = boxUrl(b.src);
    } else {
      box.html = mdBox(str(b.text));
      box.color = safeColor(b.color, '');
      var fs = num(b.fontSize, 0);
      // font-size in cqw so it scales with the canvas exactly like the box geometry.
      box.fontSize = (fs > 0) ? f4(fs / NATIVE_W * 100) + 'cqw' : '';
      box.align = boxAlign(b.align);
    }
    out.push(box);
  }
  return out;
}

// ── brand theme (host.tokens → the 7 semantic colours) ─────────────────────────
// SUSE + blank profiles declare NO color.semantic slots, so the static fallbacks
// rule unless a brand fills them in. Everything guarded — older/headless shells
// and blank brands just get the fallbacks.
function isHexish(s) { return typeof s === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(s.trim()); }
function normHex(s) { s = str(s).trim(); return /^[0-9a-fA-F]{3,8}$/.test(s) ? '#' + s : s; }
var THEME_FALLBACK = {
  primary: '#30ba78', onPrimary: '#ffffff', surface: '#ffffff', text: '#172029',
  secondary: '#2453ff', muted: '#6b7280', edge: '#e5e7eb'
};
async function readBrandTheme() {
  var T = {
    primary: THEME_FALLBACK.primary, onPrimary: THEME_FALLBACK.onPrimary, surface: THEME_FALLBACK.surface,
    text: THEME_FALLBACK.text, secondary: THEME_FALLBACK.secondary, muted: THEME_FALLBACK.muted, edge: THEME_FALLBACK.edge
  };
  try {
    if (typeof host === 'undefined' || !host || !host.tokens || !host.tokens.colors) return T;
    var byPath = {};
    var sw = (await host.tokens.colors({ theme: 'light' })) || [];
    for (var i = 0; i < sw.length; i++) { var s = sw[i]; if (s && typeof s.value === 'string') byPath[s.path] = s.value; }
    var map = {
      'color.semantic.primary': 'primary', 'color.semantic.secondary': 'secondary',
      'color.semantic.surface': 'surface', 'color.semantic.text': 'text',
      'color.semantic.on-primary': 'onPrimary', 'color.semantic.muted': 'muted', 'color.semantic.edge': 'edge'
    };
    for (var p in map) if (isHexish(byPath[p])) T[map[p]] = normHex(byPath[p]);
  } catch (e) { /* keep fallbacks */ }
  return T;
}

// ── named schemes: {bg, ink, accent} derived from the resolved brand tokens ────
var SCHEMES = { auto: 1, brand: 1, light: 1, dark: 1, primary: 1, accent: 1 };
function normScheme(v, dflt) { v = str(v); return SCHEMES[v] ? v : (dflt || 'auto'); }
// WCAG contrast — host.color.contrast when the shell offers it (v1.40+), else a
// luminance-ratio approximation, so we pick a legible ink either way.
function contrastOf(a, b) {
  try { if (typeof host !== 'undefined' && host && host.color && host.color.contrast) { var r = host.color.contrast(a, b); if (isFinite(r)) return r; } } catch (e) { /* fall through */ }
  var la = relLum(a), lb = relLum(b), hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
// Best legible ink for a background: the brand's light ink (surface) vs dark ink (text).
function pickInk(bg, T) {
  var light = T.surface || '#ffffff', dark = T.text || '#172029';
  return contrastOf(light, bg) >= contrastOf(dark, bg) ? light : dark;
}
function schemeColors(name, T) {
  switch (name) {
    case 'dark':    return { bg: T.text,      ink: T.surface,            accent: T.secondary };
    case 'primary': return { bg: T.primary,   ink: T.onPrimary,          accent: T.secondary };
    case 'accent':  return { bg: T.secondary, ink: pickInk(T.secondary, T), accent: T.primary };
    default:        return { bg: T.surface,   ink: T.text,               accent: T.primary };  // auto / brand / light
  }
}

// ── brand logo (host.assets — light/dark + colour/mono variant per slide) ──────
// Mirrors deck-studio resolveLogos: query by TAGS (portable across brands that
// follow the convention), identify the mono variant by its `mono` tag, and read
// each SVG's true aspect from its viewBox so a wide lockup is never clipped. Blank
// brands with no logo asset get nothing (guarded everywhere → no logo renders).
function hexToRgb(s) {
  s = str(s).trim();
  var m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  s = s.replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map(function (c) { return c + c; }).join('');
  if (/^[0-9a-fA-F]{6,8}$/.test(s)) return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  return null;
}
function bgIsDark(bg) {
  var rgb = hexToRgb(bg);
  if (!rgb) return relLum(bg) < 0.4;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) < 140;
}
var LOGO_MODES = { auto: 1, mono: 1, off: 1 };
function normLogo(v) { v = str(v); return LOGO_MODES[v] ? v : 'auto'; }
async function svgAspect(url) {
  try {
    var svg = '';
    if (url.indexOf('data:') === 0) {
      var comma = url.indexOf(','), meta = url.slice(5, comma), data = url.slice(comma + 1);
      svg = /base64/i.test(meta) ? (typeof atob !== 'undefined' ? atob(data) : '') : decodeURIComponent(data);
    } else if (typeof fetch !== 'undefined') {
      svg = await (await fetch(url)).text();
    }
    var vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg);
    if (vb) { var pp = vb[1].trim().split(/[\s,]+/); var w = +pp[2], h = +pp[3]; if (w > 0 && h > 0) return w / h; }
  } catch (e) { /* fall back to metadata / default */ }
  return null;
}
async function resolveLogos() {
  var out = { onLight: { color: null, mono: null }, onDark: { color: null, mono: null } };
  try {
    if (typeof host === 'undefined' || !host || !host.assets || !host.assets.query) return out;
    async function q(tags) { try { return (await host.assets.query({ type: 'vector', tags: tags })) || []; } catch (e) { return []; } }
    async function resolve(ref) {
      if (!ref) return null;
      var url = ref.url, w = ref.width, h = ref.height;
      if ((!url || !w) && host.assets.get) {
        try { var full = await host.assets.get(ref.id); if (full) { url = full.url || url; w = full.width || w; h = full.height || h; } } catch (e) { /* keep what we have */ }
      }
      if (typeof url !== 'string' || !url) return null;
      var asp = (await svgAspect(url)) || (w && h ? w / h : 3.4);
      return { url: url, aspect: asp };
    }
    var sides = [['onLight', 'on-light'], ['onDark', 'on-dark']];
    for (var i = 0; i < sides.length; i++) {
      var key = sides[i][0], on = sides[i][1];
      var all = await q(['logo', on, 'horizontal']);
      if (!all.length) all = await q(['logo', on]);
      var monoList = await q(['logo', on, 'mono', 'horizontal']);
      if (!monoList.length) monoList = await q(['logo', on, 'mono']);
      var mono = monoList[0] || null, color = null;
      for (var k = 0; k < all.length; k++) { if (!mono || all[k].id !== mono.id) { color = all[k]; break; } }
      if (!color) color = all[0] || null;
      out[key].color = await resolve(color);
      out[key].mono = (await resolve(mono)) || out[key].color;
    }
  } catch (e) { /* no logos — decks just render without one */ }
  return out;
}
function pickLogo(logos, darkBg, mono) {
  if (!logos) return null;
  var g = darkBg ? logos.onDark : logos.onLight;
  return mono ? (g.mono || g.color) : (g.color || g.mono);
}

// ── the work ─────────────────────────────────────────────────────────────────

/**
 * Per-slide @keyframes on the shared timeline, plus the .sl-anim play bindings and
 * the .sl-frozen hold. Slide 0 is the static base layer (styles.css keeps it at
 * opacity 1), so only 1..n-1 animate.
 */
function buildAnimCss(n, startS, inS, R, T, motion, loop, focusIdx) {
  var iter = (loop === 'once') ? '1' : 'infinite';
  var e = entrance(motion);
  var keyframes = [];
  var bindings = [];

  for (var k = 1; k < n; k++) {
    var pStart = f4(startS[k] / R * 100);            // the slide starts arriving
    var pIn = f4((startS[k] + inS[k]) / R * 100);    // the transform has settled
    // Two decoupled tracks on the shared timeline. When a TRANSFORM carries the
    // entrance (slide/zoom) it eases from → none over the whole length while opacity
    // ramps 0→1 in a short window on top, so it never lingers. A fade has no
    // transform, so opacity IS the entrance and takes the whole length — capping it
    // would leave "Transition length" doing nothing for the default transition. A cut
    // is a near-instant flash either way.
    var opSec = e.cut ? Math.min(inS[k], 0.04)
      : (e.from === 'none') ? inS[k]
      : Math.min(inS[k], OPACITY_SEC);
    var pOp = f4((startS[k] + opSec) / R * 100);
    keyframes.push(
      '@keyframes slO' + k + '{' +
        '0%{opacity:0}' + pStart + '%{opacity:0;animation-timing-function:ease-out}' +
        pOp + '%{opacity:1}100%{opacity:1}}'
    );
    var anim = 'slO' + k + ' ' + T + 's ' + iter + ' both linear';
    if (e.from !== 'none') {
      keyframes.push(
        '@keyframes slT' + k + '{' +
          '0%{transform:' + e.from + '}' +
          pStart + '%{transform:' + e.from + ';animation-timing-function:' + e.ease + '}' +
          pIn + '%{transform:none}100%{transform:none}}'
      );
      anim += ',slT' + k + ' ' + T + 's ' + iter + ' both linear';
    }
    bindings.push('.slides.sl-anim .sl-slide--' + k + '{animation:' + anim + '}');
  }

  // Editor freeze — hold the slide being edited (styles.css hides the rest).
  var freeze = (focusIdx >= 0)
    ? '.slides.sl-frozen .sl-slide--' + focusIdx + '{opacity:1!important}'
    : '';

  return keyframes.join('') + bindings.join('') + freeze;
}

// Bottom-corner furniture (per slide): the brand logo (bottom-left, light/dark or
// mono, per-slide override) and the page number (bottom-right). Both are REAL slide
// content — they export (never [data-export-hide]). The logo box is sized in cqh
// (share of the slide height) so it scales with any deck size; ~4cqh (SMALLER than
// deck-studio's 5.5%). Width follows the SVG's real aspect so a wide lockup fits
// `contain` without clipping.
function furniture(bg, row, theme, logos, pageNumbers, brandLogo, index, scheme) {
  var out = { logo: null, showPageNo: false, pageNo: index + 1 };
  out.showPageNo = !!pageNumbers;
  var mode = normLogo(row.logo);
  // On the accent scheme the background IS the brand accent/secondary — which in most brands
  // is (or is close to) the logomark colour, so a colour logo would clash or vanish into it.
  // Force the mono variant there (unless the slide explicitly turned the logo off).
  var useMono = (mode === 'mono') || (scheme === 'accent');
  if (brandLogo && mode !== 'off' && logos) {
    var v = pickLogo(logos, bgIsDark(bg), useMono);
    if (v && v.url) {
      var aspect = (v.aspect && isFinite(v.aspect) && v.aspect > 0) ? v.aspect : 3.4;
      out.logo = { url: v.url, w: f4(4 * aspect) + 'cqh', h: '4cqh' };
    }
  }
  return out;
}

function compute(model, theme, logos) {
  var inputs = toInputs(model);
  // Animation is OFF by default: an unset transition means "none" (a still deck), not "fade".
  var motion = str(inputs.transition) || 'none';
  var animOff = (motion === 'none');
  var speed = clamp(num(inputs.transitionSpeed, 0.5), 0.1, 1.5);
  var hold = clamp(num(inputs.slideDuration, 3), 0.5, 20);
  var focus = Math.round(num(inputs.focusSlide, 0));
  _loop = str(inputs.loop) || 'loop';

  var deckTheme = normScheme(inputs.theme, 'auto');
  var pageNumbers = inputs.pageNumbers !== false;   // default on
  var brandLogo = inputs.brandLogo !== false;       // default on
  var T = theme || THEME_FALLBACK;

  var all = Array.isArray(inputs.deck) ? inputs.deck : [];
  var rows = all.slice(0, MAX_SLIDES);
  if (all.length > MAX_SLIDES && host.log) {
    host.log('warn', 'deck-builder: slide count capped', { max: MAX_SLIDES, requested: all.length });
  }
  var n = rows.length;
  if (!n) {
    _totalDuration = 1;
    return { pages: [], animCss: '', rootClass: 'sl-anim', durSec: 1, slideCount: 0 };
  }

  // Timeline: slide i arrives at startS[i] over inS[i], then holds. Cover model —
  // it stays visible (covered by later slides) so there are no blank gaps.
  var inS = [], startS = [], acc = 0;
  for (var i = 0; i < n; i++) {
    inS[i] = (i === 0) ? 0 : speed;   // the first slide is simply there
    startS[i] = acc;
    acc += inS[i] + hold;
  }
  var R = acc || 1;
  var TT = f4(R);
  _totalDuration = TT;

  // The engine applies NO defaults to block sub-fields — every one is defended here.
  var pages = [];
  for (var k = 0; k < n; k++) {
    var row = rows[k] || {};
    var isFreeform = str(row.mode) === 'freeform';
    var layout = isFreeform ? 'freeform' : (SLOTS_FOR[str(row.layout)] ? str(row.layout) : 'title');

    // Scheme + chrome are shared by BOTH modes: a freeform slide still gets the
    // brand theme bg/ink and the logo/page-number furniture.
    var slideTheme = str(row.theme);
    var scheme = (slideTheme && slideTheme !== 'auto' && SCHEMES[slideTheme]) ? slideTheme : deckTheme;
    var sc = schemeColors(scheme, T);
    var bg = sc.bg, ink = sc.ink, accent = sc.accent;
    // Per-slide background override (empty = keep the scheme bg); re-pick a legible ink.
    var over = safeColor(row.bg, '');
    if (over) { bg = over; ink = pickInk(bg, T); }

    var f = furniture(bg, row, T, logos, pageNumbers, brandLogo, k, scheme);
    var page = {
      idx: k,
      layout: layout,
      isFreeform: isFreeform,
      bg: bg,
      ink: ink,
      accent: accent,
      notes: str(row.notes),
      logo: f.logo,
      showPageNo: f.showPageNo,
      pageNo: f.pageNo
    };

    if (isFreeform) {
      page.boxes = renderBoxes(row.boxes);
      // Layout-only keys stay falsy so the template's {{#if}} chrome collapses.
      page.titleHtml = ''; page.bodyHtml = '';
      page.hasHead = false; page.hasBody = false;
      page.slots = []; page.slotCount = 0;
    } else {
      var parts = mdToParts(row.content);
      var slots = [];
      var fields = SLOTS_FOR[layout];
      for (var s = 0; s < fields.length; s++) {
        slots.push({ n: s + 1, url: refUrl(row[fields[s]]) });
      }
      page.boxes = [];
      page.titleHtml = parts.titleHtml;
      page.bodyHtml = parts.bodyHtml;
      page.hasHead = !!parts.titleHtml;
      page.hasBody = !!parts.bodyHtml;
      page.slots = slots;
      page.slotCount = slots.length;
    }
    pages.push(page);
  }

  // "Pause on slide" freezes the preview on one slide. With animation OFF (the default) the
  // preview NEVER auto-plays: an unfocused deck rests on the first slide, static. With a
  // transition chosen, an unfocused deck plays (opt-in); the editor filmstrip sets focusSlide
  // per active slide, so the editing surface stays still either way.
  var focusIdx = (focus > 0) ? clamp(focus - 1, 0, n - 1) : (animOff ? 0 : -1);

  // The returned keys (pages/animCss/rootClass/durSec/slideCount) must never collide
  // with an input id — a match would overwrite that INPUT instead of landing in
  // extras. The blocks input is `deck` precisely so `pages` stays free.
  return {
    pages: pages,
    animCss: buildAnimCss(n, startS, inS, R, TT, motion, _loop, focusIdx),
    // Animation off (default) OR a slide focused → the resting preview is STILL (sl-frozen).
    // Only an explicit transition + no focus lets the preview auto-play. Video export forces
    // sl-anim in beforeExport regardless, so exports still animate when a transition is set.
    rootClass: (animOff || focusIdx >= 0) ? 'sl-frozen' : 'sl-anim',
    durSec: TT,
    slideCount: n
  };
}

// onInit is async: resolve the brand tokens + logo assets once, cache them, and
// reuse across the (synchronous) onInput re-renders as the user edits.
async function onInit(ctx) {
  _theme = await readBrandTheme();
  _logos = await resolveLogos();
  return compute(ctx.model, _theme, _logos);
}
function onInput(ctx) { return compute(ctx.model, _theme || THEME_FALLBACK, _logos); }

// ── export ───────────────────────────────────────────────────────────────────

/**
 * Register the deterministic export frame clock.
 *
 * The capture loop re-serialises the whole node once per frame and hands frame()
 * a normalised time t — but it only USES that t when a <canvas> inside the node
 * carries __lollyFrameRender. Without one, capture happens at serialisation speed
 * while the encoder replays at a fixed fps, so the authored "seconds per slide" and
 * "transition length" are simply ignored and the clip drifts. So we seek the deck
 * ourselves: pause every animation and pin it to t's exact millisecond. A PAUSED
 * animation has a stable computed style, which is what the serialiser copies onto
 * its clone — more reliable than sampling a live, mid-flight phase.
 *
 * Degrades to the wall-clock path both ways. Without Web Animations there is no
 * clock at all (frame() falls back to real-time capture — digi-ad's shipping
 * behaviour), and if the seek ever throws mid-capture the animations are simply
 * left running, which is the same fallback. The CSS timeline stays the single
 * source of truth either way; the clock only ever reads it.
 */
function armFrameClock(root) {
  var canvas = root.querySelector('[data-slide-clock]');
  if (!canvas || typeof root.getAnimations !== 'function') return;
  _clock = canvas;
  canvas.__lollyFrameRender = function (t) {
    try {
      var ms = t * _clipMs;
      var anims = root.getAnimations({ subtree: true });
      for (var i = 0; i < anims.length; i++) {
        anims[i].pause();
        anims[i].currentTime = ms;
      }
    } catch (e) {
      // Leave them running — the frame captures the wall-clock phase instead.
    }
  };
}

function beforeExport(ctx) {
  var root = ctx.node && ctx.node.querySelector && ctx.node.querySelector('.slides');
  if (!root) return;
  _savedClass = root.className;
  var fmt = ctx.format;

  if (PAGED[fmt]) {
    // Every stacked slide opaque + motionless, or pptx emits blank slides.
    root.classList.remove('sl-anim', 'sl-frozen');
    root.classList.add('sl-static');
    return;
  }
  if (!CLIP[fmt]) return;

  // Exports always play, even when the preview is frozen on a slide for editing.
  root.classList.remove('sl-static', 'sl-frozen');
  root.classList.add('sl-anim');
  // Deterministic restart at t=0: freeze (animation:none) → reflow → unfreeze →
  // reflow re-arms the named animations from the start, so the clip opens cleanly.
  root.classList.add('sl-restart'); void root.offsetWidth;
  root.classList.remove('sl-restart'); void root.offsetWidth;

  ctx.opts.wait = 0;                  // the animation is already running
  // The timeline IS the clip length — but the bridge truncates past 600 frames with
  // only a warning, so clamp the seconds ourselves and say so. gif encodes at its
  // own fixed rate; video honours the export bar's fps.
  var fps = (fmt === 'gif') ? GIF_FPS : ((ctx.opts.fps > 0) ? ctx.opts.fps : 24);
  var cap = Math.floor(MAX_FRAMES / fps);
  var clip = Math.min(_totalDuration, cap);
  ctx.opts.duration = clip;
  if (cap < _totalDuration && host.log) {
    host.log('warn', 'slides: clip clamped to ' + cap + 's of a ' + _totalDuration +
      's deck (the exporter\'s 600-frame ceiling) — shorten the deck, or drop "Seconds per slide", to fit it all in.');
  }
  // Loop count (gifenc repeat semantics: -1 once, 0 forever).
  ctx.opts.repeat = (_loop === 'once') ? -1 : 0;

  // The clock seeks across the CLIP, not the whole timeline: when the deck is longer
  // than the ceiling the clip is truncated at its authored speed, rather than the
  // whole deck being silently squeezed into the frames that fit.
  _clipMs = clip * 1000;
  armFrameClock(root);
}

function afterExport(ctx) {
  if (_clock) {
    try { delete _clock.__lollyFrameRender; } catch (e) { _clock.__lollyFrameRender = undefined; }
    _clock = null;
  }
  var root = ctx.node && ctx.node.querySelector && ctx.node.querySelector('.slides');
  if (root) {
    if (_savedClass != null) root.className = _savedClass;
    // The frame clock left every animation paused on the last captured frame, and
    // restoring a class the export never changed wouldn't re-arm them. Destroy and
    // rebuild them with the same reflow toggle, so the preview is handed back playing.
    root.classList.add('sl-restart'); void root.offsetWidth;
    root.classList.remove('sl-restart'); void root.offsetWidth;
  }
  _savedClass = null;
}
