/* global onInit, onInput, exportFile */
/**
 * Redact — runs entirely in the sandboxed hook context (no imports, no network).
 *
 * Redaction here is a destructive re-generation of the file, never a drawing
 * operation: the sensitive bytes must not exist in the output, and the output is
 * a newly constructed container. Concretely:
 *
 *   JPEG/PNG/WebP: decode → composite onto opaque white → burn 100%-opaque black
 *                  bars → re-encode through a canvas. Metadata, embedded
 *                  thumbnails, extra frames/pictures and trailing bytes are gone
 *                  BY CONSTRUCTION — the re-encode is the metadata kill.
 *   SVG (default): rasterised through the same canvas path → PNG out.
 *   SVG (vector) : opt-in string surgery — metadata/comments/scripts/foreignObject/
 *                  editor cruft deleted, bars appended as opaque rects. Honest
 *                  caveat everywhere: vector mode COVERS positioned text, it
 *                  cannot compute glyph geometry offline to delete it.
 *   PDF          : rasterise-and-rebuild via host.pdf.redact (feature-detected;
 *                  shells without it degrade to a clear "not available here").
 *                  Pages preview as per-page SVGs via host.pdf.pages, so bars
 *                  are drawn directly in PDF point space (viewBox = points,
 *                  origin top-left) and play straight over the PDF at export.
 *
 * The differentiator is honesty: the tool reports, live, what the current marks
 * do and do NOT remove — and exportFile re-scans its own output (residual
 * metadata, trailing bytes, bar-region uniformity) and THROWS on any failure,
 * so nothing downloads that the tool cannot vouch for. Absence of a finding is
 * never presented as evidence of absence.
 *
 * Analysis is hand-rolled byte scanning (same spirit as strip-data): no DOM, no
 * DOMParser, identical behaviour across web, Tauri and CLI shells. Only the
 * export path needs a real browser canvas, and it says so plainly when headless.
 * The input buffer (f.bytes) is never mutated — every output is a new buffer.
 */

// ─── shared byte / text helpers ──────────────────────────────────────────────

function inputsFrom(model) {
  const o = {};
  model.forEach((i) => { o[i.id] = i.value; });
  return o;
}

function fmtBytes(n) {
  if (!(n > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function matchAscii(bytes, off, str) {
  if (off < 0 || off + str.length > bytes.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (bytes[off + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

// Naive forward search for an ASCII needle in a byte buffer. Fine at 50 MB for
// the short needles we use ("jumb", "%%EOF", "/C2PA").
function indexOfAscii(bytes, str, from) {
  const first = str.charCodeAt(0);
  const last = bytes.length - str.length;
  for (let i = Math.max(0, from || 0); i <= last; i++) {
    if (bytes[i] !== first) continue;
    if (matchAscii(bytes, i, str)) return i;
  }
  return -1;
}

function countAscii(bytes, str) {
  let n = 0, p = 0;
  for (;;) {
    p = indexOfAscii(bytes, str, p);
    if (p === -1) return n;
    n++;
    p += str.length;
  }
}

function decodeText(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeText(str) {
  return new TextEncoder().encode(str);
}

// ─── format classification (magic bytes — the accept list is only a UX hint) ─

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function isPngMagic(b) {
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false;
  return true;
}

function isJpegMagic(b) {
  return b.length > 2 && b[0] === 0xFF && b[1] === 0xD8;
}

function isWebpMagic(b) {
  return b.length > 12 && matchAscii(b, 0, 'RIFF') && matchAscii(b, 8, 'WEBP');
}

// "%PDF-" within the first 1 KB — real readers tolerate a small leading offset.
function isPdfMagic(b) {
  if (!b || b.length < 5) return false;
  const limit = Math.min(b.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (matchAscii(b, i, '%PDF-')) return true;
  }
  return false;
}

function looksLikeSvg(text) {
  return /<svg[\s>]/i.test(text);
}

// Returns { kind: 'JPEG'|'PNG'|'WebP'|'SVG'|'PDF'|'file', text } — text only for SVG.
function classify(bytes) {
  if (isJpegMagic(bytes)) return { kind: 'JPEG', text: null };
  if (isPngMagic(bytes)) return { kind: 'PNG', text: null };
  if (isWebpMagic(bytes)) return { kind: 'WebP', text: null };
  if (isPdfMagic(bytes)) return { kind: 'PDF', text: null };
  let text = null;
  try { text = decodeText(bytes); } catch (e) { /* not decodable text */ }
  if (text != null && looksLikeSvg(text)) return { kind: 'SVG', text };
  return { kind: 'file', text: null };
}

// ─── EXIF / TIFF reader (JPEG APP1 and PNG eXIf) ─────────────────────────────
// Offsets inside a TIFF block are relative to the TIFF header, so the DataView
// is anchored there. Best-effort: anything malformed → null.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readIfd(dv, off, le) {
  const out = { entries: [], next: 0 };
  if (off <= 0 || off + 2 > dv.byteLength) return out;
  const n = dv.getUint16(off, le);
  let p = off + 2;
  for (let i = 0; i < n; i++) {
    if (p + 12 > dv.byteLength) return out;
    const tag = dv.getUint16(p, le);
    const type = dv.getUint16(p + 2, le);
    const count = dv.getUint32(p + 4, le);
    const size = (TYPE_SIZE[type] || 1) * count;
    const valueOffset = size > 4 ? dv.getUint32(p + 8, le) : p + 8;
    out.entries.push({ tag, type, count, size, valueOffset, le });
    p += 12;
  }
  if (p + 4 <= dv.byteLength) out.next = dv.getUint32(p, le);
  return out;
}

function ascii(dv, e) {
  if (e.type !== 2) return null;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const off = e.valueOffset + i;
    if (off >= dv.byteLength) break;
    const c = dv.getUint8(off);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || null;
}

function readRationals(dv, e, want) {
  if (e.type !== 5) return null;
  const out = [];
  for (let i = 0; i < Math.min(e.count, want); i++) {
    const o = e.valueOffset + i * 8;
    if (o + 8 > dv.byteLength) return null;
    const num = dv.getUint32(o, e.le), den = dv.getUint32(o + 4, e.le);
    out.push(den ? num / den : 0);
  }
  return out.length === want ? out : null;
}

function readGps(dv, off, le) {
  let latRef = null, lonRef = null, lat = null, lon = null;
  for (const e of readIfd(dv, off, le).entries) {
    if (e.tag === 0x0001) latRef = ascii(dv, e);
    else if (e.tag === 0x0003) lonRef = ascii(dv, e);
    else if (e.tag === 0x0002) lat = readRationals(dv, e, 3);
    else if (e.tag === 0x0004) lon = readRationals(dv, e, 3);
  }
  if (!lat || !lon) return null;
  const dec = (dms, ref) => {
    const d = dms[0] + dms[1] / 60 + dms[2] / 3600;
    return (ref === 'S' || ref === 'W') ? -d : d;
  };
  return { lat: dec(lat, latRef), lon: dec(lon, lonRef) };
}

function readTiff(bytes, base, len) {
  if (len < 8 || base < 0 || base + len > bytes.length) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + base, len);
  const b0 = dv.getUint8(0), b1 = dv.getUint8(1);
  let le;
  if (b0 === 0x49 && b1 === 0x49) le = true;        // "II" little-endian
  else if (b0 === 0x4D && b1 === 0x4D) le = false;  // "MM" big-endian
  else return null;
  if (dv.getUint16(2, le) !== 42) return null;
  const out = {
    make: null, model: null, software: null, dateTime: null, dateTimeOriginal: null,
    artist: null, serial: null, hasGps: false, gps: null, hasThumbnail: false,
  };
  const ifd0 = readIfd(dv, dv.getUint32(4, le), le);
  let exifOff = 0;
  for (const e of ifd0.entries) {
    switch (e.tag) {
      case 0x010F: out.make     = ascii(dv, e); break;
      case 0x0110: out.model    = ascii(dv, e); break;
      case 0x0131: out.software = ascii(dv, e); break;
      case 0x0132: out.dateTime = ascii(dv, e); break;
      case 0x013B: out.artist   = ascii(dv, e); break;
      case 0x8769: exifOff = dv.getUint32(e.valueOffset, le); break; // Exif sub-IFD
      case 0x8825: {                                                // GPS IFD
        out.hasGps = true;
        out.gps = readGps(dv, dv.getUint32(e.valueOffset, le), le);
        break;
      }
    }
  }
  // A non-zero next-IFD pointer after IFD0 is IFD1 — the embedded thumbnail.
  if (ifd0.next > 0 && ifd0.next < dv.byteLength) {
    out.hasThumbnail = readIfd(dv, ifd0.next, le).entries.length > 0;
  }
  if (exifOff > 0) {
    for (const e of readIfd(dv, exifOff, le).entries) {
      if (e.tag === 0x9003) out.dateTimeOriginal = ascii(dv, e);
      else if (e.tag === 0xA431) out.serial = ascii(dv, e); // BodySerialNumber
    }
  }
  return out;
}

// ─── JPEG scanner ────────────────────────────────────────────────────────────

function scanJpeg(bytes) {
  if (!isJpegMagic(bytes)) return null;
  const segs = [];
  let p = 2;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xFF) break;                 // misaligned — bail
    let marker = bytes[p + 1];
    while (marker === 0xFF && p + 2 < bytes.length) { p++; marker = bytes[p + 1]; }
    if (marker === 0xD9) { segs.push({ marker, start: p, end: p + 2 }); break; }
    if (marker === 0xDA) { segs.push({ marker, start: p, sos: true }); break; }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      segs.push({ marker, start: p, end: p + 2 }); p += 2; continue;
    }
    if (p + 4 > bytes.length) break;
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (len < 2 || p + 2 + len > bytes.length) break;
    segs.push({ marker, start: p, end: p + 2 + len, dataStart: p + 4, dataLen: len - 2 });
    p += 2 + len;
  }
  return segs;
}

// Offset just past the EOI (FFD9) that ends the image, walking the entropy
// stream (and any further scans in a progressive JPEG). -1 when not found.
function jpegEndOffset(bytes) {
  const segs = scanJpeg(bytes);
  if (!segs) return -1;
  const sos = segs.find((s) => s.sos);
  if (!sos) {
    const eoi = segs.find((s) => s.marker === 0xD9);
    return eoi ? eoi.end : -1;
  }
  // Skip the SOS header, then scan entropy-coded data for a real marker.
  if (sos.start + 4 > bytes.length) return -1;
  const sosLen = (bytes[sos.start + 2] << 8) | bytes[sos.start + 3];
  let p = sos.start + 2 + sosLen;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xFF) { p++; continue; }
    const m = bytes[p + 1];
    if (m === 0x00 || (m >= 0xD0 && m <= 0xD7) || m === 0xFF) { p += 2; continue; } // stuffed / RST / fill
    if (m === 0xD9) return p + 2;                                  // EOI — done
    if (m === 0xDA) { p += 2; continue; }                          // next scan
    if (p + 4 > bytes.length) return -1;
    const len = (bytes[p + 2] << 8) | bytes[p + 3];                // table segment between scans
    if (len < 2 || p + 2 + len > bytes.length) return -1;
    p += 2 + len;
  }
  return -1;
}

function jpegDims(bytes) {
  for (const s of scanJpeg(bytes) || []) {
    const m = s.marker;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC && s.dataStart != null && s.dataLen >= 5) {
      const d = s.dataStart;
      return { w: (bytes[d + 3] << 8) | bytes[d + 4], h: (bytes[d + 1] << 8) | bytes[d + 2] };
    }
  }
  return null;
}

