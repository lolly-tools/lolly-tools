// Deck Studio — turn a simple slide spec (the block builder OR a pasted JSON deck) into
// ONE px-positioned element list per slide, then render that same list two ways:
//   • an HTML preview (a [data-pdf-page] section per slide) for the canvas + PDF/PNG export
//   • a native PowerPoint model in <script data-pptx-deck> (editable text/tables/theme)
// Because both outputs derive from the SAME element list, the preview can't drift from the
// .pptx. The engine's export-pptx bridge lowers the model (px→EMU, css→hex); this hook
// never touches the DOM. Charts/diagrams are composed from OTHER Lolly tools: a tool link
// dropped into a `visual` asset slot is resolved to an image URL by the runtime before
// onInit, so we just read its .url.

// ─── tiny helpers ─────────────────────────────────────────────────────────────
function str(v) { return v == null ? '' : String(v); }
function htmlEsc(s) { return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// JSON safe to drop verbatim into <script type="application/json">: kill the only
// tag-closing sequence ("</script") by escaping '<', plus the JS line terminators.
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function isHexish(s) { return typeof s === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(s.trim()); }
// Normalise a hex colour to always carry '#': the engine's deckColor accepts bare hex but
// a CSS `background:ff0000` in the preview is invalid, so the two would drift. '#' in front
// makes both agree. Idempotent for values that already have one.
function normHex(s) { s = str(s).trim(); return /^[0-9a-fA-F]{3,8}$/.test(s) ? '#' + s : s; }

var SIZES = { wide: [1280, 720], classic: [1280, 960], square: [1080, 1080], story: [720, 1280] };

// ─── brand theme (host.tokens → hex colours + font) ───────────────────────────
// colours: swatch.value is ALWAYS hex; read by path. font: resolve('{font.brand}').
// Everything guarded — headless/older shells and the blank profile just get fallbacks.
async function readBrandTheme() {
  var T = { primary: '#0c322c', accent: '#30ba78', dark: '#1b1b1b', light: '#ffffff', font: 'SUSE', mono: 'SUSE Mono' };
  try {
    if (typeof host === 'undefined' || !host || !host.tokens) return T;
    if (host.tokens.colors) {
      var byPath = {};
      var sw = (await host.tokens.colors({ theme: 'light' })) || [];
      for (var i = 0; i < sw.length; i++) { var s = sw[i]; if (s && typeof s.value === 'string') byPath[s.path] = s.value; }
      if (isHexish(byPath['color.semantic.primary'])) T.primary = byPath['color.semantic.primary'];
      if (isHexish(byPath['color.semantic.secondary'])) T.accent = byPath['color.semantic.secondary'];
      if (isHexish(byPath['color.semantic.text'])) T.dark = byPath['color.semantic.text'];
      if (isHexish(byPath['color.semantic.surface'])) T.light = byPath['color.semantic.surface'];
    }
    if (host.tokens.resolve) {
      var valid = function (v) { return typeof v === 'string' && v && v.indexOf('{') !== 0; };
      var f = await host.tokens.resolve('{font.brand}'); if (valid(f)) { T.font = f; T.mono = f; }
      var fm = await host.tokens.resolve('{font.mono}'); if (valid(fm)) T.mono = fm;
    }
  } catch (e) { /* keep fallbacks */ }
  return T;
}
// The DrawingML theme (values) the engine threads into the .pptx.
function pptxTheme(T) {
  return { name: 'Brand', colors: { dk1: '#000000', lt1: T.light, dk2: T.primary, accent1: T.accent, accent2: T.primary, hlink: T.accent }, fonts: { major: T.font, minor: T.font } };
}

// ─── brand logo (host.assets — pick light/dark + colour/mono variant per slide) ─
// The active brand's logo is tagged in the catalog: logo + on-light|on-dark + optional
// mono + horizontal|vertical. We query by those TAGS (portable across brands that follow
// the convention) and identify the colour vs mono variant by id (the mono one carries the
// `mono` tag, so it's the query result WITH it; the colour one is the other). Blank brands
// with no logo asset just get nothing (guarded everywhere).
// A logo SVG's true width/height ratio, read from its viewBox — the catalog carries no
// dimensions, so a fallback ratio would clip a wide lockup. Handles a data: URI (what
// get() returns headless) and a plain url (fetched in the browser).
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
    if (vb) { var p = vb[1].trim().split(/[\s,]+/); var w = +p[2], h = +p[3]; if (w > 0 && h > 0) return w / h; }
  } catch (e) { /* fall back to metadata / default */ }
  return null;
}
async function resolveLogos() {
  var out = { onLight: { color: null, mono: null }, onDark: { color: null, mono: null } };
  try {
    if (typeof host === 'undefined' || !host || !host.assets || !host.assets.query) return out;
    async function q(tags) { try { return (await host.assets.query({ type: 'vector', tags: tags })) || []; } catch (e) { return []; } }
    // query() results may carry no url (some shells return metadata only — the real url
    // comes from get()). Always resolve the chosen id to a fetchable url + its real aspect.
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
      var mono = monoList[0] || null;
      var color = null;
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

// Luminance of a slide background (solid or the first gradient stop) → is it dark?
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
  var c = typeof bg === 'string' ? bg : (bg && bg.grad && bg.grad.stops && bg.grad.stops[0] && bg.grad.stops[0].color);
  var rgb = hexToRgb(c);
  if (!rgb) return false;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) < 140;
}

