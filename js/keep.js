// Selective removal. Every clean starts from a file with all metadata stripped; this module
// pulls out only the categories the person chose to keep and writes them back in.
//
// Always removed, whatever the choice: Content Credentials (any edit breaks their signature and
// they can carry location), thumbnails and other hidden images (they can show the uncropped
// original), maker notes (undocumented vendor data that can hold anything) and unknown blocks.

import { jpegSegments, classifyJpeg, pngChunks, pngText, webpChunks, gifBlocks, AI_WORDS, AI_KEYS } from './meta.js';
import { crc32 } from './zip.js';

export const CATEGORIES = ['location', 'camera', 'dates', 'author', 'ai'];
export const CATEGORY_NAMES = { location: 'Location', camera: 'Camera and device', dates: 'Dates and times', author: 'Author and captions', ai: 'AI generation data' };
// Report groups (from meta.js) that each kept category is allowed to leave behind.
export const CATEGORY_GROUPS = { location: ['gps'], camera: ['camera', 'xmp'], dates: ['dates'], author: ['author', 'text', 'comment', 'xmp'], ai: ['ai', 'xmp'] };

export function removeSet(settings) {
  if (settings.remove === 'location') return new Set(['location']);
  if (settings.remove === 'custom') return new Set(CATEGORIES.filter((c) => settings[`rm_${c}`] !== false));
  return new Set(CATEGORIES);
}

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');
const enc = new TextEncoder();

// ---- Pull kept metadata out of the original -------------------------------

export async function extractKept(b, format, remove, { redraw }) {
  const out = { tiff: null, xmp: null, iptc: null, text: [], comments: [] };
  const want = (cat) => cat !== 'never' && !remove.has(cat);
  let tiff = null, xmp = null, iim = null;

  if (format === 'jpeg') {
    for (const s of jpegSegments(b).segs) {
      if (s.dataStart === undefined) continue;
      const kind = classifyJpeg(b, s);
      const d = b.subarray(s.dataStart, s.dataEnd);
      if (kind === 'exif' && !tiff) tiff = d.subarray(6);
      else if (kind === 'xmp' && !xmp) xmp = utf8.decode(d.subarray(29));
      else if (kind === 'iptc') iim = iimFromPhotoshop(d) || iim;
      else if (kind === 'comment' && want('author')) out.comments.push(latin1.decode(d));
    }
  } else if (format === 'png') {
    for (const c of pngChunks(b).chunks) {
      if (c.type === 'eXIf' && !tiff) tiff = c.data;
      else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
        const t = await pngText(c);
        if (!t) continue;
        if (t.key === 'XML:com.adobe.xmp') { xmp = xmp || t.text; continue; }
        if (want(textCategory(t.key, t.text))) out.text.push(t);
      }
    }
  } else if (format === 'webp') {
    for (const c of webpChunks(b).chunks) {
      if (c.type === 'EXIF' && !tiff) tiff = isExifHeader(c.data, 0) ? c.data.subarray(6) : c.data;
      else if (c.type === 'XMP ' && !xmp) xmp = utf8.decode(c.data);
    }
  } else if (format === 'gif') {
    gifBlocks(b, (kind, start, end, info) => {
      if (kind !== 'comment' || !want('author')) return;
      let t = '';
      for (let p = 0; p < info.data.length && info.data[p]; p += info.data[p] + 1) t += latin1.decode(info.data.subarray(p + 1, p + 1 + info.data[p]));
      out.comments.push(t);
    });
  } else if (format === 'tiff') {
    tiff = b;
  } else {
    // HEIC, AVIF: the Exif item follows "Exif\0\0"; XMP is a plain packet.
    for (let i = find(b, 'Exif\0\0'); i >= 0; i = find(b, 'Exif\0\0', i + 1)) {
      if (isTiff(b, i + 6)) { tiff = b.subarray(i + 6); break; }
    }
    const xs = find(b, '<x:xmpmeta');
    const xe = xs >= 0 ? find(b, '</x:xmpmeta>', xs) : -1;
    if (xe > xs) xmp = utf8.decode(b.subarray(xs, xe + 12));
  }

  if (tiff) out.tiff = filterTiff(tiff, remove, { redraw, isFile: format === 'tiff' });
  if (xmp) out.xmp = filterXmp(xmp, remove);
  if (iim) out.iptc = filterIim(iim, remove);
  return out;
}