// ─── PNG scanner ─────────────────────────────────────────────────────────────

function scanPng(bytes) {
  const chunks = [];
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const end = p + 12 + len;
    if (end > bytes.length) break;
    chunks.push({ type, start: p, end, dataStart: p + 8, dataLen: len });
    p = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

function pngDims(bytes) {
  const c = scanPng(bytes)[0];
  if (!c || c.type !== 'IHDR' || c.dataLen < 8) return null;
  const d = c.dataStart;
  return {
    w: ((bytes[d] << 24) | (bytes[d + 1] << 16) | (bytes[d + 2] << 8) | bytes[d + 3]) >>> 0,
    h: ((bytes[d + 4] << 24) | (bytes[d + 5] << 16) | (bytes[d + 6] << 8) | bytes[d + 7]) >>> 0,
  };
}

// ─── WebP scanner ────────────────────────────────────────────────────────────

function scanWebp(bytes) {
  if (!isWebpMagic(bytes)) return null;
  const riffSize = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  const chunks = [];
  let p = 12;
  const end = Math.min(bytes.length, 8 + riffSize);
  while (p + 8 <= end) {
    const fourcc = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const len = (bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24)) >>> 0;
    const dataStart = p + 8;
    if (dataStart + len > bytes.length) break;
    chunks.push({ fourcc, start: p, dataStart, dataLen: len });
    p = dataStart + len + (len & 1); // chunks are padded to even length
  }
  return { riffSize, chunks };
}

function webpDims(bytes, scan) {
  const s = scan || scanWebp(bytes);
  if (!s) return null;
  for (const c of s.chunks) {
    const d = c.dataStart;
    if (c.fourcc === 'VP8X' && c.dataLen >= 10) {
      return {
        w: 1 + (bytes[d + 4] | (bytes[d + 5] << 8) | (bytes[d + 6] << 16)),
        h: 1 + (bytes[d + 7] | (bytes[d + 8] << 8) | (bytes[d + 9] << 16)),
      };
    }
    if (c.fourcc === 'VP8L' && c.dataLen >= 5 && bytes[d] === 0x2F) {
      const b = (bytes[d + 1] | (bytes[d + 2] << 8) | (bytes[d + 3] << 16) | (bytes[d + 4] << 24)) >>> 0;
      return { w: 1 + (b & 0x3FFF), h: 1 + ((b >> 14) & 0x3FFF) };
    }
    if (c.fourcc === 'VP8 ' && c.dataLen >= 10 && bytes[d + 3] === 0x9D && bytes[d + 4] === 0x01 && bytes[d + 5] === 0x2A) {
      return {
        w: (bytes[d + 6] | (bytes[d + 7] << 8)) & 0x3FFF,
        h: (bytes[d + 8] | (bytes[d + 9] << 8)) & 0x3FFF,
      };
    }
  }
  return null;
}

// ─── trailing bytes past the format terminator (the aCropalypse class) ──────

function trailingBytes(bytes, kind) {
  if (kind === 'PNG') {
    // No IEND, or a truncated chunk that stopped the scan early: everything
    // past the last whole chunk is unaccounted for — exactly the damaged
    // sources most likely to carry appended data, so count it rather than
    // failing open with 0.
    const chunks = scanPng(bytes);
    const last = chunks.length ? chunks[chunks.length - 1] : null;
    return last ? Math.max(0, bytes.length - last.end) : Math.max(0, bytes.length - 8);
  }
  if (kind === 'JPEG') {
    const end = jpegEndOffset(bytes);
    return end > 0 ? Math.max(0, bytes.length - end) : 0;
  }
  if (kind === 'WebP') {
    const s = scanWebp(bytes);
    if (!s || !(s.riffSize > 0)) return 0;
    const end = 8 + s.riffSize + (s.riffSize & 1);
    return Math.max(0, bytes.length - end);
  }
  return 0;
}

// ─── C2PA container presence (byte-scan only, never parsed) ──────────────────

function hasC2paBytes(bytes, kind) {
  if (kind === 'JPEG') {
    for (const s of scanJpeg(bytes) || []) {
      if (s.marker === 0xEB && s.dataStart != null) return true; // APP11 JUMBF
    }
  }
  if (kind === 'PNG') {
    for (const c of scanPng(bytes)) {
      if (c.type === 'caBX') return true;
      if (c.type === 'iTXt' && matchAscii(bytes, c.dataStart, 'c2pa')) return true;
    }
  }
  if (kind === 'WebP') {
    const s = scanWebp(bytes);
    for (const c of (s ? s.chunks : [])) {
      if (c.fourcc === 'C2PA' || c.fourcc === 'JUMB') return true;
    }
  }
  if (kind === 'PDF') {
    if (indexOfAscii(bytes, '/C2PA', 0) !== -1) return true;
  }
  // Generic fallback: a JUMBF superbox with a c2pa label anywhere in the file.
  return indexOfAscii(bytes, 'jumb', 0) !== -1 && indexOfAscii(bytes, 'c2pa', 0) !== -1;
}

// ─── SVG tokenizer (strip-data lineage — no DOMParser in the sandbox) ────────

function prefixOf(name) {
  const c = name.indexOf(':');
  return c > 0 ? name.slice(0, c).toLowerCase() : '';
}

const DROP_EL_PREFIX = new Set(['sodipodi', 'inkscape', 'i', 'x']); // i:/x: = Adobe private
// Vector redaction removes every never-paints, metadata-or-code element outright.
// title/desc are human-readable annotations, not artwork — they go too.
const DROP_EL_NAME = new Set(['metadata', 'script', 'foreignobject', 'title', 'desc']);
const SPACE_SENSITIVE = new Set(['text', 'tspan', 'textpath', 'tref', 'style', 'title', 'desc', 'script']);
const DROP_XMLNS = new Set([
  'xmlns:inkscape', 'xmlns:sodipodi', 'xmlns:i', 'xmlns:x',
  'xmlns:dc', 'xmlns:cc', 'xmlns:rdf',
]);

function shouldDropElement(name) {
  return DROP_EL_NAME.has(name.toLowerCase()) || DROP_EL_PREFIX.has(prefixOf(name));
}

function shouldDropAttr(name) {
  if (name === 'xml:space') return false;
  const lower = name.toLowerCase();
  if (DROP_EL_PREFIX.has(prefixOf(name))) return true;
  if (DROP_XMLNS.has(lower)) return true;
  if (lower.slice(0, 5) === 'data-') return true;   // data-* carries app payloads
  if (/^on[a-z]/.test(lower)) return true;          // event handlers are code
  return false;
}

// A data: href is an embedded payload (a data-URI JPEG carries its own EXIF);
// an http(s) href phones out when viewed. Neither may survive vector export.
// Internal '#id' references and relative paths are left alone.
function isRemoteOrDataHref(a) {
  const lower = a.name.toLowerCase();
  if (lower !== 'href' && lower !== 'xlink:href') return false;
  return !!a.value && /^\s*(?:data:|https?:)/i.test(a.value);
}

function parseAttrs(s) {
  const attrs = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;
  let m;
  while ((m = re.exec(s)) && m[0]) {
    const value = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : null));
    attrs.push({ name: m[1], value });
  }
  return attrs;
}

function parseTag(raw) {
  const selfClose = raw.endsWith('/>');
  const inner = raw.slice(1, selfClose ? -2 : -1);
  if (inner[0] === '/') return { t: 'close', name: inner.slice(1).trim(), raw };
  const m = /^\s*([^\s/>]+)/.exec(inner);
  const name = m ? m[1] : '';
  const attrs = m ? parseAttrs(inner.slice(m[0].length)) : [];
  return { t: selfClose ? 'self' : 'open', name, attrs, raw };
}

