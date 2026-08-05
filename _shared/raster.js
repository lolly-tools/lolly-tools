/**
 * Shared hook helpers — raster capability probe + image decoding.
 *
 * CANONICAL SOURCE for the `canRaster` and `loadImage` regions below. Tool
 * hooks.js ship as self-contained data (no imports), so each consumer carries
 * a byte-for-byte copy of each region between `lolly:shared` marker comments.
 * Edit the regions HERE, then run `npm run sync:shared` to rewrite every
 * consumer; `npm run validate:catalog` fails if any consumer drifts.
 *
 * Both regions delegate to the `host.raster` bridge API (engine v1.105,
 * plans/86-worker-isolation-hooks.md §6.1) instead of probing the DOM directly.
 * `host` is in lexical scope in every hooks.js (the whole file is one
 * `new Function('host', ...)` body), so these keep their signatures — 0-arg
 * `canRaster()`, 1-URL-arg `loadImage(url)` — and NO consumer call site changes.
 * Asking the host rather than the realm is what keeps them correct once hooks
 * move into a Worker, where `document`/`Image` are absent even though rastering
 * (OffscreenCanvas) works. A shell without `host.raster` (the headless CLI) makes
 * canRaster() false and loadImage() reject — the same degraded path the old
 * `typeof document === 'undefined'` guard produced.
 */

// === lolly:shared canRaster — canonical source; edit here and run npm run sync:shared ===
function canRaster() {
  return !!(host.raster && host.raster.canRaster());
}
// === /lolly:shared canRaster ===

// === lolly:shared loadImage — canonical source; edit here and run npm run sync:shared ===
function loadImage(url) {
  if (!host.raster) return Promise.reject(new Error('no raster'));
  return host.raster.decode(url);
}
// === /lolly:shared loadImage ===