// ─── input → slide-content[] ──────────────────────────────────────────────────
// slide-content: { layout, title, subtitle, body, table?, image?, accent?, notes }
function refUrl(r) { return r && typeof r === 'object' && typeof r.url === 'string' ? r.url : (typeof r === 'string' ? r : ''); }
var LAYOUTS = { title: 1, section: 1, agenda: 1, content: 1, 'two-col': 1, split: 1, table: 1, visual: 1, 'full-image': 1, quote: 1 };
var LOGO_MODES = { auto: 1, mono: 1, off: 1 };
function normLogo(v) { v = str(v); return LOGO_MODES[v] ? v : 'auto'; }
function normLayout(v) { v = str(v); return LAYOUTS[v] ? v : 'content'; }

// Pull a Markdown table and/or image out of a body blob (what mdPaste dumps in as raw
// text) so they render as a real table / picture instead of literal text. Returns the
// remaining prose as `text`, the table rows as `tableSrc`, and the first image url.
function splitMarkdownBody(body) {
  var lines = str(body).replace(/\r/g, '').split('\n');
  var text = [], pipes = [], image = '';
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i], t = l.trim();
    var im = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/.exec(t);
    if (im && !image) {
      image = im[1];
      var rest = t.replace(/!\[[^\]]*\]\([^)]*\)/, '').trim();
      if (rest) text.push(rest);
      continue;
    }
    if (t.indexOf('|') !== -1) { pipes.push(l); continue; }
    text.push(l);
  }
  var tableSrc = pipes.length >= 2 ? pipes.join('\n') : '';
  if (!tableSrc && pipes.length) text = text.concat(pipes); // a lone pipe line is just prose
  return { text: text.join('\n'), tableSrc: tableSrc, image: image };
}
// Given a base layout + what a body actually contains, pick the layout that renders it.
// Only promotes the DEFAULT 'content' layout (an explicit choice is always respected).
function autoLayout(layout, md, image) {
  if (layout !== 'content') return layout;
  if (md.tableSrc) return 'table';
  if (image) return md.text.trim() ? 'split' : 'visual';
  return 'content';
}

