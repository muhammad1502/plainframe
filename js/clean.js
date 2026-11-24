import { detectFormat, jpegSegments, classifyJpeg, pngChunks, PNG_KEEP, webpChunks, WEBP_KEEP, gifBlocks } from './meta.js';
import { decodeImage } from './decode.js';

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
  let out = lossless ? losslessStrip(bytes, format, info, opts) : await redraw(file, bytes, format, opts);
  if (!lossless && LOSSLESS.has(out.format)) {
    // Encoders add their own color profile (Chrome writes a generic sRGB one); take it off too.
    const fresh = new Uint8Array(await out.blob.arrayBuffer());
    const stripped = losslessStrip(fresh, out.format, { orientation: 1, hasIcc: false }, { keepIcc: false });
    out = { ...out, blob: stripped.blob };
  }
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
  const w = img.width, h = img.height;
  let target = opts.format === 'same' ? format : opts.format;
  if (target === 'gif' || !MIME[target]) target = GRAPHIC.has(format) ? 'png' : 'jpeg';
  if (target === 'avif' && !(await canEncodeAvif())) target = 'jpeg';

  let outW = w, outH = h;
  if (opts.fingerprint) {
    const f = 0.985 + Math.random() * 0.01;
    outW = Math.round(w * f);
    outH = Math.round(h * f);
  }
  // Try full size first; older iOS caps a canvas at 16.7 million pixels and returns no context.
  let blob = null, scaled = false, quality = null, match = null;
  try {
    for (const cap of [64e6, 16.7e6, 8e6]) {
      let tw = outW, th = outH;
      if (tw * th > cap) {
        const k = Math.sqrt(cap / (tw * th));
        tw = Math.floor(tw * k);
        th = Math.floor(th * k);
      }
      const r = await paint(img, tw, th, target, opts);
      if (r) { ({ blob, quality, match } = r); scaled = tw !== outW; break; }
    }
  } finally {
    img.done();
  }
  if (!blob) throw new Error('This photo is too large for the browser to redraw.');
  // Some browsers quietly fall back to PNG when they cannot encode a type (Safari and WebP).
  const actual = FROM_MIME[blob.type] || 'png';
  return { blob, format: actual, lossless: false, kept: [], scaled, quality: actual === 'png' ? null : quality, match: actual === 'png' ? null : match, fellBack: actual !== target ? target : null };
}

async function paint(img, w, h, target, opts) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  if (target === 'jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  if (opts.fingerprint) {
    // A small turn plus enough zoom to hide the corners, then faint noise.
    const deg = (0.35 + Math.random() * 0.45) * (Math.random() < 0.5 ? -1 : 1);
    const t = (deg * Math.PI) / 180;
    const s = Math.max(Math.cos(Math.abs(t)) + (h / w) * Math.sin(Math.abs(t)), Math.cos(Math.abs(t)) + (w / h) * Math.sin(Math.abs(t)));
    ctx.translate(w / 2, h / 2);
    ctx.rotate(t);
    ctx.scale(s, s);
    ctx.drawImage(img.source, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    addNoise(ctx, w, h);
  } else {
    ctx.drawImage(img.source, 0, 0, w, h);
  }
  let result;
  try {
    result = target === 'png' ? { blob: await encode(c, 'png'), quality: null, match: null } : await compress(c, ctx, target, opts.quality);
  } finally {
    c.width = c.height = 0; // frees the backing store right away on iOS
  }
  return result.blob && result.blob.size > 0 ? result : null;
}

const encode = (c, type, q) => new Promise((res) => c.toBlob(res, MIME[type], q));

// Measured on brightness, which the eye is most sensitive to: JPEG and WebP store colour at lower
// resolution by design, so an RGB score would call almost every photo "visibly worse".
// 42 dB is a strict line for "looks the same"; it is an estimate from the full-resolution centre
// of the photo, not a guarantee.
export const LOOKS_SAME = 42;

async function compress(c, ctx, target, setting) {
  const r = region(c.width, c.height);
  const ref = ctx.getImageData(r[0], r[1], r[2], r[3]).data;
  const tried = new Map();
  const at = async (q) => {
    if (!tried.has(q)) {
      const blob = await encode(c, target, q / 100);
      tried.set(q, { blob, quality: q, match: blob ? await psnr(ref, blob, r) : 0 });
    }
    return tried.get(q);
  };
  if (setting !== 'smart') return at(Number(setting));
  // Smallest quality from 50 to 95 that still measures as looking the same.
  let lo = 50, hi = 95;
  if ((await at(hi)).match < LOOKS_SAME) return at(hi);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await at(mid)).match >= LOOKS_SAME) hi = mid;
    else lo = mid + 1;
  }
  return at(hi);
}

function region(w, h) {
  const cw = Math.min(w, 2048), ch = Math.min(h, 2048);
  return [Math.floor((w - cw) / 2), Math.floor((h - ch) / 2), cw, ch];
}

// Peak signal-to-noise ratio of brightness (Rec. 601 luma), in dB. Higher means closer to the original.
async function psnr(ref, blob, r) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = r[2];
  c.height = r[3];
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3]);
  bmp.close();
  const d = ctx.getImageData(0, 0, r[2], r[3]).data;
  c.width = c.height = 0;
  let se = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const dy = 0.299 * (ref[i] - d[i]) + 0.587 * (ref[i + 1] - d[i + 1]) + 0.114 * (ref[i + 2] - d[i + 2]);
    se += dy * dy;
    n++;
  }
  const mse = se / n;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

function addNoise(ctx, w, h) {
  const band = Math.max(1, Math.floor(4e6 / w));
  let seed = (Math.random() * 2 ** 31) | 1;
  for (let y = 0; y < h; y += band) {
    const rows = Math.min(band, h - y);
    const img = ctx.getImageData(0, y, w, rows);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const n = (seed & 3) - 1.5; // -1.5 to 1.5
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, y);
  }
}

const stripExt = (n) => n.replace(/\.[^.]+$/, '');
function randomId() {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}