function tokenize(s) {
  const toks = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === '<') {
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        const close = end === -1 ? n : end + 3;
        toks.push({ t: 'comment', raw: s.slice(i, close), text: s.slice(i + 4, end === -1 ? n : end) });
        i = close;
      } else if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i + 9);
        const close = end === -1 ? n : end + 3;
        toks.push({ t: 'cdata', raw: s.slice(i, close), text: s.slice(i + 9, end === -1 ? n : end) });
        i = close;
      } else if (s.startsWith('<!', i)) {
        const end = s.indexOf('>', i);
        const close = end === -1 ? n : end + 1;
        toks.push({ t: 'doctype', raw: s.slice(i, close) });
        i = close;
      } else if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i);
        const close = end === -1 ? n : end + 2;
        const raw = s.slice(i, close);
        toks.push({ t: 'pi', raw, isXmlDecl: /^<\?xml\s/i.test(raw) });
        i = close;
      } else {
        let j = i + 1, q = 0;
        while (j < n) {
          const c = s[j];
          if (q) { if (c === q) q = 0; }
          else if (c === '"' || c === "'") q = c;
          else if (c === '>') break;
          j++;
        }
        const close = j < n ? j + 1 : n;
        toks.push(parseTag(s.slice(i, close)));
        i = close;
      }
    } else {
      const next = s.indexOf('<', i);
      const close = next === -1 ? n : next;
      toks.push({ t: 'text', raw: s.slice(i, close) });
      i = close;
    }
  }
  return toks;
}

// Only a unitless or px length is a natural-pixel size the browser preview
// uses. '100%', '210mm', '10em' etc. must NOT be taken as pixel dimensions —
// for those the viewBox is the drawing space, exactly as the browser resolves
// it. parseFloat would happily read '210mm' as 210 and misplace every bar.
function pxLength(v) {
  const m = /^\s*\+?(\d*\.?\d+)(?:px)?\s*$/i.exec(v == null ? '' : String(v));
  return m ? parseFloat(m[1]) : NaN;
}

function svgDims(text) {
  for (const tk of tokenize(text)) {
    if ((tk.t === 'open' || tk.t === 'self') && tk.name.toLowerCase() === 'svg') {
      let w = null, h = null, vb = null;
      for (const a of tk.attrs) {
        const lower = a.name.toLowerCase();
        if (lower === 'width') w = pxLength(a.value);
        else if (lower === 'height') h = pxLength(a.value);
        else if (lower === 'viewbox' && a.value) {
          const p = a.value.trim().split(/[\s,]+/).map(Number);
          if (p.length === 4 && isFinite(p[2]) && isFinite(p[3])) vb = { x: p[0], y: p[1], w: p[2], h: p[3] };
        }
      }
      const hasWh = isFinite(w) && isFinite(h) && w > 0 && h > 0;
      return {
        w: hasWh ? w : (vb ? vb.w : null),
        h: hasWh ? h : (vb ? vb.h : null),
        viewBox: vb,
        attrWh: hasWh,
      };
    }
  }
  return { w: null, h: null, viewBox: null, attrWh: false };
}

// ─── SVG deep analysis (redact adds code/embed findings to strip-data's set) ─

function analyzeSvg(text) {
  const findings = [];
  let editor = null, docName = null;
  let comments = 0, pathInComment = false, hasMetadata = false;
  let metaDepth = 0, metaParts = [];
  let scripts = 0, foreign = 0, handlers = 0, dataAttrs = 0;
  let embeddedImgs = 0, embeddedBytes = 0, dataFonts = 0, externalRefs = 0;
  let editorElements = false, adobePrivate = false;
  let styleDepth = 0, styleText = '';

  for (const tk of tokenize(text)) {
    if (metaDepth > 0 && tk.raw) metaParts.push(tk.raw);
    if (tk.t === 'comment') {
      comments++;
      const g = /Generator:\s*([^\n]*)/i.exec(tk.text);
      if (g && !editor) editor = g[1].replace(/-->\s*$/, '').replace(/,?\s*SVG (Export|Version).*$/i, '').trim();
      if (/[A-Za-z]:\\|\/Users\/|\/home\/|\.ai\b|\.eps\b|\.psd\b|\.sketch\b/.test(tk.text)) pathInComment = true;
    } else if (tk.t === 'open' || tk.t === 'self') {
      const lname = tk.name.toLowerCase();
      const pre = prefixOf(tk.name);
      if (lname === 'metadata') { hasMetadata = true; if (tk.t === 'open') metaDepth++; }
      if (lname === 'script') scripts++;
      if (lname === 'foreignobject') foreign++;
      if (lname === 'style' && tk.t === 'open') styleDepth++;
      if (pre === 'sodipodi' || pre === 'inkscape') editorElements = true;
      if (pre === 'i' || pre === 'x') adobePrivate = true;
      for (const a of tk.attrs) {
        const lower = a.name.toLowerCase();
        if (a.name === 'inkscape:version' && !editor) editor = 'Inkscape ' + (a.value || '').split(' ')[0];
        if (a.name === 'sodipodi:docname' && a.value) docName = a.value;
        if (/^on[a-z]/.test(lower)) handlers++;
        if (lower.slice(0, 5) === 'data-') dataAttrs++;
        if ((lower === 'href' || lower === 'xlink:href') && a.value) {
          if (/^data:image\//i.test(a.value)) {
            embeddedImgs++;
            const comma = a.value.indexOf(',');
            if (comma > -1) embeddedBytes += Math.floor((a.value.length - comma - 1) * 0.75);
          } else if (/^https?:/i.test(a.value)) externalRefs++;
        }
      }
    } else if (tk.t === 'close') {
      const lname = tk.name.toLowerCase();
      if (lname === 'metadata' && metaDepth > 0) metaDepth--;
      if (lname === 'style' && styleDepth > 0) styleDepth--;
    } else if (tk.t === 'text' || tk.t === 'cdata') {
      if (styleDepth > 0) styleText += tk.t === 'cdata' ? (tk.text || '') : tk.raw;
    }
  }

  const fontRe = /@font-face[^{}]*\{[^}]*\}/gi;
  let fm;
  while ((fm = fontRe.exec(styleText))) {
    if (/data:/i.test(fm[0])) dataFonts++;
  }

  let author = null;
  if (hasMetadata) {
    const meta = metaParts.join('');
    const cr = /<dc:(?:creator|rights)[^>]*>([\s\S]*?)<\/dc:(?:creator|rights)>/i.exec(meta);
    if (cr) { const t = cr[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); if (t) author = t; }
  }

  if (editor) findings.push({ label: 'Created with', detail: editor, tone: 'warn' });
  if (docName) findings.push({ label: 'Original filename', detail: docName, tone: 'warn' });
  if (author) findings.push({ label: 'Author', detail: author, tone: 'warn' });
  if (pathInComment) findings.push({ label: 'File path in comment', detail: 'a local path is embedded', tone: 'warn' });
  if (hasMetadata && !author) findings.push({ label: 'Metadata block', detail: 'embedded RDF or Dublin Core data', tone: '' });
  if (scripts) findings.push({ label: 'Scripts', detail: `${scripts} script element${scripts > 1 ? 's' : ''}, removed in both export modes`, tone: 'warn' });
  if (foreign) findings.push({ label: 'Foreign content', detail: `${foreign} foreignObject element${foreign > 1 ? 's' : ''} carrying non-SVG markup`, tone: 'warn' });
  if (handlers) findings.push({ label: 'Event handlers', detail: `${handlers} on* attribute${handlers > 1 ? 's' : ''}, code that runs when viewed`, tone: 'warn' });
  if (editorElements) findings.push({ label: 'Editor data', detail: 'Inkscape canvas, guides and settings', tone: '' });
  if (adobePrivate) findings.push({ label: 'Adobe private data', detail: 'Illustrator graphics format', tone: '' });
  if (dataAttrs) findings.push({ label: 'Data attributes', detail: `${dataAttrs} data-* attribute${dataAttrs > 1 ? 's' : ''} from an authoring app`, tone: '' });
  if (comments) findings.push({ label: 'Comments', detail: `${comments} comment${comments > 1 ? 's' : ''}`, tone: '' });
  if (embeddedImgs) findings.push({ label: 'Embedded images', detail: `${embeddedImgs} data-URI image${embeddedImgs > 1 ? 's' : ''}${embeddedBytes ? `, ~${fmtBytes(embeddedBytes)}` : ''}, each can carry its own EXIF`, tone: 'warn' });
  if (dataFonts) findings.push({ label: 'Embedded fonts', detail: `${dataFonts} data-URI @font-face block${dataFonts > 1 ? 's' : ''}, subset fonts reveal which glyphs the document used`, tone: '' });
  if (externalRefs) findings.push({ label: 'External references', detail: `${externalRefs} http(s) href${externalRefs > 1 ? 's' : ''}, viewing can phone out`, tone: 'warn' });
  return findings;
}

// ─── SVG vector-mode surgery ─────────────────────────────────────────────────
// REMOVE, never hide: metadata, comments, scripts, foreignObject, editor
// namespaces, data-* attributes, event handlers, @font-face data-URI blocks —
// then unreferenced defs entries, then the opaque bars are appended in root
// viewBox coordinates. What this deliberately does NOT do: delete positioned
// <text> under a bar. Glyph geometry is a layout computation this sandbox
// cannot do offline, so vector mode COVERS text and the UI says so plainly.
// Returns { out, removed } — removed is the string content that was inside
// deleted nodes, used by the export gate's grep.

function rebuildTag(tk) {
  const kept = [];
  for (const a of tk.attrs) {
    if (shouldDropAttr(a.name) || isRemoteOrDataHref(a)) continue;
    if (a.value == null) { kept.push(a.name); continue; }
    const quote = a.value.includes('"') ? "'" : '"';
    kept.push(`${a.name}=${quote}${a.value}${quote}`);
  }
  const body = tk.name + (kept.length ? ' ' + kept.join(' ') : '');
  return tk.t === 'self' ? `<${body}/>` : `<${body}>`;
}

function stripFontFaceDataUris(css) {
  return css.replace(/@font-face[^{}]*\{[^}]*\}/gi, (rule) => (/data:/i.test(rule) ? '' : rule));
}

function cleanSvgTokens(toks, removed) {
  const out = [];
  const stack = [];
  let dropName = null, dropDepth = 0;
  let styleDepth = 0;

  for (const tk of toks) {
    if (dropDepth > 0) {
      // Inside a deleted subtree: collect its text so the gate can grep for it.
      if (tk.t === 'text' || tk.t === 'cdata') removed.push(tk.t === 'cdata' ? (tk.text || '') : tk.raw);
      if (tk.t === 'open' && tk.name === dropName) dropDepth++;
      else if (tk.t === 'close' && tk.name === dropName) dropDepth--;
      continue;
    }
    switch (tk.t) {
      case 'comment':
        removed.push(tk.text || '');
        break;
      case 'doctype':
        break;
      case 'pi':
        if (tk.isXmlDecl) out.push(tk.raw);
        break;
      case 'cdata':
        if (styleDepth > 0) {
          const kept = stripFontFaceDataUris(tk.text || '');
          out.push(`<![CDATA[${kept}]]>`);
        } else {
          out.push(tk.raw);
        }
        break;
      case 'text': {
        if (styleDepth > 0) { out.push(stripFontFaceDataUris(tk.raw)); break; }
        const sensitive = stack.length && SPACE_SENSITIVE.has(stack[stack.length - 1]);
        if (!sensitive && /^\s*$/.test(tk.raw)) break;
        out.push(tk.raw);
        break;
      }
      case 'open':
      case 'self': {
        if (shouldDropElement(tk.name)) {
          if (tk.t === 'open') { dropName = tk.name; dropDepth = 1; }
          break;
        }
        // An <image> whose href is a data: URI or an external URL is a payload
        // of its own — the whole element goes, and the href joins the grep
        // list so the gate proves it is gone.
        if (tk.name.toLowerCase() === 'image' && tk.attrs.some(isRemoteOrDataHref)) {
          for (const a of tk.attrs) if (isRemoteOrDataHref(a)) removed.push(a.value);
          if (tk.t === 'open') { dropName = tk.name; dropDepth = 1; }
          break;
        }
        // Dropped ATTRIBUTE values are editor housekeeping (data-name="Layer 2"
        // pairs with a kept id="Layer_2"), not secret content — they stay out
        // of the grep list; residualSvg proves the attribute classes are gone.
        // External and data: hrefs on other elements (an <a>, a remote <use>)
        // are stripped and DO join the grep list.
        const hasDroppable = tk.attrs.some((a) => shouldDropAttr(a.name) || isRemoteOrDataHref(a));
        if (hasDroppable) {
          for (const a of tk.attrs) if (isRemoteOrDataHref(a)) removed.push(a.value);
          out.push(rebuildTag(tk));
        } else {
          out.push(tk.raw);
        }
        if (tk.t === 'open') {
          stack.push(tk.name.toLowerCase());
          if (tk.name.toLowerCase() === 'style') styleDepth++;
        }
        break;
      }
      case 'close': {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k] === tk.name.toLowerCase()) { stack.length = k; break; }
        }
        if (tk.name.toLowerCase() === 'style' && styleDepth > 0) styleDepth--;
        out.push(tk.raw);
        break;
      }
    }
  }
  return out.join('');
}

// Second pass: drop <defs> children whose id is no longer referenced anywhere
// in the cleaned output (a removed consumer must not leave its master behind).
// Scoped to defs on purpose — an unreferenced id on a painting element outside
// defs still renders, so deleting it would change the artwork.
function dropUnreferencedDefs(svgText) {
  const referenced = new Set();
  let m;
  const urlRe = /url\(\s*["']?#([^)"'\s]+)/g;
  while ((m = urlRe.exec(svgText))) referenced.add(m[1]);
  const hrefRe = /(?:xlink:)?href\s*=\s*["']#([^"']+)["']/g;
  while ((m = hrefRe.exec(svgText))) referenced.add(m[1]);

  const out = [];
  const toks = tokenize(svgText);
  let defsDepth = 0, dropName = null, dropDepth = 0;
  for (const tk of toks) {
    if (dropDepth > 0) {
      if (tk.t === 'open' && tk.name === dropName) dropDepth++;
      else if (tk.t === 'close' && tk.name === dropName) dropDepth--;
      continue;
    }
    if (tk.t === 'open' || tk.t === 'self') {
      const lname = tk.name.toLowerCase();
      if (defsDepth === 1 && lname !== 'defs') {
        const idAttr = tk.attrs.find((a) => a.name.toLowerCase() === 'id');
        if (idAttr && idAttr.value && !referenced.has(idAttr.value)) {
          if (tk.t === 'open') { dropName = tk.name; dropDepth = 1; }
          continue;
        }
      }
      if (lname === 'defs' && tk.t === 'open') defsDepth++;
    } else if (tk.t === 'close' && tk.name.toLowerCase() === 'defs' && defsDepth > 0) {
      defsDepth--;
    }
    out.push(tk.raw);
  }
  return out.join('');
}

function svgWithBars(svgText, rects, vb) {
  if (!rects.length) return svgText;
  // Tolerate whitespace in the close tag ('</svg >'); a document whose bars
  // cannot be inserted must fail loudly, never ship without them.
  let close = -1, m;
  const closeRe = /<\/svg\s*>/gi;
  while ((m = closeRe.exec(svgText))) close = m.index;
  if (close === -1) {
    throw new Error('Verification failed: the redaction bars could not be placed in this SVG. Nothing was downloaded.');
  }
  const parts = rects.map((r) => {
    const x = vb.x + r.x0, y = vb.y + r.y0;
    return `<rect x="${x}" y="${y}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" fill="#000000" fill-opacity="1"/>`;
  });
  return `${svgText.slice(0, close)}<g>${parts.join('')}</g>${svgText.slice(close)}`;
}

// ─── bars: parsing, snapping, quantising, coverage ───────────────────────────

// Bars arrive as blocks rows (page/x/y/w/h). Values can be strings from URL
// mode, so coerce; a bar with no area is ignored.
function parseBars(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const page = Math.max(1, Math.round(Number(row.page)) || 1);
    const x = Number(row.x), y = Number(row.y), w = Number(row.w), h = Number(row.h);
    if (!isFinite(x) || !isFinite(y) || !(w > 0) || !(h > 0)) continue;
    out.push({ page, x, y, w, h });
  }
  return out;
}

// Every row, coerced but NOT area-filtered — the canvas round-trip. The canvas
// script commits the whole array back on each draw/delete, so a half-typed
// sidebar row (w and h still 0) must survive that round-trip instead of
// vanishing under the user's cursor. parseBars stays the geometry filter for
// coverage, burning and export; this is only for data-bars.
function barRows(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    out.push({
      page: Math.max(1, Math.round(Number(row.page)) || 1),
      x: num(row.x), y: num(row.y), w: num(row.w), h: num(row.h),
    });
  }
  return out;
}

const INFLATE_PX = 2;   // chroma-subsampling edge bleed margin, each side
const QUANT_GRID = 24;  // widths round UP to this grid when quantise is on

// The one shared geometry: integer-snapped, inflated, optionally width-
// quantised, clamped to the frame. Preview coverage, the canvas burn and the
// output verification all use exactly this rect, so what the meter reports is
// what gets painted and what gets checked.
function effectiveRect(bar, W, H, quantise) {
  let x0 = Math.floor(bar.x) - INFLATE_PX;
  let y0 = Math.floor(bar.y) - INFLATE_PX;
  let x1 = Math.ceil(bar.x + bar.w) + INFLATE_PX;
  let y1 = Math.ceil(bar.y + bar.h) + INFLATE_PX;
  if (quantise) {
    const w = x1 - x0;
    const qw = Math.ceil(w / QUANT_GRID) * QUANT_GRID;
    const extra = qw - w;
    x0 -= Math.floor(extra / 2);
    x1 += Math.ceil(extra / 2);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

function rectsFor(bars, W, H, quantise, page) {
  const out = [];
  for (const b of bars) {
    if ((b.page || 1) !== (page || 1)) continue;
    const r = effectiveRect(b, W, H, quantise);
    if (r) out.push(r);
  }
  return out;
}

// Union coverage of the repainted pixels, computed on a 100x100 occupancy grid
// so overlapping bars aren't double-counted. Accurate to about 1%.
function coveragePercent(rects, W, H) {
  if (!rects.length || !(W > 0) || !(H > 0)) return 0;
  const G = 100;
  const grid = new Uint8Array(G * G);
  for (const r of rects) {
    const cx0 = Math.max(0, Math.floor(r.x0 / W * G));
    const cy0 = Math.max(0, Math.floor(r.y0 / H * G));
    const cx1 = Math.min(G, Math.ceil(r.x1 / W * G));
    const cy1 = Math.min(G, Math.ceil(r.y1 / H * G));
    for (let cy = cy0; cy < cy1; cy++) {
      for (let cx = cx0; cx < cx1; cx++) grid[cy * G + cx] = 1;
    }
  }
  let n = 0;
  for (let i = 0; i < grid.length; i++) n += grid[i];
  return Math.min(100, Math.round(n / (G * G) * 100));
}

// ─── preset bar heights (the canvas rail's Line / Heading / Block buttons) ───
// Fractions of the frame height, so a preset reads the same on an A4 page and a
// phone screenshot. The template script multiplies the fraction by the frame's
// own coordinate space (PDF points or natural pixels) — the constants live HERE,
// once, and ship to the canvas as JSON so the script never re-declares them.

const PRESET_FRACS = { line: 0.02, heading: 0.038, block: 0.14 };
const PRESET_MIN = 6; // floor in frame units, so a tiny image still gets a visible bar

function presetBarHeight(preset, frameH) {
  if (!Object.prototype.hasOwnProperty.call(PRESET_FRACS, preset)) return null;
  if (!(frameH > 0)) return null;
  return Math.max(PRESET_MIN, Math.round(frameH * PRESET_FRACS[preset]));
}

// ─── advisories (transient toasts, not prose walls) ─────────────────────────
// Guidance arrives as the user edits, one short sentence at a time. Each key
// fires at most once per file (the seen set); at most one toast per patch. The
// picker is pure — it never mutates `seen`, the caller marks a key seen only
// when it actually emits the toast.

const THIN_BAR_PT = 8;   // a bar under this height in PDF points can hint at what it hides
const THIN_BAR_PX = 11;  // the same threshold for pixel-space frames (8pt at 96 dpi)

function thinBarLimit(isPdf) {
  return isPdf ? THIN_BAR_PT : THIN_BAR_PX;
}

function joinPages(list) {
  return list.join(', ').replace(/, ([^,]*)$/, ' and $1');
}

// state: { pagesFailed: number[], pagesTruncated, barsEdited, barCount,
//          isImage, hasThinBar }. Returns { key, text } or null.
function advisoryFor(state, seen) {
  const cands = [];
  const failed = Array.isArray(state.pagesFailed) ? state.pagesFailed : [];
  if (failed.length) {
    const list = joinPages(failed);
    cands.push({
      key: 'pages-failed',
      text: failed.length > 1
        ? `Pages ${list} could not be rendered, so their previews are missing. The export refuses to ship a page that fails to render.`
        : `Page ${list} could not be rendered, so its preview is missing. The export refuses to ship a page that fails to render.`,
    });
  }
  if (state.pagesTruncated) {
    cands.push({ key: 'pages-truncated', text: 'Not every page could be previewed. Only pages with a preview can be marked here.' });
  }
  if (state.barsEdited && state.barCount > 0) {
    cands.push({ key: 'first-bar', text: 'Covered content is destroyed when the file is rebuilt, not hidden.' });
    if (state.isImage) {
      cands.push({ key: 'image-mark', text: 'Whole-image watermarks survive partial cover. This tool removes what you mark, it does not launder provenance.' });
    }
    if (state.hasThinBar) {
      cands.push({ key: 'thin-bar', text: 'A very thin bar can hint at what it hides.' });
    }
  }
  for (const c of cands) {
    if (!seen.has(c.key)) return c;
  }
  return null;
}

// Seen keys per file identity — a new file starts a clean advisory slate.
let _advice = { key: '', seen: new Set() };

function adviceSeenFor(fileKey) {
  if (_advice.key !== fileKey) _advice = { key: fileKey, seen: new Set() };
  return _advice.seen;
}

// ─── raster analysis ─────────────────────────────────────────────────────────

function gpsDetail(gps) {
  return gps ? `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` : 'present';
}

function exifFindings(exif, findings) {
  if (!exif) return;
  if (exif.hasGps) findings.push({ label: 'GPS location', detail: gpsDetail(exif.gps), tone: 'warn' });
  if (exif.make || exif.model) findings.push({ label: 'Camera / device', detail: [exif.make, exif.model].filter(Boolean).join(' '), tone: 'warn' });
  if (exif.serial) findings.push({ label: 'Camera serial number', detail: exif.serial, tone: 'warn' });
  if (exif.artist) findings.push({ label: 'Author', detail: exif.artist, tone: 'warn' });
  if (exif.dateTimeOriginal || exif.dateTime) findings.push({ label: 'Date taken', detail: exif.dateTimeOriginal || exif.dateTime, tone: '' });
  if (exif.software) findings.push({ label: 'Software', detail: exif.software, tone: '' });
  if (exif.hasThumbnail) findings.push({ label: 'Embedded thumbnail', detail: 'a small preview inside the EXIF block, it may show the un-cropped original', tone: 'warn' });
}

function trailingFinding(bytes, kind, findings) {
  const extra = trailingBytes(bytes, kind);
  if (extra > 0) {
    findings.push({
      label: 'Data after end of image',
      detail: `${fmtBytes(extra)} past the ${kind} terminator, it may include an earlier un-cropped or un-redacted version`,
      tone: 'warn',
    });
  }
}

function c2paFinding(bytes, kind, findings) {
  if (hasC2paBytes(bytes, kind)) {
    findings.push({
      label: 'Content Credentials (C2PA)',
      detail: 'the manifest can carry a pixel-accurate thumbnail of the un-redacted original',
      tone: 'warn',
    });
  }
}

function analyzeJpeg(bytes) {
  const findings = [];
  let exif = null, xmp = false, icc = false, iptc = false, comment = false, mpf = false;
  for (const s of scanJpeg(bytes) || []) {
    if (s.dataStart == null) continue;
    if (s.marker === 0xE1) {
      if (matchAscii(bytes, s.dataStart, 'Exif\0\0')) exif = readTiff(bytes, s.dataStart + 6, s.dataLen - 6);
      else if (matchAscii(bytes, s.dataStart, 'http://ns.adobe.com/xap/')) xmp = true;
    } else if (s.marker === 0xE2) {
      if (matchAscii(bytes, s.dataStart, 'ICC_PROFILE\0')) icc = true;
      else if (matchAscii(bytes, s.dataStart, 'MPF\0')) mpf = true;
    } else if (s.marker === 0xED) iptc = true;
    else if (s.marker === 0xFE) comment = true;
  }
  exifFindings(exif, findings);
  if (exif) findings.push({ label: 'EXIF block', detail: 'camera and shooting data', tone: '' });
  if (xmp) findings.push({ label: 'XMP metadata', detail: 'editing and rights data', tone: '' });
  if (icc) findings.push({ label: 'ICC colour profile', detail: 'embedded profile', tone: '' });
  if (iptc) findings.push({ label: 'IPTC / Photoshop', detail: 'caption and author data (8BIM)', tone: '' });
  if (comment) findings.push({ label: 'Comment', detail: 'embedded text', tone: '' });
  if (mpf) findings.push({ label: 'Extra pictures (MPF)', detail: 'later pictures may show unredacted content, the export keeps the visible image only', tone: 'warn' });
  c2paFinding(bytes, 'JPEG', findings);
  trailingFinding(bytes, 'JPEG', findings);
  return findings;
}

function analyzePng(bytes) {
  const findings = [];
  let exif = null, texts = 0, time = false, icc = false, animated = false;
  for (const c of scanPng(bytes)) {
    if (c.type === 'eXIf') exif = readTiff(bytes, c.dataStart, c.dataLen);
    else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') texts++;
    else if (c.type === 'tIME') time = true;
    else if (c.type === 'iCCP') icc = true;
    else if (c.type === 'acTL') animated = true;
  }
  exifFindings(exif, findings);
  if (exif) findings.push({ label: 'EXIF block', detail: 'embedded camera data', tone: '' });
  if (texts) findings.push({ label: 'Text chunks', detail: `${texts} text/metadata chunk${texts > 1 ? 's' : ''}`, tone: '' });
  if (icc) findings.push({ label: 'ICC colour profile', detail: 'embedded profile', tone: '' });
  if (time) findings.push({ label: 'Timestamp', detail: 'last-modified time', tone: '' });
  if (animated) findings.push({ label: 'Animated PNG', detail: 'later frames may show unredacted content, the export keeps the visible frame only', tone: 'warn' });
  c2paFinding(bytes, 'PNG', findings);
  trailingFinding(bytes, 'PNG', findings);
  return findings;
}

function analyzeWebp(bytes) {
  const findings = [];
  const scan = scanWebp(bytes);
  let exif = null, xmp = false, icc = false, animated = false;
  for (const c of (scan ? scan.chunks : [])) {
    if (c.fourcc === 'EXIF') exif = readTiff(bytes, c.dataStart, c.dataLen) || readTiff(bytes, c.dataStart + 6, c.dataLen - 6);
    else if (c.fourcc === 'XMP ') xmp = true;
    else if (c.fourcc === 'ICCP') icc = true;
    else if (c.fourcc === 'ANIM' || c.fourcc === 'ANMF') animated = true;
    else if (c.fourcc === 'VP8X' && c.dataLen >= 1 && (bytes[c.dataStart] & 0x02)) animated = true;
  }
  exifFindings(exif, findings);
  if (exif) findings.push({ label: 'EXIF block', detail: 'embedded camera data', tone: '' });
  if (xmp) findings.push({ label: 'XMP metadata', detail: 'editing and rights data', tone: '' });
  if (icc) findings.push({ label: 'ICC colour profile', detail: 'embedded profile', tone: '' });
  if (animated) findings.push({ label: 'Animated WebP', detail: 'later frames may show unredacted content, the export keeps the visible frame only', tone: 'warn' });
  c2paFinding(bytes, 'WebP', findings);
  trailingFinding(bytes, 'WebP', findings);
  return findings;
}

// ─── PDF analysis (structure via host.pdf.analyze, byte scans in-sandbox) ────

// One in-flight (or settled) analyze job keyed on file identity, so re-renders
// during a slow analyze share a single run (compress-pdf's _job pattern).
let _pdfJob = { key: '', promise: null, result: null, error: false };
// Both waits happen inside ONE onInput pass, whose runtime budget is 2000ms
// (HOOK_BUDGET_MS — an overrun DISCARDS the whole patch, so the drop would look
// dead). They run concurrently in patch(), so the wall-time worst case is
// max(PAGES, PREVIEW) plus the synchronous byte scans — keep that under ~1.5s.
const PREVIEW_BUDGET_MS = 1200;
const PAGES_BUDGET_MS = 1400;

// ─── PDF page previews (host.pdf.pages, feature-detected) ────────────────────
// One render job per file identity. The job object carries its own settled
// state (result/error) so a later re-render can read it synchronously — the
// template poll re-commits the bars array until the job settles, and the
// settled result must be pick-up-able without another await race.
// Object URLs created for page SVGs are tracked module-level and revoked when
// the file changes (a new key retires the old job's URLs).

let _pagesJob = { key: '', promise: null, result: null, error: null };
let _pageUrls = [];

function revokeUrls(urls) {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    for (const u of urls) {
      try { URL.revokeObjectURL(u); } catch (e) { /* already gone */ }
    }
  }
}

// Old page URLs are revoked on a DELAY, not immediately: the runtime's
// immediate pre-hook emit repaints the OLD extras, so fresh <img> elements can
// still be loading these URLs for a beat after a new file lands (the patch
// itself takes up to the 1400ms pages budget). 1.5s outlives that window.
const URL_RETIRE_MS = 1500;

function retirePageUrls() {
  const old = _pageUrls;
  _pageUrls = [];
  if (!old.length) return;
  if (typeof setTimeout === 'function') setTimeout(() => revokeUrls(old), URL_RETIRE_MS);
  else revokeUrls(old);
}

// Called whenever the loaded file is no longer a PDF (replaced with an image,
// cleared, unsupported) — without this, replacing a 40-page PDF with a JPEG
// left every page blob URL alive until the next PDF or page unload.
function resetPagesJob() {
  if (_pagesJob.key || _pagesJob.promise) {
    _pagesJob = { key: '', promise: null, result: null, error: null };
  }
  retirePageUrls();
}

// Preview URL for one page SVG: object URL when the globals exist (browser),
// data: URL otherwise (node/CLI shells with no Blob/URL.createObjectURL).
function svgPreviewUrl(svg) {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
    try {
      const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      _pageUrls.push(u);
      return u;
    } catch (e) { /* fall through to data: */ }
  }
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function pdfPagesJobFor(host, f, key) {
  if (_pagesJob.key === key && _pagesJob.promise) return _pagesJob;
  retirePageUrls();
  const job = { key, promise: null, result: null, error: null };
  job.promise = Promise.resolve()
    .then(() => host.pdf.pages(f.bytes))
    .then((res) => {
      const pages = res && Array.isArray(res.pages) ? res.pages : [];
      job.result = {
        pages: pages.map((p) => ({
          url: svgPreviewUrl(p.svg),
          page: p.page,
          w: p.widthPt,
          h: p.heightPt,
        })),
        truncated: Boolean(res && res.truncated),
        // 1-based pages the shell could not render (v1.85 additive field) —
        // surfaced as a note so a missing page never passes silently.
        failed: res && Array.isArray(res.failed) ? res.failed.filter((n) => isFinite(n)) : [],
      };
    })
    .catch((e) => {
      job.error = (e && e.message) ? e.message : 'Page rendering failed.';
    });
  _pagesJob = job;
  return job;
}

// Analyze job: same settled-state shape as the pages job. A rejection is a
// terminal error state, NOT a reset — resetting retried the failing analyze on
// every onInput (including every poll tick) while the UI claimed "still
// reading" forever. The error sticks per file identity and the template says
// plainly that the structural checks did not run.
function pdfJobFor(host, f, key) {
  if (_pdfJob.key === key && _pdfJob.promise) return _pdfJob;
  const job = { key, promise: null, result: null, error: false };
  job.promise = Promise.resolve()
    .then(() => host.pdf.analyze(f.bytes))
    .then((res) => { job.result = res || { findings: [] }; })
    .catch(() => { job.error = true; });
  _pdfJob = job;
  return job;
}

function withBudget(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, ms);
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(t); resolve(null); } }
    );
  });
}