const isExifHeader = (b, i) => b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66;
const isTiff = (b, i) => (b[i] === 0x4d && b[i + 1] === 0x4d && b[i + 2] === 0 && b[i + 3] === 0x2a) || (b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 0x2a && b[i + 3] === 0);

function find(b, text, from = 0) {
  const first = text.charCodeAt(0);
  outer: for (let i = from; i <= b.length - text.length; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < text.length; j++) if (b[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

function textCategory(key, text) {
  if (AI_KEYS.test(key)) return 'ai';
  if (key === 'Comment' && /"(prompt|uc|steps|sampler)"/.test(text)) return 'ai';
  if (key === 'Description' && /--(v|ar|style|seed) /.test(text)) return 'ai';
  if (key === 'Software') return AI_WORDS.test(text) ? 'ai' : 'camera';
  if (/^creation time$/i.test(key)) return 'dates';
  if (/^Raw profile type/i.test(key)) return 'never';
  return 'author';
}

// ---- EXIF / TIFF ---------------------------------------------------------

const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const DATE_TAGS = new Set([0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292]);
const AUTHOR0 = new Set([0x010e, 0x013b, 0x8298, 0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f]);
// Pixel-layout tags of a TIFF file; the redrawn output describes its own pixels.
const LAYOUT = new Set([0xfe, 0xff, 0x100, 0x101, 0x102, 0x103, 0x106, 0x107, 0x10a, 0x111, 0x115, 0x116, 0x117, 0x118, 0x119, 0x11a, 0x11b, 0x11c, 0x122, 0x123, 0x128, 0x13d, 0x13e, 0x13f, 0x140, 0x142, 0x143, 0x144, 0x145, 0x147, 0x148, 0x14a, 0x14c, 0x14d, 0x152, 0x153, 0x154, 0x155, 0x156, 0x15b, 0x200, 0x201, 0x202, 0x211, 0x212, 0x213, 0x214, 0x2bc, 0x83bb, 0x8773, 0x8649, 0x935c, 0xc612, 0xc614]);

function tagCategory(ifd, tag, raw, le, opts) {
  if (ifd === 'gps') return 'location';
  if (tag === 0x0112) return opts.redraw ? 'never' : 'orientation';
  if (ifd === 'ifd0') {
    if (opts.isFile && LAYOUT.has(tag)) return 'never';
    if (tag === 0x0132) return 'dates';
    if (AUTHOR0.has(tag)) return /Steps: \d+/.test(latin1.decode(raw)) ? 'ai' : 'author';
    if (tag === 0x0131) return AI_WORDS.test(latin1.decode(raw)) ? 'ai' : 'camera';
    if (tag === 0x02bc || tag === 0x83bb || tag === 0x8773 || tag === 0x8649) return 'never';
    return 'camera';
  }
  if (DATE_TAGS.has(tag)) return 'dates';
  if (tag === 0x9286) return /Steps: \d+/.test(decodeComment(raw)) ? 'ai' : 'author';
  if (tag === 0xa430) return 'author';
  if (tag === 0x927c || tag === 0xa005 || tag === 0xc4a5) return 'never'; // maker notes, interop, print IM
  if (opts.redraw && (tag === 0xa002 || tag === 0xa003)) return 'never';
  return 'camera';
}

function decodeComment(raw) {
  if (raw.length < 8) return '';
  const head = latin1.decode(raw.subarray(0, 8));
  const body = raw.subarray(8);
  if (head.startsWith('UNICODE')) return new TextDecoder(body[0] === 0 ? 'utf-16be' : 'utf-16le').decode(body);
  return latin1.decode(body);
}

function readIfd(t, off, le, seen) {
  const u16 = (i) => (le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1]);
  const u32 = (i) => (le ? (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16)) + t[i + 3] * 16777216 : t[i] * 16777216 + ((t[i + 1] << 16) | (t[i + 2] << 8) | t[i + 3]));
  if (!off || off + 2 > t.length || seen.has(off)) return { entries: [], u32 };
  seen.add(off);
  const n = u16(off);
  const entries = [];
  for (let e = 0; e < n; e++) {
    const p = off + 2 + e * 12;
    if (p + 12 > t.length) break;
    const tag = u16(p), type = u16(p + 2), count = u32(p + 4);
    const size = (SIZES[type] || 1) * count;
    const at = size <= 4 ? p + 8 : u32(p + 8);
    if (!SIZES[type] || at + size > t.length) continue;
    entries.push({ tag, type, count, raw: t.subarray(at, at + size), ptr: u32(p + 8) });
  }
  return { entries, u32 };
}

export function filterTiff(t, remove, opts) {
  if (t.length < 8 || !isTiff(t, 0)) return null;
  const le = t[0] === 0x49;
  const seen = new Set();
  const { entries: ifd0, u32 } = readIfd(t, u32Of(t, 4, le), le, seen);
  let exif = [], gps = [];
  const keep = (ifd) => (e) => {
    const cat = tagCategory(ifd, e.tag, e.raw, le, opts);
    return cat === 'orientation' || (cat !== 'never' && !remove.has(cat));
  };
  const keep0 = [];
  for (const e of ifd0) {
    if (e.tag === 0x8769) exif = readIfd(t, e.ptr, le, seen).entries.filter(keep('exif'));
    else if (e.tag === 0x8825) gps = readIfd(t, e.ptr, le, seen).entries.filter(keep('gps'));
    else if (keep('ifd0')(e)) keep0.push(e);
  }
  if (!keep0.length && !exif.length && !gps.length) return null;
  return writeTiff(le, keep0, exif, gps);
}

const u32Of = (t, i, le) => (le ? (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16)) + t[i + 3] * 16777216 : t[i] * 16777216 + ((t[i + 1] << 16) | (t[i + 2] << 8) | t[i + 3]));

