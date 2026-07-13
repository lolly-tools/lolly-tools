/**
 * Shared hook helpers — raster capability probe + image decoding.
 *
 * CANONICAL SOURCE for the `canRaster` and `loadImage` regions below. Tool
 * hooks.js ship as self-contained data (no imports), so each consumer carries
 * a byte-for-byte copy of each region between `lolly:shared` marker comments.
 * Edit the regions HERE, then run `npm run sync:shared` to rewrite every
 * consumer; `npm run validate:catalog` fails if any consumer drifts.
 *
 * Follow-up (recorded, not done): promote canRaster/loadImage to a
 * `host.raster` bridge API so tools stop probing the platform themselves —
 * that is an engine contract change (new HostV1 surface), out of scope here.
 */

// === lolly:shared canRaster — canonical source; edit here and run npm run sync:shared ===
function canRaster() {
  if (typeof document === 'undefined' || !document.createElement) return false;
  try { var c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d')); }
  catch (e) { return false; }
}
// === /lolly:shared canRaster ===

// === lolly:shared loadImage — canonical source; edit here and run npm run sync:shared ===
function loadImage(url) {
  return new Promise(function (resolve, reject) {
    if (typeof Image === 'undefined') { reject(new Error('no Image')); return; }
    var im = new Image();
    im.onload = function () { resolve(im); };
    im.onerror = function () { reject(new Error('image load failed')); };
    try { im.crossOrigin = 'anonymous'; } catch (e) { /* ignore */ }
    im.src = url;
  });
}
// === /lolly:shared loadImage ===
