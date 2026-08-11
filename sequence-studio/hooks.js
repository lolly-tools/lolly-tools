/* global onInit, onInput, beforeExport, host */

/**
 * Sequence Studio — a free-form canvas of positioned "boxes" that also has TIME.
 *
 * Derived from Layout Studio. Same box model, same pure-string computation, same
 * canvas overlay; what this tool adds is a composition arranged along a timeline —
 * boxes carry start/dur/lane, the sequence row plays one clip after another, and
 * overlays ride above it. Everything time-related is emitted as the data-t-* wire
 * attributes the shell's timeline panel reads; nothing here interprets them.
 *
 * The ONE behavioural difference from Layout Studio: a box whose media is an AUDIO
 * asset renders no visible content at all (see mediaHtmlFor's audio branch). Audio
 * boxes exist for the timeline and the mix, never for the artboard, so a still
 * export never shows a stray rectangle where the music bed sits.
 *
 * The tool is DATA: each box is one row of the `boxes` blocks input, carrying flat
 * geometry (x/y/w/h/rot) + decoration (shape/radius/fill/opacity/image/text/…) +
 * timing (start/dur/clipIn/speed/enter/exit/mute/lane).
 * The direct-manipulation overlay (select / drag / resize / rotate / z-order /
 * align / distribute) lives entirely in the web shell (shells/web/src/views/
 * free-canvas.js) and only ever writes this flat array back through the normal
 * input path — so the engine, the URL, and the CLI never see the editor, and a
 * headless render of the same state produces identical artwork.
 *
 * This hook is PURE (no DOM, no async): Handlebars is logic-less, so it can't
 * divide opacity by 100 or map a shape to a border-radius. We precompute a CSS
 * string per box (boxStyle) and per text block (textStyle) and expose them as
 * extras the template applies via {{lookup boxStyle @index}}. Running here (not in
 * the template) means the CLI produces the same styles as the browser.
 */

function inputsFrom(model) {
  var o = {};
  (model || []).forEach(function (i) { o[i.id] = i.value; });
  return o;
}

function num(v, d) {
  var x = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(x) ? x : d;
}
// === lolly:shared clamp — generated from community/_shared/math.js; edit there and run npm run sync:shared ===
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
// === /lolly:shared clamp ===

// Only let a value through if it's a shape CSS colour can't be smuggled past —
// box fill/text colour come from colour inputs, but a hand-edited URL could carry
// anything, and these land inside a style="" attribute, so guard against
// property-injection via a stray ';'.
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

// Coerce a manifest/URL boolean (real boolean, or "true"/"1"/"on" string) to a
// boolean, falling back to `dflt` for empty/unknown values.
function boolVal(v, dflt) {
  if (v === true || v === false) return v;
  if (v == null || v === '') return dflt;
  var s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return dflt;
}

// Escape a string for safe inclusion in raw HTML output ({{{ }}} in the template).
// === lolly:shared esc — generated from community/_shared/text.js; edit there and run npm run sync:shared ===
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// === /lolly:shared esc ===

// Inline emphasis on an ALREADY-escaped fragment: **bold** first, then *italic* /
// _italic_. The markers are literal chars in the escaped text and we only ever inject
// our own fixed <strong>/<em> tags, so this can't smuggle markup through.
// \* and \_ are literal-marker escapes (the WYSIWYG editor emits them for typed
// asterisks/underscores so "5 * 3 * 2" never italicises): park them in control
// chars while the emphasis regexes run, then restore the bare character.
function inlineMd(s) {
  s = s.replace(/\\\*/g, '\u0001').replace(/\\_/g, '\u0002');
  // Attribute runs: {#rrggbb|text}, {w600|text}, {mono|text}, {u|text}, {s|text}, or
  // any combination {#rrggbb w600 mono u|text}. The attrs are a space-separated list of
  // a validated colour (safeColor → only a real colour reaches style=""), a numeric
  // weight wNNN, a closed font token mono|sans, and/or the decoration flags u
  // (underline) / s (strikethrough); anything else leaves the {…|…} literal so ordinary
  // "{x|y}" copy is never swallowed. Only fixed, validated values reach style="" — no
  // token text is echoed — so this stays XSS-safe. The inner text still carries **/*,
  // handled just below. The vector export reads each run's computed colour, weight and
  // font-family (and draws underline/strike), so styled text outlines correctly.
  s = s.replace(/\{([^|{}]+)\|([^{}]*)\}/g, function (whole, attrs, inner) {
    var styles = [];
    var deco = [];
    var toks = attrs.trim().split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i];
      if (/^#[0-9a-fA-F]{3,8}$/.test(tok)) {
        var c = safeColor(tok, '');
        if (!c) return whole;
        styles.push('color:' + c);
      } else if (/^w[1-9]00$/.test(tok)) {
        styles.push('font-weight:' + tok.slice(1));
      } else if (tok === 'mono' || tok === 'sans') {
        styles.push('font-family:' + fontFamily(tok));
      } else if (tok === 'u') {
        deco.push('underline');
      } else if (tok === 's') {
        deco.push('line-through');
      } else {
        return whole;
      }
    }
    if (deco.length) styles.push('text-decoration:' + deco.join(' '));
    return styles.length ? '<span style="' + styles.join(';') + '">' + inner + '</span>' : whole;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s.replace(/\u0001/g, '*').replace(/\u0002/g, '_');
}

// Semi-rich text → safe HTML. Escape first, then a tiny markdown subset: **bold**,
// *italic*/_italic_, and lines starting with - / * / • become "•"-prefixed bullets.
// Newlines are preserved (styles.css sets white-space:pre-wrap). Emphasis is emitted
// as inline <strong>/<em>; the SVG/PDF vector walkers recurse into inline runs and
// outline each with its OWN computed weight/style, so bold/italic survive vector
// export too (not just raster). Bullets are plain "•" text, so they're trivially safe.
function richText(raw) {
  return esc(raw).split('\n').map(function (ln) {
    var mb = ln.match(/^(\s*)[-*•]\s+(.*)$/);
    if (mb) return mb[1] + '•  ' + inlineMd(mb[2]);
    // Ordered list: N. text (1-999) -> N.  text, numbers kept literal (like bullets).
    var mo = ln.match(/^(\s*)(\d{1,3})\.\s+(.*)$/);
    if (mo) return mo[1] + mo[2] + '.  ' + inlineMd(mo[3]);
    return inlineMd(ln);
  }).join('\n');
}

function radiusFor(shape, radius) {
  switch (shape) {
    case 'rounded': return Math.max(0, num(radius, 0)) + 'px';
    case 'pill': return '9999px';
    // A circle is an ellipse the editor keeps square (w === h); both round to 50%.
    case 'ellipse': case 'circle': return '50%';
    default: return '0';
  }
}