// Writes a fresh TIFF block: IFD0, then the Exif IFD, then the GPS IFD, each followed by its values.
function writeTiff(le, ifd0, exif, gps) {
  const ifdSize = (entries) => 2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + (e.raw.length > 4 ? e.raw.length + (e.raw.length & 1) : 0), 0);
  const z = [...ifd0];
  if (exif.length) z.push({ tag: 0x8769, type: 4, count: 1, raw: new Uint8Array(4), ptrTo: 'exif' });
  if (gps.length) z.push({ tag: 0x8825, type: 4, count: 1, raw: new Uint8Array(4), ptrTo: 'gps' });
  z.sort((a, b) => a.tag - b.tag);
  exif.sort((a, b) => a.tag - b.tag);
  gps.sort((a, b) => a.tag - b.tag);
  const exifOff = 8 + ifdSize(z);
  const gpsOff = exifOff + (exif.length ? ifdSize(exif) : 0);
  const total = gpsOff + (gps.length ? ifdSize(gps) : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set(le ? [0x49, 0x49, 0x2a, 0] : [0x4d, 0x4d, 0, 0x2a], 0);
  v.setUint32(4, 8, le);
  const write = (list, off) => {
    v.setUint16(off, list.length, le);
    let data = off + 2 + list.length * 12 + 4;
    list.forEach((e, i) => {
      const p = off + 2 + i * 12;
      v.setUint16(p, e.tag, le);
      v.setUint16(p + 2, e.type, le);
      v.setUint32(p + 4, e.count, le);
      if (e.ptrTo) { v.setUint32(p + 8, e.ptrTo === 'exif' ? exifOff : gpsOff, le); return; }
      if (e.raw.length <= 4) out.set(e.raw, p + 8);
      else {
        v.setUint32(p + 8, data, le);
        out.set(e.raw, data);
        data += e.raw.length + (e.raw.length & 1);
      }
    });
    v.setUint32(off + 2 + list.length * 12, 0, le);
  };
  write(z, 8);
  if (exif.length) write(exif, exifOff);
  if (gps.length) write(gps, gpsOff);
  return out;
}

// ---- XMP ------------------------------------------------------------------