function blockToContent(row) {
  row = row || {};
  var md = splitMarkdownBody(row.body);
  var image = refUrl(row.visual || row.image) || md.image;
  return {
    layout: autoLayout(normLayout(row.layout), md, image),
    title: str(row.heading || row.title),
    subtitle: str(row.subtitle),
    body: md.text,
    tableSrc: str(row.data) || md.tableSrc,
    image: image,
    accent: isHexish(row.accent) ? normHex(row.accent) : '',
    logo: normLogo(row.logo),
    notes: str(row.notes),
  };
}
// A pasted JSON deck. Accepts { slides:[…] } or a bare array. Each slide mirrors the
// block fields; `bullets` (array) or `body` (string) both feed the body; `table` can be
// { headers, rows } or a CSV/markdown string; `image` is a url/data-uri.
function specToContent(slide) {
  slide = slide || {};
  var body = slide.body;
  if (Array.isArray(slide.bullets)) body = slide.bullets.map(function (b) { return str(b); }).join('\n');
  var md = splitMarkdownBody(body);
  var image = str(slide.image || slide.visual) || md.image;
  var tableSrc = typeof slide.table === 'string' ? slide.table : md.tableSrc;
  return {
    layout: autoLayout(normLayout(slide.layout), md, image),
    title: str(slide.title || slide.heading),
    subtitle: str(slide.subtitle),
    body: md.text,
    tableSrc: tableSrc,
    tableObj: slide.table && typeof slide.table === 'object' ? slide.table : null,
    image: image,
    accent: isHexish(slide.accent) ? normHex(slide.accent) : '',
    logo: normLogo(slide.logo),
    notes: str(slide.notes),
  };
}
// One Markdown chunk (one slide) → slide-content. First heading = title, a second
// heading = subtitle, the rest is the body (bullets + any table/image are pulled out).
function mdChunkToContent(chunk) {
  var lines = str(chunk).split('\n');
  var title = '', subtitle = '', bodyLines = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i], t = l.trim();
    var h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) {
      var htext = h[1].replace(/#+\s*$/, '').trim();
      if (!title) title = htext;
      else if (!subtitle) subtitle = htext;
      else bodyLines.push(l);
    } else bodyLines.push(l);
  }
  var md = splitMarkdownBody(bodyLines.join('\n'));
  return {
    layout: autoLayout('content', md, md.image),
    title: title, subtitle: subtitle,
    body: md.text, tableSrc: md.tableSrc, image: md.image,
    accent: '', logo: 'auto', notes: '',
  };
}
// A whole Markdown deck → slides. Splits on `---` slide breaks (Marp) when present,
// else before each top-level heading. Strips leading YAML/`---` frontmatter first.
function parseMarkdownDeck(text) {
  text = str(text).replace(/\r/g, '');
  text = text.replace(/^\s*---\n[\s\S]*?\n---\s*(\n|$)/, ''); // frontmatter
  var chunks;
  if (/\n-{3,}[ \t]*(\n|$)/.test(text)) {
    chunks = text.split(/\n-{3,}[ \t]*(?:\n|$)/);
  } else {
    chunks = [];
    var cur = '', lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (/^#{1,2}\s+/.test(lines[i]) && cur.trim()) { chunks.push(cur); cur = ''; }
      cur += lines[i] + '\n';
    }
    if (cur.trim()) chunks.push(cur);
  }
  var slides = [];
  for (var c = 0; c < chunks.length; c++) {
    if (str(chunks[c]).trim()) slides.push(mdChunkToContent(chunks[c]));
  }
  return slides.length ? slides : null;
}
// The `spec` field accepts EITHER a JSON deck OR raw Markdown. JSON wins when the text
// opens with { or [; otherwise it's parsed as a Markdown deck.
function parseSpec(specStr) {
  var s = str(specStr).trim();
  if (!s) return null;
  if (s.charAt(0) === '{' || s.charAt(0) === '[') {
    try {
      var doc = JSON.parse(s);
      var arr = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.slides) ? doc.slides : null);
      if (arr && arr.length) return { slides: arr.map(specToContent), size: doc && !Array.isArray(doc) ? str(doc.size) : '' };
    } catch (e) { /* not JSON after all — fall through to Markdown */ }
  }
  var md = parseMarkdownDeck(s);
  return md ? { slides: md, size: '' } : null;
}
function slidesFromInputs(model) {
  var spec = null, deck = [], size = '';
  for (var i = 0; i < model.length; i++) {
    var it = model[i];
    if (it.id === 'spec') spec = it.value;
    else if (it.id === 'deck') deck = Array.isArray(it.value) ? it.value : [];
    else if (it.id === 'size') size = str(it.value);
  }
  var parsed = parseSpec(spec);
  if (parsed) return { slides: parsed.slides, size: parsed.size || size };
  return { slides: deck.map(blockToContent), size: size };
}

