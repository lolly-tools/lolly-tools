/* global host */
/**
 * Audiogram hooks — turn the chosen clip into a per-frame animation track.
 *
 * The division of labour with template.html is deliberate:
 *
 *   hooks.js (here)  decides WHAT the animation knows — it calls host.audio to
 *                    analyse the visible window of the clip, derives the brand
 *                    colour ramp from host.color, and hands both to the template
 *                    as a compact packed payload.
 *   template.html    decides how it LOOKS — a canvas draw function per style,
 *                    reading that payload. No fetching, no decoding, no colour
 *                    science, and (importantly) no async work during a repaint.
 *
 * Why the payload is packed bytes rather than JSON: a frame track is `count ×
 * bands` numbers, so an 8-second clip at 30fps over 48 bands is 11,520 values.
 * As JSON that is ~80 KB of text re-parsed on every keystroke and embedded in
 * every exported HTML file; quantised to bytes and base64'd it is ~15 KB. The
 * values are all normalised 0..1 already, so a byte is the honest precision — a
 * bar's height is being drawn into a pixel grid, not integrated.
 *
 * Everything the template needs travels IN the payload, which is what makes an
 * exported `html` render animate on its own and a headless CLI render draw the
 * same frames as the browser.
 */

/** Analysis frames per second. Matches the export's default fps, so one analysis
 *  frame is one video frame and nothing interpolates. */
const FPS = 30;

/** Spectrum bands. 48 log-spaced bands is more bars than any of these styles draws
 *  at once, so styles subsample rather than ask for a second analysis. */
const BANDS = 48;

/** Overview waveform columns — the `wave` style's envelope. */
const BUCKETS = 160;

/**
 * Oscilloscope window length, in samples. This is a TIME window, not a resolution:
 * 1024 samples is ~23ms, which is two or three cycles of a bass note, and that is
 * what makes a scope look like a scope. 256 was tried first on the reasoning that a
 * polyline across 1080 pixels cannot show more detail than that — true, but it
 * covers only 5.8ms, less than one cycle of a 110Hz bass line, so it rendered as a
 * lazy sine wobble instead of a waveform.
 *
 * Requested ONLY for this style, because it is by far the largest thing the payload
 * can carry (~250 KB of sample bytes for an 8-second clip). Every other style stays
 * on the ~15 KB spectrum track.
 */
const SCOPE = 1024;

/**
 * Time-domain window length for the MilkDrop style, in samples.
 *
 * NOT a free choice: butterchurn's AudioProcessor allocates its arrays at
 * `numSamps * 2 = 1024` and `updateAudio` copies into them with a bare `.set()`. A
 * longer window throws RangeError inside the renderer (which stands the visualizer
 * down for the session, silently, over a black canvas); a shorter one leaves the tail
 * of the previous frame in place and reads as a stuck bass note.
 */
const VIZ_SAMPLES = 1024;

/** Seconds of audio to analyse. Matches render.video.duration — there is no reason
 *  to analyse a three-minute track to draw eight seconds of it. */
const WINDOW = 8;

/**
 * Deterministic speech-like placeholder, so the tool (and its gallery examples)
 * renders as something recognisable with no audio chosen. Seeded — identical on
 * every run, which matters because a gallery thumbnail that changed every rebuild
 * would show up as churn in every preview diff.
 */
function synthTrack(count, bands) {
  let s = 1337;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const rms = new Array(count);
  const mag = new Array(count * bands);
  let env = 0.2;
  for (let i = 0; i < count; i++) {
    // Bursts and decay — the shape of speech rather than of noise.
    if (rnd() < 0.06) env = 0.35 + rnd() * 0.65;
    else env = env * 0.93 + rnd() * 0.05;
    rms[i] = Math.min(1, 0.1 + env * 0.9);
    for (let b = 0; b < bands; b++) {
      // Energy falls away with frequency, with a little life on top.
      const tilt = Math.pow(1 - b / bands, 1.7);
      mag[i * bands + b] = Math.min(1, rms[i] * tilt * (0.75 + rnd() * 0.5));
    }
  }
  return { rms, mag };
}