const XMP_CATEGORIES = {
  location: ['exif:GPS\\w*', 'exifEX:GPS\\w*', 'photoshop:City', 'photoshop:State', 'photoshop:Country', 'Iptc4xmpCore:Location', 'Iptc4xmpCore:CountryCode', 'Iptc4xmpExt:LocationCreated', 'Iptc4xmpExt:LocationShown', 'Iptc4xmpExt:City', 'Iptc4xmpExt:CountryName', 'Iptc4xmpExt:ProvinceState', 'Iptc4xmpExt:Sublocation'],
  dates: ['xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate', 'photoshop:DateCreated', 'exif:DateTime\\w*', 'exif:SubSecTime\\w*', 'exif:OffsetTime\\w*', 'tiff:DateTime'],
  author: ['dc:\\w+', 'photoshop:Credit', 'photoshop:AuthorsPosition', 'photoshop:CaptionWriter', 'photoshop:Headline', 'photoshop:Source', 'photoshop:Instructions', 'xmpRights:\\w+', 'Iptc4xmpCore:\\w+', 'plus:\\w+', 'Iptc4xmpExt:(?!DigitalSourceType)\\w+', 'lr:\\w+', 'MicrosoftPhoto:\\w+'],
  ai: ['Iptc4xmpExt:DigitalSourceType', 'sd:\\w+', 'invokeai:\\w+'],
  camera: ['tiff:\\w+', 'aux:\\w+', 'exifEX:\\w+', 'exif:\\w+', 'xmp:CreatorTool', 'crs:\\w+', 'xmpMM:\\w+', 'photoshop:\\w+', 'GPano:\\w+', 'GCamera:\\w+', 'Camera:\\w+', 'apple-fi:\\w+', 'hdrgm:\\w+'],
};
const ALWAYS_XMP = ['xmpNote:HasExtendedXMP', 'GContainer:\\w+', 'Container:\\w+', 'xmpGImg:\\w+'];