function pdfByteFindings(bytes) {
  const findings = [];
  const eofs = countAscii(bytes, '%%EOF');
  if (eofs > 1) {
    findings.push({
      label: 'Earlier document versions',
      detail: `${eofs} end-of-file markers, incremental saves can keep earlier content recoverable`,
      tone: 'warn',
    });
  }
  c2paFinding(bytes, 'PDF', findings);
  return findings;
}

// ─── lifecycle: analysis + live mark feedback ────────────────────────────────

async function patch(ctx) {
  const { model, host } = ctx;
  // The input id that triggered this pass ('' for onInit) — bar advisories only
  // fire on a real bars edit, never on hydration of a URL-restored session.
  const trigger = ctx.id || '';
  const inputs = inputsFrom(model);
  const f = inputs.source;
  // NOTE: no key returned here may match a declared input id (source, bars,
  // quantise, grayscale, svgVector, resign) — those would write back into the
  // model. The template reads the toggles by id straight from the input values.
  const blank = {
    hasFile: false, supported: false, pdfUnavailable: false, pdfRedactUnavailable: false,
    fileName: '', fileSize: '', kind: '',
    isRaster: false, isSvg: false, isPdfKind: false, vectorMode: false,
    previewUrl: '', barsJson: '[]',
    findings: [], foundSummary: '', nothingFound: false, analysisPending: false, analysisFailed: false,
    barCount: 0, barPlural: false, hasBars: false, coveragePct: 0, hasCoverage: false,
    coverageText: '', coverageHigh: false,
    pageBars: [], hasPageBars: false, resignUnavailable: false,
    pdfPages: [], hasPdfPages: false, pagesPending: false, pagesError: '', pagesTruncated: false,
    toastKey: '', toastText: '',
    presetsJson: JSON.stringify(PRESET_FRACS),
    downloadLabel: 'Download redacted copy',
  };
  if (!f || !f.bytes) { resetPagesJob(); return blank; }

  const base = { ...blank, hasFile: true, fileName: f.name, fileSize: fmtBytes(f.size) };
  const info = classify(f.bytes);
  base.kind = info.kind;
  if (info.kind !== 'PDF') resetPagesJob(); // a non-PDF replacing a PDF retires the page URLs
  if (info.kind === 'file') return base; // supported stays false → guidance

  const bars = parseBars(inputs.bars);
  const quantise = inputs.quantise !== false;
  base.barCount = bars.length;
  base.barPlural = bars.length > 1;
  base.hasBars = bars.length > 0;
  // The canvas gets EVERY row (coerced, not filtered): its commits echo the
  // whole array back, so an incomplete sidebar row must round-trip intact.
  base.barsJson = JSON.stringify(barRows(inputs.bars));

  if (info.kind === 'PDF') {
    base.isPdfKind = true;
    if (!host || !host.pdf || typeof host.pdf.analyze !== 'function') {
      return { ...base, supported: true, pdfUnavailable: true };
    }
    base.supported = true;
    base.pdfRedactUnavailable = typeof host.pdf.redact !== 'function';
    base.resignUnavailable = Boolean(inputs.resign)
      && !(host.c2pa && typeof host.c2pa.sign === 'function');

    const fileKey = `${f.url || ''}|${f.name}|${f.size}`;
    let failedPages = [];

    // Start the analyze wait FIRST so its budget timer runs concurrently with
    // the pages wait below. Awaiting them sequentially summed the budgets
    // (1800 + 1200 = 3000ms on a slow scanned PDF), which blew the runtime's
    // 2000ms onInput box — the patch was discarded and the drop looked dead.
    const analyzeJob = pdfJobFor(host, f, fileKey);
    const analyzeWait = (analyzeJob.result || analyzeJob.error)
      ? null
      : withBudget(analyzeJob.promise, PREVIEW_BUDGET_MS);

    // Page previews: render every page to a self-contained SVG in the shell
    // (host.pdf.pages), budgeted so a slow render never blocks the paint. The
    // template polls (re-committing the bars array) until the job settles.
    if (typeof host.pdf.pages === 'function') {
      const job = pdfPagesJobFor(host, f, fileKey);
      if (!job.result && !job.error) await withBudget(job.promise, PAGES_BUDGET_MS);
      if (job.result) {
        base.pdfPages = job.result.pages;
        base.hasPdfPages = job.result.pages.length > 0;
        base.pagesTruncated = job.result.truncated;
        failedPages = job.result.failed || [];
      } else if (job.error) {
        base.pagesError = 'The page previews could not be rendered. The analysis below still applies.';
      } else {
        base.pagesPending = true;
      }
    }

    let findings = pdfByteFindings(f.bytes);
    if (analyzeWait) await analyzeWait;
    const res = analyzeJob.result;
    if (res && Array.isArray(res.findings)) findings = findings.concat(res.findings);
    else if (analyzeJob.error) base.analysisFailed = true;
    else if (!res) base.analysisPending = true;
    base.findings = findings;
    base.nothingFound = !base.analysisPending && !base.analysisFailed && findings.length === 0;
    base.foundSummary = findings.length
      ? `Found ${findings.length} item${findings.length > 1 ? 's' : ''} of hidden or non-visible data.`
      : '';

    // Per-page bar counts (bars are in PDF points, page origin top-left) —
    // shown when page previews are unavailable so sidebar-set bars still get
    // live feedback. Text hit-testing would mean re-implementing PDF text
    // extraction in the sandbox, which is out of scope on purpose.
    const perPage = new Map();
    for (const b of bars) perPage.set(b.page, (perPage.get(b.page) || 0) + 1);
    base.pageBars = [...perPage.keys()].sort((a, b) => a - b)
      .map((p) => ({ page: p, count: perPage.get(p), plural: perPage.get(p) > 1 }));
    base.hasPageBars = base.pageBars.length > 0;
    base.downloadLabel = 'Download redacted PDF';

    // One advisory toast at most, each key once per file. Bar advisories only
    // on a real bars edit; page advisories on whichever pass first sees them.
    const seen = adviceSeenFor(fileKey);
    const adv = advisoryFor({
      pagesFailed: failedPages,
      pagesTruncated: base.pagesTruncated,
      barsEdited: trigger === 'bars',
      barCount: bars.length,
      isImage: false,
      hasThinBar: bars.some((b) => b.h < thinBarLimit(true)),
    }, seen);
    if (adv) {
      seen.add(adv.key);
      // The DOM dedupe marker needs file identity too, so a NEW file's first
      // toast is never suppressed by the previous file's dismissal record.
      base.toastKey = `${adv.key}@${f.name}:${f.size}`;
      base.toastText = adv.text;
    }
    return base;
  }

  base.supported = true;
  base.previewUrl = f.url || '';
  base.isSvg = info.kind === 'SVG';
  base.isRaster = !base.isSvg;
  // Vector mode is only real for an SVG — the svgVector toggle can be left on
  // from an earlier file, and the raster copy must not flip on a JPEG.
  base.vectorMode = base.isSvg && Boolean(inputs.svgVector);

  let findings = [];
  try {
    if (info.kind === 'JPEG') findings = analyzeJpeg(f.bytes);
    else if (info.kind === 'PNG') findings = analyzePng(f.bytes);
    else if (info.kind === 'WebP') findings = analyzeWebp(f.bytes);
    else if (info.kind === 'SVG') findings = analyzeSvg(info.text);
  } catch (e) { findings = []; }
  base.findings = findings;
  base.nothingFound = findings.length === 0;
  base.foundSummary = findings.length
    ? `Found ${findings.length} item${findings.length > 1 ? 's' : ''} of hidden or non-visible data. All of it goes when the file is rebuilt.`
    : '';

  // Coverage: % of pixels the effective bar rects repaint. Dimensions come
  // from the file header, so this stays sandbox-pure. (For a rotated JPEG the
  // header dims are pre-orientation, so treat the number as approximate.)
  let dims = null;
  try {
    if (info.kind === 'JPEG') dims = jpegDims(f.bytes);
    else if (info.kind === 'PNG') dims = pngDims(f.bytes);
    else if (info.kind === 'WebP') dims = webpDims(f.bytes);
    else if (info.kind === 'SVG') { const d = svgDims(info.text); dims = d.w && d.h ? { w: d.w, h: d.h } : null; }
  } catch (e) { dims = null; }
  if (dims && bars.length) {
    const rects = rectsFor(bars, dims.w, dims.h, quantise, 1);
    const pct = coveragePercent(rects, dims.w, dims.h);
    base.coveragePct = pct;
    base.hasCoverage = true;
    // Honest verb per mode: raster paths destroy the pixels, vector mode only
    // covers what sits under the bar.
    base.coverageText = base.vectorMode
      ? `${bars.length} mark${bars.length > 1 ? 's' : ''} will cover about ${pct}% of the frame.`
      : `${bars.length} mark${bars.length > 1 ? 's' : ''} will repaint about ${pct}% of the pixels.`;
    base.coverageHigh = pct >= 97;
  }

  base.downloadLabel = base.isSvg
    ? (inputs.svgVector ? 'Download redacted SVG' : 'Download redacted PNG')
    : `Download redacted ${info.kind}`;

  const seen = adviceSeenFor(`${f.url || ''}|${f.name}|${f.size}`);
  const adv = advisoryFor({
    pagesFailed: [],
    pagesTruncated: false,
    barsEdited: trigger === 'bars',
    barCount: bars.length,
    isImage: true,
    hasThinBar: bars.some((b) => b.h < thinBarLimit(false)),
  }, seen);
  if (adv) {
    seen.add(adv.key);
    base.toastKey = `${adv.key}@${f.name}:${f.size}`;
    base.toastText = adv.text;
  }
  return base;
}

