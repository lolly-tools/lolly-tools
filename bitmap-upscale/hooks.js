/* global onInit, onInput, host */
/**
 * Bitmap Upscale — hooks.
 *
 * IMPORTANT: no upscaling happens here. The actual AI enlargement runs earlier,
 * in the shell's asset picker "Upscale" affordance (host.upscale + its own
 * dialog, built separately from this tool). By the time an asset reaches this
 * tool's `image` input it is already the upscaled bitmap — this tool's job is
 * only to frame it (template.html handles zoom/pan) and export it, which keeps
 * the render on the normal stamped render path (the one that carries the C2PA
 * credential). That is also why this tool does NOT set `privacy: "on-device"`:
 * that flag suppresses provenance embedding, and provenance is exactly what a
 * "was this AI-upscaled" credential needs to survive.
 *
 * These hooks do no image inference or pixel work of their own — they only
 * read whether an image is set and report a short status string as `extras`
 * for the a11y label (`{{default upscaleNote ''}}` in template.html). Trivial
 * and synchronous, nowhere near the 2s onInput budget.
 */

function inputsFrom(model) {
  var o = {};
  model.forEach(function (i) { o[i.id] = i.value; });
  return o;
}

function compute(model) {
  var inputs = inputsFrom(model);
  var has = !!(inputs.image && (inputs.image.id || inputs.image.url || inputs.image));
  return {
    upscaleNote: has
      ? 'Upscaled image ready to export'
      : 'Choose an image, then use the picker’s Upscale action to enlarge it before exporting',
  };
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }
