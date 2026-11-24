import { detectFormat, jpegSegments, classifyJpeg, pngChunks, PNG_KEEP, webpChunks, WEBP_KEEP, gifBlocks } from './meta.js';
import { decodeImage } from './decode.js';
import { render, pageCanvas, MIME as RENDER_MIME, LOOKS_SAME } from './render.js';
import { removeSet, extractKept, insertKept, hasKept } from './keep.js';

export { LOOKS_SAME };

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif' };
const FROM_MIME = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };
export const LOSSLESS = new Set(['jpeg', 'png', 'webp', 'gif']);
// Graphics without a photo encoder of their own become PNG; photos become JPEG.
const GRAPHIC = new Set(['gif', 'bmp', 'ico']);

let avifOk;
export async function canEncodeAvif() {
  if (avifOk !== undefined) return avifOk;
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const blob = await new Promise((res) => c.toBlob(res, 'image/avif', 0.8));
  avifOk = !!blob && blob.type === 'image/avif';
  return avifOk;
}

export async function cleanImage(bytes, file, info, opts) {
  const format = detectFormat(bytes);
  const lossless = opts.mode === 'lossless' && LOSSLESS.has(format);
  const remove = removeSet(opts);
  const kept = remove.size < 5 ? await extractKept(bytes, format, remove, { redraw: !lossless }) : null;
  // When EXIF is kept in a lossless clean it already carries the orientation tag.
  const stripInfo = kept && kept.tiff && lossless ? { ...info, orientation: 1 } : info;
  let out = lossless ? losslessStrip(bytes, format, stripInfo, opts) : await redraw(file, bytes, format, opts);
  if (!lossless && LOSSLESS.has(out.format)) {
    // Encoders add their own color profile (Chrome writes a generic sRGB one); take it off too.
    const fresh = new Uint8Array(await out.blob.arrayBuffer());
    const stripped = losslessStrip(fresh, out.format, { orientation: 1, hasIcc: false }, { keepIcc: false });
    out = { ...out, blob: stripped.blob };
  }
  out.notes = [];
  if (hasKept(kept)) {
    const r = await insertKept(out.blob, out.format, kept);
    out = { ...out, blob: r.blob, notes: r.notes };
  }
  out.removed = remove;
  const base = opts.rename ? `photo-${randomId()}` : stripExt(file.name) || 'photo';
  return { ...out, name: `${base}.${EXT[out.format]}` };
}

// ---- Lossless: copy the image data, drop everything else ------------------

function losslessStrip(b, format, info, opts) {
  const parts = [];
  const kept = [];
  if (format === 'jpeg') {
    parts.push(b.subarray(0, 2));
    const { segs } = jpegSegments(b);
    let wroteOrientation = false;
    for (const s of segs) {
      const kind = s.dataStart === undefined ? 'keep' : classifyJpeg(b, s);
      const keep = kind === 'keep' || (kind === 'icc' && opts.keepIcc);
      if (!keep) continue;
      parts.push(b.subarray(s.start, s.end));
      // A minimal EXIF block that only says which way is up goes right after JFIF/SOI.
      if (!wroteOrientation && info.orientation > 1 && (s.m === 0xe0 || s.m >= 0xc0)) {
        if (s.m === 0xe0) parts.push(orientationApp1(info.orientation));
        else parts.splice(parts.length - 1, 0, orientationApp1(info.orientation));
        wroteOrientation = true;
      }
    }
    if (info.orientation > 1) kept.push('Orientation, so the photo stays upright');
  } else if (format === 'png') {
    parts.push(b.subarray(0, 8));
    for (const c of pngChunks(b).chunks) {
      if (PNG_KEEP.has(c.type) || (c.type === 'iCCP' && opts.keepIcc)) parts.push(b.subarray(c.start, c.end));
    }
  } else if (format === 'webp') {
    const body = [];
    let hasIcc = false;
    for (const c of webpChunks(b).chunks) {
      const keepIcc = c.type === 'ICCP' && opts.keepIcc;
      if (!WEBP_KEEP.has(c.type) && !keepIcc) continue;
      if (keepIcc) hasIcc = true;
      let chunk = b.subarray(c.start, c.end);
      if (c.type === 'VP8X') {
        chunk = chunk.slice();
        chunk[8] &= ~(0x08 | 0x04 | 0x01); // EXIF, XMP and reserved bits
        if (!hasIcc && !opts.keepIcc) chunk[8] &= ~0x20;
      }
      body.push(chunk);
    }
    const size = body.reduce((n, p) => n + p.length, 4);
    const head = new Uint8Array(12);
    head.set([0x52, 0x49, 0x46, 0x46], 0);
    new DataView(head.buffer).setUint32(4, size, true);
    head.set([0x57, 0x45, 0x42, 0x50], 8);
    parts.push(head, ...body);
  } else if (format === 'gif') {
    gifBlocks(b, (kind, start, end) => {
      if (kind === 'head' || kind === 'image' || kind === 'gce' || kind === 'loop' || kind === 'text' || kind === 'end') parts.push(b.subarray(start, end));
    });
  }
  if (opts.keepIcc && info.hasIcc) kept.push('Color profile');
  return { blob: new Blob(parts, { type: MIME[format] }), format, lossless: true, kept, scaled: false };
}

function orientationApp1(o) {
  const a = new Uint8Array(36);
  const v = new DataView(a.buffer);
  v.setUint16(0, 0xffe1);
  v.setUint16(2, 34);
  a.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  a.set([0x4d, 0x4d, 0, 0x2a], 10); // big-endian TIFF
  v.setUint32(14, 8);
  v.setUint16(18, 1); // one entry
  v.setUint16(20, 0x0112);
  v.setUint16(22, 3);
  v.setUint32(24, 1);
  v.setUint16(28, o);
  v.setUint32(32, 0); // no next IFD
  return a;
}

// ---- Redraw: decode, paint to a fresh canvas, encode a new file ----------

async function redraw(file, bytes, format, opts) {
  const img = await decodeImage(file, bytes, format);
  let target = opts.format === 'same' ? format : opts.format;
  if (target === 'gif' || !MIME[target]) target = GRAPHIC.has(format) ? 'png' : 'jpeg';
  if (target === 'avif' && !(await canEncodeAvif())) target = 'jpeg';
  const job = { target, opts: { fingerprint: !!opts.fingerprint, quality: String(opts.quality) } };

  let r = null;
  try {
    if (workerReady()) {
      try {
        const bitmap = await createImageBitmap(img.source);
        r = await inWorker({ bitmap, w: img.width, h: img.height, ...job }, [bitmap]);
      } catch {
        r = null;
      }
    }
    if (!r) r = await render(img.source, img.width, img.height, target, job.opts, pageCanvas);
  } finally {
    img.done();
  }
  if (!r) throw new Error('This photo is too large for the browser to redraw.');
  // Some browsers quietly fall back to PNG when they cannot encode a type (Safari and WebP).
  const actual = FROM_MIME[r.blob.type] || 'png';
  return {
    blob: r.blob, format: actual, lossless: false, kept: [], scaled: r.scaled,
    quality: actual === 'png' ? null : r.quality, match: actual === 'png' ? null : r.match,
    fellBack: actual !== target ? target : null,
  };
}

// One worker for the whole session. Falls back to the page when OffscreenCanvas is missing.
let worker = null;
let workerBroken = false;
let jobId = 0;
const waiting = new Map();

function workerReady() {
  if (workerBroken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  if (!('convertToBlob' in OffscreenCanvas.prototype)) return false;
  if (!worker) {
    try {
      worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const p = waiting.get(e.data.id);
        if (!p) return;
        waiting.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.result);
      };
      worker.onerror = () => {
        workerBroken = true;
        for (const p of waiting.values()) p.reject(new Error('worker failed'));
        waiting.clear();
      };
    } catch {
      workerBroken = true;
      return false;
    }
  }
  return true;
}

function inWorker(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg }, transfer);
  });
}

const stripExt = (n) => n.replace(/\.[^.]+$/, '');
function randomId() {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}
