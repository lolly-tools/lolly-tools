/**
 * URL Capture hooks.
 *
 * Capture is a slow, side-effectful navigation (load a page, settle, scroll,
 * read its pixels or geometry), so it runs in `beforeExport` — the deliberate
 * export action. The auto-fired hooks can't host it: onInit (5s) and onInput (2s)
 * are timeout-wrapped and a real page load + settle won't fit, and re-capturing on
 * every keystroke would hammer the network.
 *
 * beforeExport receives { node, format, opts, host } but NOT the input model, so
 * onInit/onInput stash the latest inputs in a module-level var for it to read
 * (the same pattern qr-code uses for its transparent-bg flag).
 *
 * beforeExport is FORMAT-AWARE — it stages the render node three ways:
 *   • png/jpg/webp  → a raster still in <img> (host.capture.page, crop applied)
 *   • svg (+ pdf)   → a TRUE vector still in <img> (host.capture.vector). The
 *                     export SVG/PDF walker inlines an SVG-sourced <img> as nested
 *                     vector, so the output is resolution-independent, not a raster.
 *     Falls back to the raster page() where a shell lacks capture.vector.
 *   • webm/mp4      → a scroll PAN: capture a tall range strip (scrollDepth →
 *                     scrollTo), draw a moving window of it onto a <canvas> whose
 *                     __lollyFrameRender(t) the video export drives deterministically.
 */

var _params = {
  url: '', scrollDepth: 0, scrollTo: 1, waitMs: 500, css: '',
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
};

// Recolor pass → a CSS filter on <html>, appended to the injected stylesheet so it
// works in every shell that fulfils capture (web/desktop). The TUI applies the same
// pass itself (url-capture.ts) and also honours the crop insets, which a plain
// capture() can't express. Keep this in sync with url-capture.ts recolorCss().
function recolorCss(v) {
  var deg = Math.round(Number(v.hue)) || 0;
  switch (v.recolor) {
    case 'invert':    return 'html{filter:invert(1) hue-rotate(180deg)!important}';
    case 'grayscale': return 'html{filter:grayscale(1)!important}';
    case 'sepia':     return 'html{filter:sepia(0.9)!important}';
    case 'hue':       return 'html{filter:hue-rotate(' + deg + 'deg)!important}';
    case 'tint':      return 'html{filter:grayscale(1) contrast(1.05)!important}';
    default:          return '';
  }
}

// Browser zoom → a `zoom` on <html>, injected with the recolor/user CSS. Chrome's
// own Ctrl/Cmd-+ zoom uses the same mechanism, so this magnifies the page BEFORE
// the shot (content renders bigger and crisper, not upscaled) — the way to enlarge
// even a bitmap capture. scrollHeight reflows with it, so the scroll/crop geometry
// (measured post-injection by the capture engine) stays self-consistent.
function zoomCss(v) {
  var z = Number(v.zoom);
  return (Number.isFinite(z) && z > 0 && Math.abs(z - 1) > 1e-3) ? 'html{zoom:' + z + '!important}' : '';
}

var clampInset = function (n) {
  var x = Number(n);
  return Number.isFinite(x) ? Math.min(0.9, Math.max(0, x)) : 0;
};
var clamp01 = function (n) {
  var x = Number(n);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
};

function stash(model) {
  var v = Object.fromEntries(model.map(function (i) { return [i.id, i.value]; }));
  var userCss = typeof v.css === 'string' ? v.css : '';
  _params = {
    url: typeof v.url === 'string' ? v.url.trim() : '',
    scrollDepth: clamp01(v.scrollDepth),
    scrollTo: v.scrollTo == null ? 1 : clamp01(v.scrollTo),
    waitMs: Number.isFinite(Number(v.waitMs)) ? Math.max(0, Number(v.waitMs)) : 500,
    css: [recolorCss(v), zoomCss(v), userCss].filter(Boolean).join('\n'),
    crop: {
      top: clampInset(v.cropTop), right: clampInset(v.cropRight),
      bottom: clampInset(v.cropBottom), left: clampInset(v.cropLeft),
    },
  };
  return {};
}

function onInit({ model }) { return stash(model); }
function onInput({ model }) { return stash(model); }

// Show exactly one .shot (the <img> or the <canvas>) and drop the placeholder.
function reveal(node, which) {
  var root = (node.matches && node.matches('.url-shot')) ? node : node.querySelector('.url-shot');
  var img = node.querySelector('[data-capture]');
  var canvas = node.querySelector('[data-shot-canvas]');
  var placeholder = node.querySelector('[data-placeholder]');
  if (img) img.hidden = which !== 'img';
  if (canvas) canvas.hidden = which !== 'canvas';
  // Stale frame-clock hook off the canvas whenever it's not the video surface, so a
  // later still export's frame-clock scan can't repaint a hidden canvas.
  if (canvas && which !== 'canvas') { try { delete canvas.__lollyFrameRender; } catch (e) { canvas.__lollyFrameRender = null; } }
  if (placeholder) placeholder.style.display = 'none';
  // Mark the canvas as holding a capture — unlocks the hover-revealed re-capture
  // button (styles.css .url-shot[data-captured]:hover .shot-refresh).
  if (root) root.setAttribute('data-captured', '');
}