var H_JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' };
var V_ALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
// Any 100-step weight in the variable font's range. Sans stacks commonly cover
// 100–900; mono cuts rarely ship a Black, so cap mono at 800 — this keeps the
// browser render and the static-TTF vector export in agreement.
function weightOf(b) {
  var w = clamp(Math.round(num(b.weight, 700) / 100) * 100, 100, 900);
  if (/mono/i.test(String(b.font)) && w > 800) w = 800;
  return String(w);
}
// Text block font family. The sans stack leads with the brand font var (resolved
// on the canvas root when a brand sets it; the fallbacks keep headless/CLI renders
// identical without it). 'sans'/'mono' are closed keywords; any other value is a
// brand font family the user added to their kit (the font select's brandFonts
// option list), sanitised to safe chars before it reaches style="" so a family
// name can never inject CSS. Unknown/empty values fall back to sans.
var FONTS = {
  'mono': 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  'sans': "var(--font-brand, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)",
};
function fontFamily(v) {
  var key = String(v);
  // Own-property, not bare truthiness — the SHADOW_TARGETS rule, applied to every enum
  // whitelist in this file: `font=constructor` from a hand-edited URL would otherwise
  // return Object and emit its source text as a font-family.
  if (Object.prototype.hasOwnProperty.call(FONTS, key)) return FONTS[key];
  var safe = key.replace(/[^\w \-]/g, '').trim(); // letters/digits/space/hyphen only
  return safe ? ("'" + safe + "', " + FONTS.sans) : FONTS.sans;
}
var FITS = { cover: 1, contain: 1, fill: 1, none: 1, 'scale-down': 1 };
// Whitelisted CSS object-position anchors — the free-canvas 3×3 picker writes one of
// these. The value lands in a style="" attr, so (like safeColor) only known keywords
// pass. 'center' is the CSS default, so it's emitted as nothing to keep URLs terse.
// Picks which edge/corner a contain-fitted image sits against, or which part of a
// cover-cropped image stays in frame. The vector exporter reads the computed value, so
// SVG (preserveAspectRatio) and PDF honour the same anchor.
var OBJPOS = {
  center: 1, 'center top': 1, 'center bottom': 1, 'left center': 1, 'right center': 1,
  'left top': 1, 'right top': 1, 'left bottom': 1, 'right bottom': 1,
  top: 1, bottom: 1, left: 1, right: 1,
};
// CSS mix-blend-mode keywords. Faithful in raster (PNG/JPG/WebP) export; the vector
// walkers (SVG/PDF) don't honour blend, so it flattens there — documented.
var BLENDS = {
  multiply: 1, screen: 1, overlay: 1, darken: 1, lighten: 1, 'color-dodge': 1,
  'color-burn': 1, 'hard-light': 1, 'soft-light': 1, difference: 1, exclusion: 1,
  hue: 1, saturation: 1, color: 1, luminosity: 1,
};

// ONE answer to "is this box audio?", shared by every place that has to leave no mark
// on the frame: the fill (boxCss), the shadow + clip (compute), the text (compute) and
// the media element (mediaHtmlFor). Keying some of those off `kind` and others off the
// asset's type is how you get an MP3 dropped on an ordinary image box rendering as a
// coloured rectangle with a label while the real Audio box beside it is invisible.
// A box is audio when it SAYS so (kind:'audio' — what the Audio add-kind seeds and what
// the timeline panel keys its waveform lane off), or when the asset it carries is audio
// by type/extension. Both, because a catalog ref's url is an opaque `asset:`/blob id
// with no extension and a resolver may not fill in .type, so the kind is the only
// reliable signal for a library track — while the extension test still catches an audio
// file dropped onto an ordinary box.
function isAudioBox(b) {
  if (!b) return false;
  if (String(b.kind) === 'audio') return true;
  var img = b.image;
  if (!img) return false;
  if (img.type === 'audio') return true;
  // Both the resolved url AND the ref's id: a catalog/upload ref resolves to an opaque
  // `asset:<id>`/blob url that has lost the extension, so the id is often the only
  // place the file name survives.
  var re = /\.(mp3|wav|ogg|m4a|flac)($|\?|#)/i;
  return re.test(String(img.url == null ? '' : img.url)) || re.test(String(img.id == null ? '' : img.id));
}

// plan 104 §5.4 — "is this box a camera?". A camera is a non-visual TIMELINE citizen
// like an audio bed: it carries the scene's pose (its own `kf` track and `z`) and paints
// nothing at all. Keyed off `kind` ALONE, unlike isAudioBox: no asset can imply a camera,
// so there is no second signal to reconcile — a box is a camera because the Camera
// add-kind seeded it (or a hand-edited URL says so). Mirrors Layout Studio's predicate
// verbatim so Design and Sequence Studio decide identically.
function isCameraBox(b) {
  return !!b && String(b.kind) === 'camera';
}

// The boxes that leave NO MARK on the frame: an audio bed and a camera marker. One
// predicate so every "paints nothing" site (fill, clip, shadow, text) stays in one
// vocabulary and a new bare kind is added in exactly one place.
function isBareBox(b) {
  return isAudioBox(b) || isCameraBox(b);
}

function boxCss(b) {
  var x = Math.round(num(b.x, 0));
  var y = Math.round(num(b.y, 0));
  var w = Math.max(1, Math.round(num(b.w, 1)));
  var h = Math.max(1, Math.round(num(b.h, 1)));
  var rot = num(b.rot, 0);
  var op = clamp(num(b.opacity, 100), 0, 100) / 100;
  // A path box's `bg` is the PATH's fill (see pathHtmlFor), so the div behind it
  // stays transparent — otherwise every pen shape would sit on an opaque rectangle
  // of its own fill colour. An audio box or a camera marker paints nothing at all (see
  // mediaHtmlFor), so their fill is dropped for the same reason: they must leave no mark
  // on the frame.
  var kind = String(b.kind);
  var fill = (kind === 'path' || isBareBox(b)) ? 'transparent' : safeColor(b.bg, 'transparent');
  var blend = Object.prototype.hasOwnProperty.call(BLENDS, String(b.blend)) ? String(b.blend) : '';
  var css =
    'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;' +
    (rot ? 'transform:rotate(' + (Math.round(rot * 10) / 10) + 'deg);' : '') +
    (op !== 1 ? 'opacity:' + op + ';' : '') +
    (blend ? 'mix-blend-mode:' + blend + ';' : '') +
    'background:' + fill + ';' +
    // .lolly-box clips its children, which is right for an image or text but wrong for a
    // path box: the frame is the curve's tight bbox, so a stroke legitimately paints half
    // its width outside it (see pathHtmlFor's stroke pad) and the div would cut it off
    // again. Inline rather than in styles.css so the CLI and the export walkers, which read
    // this string, agree with the browser.
    (kind === 'path' ? 'overflow:visible;' : '') +
    'border-radius:' + radiusFor(b.shape, b.radius) + ';' +
    'justify-content:' + (H_JUSTIFY[b.align] || 'center') + ';' +
    'align-items:' + (V_ALIGN[b.valign] || 'center') + ';';
  return css;
}

function imgCss(b) {
  var fit = FITS[String(b.fit)] ? String(b.fit) : 'contain';
  var pos = String(b.imgpos == null ? '' : b.imgpos).trim();
  return 'object-fit:' + fit + ';' +
    (OBJPOS[pos] && pos !== 'center' ? 'object-position:' + pos + ';' : '');
}

// A box's media element. When its image is a Lottie asset, emit the marker div the
// web shell's lottie-mount enhancer plays (data-lottie-src → live <svg>; still
// formats snapshot a frame, gif/webm/mp4 capture the motion) — otherwise a plain
// <img>. Empty when the box has no (resolved) image. Asset refs are resolved before
// this hook runs, so b.image carries .type + .url (same shape lottie-digi-ad reads).
// Pure/string-only, mirroring textHtml, so the CLI produces the same markup — the
// marker div is simply inert there (no browser enhancer). The url is esc()'d for
// parity with the {{asset image}} Handlebars escaping it replaces.
function mediaHtmlFor(b) {
  // plan 104 §5.4 — a CAMERA box is a bare marker and nothing else: no fill (boxCss), no
  // media, no text, no shadow (compute). It exists so the scene's pose has somewhere to
  // live — the pose itself rides on the wrapper's data-t-kf/data-t-z, exactly like every
  // other timing attribute — and the marker is what the evaluators key their camera
  // branch off. Checked FIRST, before the `url` guard: a camera carries no image, so an
  // early return on "no url" would swallow the marker entirely. data-export-hide keeps it
  // out of every export walk (the same tag the editor's own chrome carries), on top of
  // styles.css hiding it.
  if (isCameraBox(b)) {
    return '<div class="lolly-box-cam" data-cam="1" data-export-hide aria-hidden="true"></div>';
  }
  var img = b && b.image;
  var url = img && img.url ? String(img.url) : '';
  if (!url) return '';
  var isLottie = (img && img.type === 'lottie') || /\.json($|\?|#)/i.test(url);
  var isVideo = (img && img.type === 'video') || /\.(mp4|m4v|mov|webm)($|\?|#)/i.test(url);
  // A box is audio when it SAYS so (kind:'audio' — what the Audio add-kind seeds and
  // what the timeline panel keys its waveform lane off), or when the asset it carries
  // is audio by type/extension. Both, because a catalog ref's url is an opaque
  // `asset:`/blob id with no extension and a resolver may not fill in .type, so the
  // kind is the only reliable signal for a library track — while the extension test
  // still catches an audio file dropped onto an ordinary box.
  var isAudio = isAudioBox(b);
  var style = imgCss(b);
  // An audio box is a TIMELINE citizen, not an artboard one: a music bed or a
  // voiceover has no picture, so it paints nothing and a still export can never
  // show a stray rectangle where it sits (styles.css hides the marker; boxCss
  // keeps the box transparent and compute() drops its text). The marker div is
  // the only trace, carrying the src for the panel's waveform and the export
  // mix — inert in the CLI and in a plain browser render, exactly like the
  // Lottie marker above. Checked BEFORE the lottie/video branches so an asset
  // typed 'audio' can never fall through to an <img>.
  if (isAudio) {
    // The source's own LENGTH, in ms, when the asset knows it (uploads probe it at
    // ingest; a catalog entry authors it on the format and assets.ts lifts it onto
    // meta). Without this the panel has no media duration for an audio box — a
    // <video> can be asked for .duration but a marker div cannot — so trimming had
    // nothing to clamp against: you could drag the out-edge past the end of the
    // sound into silence, "fit to media" could not work, and promoting an audio box
    // fell back to a flat default length instead of the track's own. Omitted when
    // unknown (a procedural zzfxm bed has no fixed length by design), which reads
    // back as null and keeps the old unclamped behaviour.
    var adur = img && img.meta && Number(img.meta.durationMs);
    var adurAttr = (isFinite(adur) && adur > 0) ? ' data-audio-dur="' + Math.round(adur) + '"' : '';
    return '<div class="lolly-box-audio" data-audio-src="' + esc(url) + '"' + adurAttr + ' aria-hidden="true"></div>';
  }
  if (isLottie) {
    var fit = String(b.fit) === 'cover' ? 'cover' : 'contain';
    return '<div class="lolly-box-img lolly-box-lottie" data-lottie-src="' + esc(url) +
      '" data-lottie-loop="1" data-lottie-autoplay="1" data-lottie-fit="' + fit +
      '" style="' + style + '"></div>';
  }
  // A video box: a muted, looping, autoplaying <video> (muted + playsinline are
  // required for autoplay, incl. Tauri mobile WebViews). object-fit rides in `style`
  // just like the <img>. Still exports snapshot the current frame (export.js swaps
  // <video> → an <img> still). data-video-key (the box id) lets the shell's
  // video-mount enhancer restore playback position across per-paint rebuilds so the
  // clip doesn't restart at 0 on every edit. Pure string like the other branches, so
  // the CLI emits identical markup (the <video> is simply inert there).
  if (isVideo) {
    var vkey = b && b.id != null ? esc(String(b.id)) : esc(url);
    return '<video class="lolly-box-img lolly-box-video" src="' + esc(url) +
      '" data-video-key="' + vkey + '" muted loop autoplay playsinline style="' + style + '"></video>';
  }
  return '<img class="lolly-box-img" src="' + esc(url) + '" style="' + style + '" alt="" draggable="false">';
}

// ── vector path boxes ────────────────────────────────────────────────────────
//
// A `kind:'path'` box is a pen shape. Its geometry is NOT in this file: the box
// carries an AUTHORED path (nodes + handles + spline kind) in its `path` field,
// and the engine's geometry kernel — reached through host.geom, because tools may
// not import from the engine — decodes it and lowers it to cubics. That is what
// makes a pen shape render headlessly: a URL render, a CLI render and an export
// all run manifest -> inputs -> hooks -> template with no editor anywhere, so if
// the lowering lived in the overlay a shared link would arrive blank.
//
// Node coordinates are fractions of the BOX FRAME (see plans/pen-tool-and-vector-
// ops.md), so drag/resize/rotate act on a path box through x/y/w/h/rot exactly as
// they do on every other kind, without rewriting a node. They are mapped into
// box-local PIXELS here, before the lowering, for two reasons: the spline then
// solves in the same frame it is drawn in (so what the pen tool previews is what
// exports), and the emitted <svg> can carry a 1:1 viewBox. The alternative — a
// viewBox of "0 0 1 1" with preserveAspectRatio="none" — would scale the stroke
// non-uniformly with the box and leans on export-walker behaviour we don't rely on.

var FILL_RULES = { nonzero: 1, evenodd: 1 };

// host.geom is OPTIONAL and additive (HostV1 v1.64), so feature-detect it the way
// the shipped tools feature-detect host.color — never assume, never throw.
function geomApi() {
  return typeof host !== 'undefined' && host && host.geom ? host.geom : null;
}

// Report through host.log, never by throwing: onInit/onInput errors are caught and
// DISCARDED by the runtime, so a throw here would make a path box vanish with
// nothing anywhere to say why.
function pathWarn(msg) {
  try {
    if (typeof host !== 'undefined' && host && host.log) host.log('warn', 'sequence-studio: ' + msg);
  } catch (e) { /* a host without log is still a host */ }
}

// The honest degrade: a dashed outline of the box frame. A path we cannot draw is
// still a box the user placed, and an invisible element is the one answer that
// can't be acted on — this one says "there is a shape here and it did not draw",
// keeps the element selectable in the editor, and carries no geometry it made up.
// currentColor + fixed numbers, so nothing from the box can reach the markup.
function pathPlaceholder(w, h, why) {
  pathWarn(why);
  var d = 'M.75 .75H' + (w - 0.75) + 'V' + (h - 0.75) + 'H.75Z';
  return '<svg class="lolly-box-path lolly-box-path-undrawn" width="' + w + '" height="' + h +
    '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5"' +
    ' stroke-dasharray="6 4" opacity="0.45"></path></svg>';
}

// A path box's inline <svg>, or '' for every other kind. Pure/string-only like
// mediaHtmlFor, so the CLI emits identical markup.
function pathHtmlFor(b) {
  if (String(b.kind) !== 'path') return '';
  var w = Math.max(1, Math.round(num(b.w, 1)));
  var h = Math.max(1, Math.round(num(b.h, 1)));
  var raw = b.path == null ? '' : String(b.path);
  // Nothing authored yet (a freshly added box, or a cleared field). Not an error:
  // there is no shape, so there is nothing to draw and nothing to warn about.
  if (!raw) return '';

  var geom = geomApi();
  if (!geom || !geom.decodeAuthored || !geom.fromNodes) {
    return pathPlaceholder(w, h, 'host.geom is unavailable, so a path box cannot be drawn (needs engine >= 1.64)');
  }
  var dec = geom.decodeAuthored(raw);
  if (!dec || !dec.ok) {
    return pathPlaceholder(w, h, 'path box: ' + ((dec && dec.message) || 'unreadable path field'));
  }
  // A value carries a LIST of contours, always — one for a pen-drawn shape, several
  // when a boolean punched a hole or split the shape into loops. Every contour is
  // lowered on its own and the subpaths are concatenated into ONE `d`, which is what
  // makes the hole a hole: fill-rule is a property of a path, so two <path>s can
  // never subtract, and one <path> with two subpaths does it for free.
  var srcs = dec.value;
  var ds = [];
  for (var pi = 0; pi < srcs.length; pi++) {
    var src = srcs[pi];
    var nodes = [];
    for (var i = 0; i < src.nodes.length; i++) {
      var n = src.nodes[i];
      var out = { x: n.x * w, y: n.y * h };
      if (n.hInX != null) out.hInX = n.hInX * w;
      if (n.hInY != null) out.hInY = n.hInY * h;
      if (n.hOutX != null) out.hOutX = n.hOutX * w;
      if (n.hOutY != null) out.hOutY = n.hOutY * h;
      if (n.continuity) out.continuity = n.continuity;
      nodes.push(out);
    }
    var res = geom.fromNodes({
      kind: src.kind, nodes: nodes, closed: src.closed === true,
      tension: src.tension, decimals: 3,
    });
    if (!res || !res.ok) {
      return pathPlaceholder(w, h, 'path box: ' + ((res && res.code) || 'error') + ' — ' + ((res && res.message) || 'could not lower the path'));
    }
    // ok with no geometry is an ANSWER, not a failure (fewer than two nodes lowers to
    // no curves), so an empty contour is skipped rather than treated as a refusal.
    if (res.d) ds.push(res.d);
  }
  // Nothing to draw at all: emit nothing rather than a placeholder crying wolf.
  if (!ds.length) return '';
  var d = ds.join(' ');

  // `bg` is the path's FILL for a path box (boxCss keeps the div transparent so the
  // shape is the only thing painted). Empty fill means an unfilled outline, which is
  // what a stroked pen path wants, so it maps to 'none' rather than to a colour.
  var fill = b.bg == null || String(b.bg).trim() === '' ? 'none' : safeColor(b.bg, 'none');
  var stroke = b.stroke == null || String(b.stroke).trim() === '' ? '' : safeColor(b.stroke, '');
  var sw = clamp(num(b.strokeW, 0), 0, 400);
  var rule = FILL_RULES[String(b.fillRule)] ? String(b.fillRule) : 'nonzero';

  // The STROKE PAD. The frame is the curve's tight bounding box (the pen tool refits it to
  // exactly that), so a stroke straddles the frame edge and half of it falls outside — and
  // an outer <svg> clips to its viewport, so without a pad every stroked pen shape loses
  // half its outline all the way round. `overflow: visible` is NOT the fix: this markup is
  // read by three renderers (the browser, the SVG export walker, the PDF walker) and a
  // nested <svg> clips by default in SVG output too, so the geometry is made explicit
  // instead — the element is grown by `pad` on every side and offset by −pad, and the
  // viewBox is shifted to match, which leaves path coordinates mapping to 0..w / 0..h
  // exactly as before. Cap and join are both hard-coded `round` here, and each reaches
  // exactly half the stroke width, so sw / 2 is the whole reach.
  //
  // The inline geometry also has to override styles.css's `inset: 0; width/height: 100%`,
  // which would otherwise pull the element back to the frame — hence `inset:auto` first.
  var pad = stroke && sw > 0 ? sw / 2 : 0;
  var vw = f2(w + pad * 2), vh = f2(h + pad * 2), o = f2(-pad);
  // Everything interpolated is esc()'d even though each value is already reduced to a
  // validated colour, a whitelisted keyword or a number: the extra is emitted through
  // {{{ }}}, which bypasses Handlebars' escaping, so the escape has to happen here.
  return '<svg class="lolly-box-path" width="' + esc(vw) + '" height="' + esc(vh) +
    '" viewBox="' + esc(o) + ' ' + esc(o) + ' ' + esc(vw) + ' ' + esc(vh) + '" preserveAspectRatio="none"' +
    (pad ? ' style="inset:auto;left:' + esc(o) + 'px;top:' + esc(o) + 'px;width:' + esc(vw) + 'px;height:' + esc(vh) + 'px"' : '') +
    '>' +
    '<path d="' + esc(d) + '" fill="' + esc(fill) + '" fill-rule="' + esc(rule) + '"' +
    (stroke && sw > 0
      ? ' stroke="' + esc(stroke) + '" stroke-width="' + esc(f2(sw)) +
        '" stroke-linejoin="round" stroke-linecap="round"'
      : '') +
    '></path></svg>';
}

function rot2(px, py, deg) {
  var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [px * c - py * s, px * s + py * c];
}
function f2(v) { return Math.round(v * 100) / 100; }

// Clip a box to ANOTHER box's silhouette (a clip-path mask). Expresses the mask
// box's shape in THIS box's unrotated local coordinate space (clip-path is applied
// pre-transform), so it stays correct when either box is rotated. Rect/rounded/pill
// masks use the 4 corners (rounding approximated as square); ellipse is sampled.
// Faithful in raster + SVG export (the SVG walker reads this polygon); PDF flattens.
function clipCss(b, byId) {
  var maskId = b.clip != null ? String(b.clip) : '';
  var selfId = b.id != null ? String(b.id) : '';
  if (!maskId || maskId === selfId) return '';
  var m = byId[maskId];
  if (!m) return '';
  var bw = Math.max(1, num(b.w, 1)), bh = Math.max(1, num(b.h, 1));
  var bcx = num(b.x, 0) + bw / 2, bcy = num(b.y, 0) + bh / 2, brot = num(b.rot, 0);
  var mw = Math.max(1, num(m.w, 1)), mh = Math.max(1, num(m.h, 1));
  var mcx = num(m.x, 0) + mw / 2, mcy = num(m.y, 0) + mh / 2, mrot = num(m.rot, 0);
  var world = [];
  if (String(m.shape) === 'ellipse' || String(m.shape) === 'circle') {
    for (var i = 0; i < 48; i++) {
      var t = i / 48 * 2 * Math.PI, w = rot2(Math.cos(t) * mw / 2, Math.sin(t) * mh / 2, mrot);
      world.push([mcx + w[0], mcy + w[1]]);
    }
  } else {
    var cs = [[-mw / 2, -mh / 2], [mw / 2, -mh / 2], [mw / 2, mh / 2], [-mw / 2, mh / 2]];
    for (var j = 0; j < 4; j++) { var w2 = rot2(cs[j][0], cs[j][1], mrot); world.push([mcx + w2[0], mcy + w2[1]]); }
  }
  var poly = world.map(function (p) {
    var lc = rot2(p[0] - bcx, p[1] - bcy, -brot);
    return f2(lc[0] + bw / 2) + 'px ' + f2(lc[1] + bh / 2) + 'px';
  }).join(',');
  return 'clip-path:polygon(' + poly + ');';
}

// Drop shadow. The `shadow` field picks WHAT the shadow follows, which decides the
// CSS property: 'box' → box-shadow (the box outline / radius), 'text' → text-shadow
// (on the text run), 'content' → filter:drop-shadow (the visible alpha silhouette,
// e.g. a transparent PNG / icon), 'depth' → the same drop-shadow, but DERIVED from the
// box's own `z` instead of the manual offsets (plan 104 §5.3). Returns the fragments for
// each target element. Raster and SVG export are faithful; PDF carries it partially.
//
// An own-property lookup, not the bare `SHADOW_TARGETS[tgt]` truthiness test: every
// object literal inherits truthy `constructor`/`__proto__`/`toString`/`valueOf` from
// Object.prototype, so `shadow=constructor` in a hand-edited URL would otherwise select
// a shadow target that does not exist and fall through to the content branch. Same
// posture as isTransition below — one rule for every enum whitelist in this file.
var SHADOW_TARGETS = { box: 1, text: 1, content: 1, depth: 1 };
function isShadowTarget(v) {
  return Object.prototype.hasOwnProperty.call(SHADOW_TARGETS, v);
}
function shadowCss(b) {
  var tgt = String(b.shadow || 'none');
  if (!isShadowTarget(tgt)) return { box: '', text: '', filter: '' };
  // The depth shadow is a pure function of `z` — straight overhead light, alpha and
  // spread growing with the lift, so raising a box off the surface reads as height
  // rather than as a light direction (a baked down-right offset is an LTR assumption
  // that would be wrong in half of the 26 locales). The manual shadowColor/X/Y/Blur
  // stay as the OVERRIDE tier: pick 'box'/'text'/'content' to drive them by hand.
  // Blur is floored at 0 because a sunken box (z < 0) drives 10 + z·0.2 negative,
  // which is not a legal CSS length.
  if (tgt === 'depth') {
    var dz = clamp(num(b.z, 0), -300, 900);
    var dy = f2(dz * 0.15);
    var dbl = f2(clamp(10 + dz * 0.2, 0, 300));
    return { box: '', text: '', filter: 'filter:drop-shadow(0px ' + dy + 'px ' + dbl + 'px #00000055);' };
  }
  var col = safeColor(b.shadowColor, '#00000055');
  var x = Math.round(clamp(num(b.shadowX, 0), -300, 300));
  var y = Math.round(clamp(num(b.shadowY, 0), -300, 300));
  var bl = Math.round(clamp(num(b.shadowBlur, 10), 0, 300));
  var off = x + 'px ' + y + 'px ' + bl + 'px ';
  if (tgt === 'text') return { box: '', text: 'text-shadow:' + off + col + ';', filter: '' };
  if (tgt === 'box') return { box: 'box-shadow:' + off + col + ';', text: '', filter: '' };
  return { box: '', text: '', filter: 'filter:drop-shadow(' + off + col + ');' };
}

// Uniform letter-spacing ("kerning" in the UI) in px, and OpenType feature toggles:
// ligatures default ON (off → disable liga/clig), stylistic alternates default OFF
// (on → salt). Expressed through font-feature-settings ONLY (one property) so the
// browser render and the vector exporter — which reads the computed feature string
// and re-shapes via HarfBuzz — stay in agreement.
function typeFeatureCss(b) {
  var track = clamp(num(b.tracking, 0), -100, 400);
  var ligOff = !boolVal(b.ligatures, true);
  var altOn = boolVal(b.alternates, false);
  var feat = [];
  if (ligOff) feat.push('"liga" 0', '"clig" 0');
  if (altOn) feat.push('"salt" 1');
  return (
    (track ? 'letter-spacing:' + f2(track) + 'px;' : '') +
    (feat.length ? 'font-feature-settings:' + feat.join(', ') + ';' : '')
  );
}

function textCss(b) {
  var size = Math.max(1, Math.round(num(b.fontSize, 48)));
  var weight = weightOf(b);
  var align = H_JUSTIFY[b.align] ? b.align : 'center';
  // Inner padding between the box edge and the text (all sides). Clamped so a
  // hand-edited URL can't push text absurdly far or negative.
  var pad = Math.round(clamp(num(b.pad, 8), 0, 400));
  return (
    'text-align:' + align + ';' +
    'color:' + safeColor(b.fg, '#0e1217') + ';' +
    'font-family:' + fontFamily(b.font) + ';' +
    // The authored size, multiplied by --fit (default 1, so this is inert unless the
    // box opted into shrink-to-fit). The fit pass in template.html measures the laid-out
    // text and writes ONE unitless --fit onto the box; a ratio is right at any canvas
    // scale (the stage previews small, the export scales the same DOM up). See boxFit.
    'font-size:calc(' + size + 'px * var(--fit, 1));' +
    'font-weight:' + weight + ';' +
    'line-height:' + clamp(num(b.lineHeight, 1.12), 0.5, 4) + ';' +
    'padding:' + pad + 'px;' +
    typeFeatureCss(b)
  );
}

// ── time model (phase 1: inert data only — no panel mounts this yet) ───────────
//
// Enter/exit transition keywords, mirroring record's tool.json transition options
// exactly. A hostile enum value (e.g. from a hand-edited URL) must never reach an
// HTML attribute unescaped, so timeAttrsFor only ever emits a value that's a member
// of this whitelist or a clamped number — never raw user text.
var TRANSITIONS = {
  fade: 1, pop: 1, grow: 1, rise: 1, drop: 1, 'slide-left': 1, 'slide-right': 1,
  'slide-up': 1, 'slide-down': 1, 'zoom-in': 1, 'zoom-out': 1, tilt: 1, swoop: 1,
  spin: 1, drift: 1, none: 1,
};

// Is `v` a value that parses to a finite number at all (as opposed to num()'s
// "finite, or fall back to a default")? Distinguishes "authored 0" from "empty" —
// start:"" means scenery (never timed), start:0 means "enters at the top".
function isFiniteNum(v) {
  if (v == null || v === '') return false;
  var x = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(x);
}

// Ceiling (seconds) for every authored time value. An hour is far past anything a
// layout document should hold, and clamping EVERY time field to it — start included
// — keeps the emitted attribute a plain integer: 1e308 * 1000 is Infinity, and
// anything from 1e21 up stringifies exponentially ("1e+24"), both of which a
// parseInt on the phase-2 side would read as NaN / 1.
var MAX_TIME_S = 3600;

// Is `v` one of the whitelisted transition keywords? An own-property test, not the
// bare `TRANSITIONS[v]` truthiness check — every object literal inherits truthy
// `constructor` / `__proto__` / `toString` / `valueOf` from Object.prototype, so a
// hand-authored URL could otherwise smuggle any of those through as a "transition".
// The typeof guard also stops an object-valued field (?boxes= accepts raw JSON) from
// throwing on property-key coercion and aborting the whole compute().
function isTransition(v) {
  return typeof v === 'string' && v !== 'none'
    && Object.prototype.hasOwnProperty.call(TRANSITIONS, v);
}

// The named easing curves the shell implements (lib/transitions.ts EASINGS). 'smooth'
// and 'snappy' arrived with the keyframe grammar (plan 104 §5.1) and are listed here for
// the same reason the other six are: the ease select offers every name in that table, and
// a name this whitelist did not know would be dropped on the way to the attribute and
// silently revert to the preset's built-in curve. One vocabulary, three copies of it.
var EASINGS = {
  linear: 1, 'ease-out': 1, 'ease-in': 1, 'ease-in-out': 1, overshoot: 1, anticipate: 1,
  smooth: 1, snappy: 1,
};

// An authored easing, canonicalised for the attribute: a whitelisted preset name, or
// a cubic-bezier re-emitted from its own PARSED numbers rather than from the user's
// string — which is what keeps arbitrary text out of an attribute this hook writes
// through {{{ }}}. The x controls are TIME and must stay inside 0..1 or the curve is
// not a function of progress (CSS refuses the same thing); y is unbounded on purpose,
// because that is the whole overshoot family. Anything else answers '' and the
// attribute is omitted entirely, so the preset keeps the built-in curve it has always
// had. Mirrors easingPoints/easingToWire in shells/web/src/lib/transitions.ts, which
// re-validates on the way back in — two guards, one vocabulary.
function easeAttr(v) {
  if (typeof v !== 'string') return '';
  var s = v.trim();
  if (Object.prototype.hasOwnProperty.call(EASINGS, s)) return s;
  var m = /^cubic-bezier\(([^)]*)\)$/i.exec(s);
  if (!m) return '';
  var raw = m[1].split(',');
  if (raw.length !== 4) return '';
  var n = [];
  for (var i = 0; i < 4; i++) {
    var x = Number(raw[i].trim());
    if (!isFinite(x)) return '';
    n.push(Math.round(x * 1000) / 1000);
  }
  if (n[0] < 0 || n[0] > 1 || n[2] < 0 || n[2] > 1) return '';
  return 'cubic-bezier(' + n.join(',') + ')';
}

// A box's start offset in seconds, clamped into range. One definition so the
// attribute and the derived sequence length can never disagree.
function startSeconds(b) {
  return clamp(num(b.start, 0), 0, MAX_TIME_S);
}

// ── plan 104 §5.1: the keyframe track ──────────────────────────────────────────
//
// `kf` is a per-box TEXT field carrying a whole animation as one compact string:
// keyframes separated by '*', tokens within a keyframe by '_', the first token that
// keyframe's LOCAL time in ms (t1500), the rest channel values (x-40, s1.2, rx-8) plus
// at most one ease token for the segment leaving it (eo, or eb(0.32)(0)(0.67)(1)).
//
// It is free text, authorable from a hand-edited share URL, and it lands in an HTML
// attribute through {{{ }}} — so this hook NEVER emits the authored string. It PARSES the
// value and re-serialises its own: the easeAttr posture, one step further out. A track
// carrying `"><img` leaves no surviving token, so the attribute is omitted entirely
// rather than escaped — the same answer this file gives a non-whitelisted transition.
//
// The tables below are TRANSCRIBED from engine/src/keyframes.ts (KF_CHANNELS, KF_CLAMPS,
// KF_QUANTA, KF_EASE_PRESETS and the parse caps), because a hook cannot import the
// engine. So the grammar has two implementations — and tests/timeline-model.test.ts pins
// them to each other by asserting the emitted attribute equals the engine's own
// serialiseKf(parseKf(raw)) for a corpus of hostile and ordinary tracks. Change one side
// without the other and that test fails, which is exactly what it is for.
var KF_CHANNEL_ORDER = ['x', 'y', 'z', 's', 'r', 'rx', 'ry', 'o', 'b', 'f', 'a', 'p'];
// The same names LONGEST-FIRST, which is what makes 'rx-8' channel rx at −8 rather than
// channel r followed by junk. No channel is named 'e', so an ease token can never be read
// as a channel.
var KF_CHANNELS_BY_LEN = ['rx', 'ry', 'a', 'b', 'f', 'o', 'p', 'r', 's', 'x', 'y', 'z'];
// `z` spans ±12000 on the WIRE, which is NOT the z field's own −300…900: one kf grammar
// carries both a box's lift and the CAMERA's dolly, and camZ is the only zoom control
// there is. The field clamp still governs the z FIELD — see data-t-z below.
var KF_CLAMPS = {
  x: [-100000, 100000], y: [-100000, 100000], z: [-12000, 12000], s: [0.01, 100],
  r: [-3600, 3600], rx: [-180, 180], ry: [-180, 180], o: [0, 1], b: [0, 300],
  f: [-3000, 3000], a: [0, 1], p: [50, 12000],
};
var KF_QUANTA = {
  x: 0.01, y: 0.01, z: 0.01, s: 0.001, r: 0.01, rx: 0.01, ry: 0.01,
  o: 0.001, b: 0.01, f: 0.01, a: 0.001, p: 0.01,
};
// The eight named curves, by their wire token: linear, ease-in, ease-out, ease-in-out,
// overshoot, anticipate, smooth, snappy. 'eh' (hold) is an ease too but has no points.
var KF_EASES = {
  el: [0, 0, 1, 1], ei: [0.32, 0, 0.67, 0], eo: [0.33, 1, 0.68, 1],
  eio: [0.65, 0, 0.35, 1], ev: [0.34, 1.56, 0.64, 1], ea: [0.36, -0.4, 0.66, 1],
  es: [0.4, 0, 0.2, 1], ek: [0.4, 0, 0.6, 1],
};
var KF_HOLD_EASE = 'eh';
var KF_DEFAULT_EASE = 'eio'; // absent from the wire means this curve
var KF_BEZIER_Q = 0.001;
var KF_BEZIER_Y_MAX = 10;
var KF_MAX_KEYS = 256;   // parse caps — a blocks sub-field has no length limit of its own
// DERIVED from KF_MAX_KEYS, not picked: 256 keyframes at the widest a keyframe can
// serialise to (154 chars) plus separators is 39 679, so a full-density track always
// fits and the two caps can never disagree. The engine pins the derivation.
var KF_MAX_CHARS = 40960;
var KF_NUM = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/; // no exponent, no '+', no NaN/Infinity
var KF_T = /^t(-?(?:\d+(?:\.\d+)?|\.\d+))$/;
var KF_EB = /^eb\(([^()]*)\)\(([^()]*)\)\(([^()]*)\)\(([^()]*)\)$/;

// Round to a quantum whose inverse is an exact power of ten, so String() of the result is
// its shortest round-tripping spelling — and −0 never reaches the wire.
function kfQuant(v, q) {
  var inv = Math.round(1 / q);
  var n = Math.round(v * inv) / inv;
  return n === 0 ? 0 : n;
}

// Strict decimal parse, matching the engine's: null for anything else.
function kfNum(s) {
  if (!KF_NUM.test(s)) return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

// An ease token in canonical spelling, or '' when it is not an ease at all. A custom
// bezier landing exactly on a preset's points comes back as that preset's name.
function kfEase(tok) {
  if (tok === KF_HOLD_EASE) return tok;
  if (Object.prototype.hasOwnProperty.call(KF_EASES, tok)) return tok;
  var m = KF_EB.exec(tok);
  if (!m) return '';
  var p = [];
  for (var i = 1; i <= 4; i++) {
    var n = kfNum(m[i]);
    if (n === null) return '';
    // The odd positions are the x controls: TIME, which must stay inside 0..1 or the
    // curve is not a function of progress (the rule easeAttr applies to cubic-bezier).
    // y is bounded only to keep the attribute finite — the overshoot family lives
    // outside 0..1 by design. Clamped, never rejected: the engine's parser clamps too,
    // and the two must agree on every input.
    var odd = (i % 2) === 1;
    p.push(kfQuant(clamp(n, odd ? 0 : -KF_BEZIER_Y_MAX, odd ? 1 : KF_BEZIER_Y_MAX), KF_BEZIER_Q));
  }
  for (var name in KF_EASES) {
    if (!Object.prototype.hasOwnProperty.call(KF_EASES, name)) continue;
    var q = KF_EASES[name];
    if (q[0] === p[0] && q[1] === p[1] && q[2] === p[2] && q[3] === p[3]) return name;
  }
  return 'eb(' + p[0] + ')(' + p[1] + ')(' + p[2] + ')(' + p[3] + ')';
}

// The whole track, parsed and re-serialised, or '' to omit the attribute entirely.
// Never throws: junk tokens are skipped, and a keyframe whose first token is not
// t<number> is skipped whole (the grammar puts time first, always).
function kfAttr(v) {
  if (typeof v !== 'string' || v === '') return '';
  var src = v.length > KF_MAX_CHARS ? v.slice(0, KF_MAX_CHARS) : v; // the excess is ignored
  var segs = src.split('*');
  var keys = [];
  for (var s = 0; s < segs.length && keys.length < KF_MAX_KEYS; s++) {
    if (segs[s] === '') continue;
    var raw = segs[s].split('_');
    var toks = [];
    for (var r = 0; r < raw.length; r++) { if (raw[r] !== '') toks.push(raw[r]); }
    if (!toks.length) continue;
    var tm = KF_T.exec(toks[0]);
    if (!tm) continue;
    var tRaw = kfNum(tm[1]);
    if (tRaw === null) continue;
    var ease = KF_DEFAULT_EASE;
    var vals = {};
    for (var i = 1; i < toks.length; i++) {
      var tok = toks[i];
      if (tok.charAt(0) === 'e') {
        // Later tokens overwrite earlier ones — the wire reads as a list of assignments.
        var e = kfEase(tok);
        if (e) { ease = e; continue; }
      }
      for (var c = 0; c < KF_CHANNELS_BY_LEN.length; c++) {
        var ch = KF_CHANNELS_BY_LEN[c];
        if (tok.slice(0, ch.length) !== ch) continue;
        var n = kfNum(tok.slice(ch.length));
        if (n === null) continue; // a shorter channel name may still match
        vals[ch] = kfQuant(clamp(n, KF_CLAMPS[ch][0], KF_CLAMPS[ch][1]), KF_QUANTA[ch]);
        break;
      }
    }
    keys.push({ t: Math.round(clamp(tRaw, 0, MAX_TIME_S * 1000)), ease: ease, v: vals });
  }
  // Sorted by time, then last-wins at equal times: a re-keyed pose replaces the one it was
  // written over rather than leaving an unreachable twin behind. Array.sort is stable.
  keys.sort(function (a, b) { return a.t - b.t; });
  var out = [];
  for (var k = 0; k < keys.length; k++) {
    if (out.length && out[out.length - 1].t === keys[k].t) out[out.length - 1] = keys[k];
    else out.push(keys[k]);
  }
  var wire = [];
  for (var w = 0; w < out.length; w++) {
    var key = out[w];
    var parts = ['t' + key.t];
    if (key.ease !== KF_DEFAULT_EASE) parts.push(key.ease);
    for (var o = 0; o < KF_CHANNEL_ORDER.length; o++) {
      var cn = KF_CHANNEL_ORDER[o];
      if (!Object.prototype.hasOwnProperty.call(key.v, cn)) continue;
      parts.push(cn + key.v[cn]);
    }
    wire.push(parts.join('_'));
  }
  return wire.join('*');
}

// A box's time attributes, or '' for a box with no timing, no depth and no keyframes.
// Pure; every value lands in an HTML attribute via {{{ }}}, so every emitted value is
// either a clamped NUMBER or a whitelisted enum token — never raw user text. `kf` is the
// one free-text field among them, and kfAttr parses and re-serialises it rather than
// passing it through, so the invariant holds unchanged.
// Each attribute string starts with a leading space so concatenation into a tag is
// safe with no manual separator bookkeeping.
function timeAttrsFor(b) {
  var parts = [];
  // SCENERY (no lane, no start authored) carries no TIMING attributes — the contract
  // every document written before the time model still renders under. Depth and
  // keyframes are not timing: a scenery box on a sequence stage is visible throughout
  // and can still be lifted off the surface or animated, and an always-on camera is
  // exactly that box, so those two are emitted below for timed and untimed alike.
  if (b.lane === 'seq' || isFiniteNum(b.start)) {
    parts.push(' data-t-start="' + Math.round(startSeconds(b) * 1000) + '"');
    if (isFiniteNum(b.dur)) {
      parts.push(' data-t-dur="' + Math.round(clamp(num(b.dur, 0), 0.1, MAX_TIME_S) * 1000) + '"');
    }
    if (num(b.clipIn, 0) > 0) {
      parts.push(' data-clip-in="' + Math.round(clamp(num(b.clipIn, 0), 0, MAX_TIME_S) * 1000) + '"');
    }
    // f2 so an accumulated slider value (0.30000000000000004) doesn't leak float noise
    // into the attribute; re-test against 1 AFTER rounding so a no-op speed stays absent.
    var speed = f2(clamp(num(b.speed, 1), 0.25, 4));
    if (speed !== 1) {
      parts.push(' data-t-speed="' + speed + '"');
    }
    if (isTransition(b.enter)) {
      parts.push(' data-t-enter="' + b.enter + '" data-t-enter-ms="' + Math.round(clamp(num(b.enterMs, 400), 100, 3000)) + '"');
      // Only ever alongside a kind, and only when it survives easeAttr — an unauthored
      // or unparseable curve leaves the attribute absent, which is what every reader
      // treats as "the preset's own curve".
      var enterEase = easeAttr(b.enterEase);
      if (enterEase) parts.push(' data-t-enter-ease="' + enterEase + '"');
    }
    if (isTransition(b.exit)) {
      parts.push(' data-t-exit="' + b.exit + '" data-t-exit-ms="' + Math.round(clamp(num(b.exitMs, 400), 100, 3000)) + '"');
      var exitEase = easeAttr(b.exitEase);
      if (exitEase) parts.push(' data-t-exit-ease="' + exitEase + '"');
    }
    if (boolVal(b.mute, false)) parts.push(' data-t-mute="1"');
    if (b.lane === 'seq') parts.push(' data-t-lane="seq"');
  }
  // plan 104 §5.3 / §5.1 — depth as a clamped number (the ±300 house clamp on one side,
  // 900 on the other so a deep lift stays clear of the behind-camera guard), and the
  // keyframe track as re-serialised tokens. Both stay absent unless authored, so a
  // document using neither renders byte-identically to before the feature landed.
  var z = Math.round(clamp(num(b.z, 0), -300, 900));
  if (z !== 0) parts.push(' data-t-z="' + z + '"');
  var kf = kfAttr(b.kf);
  if (kf) parts.push(' data-t-kf="' + kf + '"');
  return parts.join('');
}

var DEFAULT_SEQ_S = 5; // no box has an authored duration, but something is timed

// Motion export (beforeExport). A still is a poster of the playhead and is never
// touched; these four are the whole-sequence clip formats.
var MOTION_FORMAT = { mp4: 1, webm: 1, gif: 1, apng: 1 };
var GIF_FPS = 15;      // the gif encoder's own fixed rate — it ignores opts.fps
var DEFAULT_FPS = 24;  // apng follows the export bar's fps; this is its fallback
// Margin under the bridge's buffered-frame ceiling (maxVideoFrames(): 600 on a
// full-memory device, scaled down on a small one, where the bridge's own warning
// is the accurate one — it knows the device, this hook does not).
var MAX_FRAMES = 595;

// The sequence's total derived length in ms — single source of truth, reused
// verbatim by the phase-2 timeline panel. `dur` is TIMELINE seconds (the author's
// own trim, already reflecting any speed change), so it is never multiplied by
// speed here. Open-ended boxes (no dur authored) extend to fill this length.
function seqDurationMs(boxes) {
  var timedBoxes = boxes.filter(function (b) { return b && (b.lane === 'seq' || isFiniteNum(b.start)); });
  var withDur = timedBoxes.filter(function (b) { return isFiniteNum(b.dur); });
  if (withDur.length) {
    var max = 0;
    withDur.forEach(function (b) {
      var end = (startSeconds(b) + clamp(num(b.dur, 0), 0.1, MAX_TIME_S)) * 1000;
      if (end > max) max = end;
    });
    return Math.round(max);
  }
  return timedBoxes.length ? DEFAULT_SEQ_S * 1000 : 0;
}

function compute(model) {
  var inp = inputsFrom(model);
  var boxes = Array.isArray(inp.boxes) ? inp.boxes : [];
  var transparent = inp.transparentBg === true;
  var byId = {};
  boxes.forEach(function (b) { if (b && b.id != null && b.id !== '') byId[String(b.id)] = b; });
  // An audio box or a camera marker renders NOTHING visible: no fill (boxCss), no media
  // (mediaHtmlFor emits a display:none marker), no text, and — the part that is easy to
  // miss — no shadow and no clip either. `shadow` is a plain sidebar field with no showFor
  // restriction, so a bare box can carry one, and box-shadow/drop-shadow paint outside
  // the (transparent) box: it would print a stray rectangle of colour exactly where the
  // music bed or the camera sits, which is the one thing this contract promises never
  // happens.
  var NO_SHADOW = { box: '', text: '', filter: '' };
  var shadows = boxes.map(function (b) { return isBareBox(b) ? NO_SHADOW : shadowCss(b || {}); });
  var boxStyle = boxes.map(function (b, i) {
    return boxCss(b || {}) + (isBareBox(b) ? '' : clipCss(b || {}, byId)) + shadows[i].box + shadows[i].filter;
  });
  var textStyle = boxes.map(function (b, i) { return textCss(b || {}) + shadows[i].text; });
  var textHtml = boxes.map(function (b) {
    return isBareBox(b) ? '' : richText((b && b.text) || '');
  });
  var mediaHtml = boxes.map(function (b) { return mediaHtmlFor(b || {}); });
  var pathHtml = boxes.map(function (b) { return pathHtmlFor(b || {}); });
  // Which boxes opted into shrink-to-fit ("1" marks a fit root for the template's fit
  // pass; "" is ignored). Off by default so grow-to-fit (the editor's box-grows-to-text
  // behaviour) stays the norm; a box turns this on to instead shrink the text to a fixed box.
  var boxFit = boxes.map(function (b) { return boolVal(b && b.fitText, false) ? '1' : ''; });
  // Time model (phase 1 — inert data; nothing reads these attributes yet, the
  // phase-2 panel does). timeAttrs is index-aligned with boxStyle/boxFit/etc.
  var timeAttrs = boxes.map(function (b) { return timeAttrsFor(b || {}); });
  var seqMs = seqDurationMs(boxes);
  var seqAttrs = [seqMs > 0 ? ' data-sequence data-seq-ms="' + seqMs + '"' : ''];
  return {
    boxStyle: boxStyle,
    textStyle: textStyle,
    textHtml: textHtml,
    mediaHtml: mediaHtml,
    pathHtml: pathHtml,
    boxFit: boxFit,
    timeAttrs: timeAttrs,
    seqAttrs: seqAttrs,
    bgStyle: [transparent ? 'transparent' : safeColor(inp.background, '#ffffff')],
  };
}

// ─── Brand colours inside blocks ─────────────────────────────────────────────
//
// A top-level colour input may default to a `{color.semantic.*}` alias and the ENGINE
// resolves it (runtime.ts resolveTokenRefs) — that is how `background` above picks up
// the active brand. It resolves TOP-LEVEL colour inputs only: a `blocks` input is
// type 'blocks', so the colour fields inside each row are never visited, and an alias
// left in one reaches safeColor() as the literal string "{color.semantic.secondary}",
// gets rejected as a colour, and silently becomes the fallback.
//
// So the tool resolves its own. This is what lets ONE default seed be on-brand
// everywhere: the shipped composition names semantic slots rather than hexes, so it
// renders in SUSE's jungle/pine under the SUSE pack and in the starter brand's own
// neutrals under lolly-start, with no per-brand copy of the tool.
//
// Resolution happens once, in onInit (async is allowed there, 5s budget), and the
// answers are cached — onInput must stay synchronous and runs on every keystroke, so
// it resolves newly added rows from the cache and never awaits. A miss leaves the
// alias exactly as it was: safeColor's fallback still applies, which is the same
// degrade as before this existed.
var COLOR_FIELDS = ['bg', 'fg', 'stroke', 'shadowColor'];
var ALIAS_RE = /^\{[A-Za-z0-9_.-]+\}$/;
var tokenHex = {};   // alias string → resolved hex ('' once known-unresolvable)

function aliasesIn(boxes) {
  var out = [];
  (boxes || []).forEach(function (b) {
    if (!b) return;
    COLOR_FIELDS.forEach(function (f) {
      var v = b[f];
      if (typeof v === 'string' && ALIAS_RE.test(v.trim()) && out.indexOf(v.trim()) < 0) out.push(v.trim());
    });
  });
  return out;
}

/** Rewrite cached aliases to hex. Returns null when nothing changed, so the patch
 *  omits `boxes` entirely rather than overwriting the user's own array every keystroke. */
function applyTokenHex(boxes) {
  var changed = false;
  var next = (boxes || []).map(function (b) {
    if (!b) return b;
    var copy = null;
    COLOR_FIELDS.forEach(function (f) {
      var v = typeof b[f] === 'string' ? b[f].trim() : '';
      if (!v || !ALIAS_RE.test(v)) return;
      var hex = tokenHex[v];
      if (!hex) return;                       // unknown or known-unresolvable → leave it
      if (!copy) copy = Object.assign({}, b);
      copy[f] = hex;
      changed = true;
    });
    return copy || b;
  });
  return changed ? next : null;
}

function onInit(ctx) {
  var inp = inputsFrom(ctx.model);
  var boxes = Array.isArray(inp.boxes) ? inp.boxes : [];
  var want = aliasesIn(boxes).filter(function (a) { return !Object.prototype.hasOwnProperty.call(tokenHex, a); });
  if (!want.length || typeof host === 'undefined' || !host || !host.tokens || !host.tokens.resolve) {
    return withResolvedBoxes(ctx.model, boxes);
  }
  // One resolve per distinct alias, in parallel. A shell without tokens, a brand
  // missing the slot, or a non-colour value all land on '' — cached, so the next
  // keystroke doesn't retry it.
  return Promise.all(want.map(function (a) {
    return Promise.resolve(host.tokens.resolve(a)).then(function (v) {
      return typeof v === 'string' ? v : (v && typeof v.hex === 'string' ? v.hex : '');
    }, function () { return ''; });
  })).then(function (values) {
    want.forEach(function (a, i) { tokenHex[a] = toHex(values[i]); });
    return withResolvedBoxes(ctx.model, boxes);
  });
}

// A token's value is whatever the brand authored, and a brand pack authored from
// DTCG/Tokens-Studio ingest holds OKLCH strings — `oklch(62% 0.035 250)`, not hex. That
// is a colour safeColor() rejects (its allow-list is hex/rgb/hsl/named, since these land
// inside a style="" attribute), and it is the value a colour FIELD would be handed, where
// the sidebar's picker wants hex. So normalise through host.color.mix — mixing a colour
// with itself at t=0 is the API's identity, and it returns hex — rather than doing colour
// maths here. No host.color (or an unreadable value) → '' → the alias is left alone and
// safeColor's fallback applies, which is the pre-existing degrade.
function toHex(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  try {
    if (typeof host !== 'undefined' && host && host.color && host.color.mix) {
      var hex = host.color.mix(s, s, 0);
      if (typeof hex === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(hex)) return hex;
    }
  } catch (e) { /* a host without the optional API is still a host */ }
  return safeColor(s, '');
}

/** compute() over the resolved array, plus the `boxes` patch itself when one is due. */
function withResolvedBoxes(model, boxes) {
  var resolved = applyTokenHex(boxes);
  if (!resolved) return compute(model);
  var patched = (model || []).map(function (i) {
    return i && i.id === 'boxes' ? Object.assign({}, i, { value: resolved }) : i;
  });
  return Object.assign({ boxes: resolved }, compute(patched));
}

function onInput(ctx) {
  var inp = inputsFrom(ctx.model);
  return withResolvedBoxes(ctx.model, Array.isArray(inp.boxes) ? inp.boxes : []);
}

// The export bar's "No BG" toggle (render.transparentBg) makes the raster export
// alpha; the live artboard already reflects it via compute() above.
//
// A STILL export (png/svg/pdf/…) is a poster of the CURRENT PLAYHEAD — the live DOM
// already carries the clock's .seq-off + inline transforms, and the still capture
// just photographs that state. So stills are left completely alone here.
//
// A MOTION export is the whole sequence: start recording immediately (wait 0) and
// run for the derived sequence length — read back off the rendered artboard's
// data-seq-ms, which compute() stamped from seqDurationMs(), so it is the same single
// source of truth the timeline panel and the exporter's compositor read. (The engine
// hands beforeExport { node, format, opts, host } and NOT the input model, so the DOM
// is where the number lives at this point.) That derived length is the DEFAULT, not a
// lock: it follows the timeline unless the user directly edits the export bar's
// duration field, which the shell flags with opts.durationUserSet and which is then
// honoured verbatim. gif/apng buffer every frame in memory, so those two are
// additionally clamped to the exporter's frame ceiling — whichever length was chosen
// — with a warning that names the trade.
function seqSecondsOf(node) {
  var el = null;
  if (node) {
    if (node.getAttribute && node.getAttribute('data-seq-ms') != null) el = node;
    else if (node.querySelector) el = node.querySelector('[data-seq-ms]');
  }
  var ms = el ? num(el.getAttribute('data-seq-ms'), 0) : 0;
  return ms > 0 ? ms / 1000 : 0;
}

function beforeExport(ctx) {
  var inp = inputsFrom(ctx.model);
  if (inp.transparentBg === true) ctx.opts.background = 'transparent';
  if (!Object.prototype.hasOwnProperty.call(MOTION_FORMAT, ctx.format)) return;

  var seqS = seqSecondsOf(ctx.node);
  if (!(seqS > 0)) seqS = DEFAULT_SEQ_S;

  ctx.opts.wait = 0;
  // The derived sequence length is the DEFAULT, so the clip tracks the timeline
  // automatically as the author edits it. A direct edit of the export bar's duration
  // field wins and is used verbatim: the shell sets opts.durationUserSet only when
  // the user actually changed that field for this export.
  var typed = num(ctx.opts && ctx.opts.duration, 0);
  var want = (ctx.opts.durationUserSet === true && typed > 0) ? typed : seqS;

  var clip = want;
  if (ctx.format === 'gif' || ctx.format === 'apng') {
    var fps = (ctx.format === 'gif') ? GIF_FPS : (num(ctx.opts && ctx.opts.fps, 0) > 0 ? num(ctx.opts.fps, 0) : DEFAULT_FPS);
    var cap = Math.floor(MAX_FRAMES / fps);
    if (cap < want) {
      clip = cap;
      if (host.log) {
        host.log('warn', 'sequence-studio: ' + ctx.format + ' clipped to ' + cap + 's of a ' +
          Math.round(want * 10) / 10 + 's clip (' + Math.round(cap * fps) + ' frames at ' + fps +
          'fps — ' + ctx.format + ' buffers every frame, and the exporter caps that near ' +
          MAX_FRAMES + ' on a full-memory device and lower on a small one) — shorten the ' +
          'sequence, or export mp4/webm, to fit it all in.');
      }
    }
  }
  ctx.opts.duration = clip;
}
