/**
 * Jump Page hooks.
 *
 * Reads the `links` blocks into the list the logic-less template prints: one
 * entry per usable link, each with a resolved href, a display label and the
 * bare host name, plus the per-scene class names and the split heading the
 * `cinema` style needs - the template is logic-less, so every scrap of
 * computation lives here. DOM-free and memoized on the input values, so the CLI and
 * the node tests run the same path the web shell does. Nothing here throws: a
 * page with no usable links comes back as a hint the template renders in place.
 *
 * The page itself is the point of the tool: the whole state rides in the share
 * link (packed `z` / password-gated `zx` like any tool), so any Lolly - a
 * static host, the PWA offline, someone else's install - rebuilds the same
 * landing page from the link alone, with nothing stored on a server.
 */

var JUMP_MAX = 10;

// A glyph is one emoji, not a caption: capped by GRAPHEME so the cut can never
// leave a lone surrogate half behind, nor split a ZWJ sequence (a family, a
// profession, a flag) into a different emoji plus a dangling joiner.
var ICON_MAX = 4;

// The stagger index the opening scene delays each word by. Capped because a
// heading arriving from a hand-typed link is not bounded by the manifest's
// maxLength (the engine constrains edits, not initial values), and an
// uncapped index holds the tail of a long heading at opacity 0 for seconds.
var WORD_STAGGER_MAX = 12;

// Scene wash classes, cycled per link: clean paper, accent tint, the full
// accent crescendo, shaded paper. Dealt in this order so a three-link page
// (the default) lands its last scene on the crescendo before the dark close.
// The template is logic-less, so the cycling happens here.
var WASHES = ['jp-wash-a', 'jp-wash-b', 'jp-wash-c', 'jp-wash-d'];

// One dial over every cinema animation (travel distance + stagger step).
var MOODS = { calm: '0.6', bold: '1', electric: '1.6' };

// Fallbacks for every colour input. A colour default is a token alias that
// resolves to '' on a brand with no tokens, so each one needs a literal here.
var INK_FALLBACK = '#17232b';
var PAPER_FALLBACK = '#f7f8fa';
var ACCENT_FALLBACK = '#2563eb';

function _str(v) {
  return String(v == null ? '' : v).trim();
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
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function _luma(hex) {
  var c = _rgb(hex);
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

// A typed address is often bare ("suse.com"): give it a scheme so the anchor
// works, but leave anything that already has one (https, mailto, tel) alone.
function _href(raw) {
  var s = _str(raw);
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return 'https://' + s;
}

// The bare host for display and for the label fallback: no scheme, no www.,
// no path unless the path is the interesting part (mailto keeps its address).
function _host(href) {
  var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(href);
  if (m) return m[1].replace(/^www\./i, '');
  return href.replace(/^[a-z][a-z0-9+.-]*:/i, '');
}

// A redirect NAVIGATES on visit, so its scheme has to be safe to hand to
// location.replace: http(s)/mailto/tel only. `javascript:`/`data:` etc. would
// execute, so they never become a redirect target (the page falls back to the
// link list). An anchor href a click away is contained; an auto-forward is not.
function _safeRedirect(href) {
  return /^(https?|mailto|tel):/i.test(href) ? href : '';
}

function _icon(v) {
  var s = _str(v).replace(/\s+/g, '');
  var units = typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter().segment(s), function (x) { return x.segment; })
    : Array.from(s);
  return units.slice(0, ICON_MAX).join('');
}

// A scene with no chosen glyph gets a ghost instead: the label's first
// grapheme, which the cinema sets huge in the brand face as the parallax
// layer - so an icon-less page still composes. Uppercased, because a lone
// letterform reads as a mark, not a typo.
function _ghost(label) {
  var s = _str(label);
  if (!s) return '';
  var units = typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter().segment(s), function (x) { return x.segment; })
    : Array.from(s);
  return (units[0] || '').toLocaleUpperCase();
}

// The heading, one span per word, so the opening scene can stagger them in.
function _words(v) {
  return _str(v).split(/\s+/).filter(Boolean).map(function (w, i) {
    return { w: w, i: i < WORD_STAGGER_MAX ? i : WORD_STAGGER_MAX };
  });
}

// A boolean arrives as a real boolean from the model and as text from a
// hand-typed URL, so both spellings of "off" have to count.
function _bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'string') return !/^(0|false|off|no)$/i.test(v.trim());
  return !!v;
}

function compute(args) {
  var rows = Array.isArray(args.links) ? args.links : [];
  var items = [];
  for (var i = 0; i < rows.length && items.length < JUMP_MAX; i++) {
    var href = _href(rows[i] && rows[i].url);
    if (!href) continue;
    var host = _host(href);
    var n = items.length;
    var label = _str(rows[i].label) || host;
    var icon = _icon(rows[i].icon);
    items.push({
      href: href,
      host: host,
      label: label,
      icon: icon,
      ghost: icon ? '' : _ghost(label),
      sceneParity: n % 2 ? 'jp-odd' : 'jp-even',
      sceneWash: WASHES[n % WASHES.length],
    });
  }

  // On visit: 'page' (default) shows the list; 'forward' redirects to the first
  // link; 'gate' redirects after a press-and-hold human check. The redirect only
  // arms when there's a safe first link - otherwise it quietly shows the list.
  var onVisit = _str(args.onVisit) || 'page';
  var redirectHref = onVisit !== 'page' && items.length ? _safeRedirect(items[0].href) : '';

  // A hand-typed URL value never passes the select's option whitelist (the
  // engine constrains edits, not initial values), so `mood` is looked up as an
  // own property - `constructor` and friends would otherwise resolve.
  var mood = _str(args.mood);
  var style = _str(args.style) || 'cinema';

  var ink = _hex(args.color, INK_FALLBACK);
  var paper = _hex(args.background, PAPER_FALLBACK);
  var accent = _hex(args.accent, ACCENT_FALLBACK);

  return {
    items: items,
    headingWords: _words(args.heading),
    motionScale: Object.prototype.hasOwnProperty.call(MOODS, mood) ? MOODS[mood] : MOODS.calm,
    showFooter: style === 'cinema' && _bool(args.footer, true) ? '1' : '',
    showCue: items.length && !redirectHref ? '1' : '',
    linkCount: items.length ? String(items.length) : '',
    error: items.length ? '' : 'Add a link to build the page.',
    redirect: redirectHref ? '1' : '',
    challenge: redirectHref && onVisit === 'gate' ? '1' : '',
    redirectHref: redirectHref,
    redirectHost: redirectHref ? _host(redirectHref) : '',
    inkColor: ink,
    paperColor: paper,
    accentColor: accent,
    onAccentColor: _luma(accent) > 0.6 ? '#111111' : '#ffffff',
    mutedColor: _luma(paper) > 0.5 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.62)',
    edgeColor: _luma(paper) > 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.18)',
    cardColor: _luma(paper) > 0.5 ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.07)',
  };
}

// One-entry memo, keyed on the whole args object so every input is covered by
// construction (same pattern as the other list tools).
var _memoKey = null;
var _memoResult = null;

function _run(model) {
  var args = Object.fromEntries(model.map(function(i) { return [i.id, i.value]; }));
  var key = JSON.stringify(args);
  if (key === _memoKey) return _memoResult;
  _memoKey = key;
  _memoResult = compute(args);
  return _memoResult;
}

function onInit({ model }) {
  return _run(model);
}

function onInput({ model }) {
  return _run(model);
}