// Load a captured strip and wire the canvas to draw a frame-height window of it at
// normalized time t∈[0,1) — the video export's deterministic frame clock. The still
// paths (png/svg) never enter here; a still of THIS canvas would paint t=0 (the top).
function setupPanCanvas(canvas, strip, frameCssH) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.decoding = 'async';
    img.onload = function () {
      var natW = img.naturalWidth || 1;
      var natH = img.naturalHeight || 1;
      // strip.width/height are CSS px; the bitmap is scaled by dpr. Derive the
      // device-px frame height from the CSS frame height via the same scale.
      var scale = natW / Math.max(1, strip.width || natW);
      var frameHpx = Math.max(1, Math.round((frameCssH || strip.height || natH) * scale));
      if (frameHpx > natH) frameHpx = natH;
      var panPx = Math.max(0, natH - frameHpx);
      canvas.width = natW;
      canvas.height = frameHpx;
      var ctx = canvas.getContext('2d');
      canvas.__lollyFrameRender = function (t) {
        var tt = (typeof t === 'number' && isFinite(t)) ? Math.min(1, Math.max(0, t)) : 0;
        var srcY = Math.round(tt * panPx);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, srcY, natW, frameHpx, 0, 0, canvas.width, canvas.height);
      };
      canvas.__lollyFrameRender(0);
      resolve();
    };
    img.onerror = function () { reject(new Error('Could not load the captured frame.')); };
    img.src = strip.url;
  });
}

async function beforeExport({ node, format, opts, host }) {
  // Thumbnails (and other cheap previews) must NOT trigger a fresh capture — that
  // is a slow headless-browser navigation. Reuse whatever is already on the canvas.
  if (opts && opts.thumbnail) return;

  if (!host.capture) {
    throw new Error('URL capture needs the desktop app — the web app can’t screenshot external pages.');
  }
  if (!_params.url) {
    throw new Error('Enter a URL to capture.');
  }

  // Capture at the requested export dimensions when they're plain pixels; fall
  // back to the tool's render size. Physical units (e.g. "210mm") are resolved by
  // the export bridge per format — the engine owns that math, not this hook — so
  // we only read a leading pixel value here.
  var px = function (d, fallback) {
    var n = parseFloat(d);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  };
  var width = px(opts.width, 1280);
  var height = px(opts.height, 720);
  var dpi = Number(opts.dpi);
  var dpr = Number.isFinite(dpi) && dpi > 96 ? dpi / 96 : 1;
  var fmt = String(format || '').toLowerCase();

  // The window shared by every format: viewport, scroll start, settle, styles.
  var baseSpec = {
    url: _params.url,
    width: width,
    height: height,
    scrollDepth: _params.scrollDepth,
    waitMs: _params.waitMs,
    dpr: dpr,
    css: _params.css,
  };

  var img = node.querySelector('[data-capture]');
  var canvas = node.querySelector('[data-shot-canvas]');

  // ── Video: pan a scroll from scrollDepth → scrollTo ─────────────────────────
  if (fmt === 'webm' || fmt === 'mp4') {
    // The pan spans the FULL viewport width (no crop) so the video aspect matches
    // the export size and never letterboxes. rangeTo ≤ scrollDepth ⇒ a still hold.
    var strip = await host.capture.page(Object.assign({}, baseSpec, {
      rangeTo: Math.max(_params.scrollTo, _params.scrollDepth),
    }));
    var frameCssH = (strip.meta && Number(strip.meta.frameHeight) > 0) ? Number(strip.meta.frameHeight) : height;
    await setupPanCanvas(canvas, strip, frameCssH);
    reveal(node, 'canvas');
    return;
  }

  // ── Vector still: a true vector when the shell can print one ─────────────────
  var wantsVector = fmt === 'svg' || fmt === 'pdf';
  if (wantsVector && typeof host.capture.vector === 'function') {
    var vec = await host.capture.vector(Object.assign({}, baseSpec, { crop: _params.crop }));
    if (img) {
      img.setAttribute('src', vec.url);
      img.setAttribute('width', String(vec.width || width));
      img.setAttribute('height', String(vec.height || height));
    }
    reveal(node, 'img');
    return;
  }

  // ── Raster still (png/jpg/webp — and svg/pdf where no vector capture) ────────
  var shot = await host.capture.page(Object.assign({}, baseSpec, { crop: _params.crop }));
  if (img) {
    img.setAttribute('src', shot.url);
    img.setAttribute('width', String(shot.width || width));
    img.setAttribute('height', String(shot.height || height));
  }
  reveal(node, 'img');
}