// ─── inline text → runs (**bold** *italic* __underline__ ~~strike~~) ──────────
function parseRuns(text, base) {
  text = str(text);
  var runs = [];
  var re = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*)/g;
  var last = 0, m;
  function push(t, style) { if (!t) return; var r = { text: t, sizePt: base.sizePt, color: base.color, font: base.font }; if (style) r[style] = true; runs.push(r); }
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    var tok = m[0];
    if (tok.slice(0, 2) === '**') push(tok.slice(2, -2), 'bold');
    else if (tok.slice(0, 2) === '__') push(tok.slice(2, -2), 'underline');
    else if (tok.slice(0, 2) === '~~') push(tok.slice(2, -2), 'strike');
    else push(tok.slice(1, -1), 'italic');
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last));
  if (!runs.length) push(text || ' ');
  return runs;
}
// Body → paragraphs. Leading spaces (2 per level) = indent; a leading -/*/• = bullet.
function parseBody(body, opt) {
  opt = opt || {};
  var lines = str(body).replace(/\r/g, '').split('\n');
  var paras = [];
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i].replace(/\t/g, '  '); // count a leading tab as one indent level
    if (!raw.trim()) continue;
    var indent = (raw.match(/^ */)[0] || '').length;
    var level = Math.min(4, Math.floor(indent / 2));
    var t = raw.trim();
    var isBul = /^[-*•]\s+/.test(t);
    if (isBul) t = t.replace(/^[-*•]\s+/, '');
    var sizePt = opt.sizePt || 18;
    if (level > 0) sizePt = Math.max(12, Math.round(sizePt - level * 2));
    paras.push({
      level: level,
      bullet: opt.bullets !== false && (isBul || level > 0) ? true : false,
      runs: parseRuns(t, { sizePt: sizePt, color: opt.color, font: opt.font }),
    });
  }
  return paras;
}

// ─── table source (CSV or Markdown pipe) → { headers, rows } ──────────────────
// Strip inline-markdown emphasis markers (table cells render as plain text, so a raw
// **Total** would otherwise show its asterisks).
function stripInlineMd(s) {
  return str(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/~~(.+?)~~/g, '$1').replace(/\*(.+?)\*/g, '$1');
}
function splitCsvLine(line) { return line.split(',').map(function (c) { return c.trim(); }); }
function parseTableSrc(src, obj) {
  if (obj && Array.isArray(obj.rows)) {
    return { headers: Array.isArray(obj.headers) ? obj.headers.map(str) : null, rows: obj.rows.map(function (r) { return (Array.isArray(r) ? r : [r]).map(str); }) };
  }
  var lines = str(src).replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); });
  if (!lines.length) return null;
  var pipe = lines[0].indexOf('|') !== -1;
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (pipe) {
      // Only the SECOND line can be a header/body separator — an all-dash line elsewhere is data.
      if (i === 1 && /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && /-/.test(l)) continue;
      var cells = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
      rows.push(cells);
    } else {
      rows.push(splitCsvLine(l));
    }
  }
  if (!rows.length) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

// ─── layout engine: slide-content → { bg, elements[] } (px in the W×H space) ──
function textEl(x, y, w, h, paras, anchor, align) {
  if (align) for (var i = 0; i < paras.length; i++) if (!paras[i].align) paras[i].align = align;
  return { t: 'text', x: x, y: y, w: w, h: h, anchor: anchor || 't', paras: paras };
}
function runsOf(text, sizePt, color, font, extra) {
  var r = { text: str(text) || ' ', sizePt: sizePt, color: color, font: font };
  if (extra) for (var k in extra) r[k] = extra[k];
  return [r];
}

// Bottom-corner chrome shared by every layout: the brand logo (bottom-left, auto light/dark
// or mono, per-slide override) and the slide number (bottom-right). Both sit over whatever
// the slide drew, contrast-picked from the background.
function addChrome(els, bg, sc, ctx, W, H, T) {
  if (!ctx) return;
  var M = Math.round(W * 0.0625);
  var cm = Math.round(H * 0.045);
  var darkBg = bgIsDark(bg);
  var ink = darkBg ? '#ffffff' : (T.dark || '#1b1b1b');
  if (ctx.pageNumbers) {
    var nw = Math.round(W * 0.08), nh = Math.round(H * 0.045);
    els.push(textEl(W - M - nw, H - cm - nh, nw, nh, [{ align: 'r', runs: runsOf(String((ctx.index || 0) + 1), 8, ink, T.mono || T.font) }], 'b'));
  }
  if (ctx.brandLogo && sc.logo !== 'off' && ctx.logos) {
    var v = pickLogo(ctx.logos, darkBg, sc.logo === 'mono');
    if (v && v.url) {
      // Box matches the logo's REAL aspect (from its viewBox) and fits `contain`, so a wide
      // lockup is never clipped or stretched.
      var lh = Math.round(H * 0.055);
      els.push({ t: 'image', x: M, y: H - cm - lh, w: Math.round(lh * (v.aspect || 5.5)), h: lh, src: v.url, fit: 'contain' });
    }
  }
}