/** 0..1 → one byte. Values outside the range are clamped rather than wrapped. */
function byte(v) {
  const n = Math.round((Number.isFinite(v) ? v : 0) * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 a byte array. Hand-rolled rather than reaching for `btoa`: hooks run in
 * whatever realm the shell gives them (a browser window, a Node context under the
 * CLI), and this is 12 lines against having to reason about which globals exist
 * where.
 */
function b64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/**
 * The brand colour ramp the gradient-ish styles paint with.
 *
 * `host.color.ramp` interpolates in OKLab, so a two-stop accent → light ramp stays
 * in the accent's own hue family instead of wandering through whatever sits between
 * two hex codes in sRGB. Feature-detected: an older shell (or the CLI without
 * host.color) just gets the flat accent repeated, which every style handles.
 */
function ramp(host, accent, n) {
  const flat = new Array(n).fill(accent);
  if (!host.color || typeof host.color.ramp !== 'function') return flat;
  try {
    // Toward the accent's own lighter end rather than toward white: a ramp that
    // reaches #fff washes the top of every bar out to paper on a light background.
    const lift = host.color.mix ? host.color.mix(accent, '#ffffff', 0.55) : '#ffffff';
    const out = host.color.ramp([accent, lift || '#ffffff'], n, { correctLightness: true });
    return Array.isArray(out) && out.length === n ? out : flat;
  } catch {
    return flat;
  }
}

/**
 * The length of audio the last analysis actually covered, in seconds.
 *
 * Module-level because `beforeExport` needs it and hooks share one module instance per
 * mount (the same pattern mesh-gradient uses for its palette). Seeded with WINDOW so an
 * export that somehow precedes an analysis still gets the manifest's own default.
 */
let _analysedSec = WINDOW;

/**
 * Analyse the visible window and pack it for the template.
 *
 * Returns the extras the template reads. Called from both onInit and onInput
 * because every input that changes what is analysed (the clip, the in-point, and
 * — via the scope window — the style) has to re-derive it. The web shell's
 * host.audio caches by source + options, so the common case of typing a title
 * re-requests an analysis that is already in hand.
 */
async function build(ctx) {
  // ctx.model is an ARRAY of input items, not a value map.
  const v = Object.fromEntries((ctx.model || []).map((i) => [i.id, i.value]));
  // The bridge arrives on the context; the injected `host` global is the fallback
  // for a shell that predates it. Named `h` because `const host = … host …` would
  // reference the binding inside its own initializer.
  const h = ctx.host || (typeof host !== 'undefined' ? host : null);
  if (!h) return {};
  const style = v.style || 'bars';
  const accent = v.accent || '#5b8def';
  const start = Math.max(0, Number(v.start) || 0);
  /**
   * The MilkDrop style is progressive enhancement, decided HERE rather than in the
   * template: only a shell with `host.viz` can run a visualizer at all, and the
   * decision has to be made before the analysis so we don't carry a quarter of a
   * megabyte of sample windows in a payload nothing will read. Everywhere else — a
   * CLI render, a browser without WebGL2, an exported html file — the card falls
   * through to the `bars` draw, which needs no extra data.
   */
  const wantViz = style === 'milkdrop' && !!h.viz && h.viz.isAvailable();
  const wantScope = style === 'scope';
  const wantSamples = wantScope || wantViz;

  const colors = ramp(h, accent, 6);
  const meta = {
    fps: FPS, bands: BANDS, buckets: BUCKETS, scope: 0,
    count: 0, bpm: null, dur: WINDOW, start, real: false,
  };

  let packed = '';
  let peaks = null;
  let beats = [];
  // The visualizer's payload, kept OUT of agData: the shell decodes these windows
  // straight into butterchurn, and agData's section layout is a contract with the
  // template's own unpack(). One reader each beats making both agree on one buffer.
  let vizWave = '';
  let vizMeta = null;

  const src = v.audio;
  if (src && h.audio && h.audio.isAvailable()) {
    try {
      const a = await h.audio.analyse(src, {
        fps: FPS,
        bands: BANDS,
        buckets: BUCKETS,
        start,
        window: WINDOW,
        ...(wantSamples ? { samples: wantViz ? VIZ_SAMPLES : SCOPE } : {}),
      });
      const f = a.frames;
      const scopeLen = f.samples;
      // Section order is the contract with the template's unpack(): the six
      // per-frame scalars, then the spectrum rows, then the overview, then the
      // scope rows. Any change here changes there.
      const size = f.count * 6 + f.count * BANDS + BUCKETS + (wantScope ? f.count * scopeLen : 0);
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const track of [f.rms, f.peak, f.bass, f.mid, f.treb, f.flux]) {
        for (let i = 0; i < f.count; i++) bytes[at++] = byte(track[i]);
      }
      for (let i = 0; i < f.count * BANDS; i++) bytes[at++] = byte(f.magnitude[i]);
      for (let i = 0; i < BUCKETS; i++) bytes[at++] = byte(a.peaks[i]);
      if (wantScope) {
        // Already 0..255 centred on 128 — copy, do not re-quantise.
        for (let i = 0; i < f.count * scopeLen; i++) bytes[at++] = f.wave[i];
      }
      packed = b64(bytes);
      peaks = a.peaks;
      meta.count = f.count;
      meta.scope = wantScope ? scopeLen : 0;
      meta.bpm = a.bpm;
      meta.dur = a.window || WINDOW;
      // beforeExport reads this to make the video as long as the audio it draws.
      _analysedSec = meta.dur;
      meta.real = true;
      if (wantViz) {
        vizWave = b64(f.wave.subarray(0, f.count * scopeLen));
        vizMeta = { count: f.count, samples: scopeLen, fps: FPS, poster: loudest(f.rms, f.count) };
      }
      // Beat FRAME indices, not seconds: the draw loop already works in frames, and
      // an index is one byte-ish of payload against a float's worth of text.
      if (v.beat !== false && a.bpm !== null) {
        beats = Array.from(a.beats).map((t) => Math.round(t * FPS)).filter((i) => i >= 0 && i < f.count);
      }
    } catch (err) {
      // An undecodable clip is a normal outcome, not a bug: codec support genuinely
      // differs between browsers, and Node has almost none. Say so once and fall
      // through to the placeholder so the card still renders.
      h.log('info', 'audiogram: could not analyse the audio, drawing a placeholder', {
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  if (!meta.real) {
    const count = FPS * WINDOW;
    const { rms, mag } = synthTrack(count, BANDS);
    const bytes = new Uint8Array(count * 6 + count * BANDS + BUCKETS);
    let at = 0;
    // The placeholder has no real peak/band split, so every scalar track gets the
    // envelope. Styles that read `bass` still animate; they just do not disagree
    // with the bars above them.
    for (let t = 0; t < 6; t++) for (let i = 0; i < count; i++) bytes[at++] = byte(rms[i]);
    for (let i = 0; i < count * BANDS; i++) bytes[at++] = byte(mag[i]);
    // Keep the overview the placeholder writes, so the script-less fallback below
    // draws the SAME envelope the canvas animates rather than nothing at all.
    const overview = new Float32Array(BUCKETS);
    for (let i = 0; i < BUCKETS; i++) {
      overview[i] = rms[Math.min(count - 1, Math.floor((i / BUCKETS) * count))];
      bytes[at++] = byte(overview[i]);
    }
    packed = b64(bytes);
    peaks = overview;
    meta.count = count;
  }

  // Attribution is only emitted for a preset the shell CONFIRMS it has: an artist
  // preset whose pack isn't staged falls back to a brand-native one, and a credit line
  // naming an artist whose work is not on screen would be worse than none.
  let vizPreset = '';
  let credit = '';
  if (wantViz && vizMeta) {
    try {
      const presets = await h.viz.presets();
      const found = presets.find((p) => p.id === v.preset) || presets[0];
      if (found) {
        vizPreset = found.id;
        if (v.credit !== false && found.author && found.author !== 'Lolly') {
          credit = `${found.name} \u00b7 a MilkDrop preset by ${found.author}`;
        }
      }
    } catch {
      vizPreset = '';
    }
  }

  return {
    agData: packed,
    agMeta: JSON.stringify(meta),
    agColors: colors.join(' '),
    agBeats: beats.join(' '),
    // A human-readable line for the a11y label and the no-script fallback, so the
    // card says something true about the audio even where nothing can animate.
    agSummary: meta.real
      ? (meta.bpm ? `${Math.round(meta.bpm)} BPM` : 'waveform')
      : 'placeholder waveform',
    // The static fallback path (see template.html): a polyline over the overview
    // peaks, so a script-less render is the clip's real envelope rather than a
    // stand-in. Built here because hooks are where the numbers already are.
    agStatic: staticPath(peaks, BUCKETS),
    // The MilkDrop half. All four are empty unless the visualizer will actually run,
    // and the template keys its placeholder off agVizPreset — so every other shell
    // renders the ordinary `bars` card with no dead markup and no dead payload.
    agVizPreset: vizPreset,
    agVizMeta: vizPreset ? JSON.stringify(vizMeta) : '',
    agWave: vizPreset ? vizWave : '',
    // Seeds the visualizer's palette. The background goes in alongside the ramp so the
    // field falls off to the card's own dark end rather than to a neutral the brand
    // never chose; the accent leads, so it stays the colour the image is about.
    agVizColors: vizPreset ? [accent, v.bg || '#101828'].concat(colors).join(' ') : '',
    agCredit: credit,
  };
}

/** The loudest frame in the middle 80% of the window — the poster frame. Clips open on
 *  silence often enough that frame 0 is the wrong still to freeze. */
function loudest(rms, count) {
  const lo = Math.floor(count * 0.1);
  const hi = Math.ceil(count * 0.9);
  let best = lo;
  let bv = -1;
  for (let i = lo; i < hi && i < count; i++) if (rms[i] > bv) { bv = rms[i]; best = i; }
  return best;
}

/**
 * The overview envelope as an SVG path over a 1000×400 box, mirrored about the
 * centre line. Used by the script-less fallback — the gallery preview pipeline, a
 * CLI `html` render, and the moment before the canvas takes over.
 */
function staticPath(peaks, buckets) {
  if (!peaks) return '';
  const n = Math.min(buckets, peaks.length);
  const step = 1000 / Math.max(1, n - 1);
  let top = '';
  let bottom = '';
  for (let i = 0; i < n; i++) {
    const x = (i * step).toFixed(1);
    const amp = Math.max(2, peaks[i] * 190);
    top += `${i ? 'L' : 'M'}${x} ${(200 - amp).toFixed(1)}`;
    bottom = `L${x} ${(200 + amp).toFixed(1)}` + bottom;
  }
  return `${top}${bottom}Z`;
}

async function onInit(ctx) {
  return build(ctx);
}

async function onInput(ctx) {
  return build(ctx);
}

/**
 * Make the video as long as the audio it is drawing.
 *
 * `WINDOW` asks for 8 seconds but the engine CLAMPS that to what the clip actually has
 * left after the in-point, so a 5-second voice memo yields 150 analysis frames — which
 * the template then walks across the manifest's full 8-second export. The picture runs
 * at 5/8 speed against its own soundtrack, and the further `start` is into a short clip
 * the worse the drift. Setting the duration from the analysis makes one analysis frame
 * one video frame by construction.
 *
 * Only when the user has NOT chosen a duration themselves: the export popup's value is a
 * deliberate instruction and must win. Same stance as the sequence tool's beforeExport.
 */
function beforeExport(ctx) {
  if (!ctx || !ctx.opts) return;
  const ANIMATED = { webm: 1, mp4: 1, gif: 1, 'webp-anim': 1 };
  if (!ANIMATED[ctx.format]) return;
  if (ctx.opts.durationUserSet) return;
  if (_analysedSec > 0.5) ctx.opts.duration = Math.round(_analysedSec * 100) / 100;
}