export function filterXmp(x, remove) {
  const names = [...ALWAYS_XMP];
  // Order matters: location and dates use specific names inside broad camera/author namespaces.
  for (const cat of ['location', 'dates', 'ai', 'author', 'camera']) if (remove.has(cat)) names.push(...XMP_CATEGORIES[cat]);
  // Keep specific categories the person wants even when a broad namespace rule would catch them.
  const protect = [];
  for (const cat of ['location', 'dates', 'ai']) if (!remove.has(cat)) protect.push(...XMP_CATEGORIES[cat]);
  const prot = protect.length ? new RegExp(`^(?:${protect.join('|')})$`) : null;
  const re = new RegExp(`^(?:${names.join('|')})$`);
  // A CreatorTool that names an AI tool is AI data, not camera data.
  const drop = (name, value = '') =>
    (re.test(name) && !(prot && prot.test(name))) || (name === 'xmp:CreatorTool' && remove.has('ai') && AI_WORDS.test(value));

  let s = x.replace(/\s([A-Za-z][\w-]*:[\w-]+)\s*=\s*("[^"]*"|'[^']*')/g, (m, name, value) => (drop(name, value) ? '' : m));
  // Elements: self-closing first, then paired (one level of same-name nesting is not expected in XMP).
  s = s.replace(/<([A-Za-z][\w-]*:[\w-]+)(\s[^>]*)?\/>/g, (m, name) => (drop(name) ? '' : m));
  // Paired elements: drop the ones asked for, and look inside the ones kept (rdf:Description holds
  // everything, so stopping at the outer match would miss every property).
  const walk = (text, depth) => text.replace(/<([A-Za-z][\w-]*:[\w-]+)(\s[^>]*)?>((?:(?!<\1[\s>/])[\s\S])*?)<\/\1>/g,
    (m, name, attrs = '', inner) => (drop(name, inner) ? '' : depth > 12 ? m : `<${name}${attrs}>${walk(inner, depth + 1)}</${name}>`));
  s = walk(s, 0);
  const left = s.replace(/<\?xpacket[\s\S]*?\?>/g, '').replace(/<\/?(x:xmpmeta|rdf:RDF|rdf:Description|rdf:Seq|rdf:Bag|rdf:Alt|rdf:li)\b[^>]*>/g, '')
    .replace(/\s(xmlns(:[\w-]+)?|rdf:about|x:xmptk|rdf:parseType)\s*=\s*("[^"]*"|'[^']*')/g, '');
  const hasProps = /<[A-Za-z][\w-]*:[\w-]+|\s[A-Za-z][\w-]*:[\w-]+\s*=/.test(left);
  return hasProps ? s : null;
}

// ---- IPTC (IIM inside Photoshop APP13) -----------------------------------

function iimFromPhotoshop(d) {
  let i = 14;
  while (i + 12 <= d.length && d[i] === 0x38 && d[i + 1] === 0x42 && d[i + 2] === 0x49 && d[i + 3] === 0x4d) {
    const id = (d[i + 4] << 8) | d[i + 5];
    let p = i + 6;
    const nameLen = d[p];
    p += 1 + nameLen + ((1 + nameLen) % 2);
    const size = d[p] * 16777216 + ((d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]);
    p += 4;
    if (id === 0x0404) return d.subarray(p, p + size);
    i = p + size + (size % 2);
  }
  return null;
}

const IIM_CATEGORY = (ds) => {
  if ([26, 27, 90, 92, 95, 100, 101].includes(ds)) return 'location';
  if ([30, 35, 37, 38, 55, 60, 62, 63].includes(ds)) return 'dates';
  if (ds === 65 || ds === 70) return 'camera'; // originating program and its version
  return 'author';
};

function filterIim(d, remove) {
  const keep = [];
  for (let i = 0; i + 5 <= d.length && d[i] === 0x1c; ) {
    const rec = d[i + 1], ds = d[i + 2], len = (d[i + 3] << 8) | d[i + 4];
    if (len & 0x8000) break;
    const block = d.subarray(i, i + 5 + len);
    if ((rec === 1 && ds === 90) || (rec === 2 && ds === 0)) keep.push(block);
    else if (rec === 2 && !remove.has(IIM_CATEGORY(ds))) keep.push(block);
    i += 5 + len;
  }
  if (!keep.some((k) => k[1] === 2 && k[2] !== 0)) return null;
  return concat(keep);
}

function photoshopApp13(iim) {
  const pad = iim.length & 1;
  const head = enc.encode('Photoshop 3.0\0');
  const res = new Uint8Array(4 + 2 + 2 + 4 + iim.length + pad);
  res.set([0x38, 0x42, 0x49, 0x4d, 0x04, 0x04, 0, 0], 0);
  new DataView(res.buffer).setUint32(8, iim.length);
  res.set(iim, 12);
  return concat([head, res]);
}

// ---- Write kept metadata into a clean file --------------------------------

export function hasKept(k) {
  return !!(k && (k.tiff || k.xmp || k.iptc || k.text.length || k.comments.length));
}

export async function insertKept(blob, format, k) {
  const notes = [];
  if (!hasKept(k)) return { blob, notes };
  const b = new Uint8Array(await blob.arrayBuffer());
  if (format === 'jpeg') {
    const segs = [];
    const add = (marker, payload, what) => {
      if (payload.length + 2 > 0xffff) { notes.push(`${what} was too large for a JPEG segment and was left out`); return; }
      const s = new Uint8Array(4 + payload.length);
      s[0] = 0xff; s[1] = marker;
      new DataView(s.buffer).setUint16(2, payload.length + 2);
      s.set(payload, 4);
      segs.push(s);
    };
    if (k.tiff) add(0xe1, concat([enc.encode('Exif\0\0'), k.tiff]), 'EXIF');
    if (k.xmp) add(0xe1, concat([enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode(k.xmp)]), 'XMP');
    if (k.iptc) add(0xed, photoshopApp13(k.iptc), 'IPTC');
    for (const c of k.comments) add(0xfe, enc.encode(c), 'A comment');
    // After SOI, and after JFIF when there is one, which must come first.
    let at = 2;
    if (b[2] === 0xff && b[3] === 0xe0) at = 4 + ((b[4] << 8) | b[5]);
    return { blob: new Blob([b.subarray(0, at), ...segs, b.subarray(at)], { type: blob.type }), notes };
  }
  if (format === 'png') {
    const chunks = [];
    if (k.tiff) chunks.push(pngChunk('eXIf', k.tiff));
    if (k.xmp) chunks.push(pngChunk('iTXt', concat([enc.encode('XML:com.adobe.xmp\0\0\0\0\0'), enc.encode(k.xmp)])));
    for (const t of k.text) chunks.push(pngChunk('iTXt', concat([latin1Bytes(t.key.slice(0, 79)), new Uint8Array([0, 0, 0, 0, 0]), enc.encode(t.text)])));
    for (const c of k.comments) chunks.push(pngChunk('iTXt', concat([enc.encode('Comment\0\0\0\0\0'), enc.encode(c)])));
    const idat = pngChunks(b).chunks.find((c) => c.type === 'IDAT');
    const at = idat ? idat.start : 33;
    return { blob: new Blob([b.subarray(0, at), ...chunks, b.subarray(at)], { type: blob.type }), notes };
  }
  if (format === 'webp') return { blob: webpWithMeta(b, k, blob.type), notes };
  if (format === 'gif') {
    const parts = [];
    gifBlocks(b, (kind, start, end) => {
      if (kind === 'end') for (const c of k.comments) parts.push(gifComment(c));
      parts.push(b.subarray(start, end));
    });
    if (k.tiff || k.xmp) notes.push('GIF cannot hold EXIF or XMP, so only comments were kept');
    return { blob: new Blob(parts, { type: blob.type }), notes };
  }
  notes.push(`${format.toUpperCase()} files are saved without the kept data`);
  return { blob, notes };
}

function latin1Bytes(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  const t = latin1Bytes(type);
  out.set(t, 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(concat([t, data])));
  return out;
}

function riffChunk(type, data) {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(latin1Bytes(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

// Adds EXIF and XMP to a WebP, converting a simple file to the extended (VP8X) layout when needed.
function webpWithMeta(b, k, type) {
  const chunks = webpChunks(b).chunks;
  let vp8x = chunks.find((c) => c.type === 'VP8X');
  let head;
  if (vp8x) head = b.slice(vp8x.start, vp8x.end);
  else {
    const img = chunks.find((c) => c.type === 'VP8 ' || c.type === 'VP8L');
    if (!img) return new Blob([b], { type });
    let w, h, alpha = false;
    const d = img.data;
    if (img.type === 'VP8L') {
      const bits = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
      w = (bits & 0x3fff) + 1;
      h = ((bits >>> 14) & 0x3fff) + 1;
      alpha = !!((bits >>> 28) & 1);
    } else {
      w = (d[6] | (d[7] << 8)) & 0x3fff;
      h = (d[8] | (d[9] << 8)) & 0x3fff;
    }
    const p = new Uint8Array(10);
    p[0] = alpha ? 0x10 : 0;
    p.set([(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, ((w - 1) >> 16) & 0xff, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, ((h - 1) >> 16) & 0xff], 4);
    head = riffChunk('VP8X', p);
  }
  head[8] = (head[8] & ~0x0c) | (k.tiff ? 0x08 : 0) | (k.xmp ? 0x04 : 0);
  const body = [head];
  for (const c of chunks) if (c.type !== 'VP8X' && c.type !== 'EXIF' && c.type !== 'XMP ') body.push(b.subarray(c.start, c.end));
  if (k.tiff) body.push(riffChunk('EXIF', k.tiff));
  if (k.xmp) body.push(riffChunk('XMP ', enc.encode(k.xmp)));
  const size = body.reduce((n, p) => n + p.length, 4);
  const riff = new Uint8Array(12);
  riff.set(latin1Bytes('RIFF'), 0);
  new DataView(riff.buffer).setUint32(4, size, true);
  riff.set(latin1Bytes('WEBP'), 8);
  return new Blob([riff, ...body], { type });
}

function gifComment(text) {
  const data = latin1Bytes(text);
  const parts = [new Uint8Array([0x21, 0xfe])];
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    parts.push(new Uint8Array([n]), data.subarray(i, i + n));
  }
  parts.push(new Uint8Array([0]));
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