function onInit(ctx) { return patch(ctx); }
function onInput(ctx) { return patch(ctx); }

// ─── export helpers (browser canvas — guarded, filter-halftone pattern) ─────

function canRaster() {
  if (typeof document === 'undefined' || !document.createElement) return false;
  try { const c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d')); }
  catch (e) { return false; }
}

const HEADLESS_MSG = 'Redacting this file needs a browser canvas. Open this tool in the Lolly web app.';

function loadImageFromBytes(bytes, mime) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      reject(new Error(HEADLESS_MSG));
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be decoded as an image.')); };
    im.src = url;
  });
}

// Decode with EXIF orientation applied, so bars drawn on the (oriented) preview
// land on the same pixels here. createImageBitmap first, <img> fallback —
// browsers orient both by default.
async function decodeImage(bytes, mime) {
  if (typeof createImageBitmap === 'function') {
    const blob = new Blob([bytes], { type: mime });
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) { try { return await createImageBitmap(blob); } catch (e2) { /* fall through */ } }
  }
  return loadImageFromBytes(bytes, mime);
}

function encodeCanvas(canvas, mime, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') { reject(new Error(HEADLESS_MSG)); return; }
    canvas.toBlob((b) => { b ? resolve(b) : reject(new Error('The browser could not encode the redacted image.')); }, mime, quality);
  });
}

// Composite onto opaque white (kills alpha-hidden content), optional grayscale
// pass, then the bars at 100% opaque black. Returns the canvas.
function drawRedacted(img, W, H, rects, grayscale) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(HEADLESS_MSG);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  if (grayscale) {
    const id = ctx.getImageData(0, 0, W, H);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      d[i] = y; d[i + 1] = y; d[i + 2] = y;
      d[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }
  ctx.fillStyle = '#000000';
  ctx.globalAlpha = 1;
  for (const r of rects) ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  return canvas;
}

// ─── the verification gate ───────────────────────────────────────────────────
// Every check re-reads the OUTPUT bytes with the same scanners the analysis
// uses. A failure throws a sentence and nothing downloads.

// An encoder-added ICC profile is tolerated: some browsers (Safari) stamp the
// display profile into canvas output, and the source's own profile never
// crosses the canvas — so it is not source data. Everything else fails the gate.
function residualRasterMetadata(bytes, kind) {
  if (kind === 'JPEG') {
    for (const s of scanJpeg(bytes) || []) {
      if (s.sos) break;
      if (s.marker === 0xFE) return 'a JPEG comment';
      if (s.marker === 0xE2 && s.dataStart != null && matchAscii(bytes, s.dataStart, 'ICC_PROFILE\0')) continue;
      if (s.marker >= 0xE1 && s.marker <= 0xEF) return `a JPEG APP${s.marker - 0xE0} metadata segment`;
    }
    return null;
  }
  if (kind === 'PNG') {
    const bad = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'acTL', 'caBX']);
    for (const c of scanPng(bytes)) {
      if (bad.has(c.type)) return `a PNG ${c.type} chunk`;
    }
    return null;
  }
  if (kind === 'WebP') {
    const bad = new Set(['EXIF', 'XMP ', 'ANIM', 'ANMF', 'C2PA', 'JUMB']);
    const s = scanWebp(bytes);
    for (const c of (s ? s.chunks : [])) {
      if (bad.has(c.fourcc)) return `a WebP ${c.fourcc.trim()} chunk`;
    }
    return null;
  }
  return null;
}

// Re-decode the output and sample points inside every bar rect: each sampled
// pixel must be (near) black. JPEG and lossy WebP ring slightly at edges even
// inside an inflated bar, so lossy formats get a small tolerance; PNG must be
// exact. `checked: false` is only possible when no 2D context exists at all —
// the caller fails the export in that case rather than shipping unchecked bars
// under the "verified before download" promise.
async function verifyBarsPainted(outBytes, mime, kind, rects) {
  if (!canRaster()) return { checked: false };
  const img = await decodeImage(outBytes, mime);
  const W = img.width || img.naturalWidth;
  const H = img.height || img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { checked: false };
  ctx.drawImage(img, 0, 0);
  const tol = kind === 'PNG' ? 2 : 16;
  for (const r of rects) {
    // Sample a 3x3 grid inset from the rect edges (the inflation absorbs any
    // codec ringing at the boundary).
    const inset = 3;
    const x0 = Math.min(r.x1 - 1, r.x0 + inset), x1 = Math.max(x0, r.x1 - 1 - inset);
    const y0 = Math.min(r.y1 - 1, r.y0 + inset), y1 = Math.max(y0, r.y1 - 1 - inset);
    for (let sy = 0; sy < 3; sy++) {
      for (let sx = 0; sx < 3; sx++) {
        const px = Math.round(x0 + (x1 - x0) * sx / 2);
        const py = Math.round(y0 + (y1 - y0) * sy / 2);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const d = ctx.getImageData(px, py, 1, 1).data;
        if (d[0] > tol || d[1] > tol || d[2] > tol) {
          throw new Error('Verification failed: a bar region is not solid black in the output. Nothing was downloaded.');
        }
      }
    }
  }
  return { checked: true };
}

function verifyRasterOutput(outBytes, kind) {
  const residual = residualRasterMetadata(outBytes, kind);
  if (residual) {
    throw new Error(`Verification failed: the output still carries ${residual}. Nothing was downloaded.`);
  }
  if (trailingBytes(outBytes, kind) > 0) {
    throw new Error('Verification failed: the output has bytes after the end of the image. Nothing was downloaded.');
  }
}

// Vector-mode gate: no removed string may survive into the output. Tokens are
// trimmed, deduplicated and capped; short fragments (under 4 chars) are noise.
function verifySvgRemoved(outText, removed) {
  const seen = new Set();
  let checked = 0;
  for (const raw of removed) {
    for (const token of String(raw).split(/\s+/)) {
      const t = token.trim();
      if (t.length < 4 || seen.has(t)) continue;
      seen.add(t);
      if (outText.includes(t)) {
        throw new Error('Verification failed: removed content is still present in the SVG output. Nothing was downloaded.');
      }
      if (++checked >= 4000) return;
    }
  }
}

function residualSvg(outText) {
  for (const tk of tokenize(outText)) {
    if (tk.t === 'comment') return 'an XML comment';
    if (tk.t === 'doctype') return 'a DOCTYPE declaration';
    if (tk.t === 'open' || tk.t === 'self') {
      if (shouldDropElement(tk.name)) return `a <${tk.name}> element`;
      for (const a of tk.attrs) {
        if (shouldDropAttr(a.name)) return `a ${a.name} attribute`;
        if (isRemoteOrDataHref(a)) return 'an embedded or external href';
      }
    }
  }
  return null;
}

