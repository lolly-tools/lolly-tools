/* global onInit, onInput, exportFile */
/**
 * Layers — hooks.
 *
 * The tool itself is deliberately tiny: the template paints one absolutely
 * positioned <img> per block row and ALL the per-layer style maths lives here,
 * in a hook-computed `view` array of style strings (extras, never keyed by an
 * input id, so it can't write back into the model).
 *
 * Two jobs:
 *  1. onInit/onInput — normalise row values that arrive as URL strings (a
 *     compact-encoded boolean comes back as the STRING 'false', which is
 *     truthy; numbers come back as strings) and build the view styles.
 *  2. exportFile — rebuild a layered Photoshop file from the rows via
 *     `host.layers.writePsd` (the engine's PSD writer behind a lazy bridge
 *     facade). Pixels come back from each row's stored asset — the import
 *     stored every layer as its own library PNG (the chunk-don't-monolith
 *     rule), so this is a decode of small per-layer images, not one giant
 *     buffer. Feature-detected: no host.layers, no button action.
 */

function rowsOf(model) {
  var rows = null;
  model.forEach(function (i) { if (i.id === 'layers') rows = i.value; });
  return Array.isArray(rows) ? rows : [];
}

function inputsFrom(model) {
  var o = {};
  model.forEach(function (i) { o[i.id] = i.value; });
  return o;
}

/** URL-string tolerant boolean: false / 'false' / '0' / '' → false. */
function truthy(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return !(v === false || v === 'false' || v === '0' || v === 0);
}

function num(v, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function viewStyles(rows) {
  return rows.map(function (r) {
    if (!truthy(r.v, true)) return 'display:none';
    var o = Math.max(0, Math.min(100, num(r.o, 100)));
    var s = 'left:' + num(r.x, 0) + 'px;top:' + num(r.y, 0) + 'px';
    if (o !== 100) s += ';opacity:' + (o / 100);
    if (r.b) s += ';mix-blend-mode:' + r.b;
    return s;
  });
}

function onInit(ctx) {
  return { view: viewStyles(rowsOf(ctx.model)) };
}

function onInput(ctx) {
  return { view: viewStyles(rowsOf(ctx.model)) };
}

// ── PSD write-back ───────────────────────────────────────────────────────────

/** Resolve a row's asset to RGBA pixels + natural size (browser realm only). */
function layerPixels(host, ref) {
  var id = ref && (ref.id || (typeof ref === 'string' ? ref : null));
  var direct = ref && ref.url;
  var urlPromise = direct
    ? Promise.resolve({ url: direct })
    : (id && host.assets && host.assets.get ? host.assets.get(id) : Promise.resolve(null));
  return urlPromise.then(function (res) {
    var url = res && res.url;
    if (!url || typeof Image === 'undefined' || typeof document === 'undefined') return null;
    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var w = img.naturalWidth;
          var h = img.naturalHeight;
          if (!w || !h) { resolve(null); return; }
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx2d = canvas.getContext('2d', { willReadFrequently: true });
          ctx2d.drawImage(img, 0, 0);
          var data = ctx2d.getImageData(0, 0, w, h).data;
          resolve({ width: w, height: h, pixels: new Uint8Array(data.buffer.slice(0)) });
        } catch (e) {
          resolve(null); // tainted canvas or decode failure — skip this layer
        }
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  });
}

async function exportFile(ctx) {
  var host = ctx.host;
  var inputs = inputsFrom(ctx.model);
  var rows = Array.isArray(inputs.layers) ? inputs.layers : [];
  if (!rows.length) throw new Error('Add at least one layer first.');
  if (!host || !host.layers || typeof host.layers.writePsd !== 'function') {
    throw new Error('Layered PSD export isn\'t available in this app.');
  }
  var docW = Math.max(1, Math.round(num(inputs.width, 1080)));
  var docH = Math.max(1, Math.round(num(inputs.height, 1080)));

  var layers = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var px = await layerPixels(host, r.img);
    if (!px) continue; // no pixels, no PSD layer — the row stays a Lolly-side note
    layers.push({
      name: (r.n || r.g || 'Layer ' + (i + 1)) + '',
      x: Math.round(num(r.x, 0)),
      y: Math.round(num(r.y, 0)),
      width: px.width,
      height: px.height,
      pixels: px.pixels,
      opacity: Math.max(0, Math.min(100, num(r.o, 100))) / 100,
      blend: r.b || 'normal',
      visible: truthy(r.v, true)
    });
  }
  if (!layers.length) throw new Error('None of the layers could be read back as images.');

  var bytes = await host.layers.writePsd({ width: docW, height: docH, layers: layers });
  return { bytes: bytes, mime: 'image/vnd.adobe.photoshop', filename: 'layers.psd' };
}