function layoutSlide(sc, W, H, T, ctx) {
  var M = Math.round(W * 0.0625);          // margin
  var cw = W - 2 * M;                       // content width
  var accent = sc.accent || T.accent;
  var els = [];
  var onDark = { title: 1, section: 1, quote: 1, 'full-image': 1 };
  var dark = !!onDark[sc.layout];
  var ink = dark ? T.light : T.dark;
  var titleInk = dark ? T.light : T.primary;
  var bg = dark ? T.primary : T.light;

  function titleBlock(y, size) {
    els.push(textEl(M, y, cw, Math.round(H * 0.16), [{ runs: runsOf(sc.title, size, titleInk, T.font, { bold: true }) }], 'b', dark ? 'ctr' : 'l'));
  }

  if (sc.layout === 'title') {
    bg = accent && sc.accent ? accent : T.primary;
    els.push(textEl(M, Math.round(H * 0.34), cw, Math.round(H * 0.22), [{ align: 'ctr', runs: runsOf(sc.title, 46, '#ffffff', T.font, { bold: true }) }], 'b'));
    if (sc.subtitle) els.push(textEl(M, Math.round(H * 0.58), cw, Math.round(H * 0.12), [{ align: 'ctr', runs: runsOf(sc.subtitle, 22, '#ffffff', T.font) }], 't'));
    els.push({ t: 'rect', x: Math.round(W / 2 - 40), y: Math.round(H * 0.72), w: 80, h: 5, fill: accent, radius: 3 });
  } else if (sc.layout === 'section') {
    bg = accent && sc.accent ? accent : T.primary;
    els.push({ t: 'rect', x: M, y: Math.round(H * 0.44), w: Math.round(W * 0.09), h: 6, fill: accent, radius: 3 });
    els.push(textEl(M, Math.round(H * 0.5), cw, Math.round(H * 0.2), [{ runs: runsOf(sc.title, 40, '#ffffff', T.font, { bold: true }) }], 't'));
    if (sc.subtitle) els.push(textEl(M, Math.round(H * 0.72), cw, Math.round(H * 0.1), [{ runs: runsOf(sc.subtitle, 20, '#ffffff', T.font) }], 't'));
  } else if (sc.layout === 'quote') {
    bg = accent && sc.accent ? accent : T.primary;
    els.push(textEl(M, Math.round(H * 0.24), cw, Math.round(H * 0.4), [{ align: 'l', runs: runsOf('“' + (sc.title || sc.body) + '”', 30, '#ffffff', T.font, { italic: true }) }], 'ctr'));
    if (sc.subtitle) els.push(textEl(M, Math.round(H * 0.7), cw, Math.round(H * 0.1), [{ align: 'l', runs: runsOf('— ' + sc.subtitle, 18, accent, T.font, { bold: true }) }], 't'));
  } else if (sc.layout === 'full-image') {
    if (sc.image) els.push({ t: 'image', x: 0, y: 0, w: W, h: H, src: sc.image, fit: 'cover' });
    else els.push({ t: 'rect', x: 0, y: 0, w: W, h: H, fill: T.primary });
    if (sc.title) {
      els.push({ t: 'rect', x: 0, y: Math.round(H * 0.8), w: W, h: Math.round(H * 0.2), fill: 'rgba(0,0,0,0.55)' });
      els.push(textEl(M, Math.round(H * 0.82), cw, Math.round(H * 0.14), [{ runs: runsOf(sc.title, 26, '#ffffff', T.font, { bold: true }) }], 'ctr'));
    }
  } else if (sc.layout === 'agenda') {
    // Title + a NUMBERED, LINKED list of the deck's section slides (each run carries a
    // linkSlide to that section — the engine emits an internal slide-jump hyperlink).
    var aty = Math.round(H * 0.07);
    els.push(textEl(M, aty, cw, Math.round(H * 0.16), [{ runs: runsOf(sc.title || 'Agenda', 30, T.primary, T.font, { bold: true }) }], 'b'));
    els.push({ t: 'rect', x: M, y: Math.round(aty + H * 0.17), w: Math.round(W * 0.11), h: 4, fill: accent, radius: 2 });
    var secs = (ctx && ctx.sections) || [];
    var aparas = [];
    for (var si = 0; si < secs.length; si++) {
      aparas.push({ bullet: 'number', spaceAfterPt: 8, runs: [{ text: secs[si].title || ('Section ' + (si + 1)), sizePt: 22, color: T.dark, font: T.font, linkSlide: secs[si].idx }] });
    }
    if (!aparas.length) aparas.push({ runs: runsOf('Add “Section header” slides — they become the agenda.', 18, T.dark, T.font) });
    els.push(textEl(M, Math.round(H * 0.3), cw, H - Math.round(H * 0.3) - M, aparas, 't'));
  } else {
    // content-family: title top, accent rule, an optional subtitle, then the body region.
    var ty = Math.round(H * 0.07);
    titleBlock(ty, 30);
    els.push({ t: 'rect', x: M, y: Math.round(ty + H * 0.17), w: Math.round(W * 0.11), h: 4, fill: accent, radius: 2 });
    var bodyY = Math.round(H * 0.3);
    if (sc.subtitle && (sc.layout === 'content' || sc.layout === 'two-col' || sc.layout === 'split')) {
      els.push(textEl(M, Math.round(ty + H * 0.2), cw, Math.round(H * 0.08), [{ runs: runsOf(sc.subtitle, 18, T.dark, T.font) }], 't'));
      bodyY = Math.round(H * 0.38);
    }
    var bodyH = H - bodyY - M;

    if (sc.layout === 'table') {
      var tbl = parseTableSrc(sc.tableSrc, sc.tableObj);
      if (tbl) els.push(tableEl(M, bodyY, cw, bodyH, tbl, accent, T));
    } else if (sc.layout === 'visual') {
      if (sc.image) els.push({ t: 'image', x: M, y: bodyY, w: cw, h: bodyH, src: sc.image });
      else els.push({ t: 'rect', x: M, y: bodyY, w: cw, h: bodyH, fill: T.light, line: { color: accent, w: 1 }, radius: 8 });
    } else if (sc.layout === 'split') {
      var lw = Math.round(cw * 0.52), gap = Math.round(W * 0.03);
      els.push(textEl(M, bodyY, lw, bodyH, parseBody(sc.body, { sizePt: 19, color: ink, font: T.font }), 't'));
      if (sc.image) els.push({ t: 'image', x: M + lw + gap, y: bodyY, w: cw - lw - gap, h: bodyH, src: sc.image });
      else els.push({ t: 'rect', x: M + lw + gap, y: bodyY, w: cw - lw - gap, h: bodyH, fill: T.light, line: { color: accent, w: 1 }, radius: 8 });
    } else if (sc.layout === 'two-col') {
      var paras = parseBody(sc.body, { sizePt: 18, color: ink, font: T.font });
      var cut = splitParasAtLevel0(paras), gap2 = Math.round(W * 0.04), colW = Math.round((cw - gap2) / 2);
      els.push(textEl(M, bodyY, colW, bodyH, paras.slice(0, cut), 't'));
      els.push(textEl(M + colW + gap2, bodyY, colW, bodyH, paras.slice(cut), 't'));
    } else {
      els.push(textEl(M, bodyY, cw, bodyH, parseBody(sc.body, { sizePt: 20, color: ink, font: T.font }), 't'));
    }
  }
  addChrome(els, bg, sc, ctx, W, H, T);
  return { bg: bg, elements: els };
}
// Split a paragraph list into two columns at the top-level (level-0) boundary nearest the
// midpoint, so a sub-bullet is never orphaned from its parent bullet across the column gap.
function splitParasAtLevel0(paras) {
  var mid = Math.ceil(paras.length / 2);
  for (var i = mid; i < paras.length; i++) if (!paras[i].level) return i;
  for (var j = mid - 1; j > 0; j--) if (!paras[j].level) return j;
  return mid;
}

