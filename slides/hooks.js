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

function compute(model) {
  var inputs = toInputs(model);
  var motion = str(inputs.transition) || 'fade';
  var speed = clamp(num(inputs.transitionSpeed, 0.5), 0.1, 1.5);
  var hold = clamp(num(inputs.slideDuration, 3), 0.5, 20);
  var focus = Math.round(num(inputs.focusSlide, 0));
  _loop = str(inputs.loop) || 'loop';

  var all = Array.isArray(inputs.deck) ? inputs.deck : [];
  var rows = all.slice(0, MAX_SLIDES);
  if (all.length > MAX_SLIDES && host.log) {
    host.log('warn', 'slides: slide count capped', { max: MAX_SLIDES, requested: all.length });
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
  var T = f4(R);
  _totalDuration = T;

  // The engine applies NO defaults to block sub-fields — every one is defended here.
  var pages = [];
  for (var k = 0; k < n; k++) {
    var row = rows[k] || {};
    var layout = SLOTS_FOR[str(row.layout)] ? str(row.layout) : 'title';
    var bg = safeColor(row.bg, '#141b2d');
    var title = str(row.title);
    var subtitle = str(row.subtitle);
    var slots = [];
    var fields = SLOTS_FOR[layout];
    for (var s = 0; s < fields.length; s++) {
      slots.push({ n: s + 1, url: refUrl(row[fields[s]]) });
    }
    pages.push({
      idx: k,
      layout: layout,
      bg: bg,
      ink: idealInk(bg),
      title: title,
      subtitle: subtitle,
      hasHead: !!(title || subtitle),
      notes: str(row.notes),
      slots: slots,
      slotCount: slots.length
    });
  }

  // "Pause on slide" freezes the preview so a slide can be edited; 0 plays the deck.
  var focusIdx = (focus > 0) ? clamp(focus - 1, 0, n - 1) : -1;

  // The returned keys (pages/animCss/rootClass/durSec/slideCount) must never collide
  // with an input id — a match would overwrite that INPUT instead of landing in
  // extras. The blocks input is `deck` precisely so `pages` stays free.
  return {
    pages: pages,
    animCss: buildAnimCss(n, startS, inS, R, T, motion, _loop, focusIdx),
    rootClass: (focusIdx >= 0) ? 'sl-frozen' : 'sl-anim',
    durSec: T,
    slideCount: n
  };
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }

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
