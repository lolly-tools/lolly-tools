// Prompt to Image — lay text out so all of it fits inside one small image.
//
// Two halves compute the layout, and they have to agree:
//
//   here      — splits the text into paragraphs and ESTIMATES a font size from
//               monospace geometry. Pure arithmetic, no DOM, so the CLI and any
//               headless shell still render something correct-ish.
//   template  — refines that estimate by binary-searching against real layout,
//               which is the only way to account for wrap raggedness.
//
// The estimate is the initial paint (and the final word where there is no layout
// engine), so keep GEO in sync with styles.css — the template reads the padding
// and line-height back off the DOM, but ADVANCE/PACK only exist here.

var GEO = {
  // Canvas size — must match render.width/height in tool.json.
  W: 1024,
  H: 1024,
  // Inner margin, in px. Emitted as --p2i-pad so styles.css can't drift from it.
  PAD: 32,
  // Fraction of font-size taken by one line box. Mirrors --p2i-line in styles.css.
  LINE: 1.35,
  // Advance width of one monospace glyph as a fraction of font-size. SUSE Mono
  // sits at ~0.6, which is the usual figure for a mono face.
  ADVANCE: 0.6,
  // How much of the theoretical grid real text actually occupies once ragged
  // line ends and short paragraph tails are counted. Tuned by eye; the template's
  // binary search corrects it either way.
  PACK: 0.82,
  // Legibility floor. Below this a vision model stops reading reliably, so we
  // clamp rather than shrink further and report the overflow instead.
  MIN: 6,
  MAX: 44
};

// Anthropic's documented approximation for how many tokens an image costs a
// Claude vision model. Other providers tile differently, so this is a guide to
// the order of magnitude, not a universal price — the readout says so.
var PX_PER_IMAGE_TOKEN = 750;
// The usual rough figure for English prose. Code and non-Latin scripts run denser.
var CHARS_PER_TEXT_TOKEN = 4;

function paragraphsOf(text) {
  var paras = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map(function (p) { return p.replace(/\s+$/, ''); })
    .filter(function (p) { return p.length > 0; });
  return paras;
}

// Largest font size at which `chars` glyphs still fit the inner box, from the
// monospace grid: capacity = (innerW / (ADVANCE*fs)) * (innerH / (LINE*fs)) * PACK.
// Solving for fs gives the sqrt below.
function estimateFontSize(chars) {
  if (chars <= 0) return GEO.MAX;
  var innerW = GEO.W - GEO.PAD * 2;
  var innerH = GEO.H - GEO.PAD * 2;
  var fs = Math.sqrt((innerW * innerH * GEO.PACK) / (GEO.ADVANCE * GEO.LINE * chars));
  return Math.max(GEO.MIN, Math.min(GEO.MAX, fs));
}

function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function compute(inputs) {
  var text = String(inputs.text == null ? '' : inputs.text);
  var paras = paragraphsOf(text);
  var chars = text.trim().length;

  var textTokens = Math.ceil(chars / CHARS_PER_TEXT_TOKEN);
  var imageTokens = Math.ceil((GEO.W * GEO.H) / PX_PER_IMAGE_TOKEN);

  return {
    paras: paras,
    isEmpty: paras.length === 0,
    // "auto" is resolved in the template, where columns can actually be measured.
    columns: inputs.columns || 'auto',
    // column-count needs a concrete number for the first paint; auto starts at 1
    // and the template overwrites it a frame later.
    initialColumns: inputs.columns === 'auto' || !inputs.columns ? 1 : Number(inputs.columns),
    wrap: inputs.keepLines === false ? 'normal' : 'pre-wrap',
    pad: GEO.PAD,
    line: GEO.LINE,
    minSize: GEO.MIN,
    maxSize: GEO.MAX,
    fontSize: Math.round(estimateFontSize(chars) * 10) / 10,
    chars: group(chars),
    textTokens: group(textTokens),
    imageTokens: group(imageTokens)
  };
}

function inputsOf(model) {
  var out = {};
  for (var i = 0; i < model.length; i++) out[model[i].id] = model[i].value;
  return out;
}

function onInit(ctx) {
  return compute(inputsOf(ctx.model));
}

function onInput(ctx) {
  return compute(inputsOf(ctx.model));
}