function tableEl(x, y, w, h, tbl, accent, T) {
  var ncol = Math.max(1, (tbl.headers || tbl.rows[0] || ['']).length);
  var colW = Math.floor(w / ncol);
  var cols = []; for (var i = 0; i < ncol; i++) cols.push(colW);
  var rows = [];
  if (tbl.headers) {
    rows.push({ cells: tbl.headers.map(function (c) { return { text: stripInlineMd(c), fill: accent, color: '#ffffff', bold: true, align: 'l' }; }) });
  }
  for (var r = 0; r < tbl.rows.length; r++) {
    var cells = [];
    for (var cIx = 0; cIx < ncol; cIx++) {
      cells.push({ text: stripInlineMd(tbl.rows[r][cIx] == null ? '' : tbl.rows[r][cIx]), color: T.dark, align: cIx === 0 ? 'l' : 'r', borders: { b: { color: '#d9d9d9', w: 1 } } });
    }
    rows.push({ cells: cells });
  }
  var rowH = Math.floor(h / Math.max(1, rows.length));
  for (var k = 0; k < rows.length; k++) rows[k].h = rowH;
  return { t: 'table', x: x, y: y, w: w, h: h, firstRow: !!tbl.headers, cols: cols, rows: rows };
}

// ─── element list → preview HTML (positions in %, sizes in cqw) ───────────────
function pctX(v, W) { return (v / W * 100); }
function pctY(v, H) { return (v / H * 100); }
function cqw(px, W) { return (px / W * 100).toFixed(3) + 'cqw'; }
function ptCqw(pt, W) { return cqw(pt * 4 / 3, W); }
function fillCss(fill, W) {
  if (!fill) return '';
  if (typeof fill === 'string') return fill;
  if (fill.grad && fill.grad.stops) {
    var stops = fill.grad.stops.map(function (s) { return htmlEsc(s.color) + ' ' + Math.round((s.pos || 0) * 100) + '%'; }).join(', ');
    return 'linear-gradient(' + (Math.round((fill.grad.angle || 180))) + 'deg, ' + stops + ')';
  }
  return '';
}
function runHtml(run) {
  var s = htmlEsc(run.text);
  if (run.bold) s = '<b>' + s + '</b>';
  if (run.italic) s = '<i>' + s + '</i>';
  if (run.underline) s = '<u>' + s + '</u>';
  if (run.strike) s = '<s>' + s + '</s>';
  return { s: s, color: run.color, sizePt: run.sizePt };
}
function paraHtml(p, W) {
  var isNum = p.bullet === 'number';
  var custom = p.bullet && typeof p.bullet === 'object' && p.bullet.char ? p.bullet.char : '';
  var cls = 'ds-p' + (isNum ? ' ds-num' : (p.bullet ? ' ds-bullet' : ''));
  var style = p.level ? 'margin-left:' + (p.level * 4) + 'cqw;' : '';
  if (custom) style += "--ds-bul:'" + htmlEsc(custom).replace(/'/g, '') + "';";
  var align = p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : p.align === 'just' ? 'justify' : 'left';
  var inner = (p.runs || []).map(function (run) {
    var r = runHtml(run);
    var link = run.linkSlide != null ? ';text-decoration:underline;text-underline-offset:2px' : '';
    return '<span style="font-size:' + ptCqw(r.sizePt, W) + ';color:' + htmlEsc(r.color || '#111') + link + '">' + r.s + '</span>';
  }).join('');
  return '<p class="' + cls + '" style="' + style + 'text-align:' + align + '">' + inner + '</p>';
}
function elHtml(el, W, H) {
  var pos = 'left:' + pctX(el.x, W).toFixed(3) + '%;top:' + pctY(el.y, H).toFixed(3) + '%;width:' + pctX(el.w, W).toFixed(3) + '%;height:' + pctY(el.h, H).toFixed(3) + '%;';
  if (el.t === 'rect') {
    var bd = el.line ? 'border:' + Math.max(1, el.line.w) + 'px solid ' + htmlEsc(el.line.color) + ';' : '';
    var rad = el.radius ? 'border-radius:' + cqw(el.radius, W) + ';' : '';
    return '<div class="ds-el" style="' + pos + 'background:' + htmlEsc(fillCss(el.fill, W)) + ';' + bd + rad + '"></div>';
  }
  if (el.t === 'text') {
    var anchor = el.anchor === 'ctr' ? ' ds-anchor-ctr' : el.anchor === 'b' ? ' ds-anchor-b' : '';
    return '<div class="ds-el ds-text' + anchor + '" style="' + pos + '">' + (el.paras || []).map(function (p) { return paraHtml(p, W); }).join('') + '</div>';
  }
  if (el.t === 'image') {
    // Default to `contain` (never clip a logo/chart); only a full-bleed background covers.
    var fitCls = el.fit === 'cover' ? ' ds-cover' : '';
    return '<div class="ds-el' + fitCls + '" style="' + pos + '"><img src="' + htmlEsc(el.src) + '" alt=""></div>';
  }
  if (el.t === 'table') {
    var trs = (el.rows || []).map(function (row) {
      var tds = (row.cells || []).map(function (c) {
        var st = 'font-size:' + ptCqw(c.sizePt || 13, W) + ';padding:0.6cqw 0.9cqw;color:' + htmlEsc(c.color || '#111') + ';';
        if (c.fill) st += 'background:' + htmlEsc(c.fill) + ';';
        if (c.bold) st += 'font-weight:700;';
        st += 'text-align:' + (c.align === 'r' ? 'right' : c.align === 'ctr' ? 'center' : 'left') + ';';
        if (c.borders && c.borders.b) st += 'border-bottom:1px solid ' + htmlEsc(c.borders.b.color) + ';';
        var span = c.colSpan > 1 ? ' colspan="' + c.colSpan + '"' : '';
        return '<td' + span + ' style="' + st + '">' + htmlEsc(c.text || '') + '</td>';
      }).join('');
      return '<tr>' + tds + '</tr>';
    }).join('');
    return '<div class="ds-el" style="' + pos + '"><table class="ds-table" style="width:100%;height:100%;">' + trs + '</table></div>';
  }
  return '';
}
function slideHtml(slide, W, H, notes, idx) {
  var bgCss = fillCss(slide.bg, W) || '#ffffff';
  var body = (slide.elements || []).map(function (el) { return elHtml(el, W, H); }).join('');
  var note = notes ? '<div class="ds-notes" data-slide-notes hidden>' + htmlEsc(notes) + '</div>' : '';
  // data-block-index ties this page to its sidebar block (index-aligned) so the shell's
  // filmstrip can jump between a slide and the block that authors it.
  return '<section class="ds-slide" data-pdf-page data-block-index="' + idx + '" style="background:' + htmlEsc(bgCss) + ';">' + body + note + '</section>';
}

// ─── compute ──────────────────────────────────────────────────────────────────
var _cachedTheme = null;
var _cachedLogos = null;

function boolInput(model, id, dflt) { for (var i = 0; i < model.length; i++) if (model[i].id === id) return model[i].value !== false; return dflt; }

function build(model, theme, logos) {
  var picked = slidesFromInputs(model);
  var sz = SIZES[picked.size] || SIZES[str(pickSize(model))] || SIZES.wide;
  var W = sz[0], H = sz[1];
  var slides = picked.slides.length ? picked.slides : [{ layout: 'title', title: 'Deck Studio', subtitle: '', body: '', notes: '', logo: 'auto' }];
  // Pass 1: the section slides become the agenda's linked table of contents.
  var sections = [];
  for (var s = 0; s < slides.length; s++) if (slides[s].layout === 'section') sections.push({ idx: s, title: slides[s].title });
  var pageNumbers = boolInput(model, 'pageNumbers', true);
  var brandLogo = boolInput(model, 'brandLogo', true);
  var laid = slides.map(function (sc, i) {
    return layoutSlide(sc, W, H, theme, { index: i, total: slides.length, sections: sections, logos: logos, pageNumbers: pageNumbers, brandLogo: brandLogo });
  });
  var deck = {
    size: { w: W, h: H },
    theme: pptxTheme(theme),
    slides: laid.map(function (sl, i) { return { bg: sl.bg, notes: slides[i].notes || undefined, elements: sl.elements }; }),
  };
  var previewHtml = laid.map(function (sl, i) { return slideHtml(sl, W, H, slides[i].notes, i); }).join('');
  return { _deckJson: safeJson(deck), _previewHtml: previewHtml, _aspect: W + ' / ' + H, _slideCount: slides.length };
}
function pickSize(model) { for (var i = 0; i < model.length; i++) if (model[i].id === 'size') return model[i].value; return 'wide'; }

async function onInit(ctx) {
  _cachedTheme = await readBrandTheme();
  _cachedLogos = await resolveLogos();
  return build(ctx.model, _cachedTheme, _cachedLogos);
}
function onInput(ctx) {
  var theme = _cachedTheme || { primary: '#0c322c', accent: '#30ba78', dark: '#1b1b1b', light: '#ffffff', font: 'SUSE' };
  return build(ctx.model, theme, _cachedLogos);
}
