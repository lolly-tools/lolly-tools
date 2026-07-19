// Embed & Track Image — the ONLY job of this hook is to size the export canvas to
// the dropped image's own pixels, so the artist gets their work back at full
// resolution. The image is re-saved through the normal render path, which is
// exactly what lets the engine embed the invisible Lolly Imprint + Content
// Credentials + the author/copyright/licence metadata (all driven by the inputs'
// bindToMeta — no hook work needed for provenance).
//
// Sizing is best-effort and fires ONCE per image: when the source changes we
// measure it and set width/height; afterwards we leave those inputs alone so a
// manual size the user typed isn't snapped back. On any failure the manifest
// default (1080²) stands and the picture simply fits with transparent letterboxing.

var MAX_EDGE = 8000;   // matches the width/height input ceiling
var _sizedUrl = null;  // the source URL we've already sized to (respect later manual edits)

function inputsOf(model) {
  var m = {};
  for (var i = 0; i < model.length; i++) m[model[i].id] = model[i].value;
  return m;
}

// The asset input value can be a resolved { url }, an { id }/{ ref }, or a bare id.
function assetUrl(v) {
  if (!v) return Promise.resolve(null);
  if (typeof v === 'object' && v.url) return Promise.resolve(v.url);
  var id = typeof v === 'string' ? v : (v.id || v.ref || null);
  if (!id || !host.assets || !host.assets.get) return Promise.resolve(null);
  return host.assets.get(id)
    .then(function (r) { return (r && r.url) || null; })
    .catch(function () { return null; });
}

function measure(url) {
  return new Promise(function (resolve) {
    if (!url || typeof Image === 'undefined') { resolve(null); return; }
    var img = new Image();
    img.decoding = 'async';
    var done = function () {
      var w = img.naturalWidth || 0, h = img.naturalHeight || 0;
      resolve(w > 0 && h > 0 ? { w: w, h: h } : null);
    };
    img.onload = done;
    img.onerror = function () { resolve(null); };
    try { img.src = url; } catch (e) { resolve(null); return; }
    if (img.complete && img.naturalWidth > 0) done();
  });
}

function sizeToImage(model) {
  var v = inputsOf(model).source;
  if (!v) return Promise.resolve({});
  return assetUrl(v).then(function (url) {
    if (!url || url === _sizedUrl) return {};   // no image, or already sized → leave W/H as-is
    return measure(url).then(function (dim) {
      if (!dim) return {};
      _sizedUrl = url;
      // Keep the exact aspect ratio; clamp only the longest edge to the ceiling.
      var scale = Math.min(1, MAX_EDGE / Math.max(dim.w, dim.h));
      return { width: Math.max(1, Math.round(dim.w * scale)), height: Math.max(1, Math.round(dim.h * scale)) };
    });
  });
}

function onInit(ctx) { return sizeToImage(ctx.model); }
function onInput(ctx) { return sizeToImage(ctx.model); }