// ─── filenames / mime ────────────────────────────────────────────────────────

const OUT_MIME = { JPEG: 'image/jpeg', PNG: 'image/png', WebP: 'image/webp' };
const OUT_EXT = { JPEG: '.jpg', PNG: '.png', WebP: '.webp' };

function redactedName(name, ext) {
  const base = String(name || 'file');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}-redacted${ext}`;
}

// ─── exportFile: rebuild, verify, only then hand bytes back ──────────────────

async function exportFile({ model, host }) {
  const inputs = inputsFrom(model);
  const f = inputs.source;
  if (!f || !f.bytes) throw new Error('Choose a file first.');

  const info = classify(f.bytes);
  if (info.kind === 'file') throw new Error('That file is not a supported image, SVG or PDF.');

  const bars = parseBars(inputs.bars);
  const quantise = inputs.quantise !== false;
  const grayscale = Boolean(inputs.grayscale);

  // ── PDF: rasterise-and-rebuild in the shell ──
  if (info.kind === 'PDF') {
    if (!host || !host.pdf || typeof host.pdf.redact !== 'function') {
      throw new Error('PDF redaction is not available in this app.');
    }
    if (!bars.length) throw new Error('Draw or add at least one redaction bar first.');
    // Bars for a PDF are stored in PDF point space (page origin top-left), so
    // they survive any DPI choice; the shell converts per page.
    const res = await host.pdf.redact(f.bytes, { bars, dpi: 200, grayscale });
    if (!res || !res.bytes) throw new Error('PDF redaction returned no output. Nothing was downloaded.');
    // A bar aimed at a page the document does not have is silently skipped by
    // the rebuild — refuse instead of shipping that region fully visible.
    const over = bars.filter((b) => b.page > res.pages);
    if (over.length) {
      throw new Error(`Verification failed: a bar targets page ${over[0].page} but the PDF has only ${res.pages} page${res.pages > 1 ? 's' : ''}. Nothing was downloaded.`);
    }
    // A warning means a page could not be rendered and would ship blank — that
    // is silent content loss, so fail closed rather than downloading it.
    if (Array.isArray(res.warnings) && res.warnings.length) {
      throw new Error(`Verification failed: ${res.warnings.join(' ')} Nothing was downloaded.`);
    }
    let out = res.bytes;

    // The gate runs on the UNSIGNED rebuild — a fresh Content Credential
    // legitimately appends an incremental update with its own %%EOF and /C2PA
    // reference afterwards. Checks: exactly one end-of-file marker, nothing
    // but whitespace after it, no Content Credential carried over, and our own
    // output re-opened by the same analyzer the source went through.
    const eofs = countAscii(out, '%%EOF');
    if (eofs !== 1) {
      throw new Error(`Verification failed: the rebuilt PDF has ${eofs} end-of-file markers instead of one. Nothing was downloaded.`);
    }
    for (let i = indexOfAscii(out, '%%EOF', 0) + 5; i < out.length; i++) {
      const c = out[i];
      if (c !== 0x0A && c !== 0x0D && c !== 0x20 && c !== 0x09) {
        throw new Error('Verification failed: the rebuilt PDF has bytes after its end-of-file marker. Nothing was downloaded.');
      }
    }
    if (indexOfAscii(out, '/C2PA', 0) !== -1) {
      throw new Error('Verification failed: the rebuilt PDF still references a Content Credential. Nothing was downloaded.');
    }
    if (typeof host.pdf.analyze === 'function') {
      const recheck = await host.pdf.analyze(out);
      // The analyzer's inventory reports the page count for EVERY valid PDF —
      // 'Pages' is document structure, not leaked content, so it never fails
      // the gate. Every other label (Info fields, XMP, attachments, scripts,
      // annotations, layers, signatures) cannot exist in an image-only rebuild
      // and stays a hard failure.
      const leaks = (recheck && Array.isArray(recheck.findings) ? recheck.findings : [])
        .filter((r) => r && r.label !== 'Pages');
      if (leaks.length) {
        throw new Error(`Verification failed: the rebuilt PDF still carries ${leaks[0].label}. Nothing was downloaded.`);
      }
    }

    if (inputs.resign && host.c2pa && typeof host.c2pa.sign === 'function') {
      // Opt-in: re-sign the redacted derivative — a fresh manifest with no
      // ingredients, so no thumbnail of the original travels along. The
      // contract is sign(bytes, format, opts) → stamped bytes, and it throws
      // on failure, which correctly fails this opt-in export visibly.
      out = await host.c2pa.sign(out, 'pdf', { description: 'Covered content removed and the file rebuilt' });
    }
    return { bytes: out, mime: 'application/pdf', filename: redactedName(f.name, '.pdf') };
  }

  // ── SVG vector mode: pure string surgery, stays sandbox-only ──
  if (info.kind === 'SVG' && inputs.svgVector) {
    const removed = [];
    let out = cleanSvgTokens(tokenize(info.text), removed);
    out = dropUnreferencedDefs(out);

    // Map bars (drawn in the preview's natural pixel space) into root viewBox
    // coordinates. Only a unitless/px width+height pair counts as the natural
    // size (svgDims rejects %, mm, em — the browser resolves those against the
    // viewBox, and so do we). When the attribute aspect differs from the
    // viewBox the browser letterboxes (preserveAspectRatio xMidYMid meet), so
    // one uniform scale plus a centring offset maps bars, never separate sx/sy.
    const d = svgDims(info.text);
    const vb = d.viewBox || { x: 0, y: 0, w: d.w || 0, h: d.h || 0 };
    if (!(vb.w > 0) || !(vb.h > 0)) {
      throw new Error('This SVG has no usable size. Turn off vector mode to export it as a PNG instead.');
    }
    const natW = d.attrWh ? d.w : vb.w;
    const natH = d.attrWh ? d.h : vb.h;
    const s = Math.min(natW / vb.w, natH / vb.h);
    const ox = (natW - vb.w * s) / 2;
    const oy = (natH - vb.h * s) / 2;
    const pageOneBars = bars.filter((b) => (b.page || 1) === 1);
    const rects = rectsFor(bars, natW, natH, quantise, 1)
      .map((r) => ({ x0: (r.x0 - ox) / s, y0: (r.y0 - oy) / s, x1: (r.x1 - ox) / s, y1: (r.y1 - oy) / s }));
    // Hard gate: every drawn bar must actually map to a painted rect. A bar
    // that clamps away would ship the covered region fully visible.
    if (rects.length < pageOneBars.length) {
      throw new Error(`Verification failed: ${pageOneBars.length - rects.length} of ${pageOneBars.length} bar${pageOneBars.length > 1 ? 's' : ''} could not be placed on this SVG. Nothing was downloaded.`);
    }
    out = svgWithBars(out, rects, vb);

    // The gate: grep the serialised output for anything that was deleted, and
    // re-run the residual scan for the node/attribute classes we remove.
    verifySvgRemoved(out, removed);
    const residual = residualSvg(out);
    if (residual) {
      throw new Error(`Verification failed: the SVG output still carries ${residual}. Nothing was downloaded.`);
    }
    return { bytes: encodeText(out), mime: 'image/svg+xml', filename: redactedName(f.name, '.svg') };
  }

  // ── Raster (and default SVG→PNG): canvas rebuild ──
  if (!canRaster()) throw new Error(HEADLESS_MSG);

  const isSvg = info.kind === 'SVG';
  const srcMime = isSvg ? 'image/svg+xml' : (OUT_MIME[info.kind] || f.mime || 'application/octet-stream');
  const img = isSvg
    ? await loadImageFromBytes(f.bytes, 'image/svg+xml') // createImageBitmap(SVG) is patchy; <img> is the reliable path
    : await decodeImage(f.bytes, srcMime);
  let W = img.width || img.naturalWidth;
  let H = img.height || img.naturalHeight;
  if (isSvg && (!W || !H)) {
    const d = svgDims(info.text);
    W = Math.round(d.w || 0);
    H = Math.round(d.h || 0);
  }
  if (!(W > 0) || !(H > 0)) throw new Error('That file could not be decoded as an image.');

  const rects = rectsFor(bars, W, H, quantise, 1);
  const canvas = drawRedacted(img, W, H, rects, grayscale);

  // Same-family re-encode is the metadata kill: jpeg→jpeg, png→png, webp→webp
  // (quality 1 asks the encoder for its lossless/best mode). SVG rasterises to
  // PNG. If the browser cannot encode the family it falls back to PNG rather
  // than failing the whole export.
  let outKind = isSvg ? 'PNG' : info.kind;
  let mime = OUT_MIME[outKind];
  const quality = outKind === 'JPEG' ? 0.92 : (outKind === 'WebP' ? 1 : undefined);
  let blob = await encodeCanvas(canvas, mime, quality);
  if (blob.type && blob.type !== mime) {
    outKind = 'PNG';
    mime = OUT_MIME.PNG;
    blob = await encodeCanvas(canvas, mime, undefined);
  }
  const out = new Uint8Array(await blob.arrayBuffer());

  // The gate — rescan the OUTPUT: no metadata, nothing past the terminator,
  // and every bar region re-decoded and sampled as solid fill.
  verifyRasterOutput(out, outKind);
  const barCheck = await verifyBarsPainted(out, mime, outKind, rects);
  if (rects.length && !barCheck.checked) {
    throw new Error('Verification failed: the bar regions could not be re-checked in this browser. Nothing was downloaded.');
  }

  return { bytes: out, mime, filename: redactedName(f.name, OUT_EXT[outKind]) };
}
