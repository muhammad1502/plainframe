// Reads metadata out of image bytes without decoding pixels.
// Everything works on Uint8Array views so nothing is copied until a clean file is built.

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

const AI_WORDS = /(stable[ _-]?diffusion|comfyui|automatic1111|a1111|invokeai|novelai|midjourney|dall[·\-. ]?e|openai|chatgpt|firefly|imagen|gemini|leonardo\.ai|flux\.1|sdxl|ideogram|runway|bing image creator|copilot designer|meta ai|grok|krea)/i;
const AI_SOURCE = /(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia|compositeSynthetic)/;

export function detectFormat(b) {
  if (b.length < 12) return 'other';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'WEBP') return 'webp';
  if (str(b, 4, 4) === 'ftyp') {
    const brands = str(b, 8, Math.min(32, b.length - 8));
    if (/avi[fs]/.test(brands)) return 'avif';
    if (/hei[cx]|hevc|heim|heis|mif1|msf1/.test(brands)) return 'heic';
  }
  if (str(b, 0, 4) === 'GIF8') return 'gif';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'tiff';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'ico';
  return 'other';
}

function str(b, at, len) {
  let s = '';
  for (let i = at; i < at + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);

function startsWith(b, at, text) {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function indexOf(b, text, from = 0, to = b.length) {
  const first = text.charCodeAt(0);
  const end = Math.min(to, b.length) - text.length;
  outer: for (let i = from; i <= end; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < text.length; j++) if (b[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

const clip = (s, n = 400) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s);
const clean = (s) => s.replace(/\0+$/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
export const formatBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// ---- Report builder -------------------------------------------------------

class Report {
  constructor(format) {
    this.format = format;
    this.groups = new Map();
    this.orientation = 1;
    this.flags = new Set();
    this.ai = new Set();
  }
  group(key) {
    if (!this.groups.has(key)) this.groups.set(key, { key, title: GROUP_TITLES[key], items: [], bytes: 0 });
    return this.groups.get(key);
  }
  add(key, label, value, bytes = 0) {
    const g = this.group(key);
    if (label) g.items.push([label, value]);
    g.bytes += bytes;
    if (FLAG_FOR[key]) this.flags.add(FLAG_FOR[key]);
  }
  noteAI(text) {
    if (!text) return;
    const m = String(text).match(AI_WORDS);
    if (m) this.ai.add(prettyAI(m[1]));
    if (AI_SOURCE.test(text)) this.ai.add('Marked as AI-made');
  }
  finish() {
    if (this.ai.size) this.flags.add('ai');
    const order = ['ai', 'c2pa', 'gps', 'camera', 'author', 'xmp', 'text', 'comment', 'thumb', 'icc', 'other'];
    const groups = [...this.groups.values()]
      .filter((g) => g.items.length || g.bytes)
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    const removable = groups.filter((g) => g.key !== 'icc');
    return {
      format: this.format,
      groups,
      orientation: this.orientation,
      ai: [...this.ai],
      flags: ['gps', 'ai', 'c2pa', 'camera', 'author'].filter((f) => this.flags.has(f)),
      count: removable.reduce((n, g) => n + Math.max(1, g.items.length), 0),
      hasIcc: this.groups.has('icc'),
    };
  }
}

const GROUP_TITLES = {
  ai: 'AI generation data',
  c2pa: 'Content Credentials (C2PA)',
  gps: 'Location',
  camera: 'Camera and device',
  author: 'Author and copyright',
  xmp: 'XMP data',
  text: 'Text notes',
  comment: 'Comments',
  thumb: 'Hidden images',
  icc: 'Color profile',
  other: 'Other data',
};
const FLAG_FOR = { gps: 'gps', c2pa: 'c2pa', camera: 'camera', author: 'author', ai: 'ai' };

function prettyAI(s) {
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {
    stablediffusion: 'Stable Diffusion', comfyui: 'ComfyUI', automatic1111: 'Automatic1111', a1111: 'Automatic1111',
    invokeai: 'InvokeAI', novelai: 'NovelAI', midjourney: 'Midjourney', dalle: 'DALL·E', openai: 'OpenAI',
    chatgpt: 'ChatGPT', firefly: 'Adobe Firefly', imagen: 'Google Imagen', gemini: 'Google Gemini',
    leonardoai: 'Leonardo.Ai', flux1: 'FLUX.1', sdxl: 'SDXL', ideogram: 'Ideogram', runway: 'Runway',
    bingimagecreator: 'Bing Image Creator', copilotdesigner: 'Copilot Designer', metaai: 'Meta AI', grok: 'Grok', krea: 'Krea',
  };
  return map[k] || s;
}

// ---- Entry point ----------------------------------------------------------

export async function inspect(bytes) {
  const format = detectFormat(bytes);
  const r = new Report(format);
  try {
    if (format === 'jpeg') readJpeg(bytes, r);
    else if (format === 'png') await readPng(bytes, r);
    else if (format === 'webp') readWebp(bytes, r);
    else if (format === 'gif') readGif(bytes, r);
    else if (format === 'tiff') readTiff(bytes, r, 0, true);
    else if (format !== 'bmp' && format !== 'ico') readByScan(bytes, r);
  } catch (err) {
    r.add('other', 'Note', 'Part of this file could not be read');
  }
  return r.finish();
}

// ---- JPEG -----------------------------------------------------------------

// Splits a JPEG into segments. SOS segments include their entropy-coded data.
export function jpegSegments(b) {
  const segs = [];
  let i = 2;
  let end = b.length;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    while (b[i] === 0xff && i < b.length) i++;
    const m = b[i];
    const start = i - 1;
    i++;
    if (m === 0xd9) { end = i; segs.push({ m, start, end: i }); break; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xd8) { segs.push({ m, start, end: i }); continue; }
    if (i + 1 >= b.length) break;
    const len = u16be(b, i);
    const dataStart = i + 2;
    let segEnd = i + len;
    if (m === 0xda) {
      let j = segEnd;
      while (j < b.length - 1) {
        if (b[j] === 0xff && b[j + 1] !== 0 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7)) break;
        j++;
      }
      segEnd = j;
    }
    segs.push({ m, start, end: Math.min(segEnd, b.length), dataStart, dataEnd: Math.min(i + len, b.length) });
    i = segEnd;
  }
  return { segs, trailer: b.length - end };
}

export function classifyJpeg(b, s) {
  const d = s.dataStart;
  switch (s.m) {
    case 0xe0: return startsWith(b, d, 'JFIF\0') ? 'keep' : 'thumb';
    case 0xe1:
      if (startsWith(b, d, 'Exif\0')) return 'exif';
      if (startsWith(b, d, 'http://ns.adobe.com/xap/1.0/')) return 'xmp';
      if (startsWith(b, d, 'http://ns.adobe.com/xmp/extension/')) return 'xmpext';
      return 'other';
    case 0xe2:
      if (startsWith(b, d, 'ICC_PROFILE\0')) return 'icc';
      if (startsWith(b, d, 'MPF\0')) return 'mpf';
      return 'other';
    case 0xeb: return 'c2pa';
    case 0xed: return 'iptc';
    case 0xee: return startsWith(b, d, 'Adobe') ? 'keep' : 'other';
    case 0xfe: return 'comment';
    default:
      return s.m >= 0xe0 && s.m <= 0xef ? 'other' : 'keep';
  }
}

function readJpeg(b, r) {
  const { segs, trailer } = jpegSegments(b);
  const c2pa = [];
  let xmpExt = 0;
  for (const s of segs) {
    if (s.dataStart === undefined) continue;
    const kind = classifyJpeg(b, s);
    const data = b.subarray(s.dataStart, s.dataEnd);
    const size = s.end - s.start;
    if (kind === 'exif') readTiff(data.subarray(6), r, size);
    else if (kind === 'xmp') readXmp(utf8.decode(data.subarray(29)), r, size);
    else if (kind === 'xmpext') { xmpExt += size; r.noteAI(latin1.decode(data)); }
    else if (kind === 'icc') r.add('icc', 'ICC profile', iccName(data.subarray(14)) || 'Embedded', size);
    else if (kind === 'mpf') r.add('thumb', 'Multi-picture index', 'Points to extra images in the file', size);
    else if (kind === 'c2pa') c2pa.push(data);
    else if (kind === 'iptc') readPhotoshop(data, r, size);
    else if (kind === 'comment') {
      const t = clean(utf8.decode(data));
      r.add('comment', 'Comment', clip(t) || 'Empty', size);
      r.noteAI(t);
    } else if (kind === 'thumb') r.add('thumb', 'APP0 extension', str(b, s.dataStart, 4).replace(/\0/g, ''), size);
    else if (kind === 'other') r.add('other', `APP${s.m - 0xe0} segment`, labelFor(b, s.dataStart), size);
  }
  if (xmpExt) r.add('xmp', 'Extended XMP', formatBytes(xmpExt), xmpExt);
  if (c2pa.length) readC2pa(concat(c2pa), r);
  if (trailer > 0) r.add('thumb', 'Data after the image', `${formatBytes(trailer)} (motion photo, gain map or app data)`, trailer);
}

function labelFor(b, at) {
  let s = '';
  for (let i = at; i < at + 24 && i < b.length; i++) {
    const c = b[i];
    if (c === 0) break;
    if (c < 32 || c > 126) return s || 'Binary data';
    s += String.fromCharCode(c);
  }
  return s || 'Binary data';
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function iccName(p) {
  // ICC 'desc' tag holds the profile name; enough to show what it is.
  if (p.length < 132) return '';
  const count = u32be(p, 128);
  for (let i = 0; i < count && 132 + i * 12 + 12 <= p.length; i++) {
    const at = 132 + i * 12;
    if (str(p, at, 4) !== 'desc') continue;
    const off = u32be(p, at + 4);
    const type = str(p, off, 4);
    if (type === 'desc') return clean(latin1.decode(p.subarray(off + 12, off + 12 + u32be(p, off + 8))));
    if (type === 'mluc') {
      const len = u32be(p, off + 20);
      const so = u32be(p, off + 24);
      const raw = p.subarray(off + so, off + so + len);
      let s = '';
      for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode((raw[k] << 8) | raw[k + 1]);
      return clean(s);
    }
  }
  return '';
}

// ---- TIFF / EXIF ----------------------------------------------------------

const TAGS0 = {
  0x010e: ['camera', 'Description'], 0x010f: ['camera', 'Make'], 0x0110: ['camera', 'Model'],
  0x0131: ['camera', 'Software'], 0x0132: ['camera', 'Modified'], 0x013b: ['author', 'Artist'],
  0x013c: ['camera', 'Computer'], 0x8298: ['author', 'Copyright'], 0x9c9b: ['author', 'Title'],
  0x9c9c: ['text', 'Comment'], 0x9c9d: ['author', 'Author'], 0x9c9e: ['author', 'Keywords'], 0x9c9f: ['author', 'Subject'],
};
const TAGS_EXIF = {
  0x829a: ['camera', 'Exposure'], 0x829d: ['camera', 'Aperture'], 0x8827: ['camera', 'ISO'],
  0x9003: ['camera', 'Taken'], 0x9004: ['camera', 'Digitized'], 0x9010: ['camera', 'Time zone'],
  0x9011: ['camera', 'Time zone'], 0x920a: ['camera', 'Focal length'], 0x927c: ['camera', 'Maker notes'],
  0x9286: ['text', 'User comment'], 0xa420: ['camera', 'Unique image ID'], 0xa430: ['author', 'Camera owner'],
  0xa431: ['camera', 'Camera serial'], 0xa433: ['camera', 'Lens make'], 0xa434: ['camera', 'Lens'],
  0xa435: ['camera', 'Lens serial'],
};
// Tags that describe the pixels of a TIFF file rather than where it came from.
const STRUCTURE = new Set([0xfe, 0xff, 0x100, 0x101, 0x102, 0x103, 0x106, 0x107, 0x10a, 0x111, 0x112, 0x115, 0x116, 0x117, 0x118, 0x119, 0x11a, 0x11b, 0x11c, 0x122, 0x123, 0x128, 0x13d, 0x13e, 0x13f, 0x140, 0x142, 0x143, 0x144, 0x145, 0x147, 0x148, 0x14a, 0x14c, 0x14d, 0x152, 0x153, 0x154, 0x155, 0x156, 0x15b, 0x200, 0x201, 0x202, 0x211, 0x212, 0x213, 0x214]);
const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export function readTiff(t, r, bytes = t.length, isFile = false) {
  if (t.length < 8) return;
  const le = t[0] === 0x49;
  const u16 = (i) => (le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1]);
  const u32 = (i) => (le ? u32le(t, i) : u32be(t, i));
  const s32 = (i) => u32(i) | 0;
  const seen = new Set();
  let other = 0;
  let found = 0;
  const gps = {};

  const value = (type, count, at) => {
    if (type === 2) return clean(latin1.decode(t.subarray(at, at + count)));
    if (type === 7 || type === 1) return t.subarray(at, at + count);
    const out = [];
    for (let k = 0; k < Math.min(count, 8); k++) {
      const p = at + k * SIZES[type];
      if (type === 3) out.push(u16(p));
      else if (type === 4) out.push(u32(p));
      else if (type === 9) out.push(s32(p));
      else if (type === 5) out.push(u32(p) / (u32(p + 4) || 1));
      else if (type === 10) out.push(s32(p) / (s32(p + 4) || 1));
      else out.push(0);
    }
    return out;
  };

  const ifd = (off, kind) => {
    if (!off || off + 2 > t.length || seen.has(off) || seen.size > 16) return 0;
    seen.add(off);
    const n = u16(off);
    for (let e = 0; e < n; e++) {
      const p = off + 2 + e * 12;
      if (p + 12 > t.length) break;
      const tag = u16(p), type = u16(p + 2), count = u32(p + 4);
      const size = (SIZES[type] || 1) * count;
      const at = size <= 4 ? p + 8 : u32(p + 8);
      if (at + Math.min(size, 1) > t.length || size > t.length) continue;
      found++;
      if (kind === 'ifd0' && tag === 0x8769) { ifd(u32(p + 8), 'exif'); continue; }
      if (kind === 'ifd0' && tag === 0x8825) { ifd(u32(p + 8), 'gps'); continue; }
      if (tag === 0xa005) continue;
      if (tag === 0x02bc) { readXmp(utf8.decode(t.subarray(at, at + size)), r, size); continue; }
      if (tag === 0x83bb) { r.add('author', '', '', size); readIim(t.subarray(at, at + size), r); continue; }
      if (tag === 0x8773) { r.add('icc', 'ICC profile', iccName(t.subarray(at, at + size)) || 'Embedded', size); continue; }
      if (tag === 0x8649) { r.add('other', 'Photoshop resources', formatBytes(size), size); continue; }
      if (kind === 'ifd0' && tag === 0x0112) { r.orientation = u16(p + 8) || 1; continue; }
      if (isFile && kind === 'ifd0' && STRUCTURE.has(tag)) { found--; continue; }
      if (kind === 'ifd0' && tag === 0x0112) { r.orientation = u16(p + 8) || 1; continue; }
      if (kind === 'gps') { gps[tag] = value(type, count, at); continue; }
      const def = (kind === 'ifd0' ? TAGS0 : TAGS_EXIF)[tag];
      if (!def) { other++; continue; }
      const v = formatTag(tag, type, value(type, count, at), count);
      if (v === '') continue;
      r.add(def[0], def[1], clip(v));
      if (tag === 0x0131 || tag === 0x010e || tag === 0x9286 || tag === 0x9c9c) r.noteAI(v);
      if (tag === 0x9286 && /Steps: \d+/.test(v) && /Sampler: /.test(v)) {
        r.add('ai', 'Generation settings', clip(v, 600));
        r.ai.add('Stable Diffusion settings');
      }
    }
    if (kind === 'ifd0' && !isFile && off + 2 + n * 12 + 4 <= t.length) {
      const next = u32(off + 2 + n * 12);
      if (next) thumbIfd(next);
    }
    return n;
  };

  const thumbIfd = (off) => {
    if (off + 2 > t.length) return;
    const n = u16(off);
    let len = 0;
    for (let e = 0; e < n; e++) {
      const p = off + 2 + e * 12;
      if (p + 12 > t.length) break;
      if (u16(p) === 0x0202) len = u32(p + 8);
    }
    r.add('thumb', 'Preview thumbnail', len ? formatBytes(len) : 'Present');
  };

  ifd(u32(4), 'ifd0');

  if (gps[2] && gps[4]) {
    const dms = (a) => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
    const lat = dms(gps[2]) * (gps[1] === 'S' ? -1 : 1);
    const lon = dms(gps[4]) * (gps[3] === 'W' ? -1 : 1);
    if (lat || lon) r.add('gps', 'Coordinates', `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  }
  if (gps[6]) r.add('gps', 'Altitude', `${Math.round(gps[6][0])} m`);
  if (gps[0x11]) r.add('gps', 'Facing', `${Math.round(gps[0x11][0])}°`);
  if (gps[0x1d]) r.add('gps', 'GPS date', String(gps[0x1d]));
  const gpsCount = Object.keys(gps).length;
  if (gpsCount && !r.groups.has('gps')) r.add('gps', 'GPS tags', `${gpsCount}`);
  if (other) r.add('camera', 'Other camera tags', `${other}`);
  if (found && r.groups.has('camera')) r.group('camera').bytes += bytes;
}

function formatTag(tag, type, v, count) {
  if (tag === 0x927c) return formatBytes(count);
  if (tag === 0x9286) return userComment(v);
  if (tag >= 0x9c9b && tag <= 0x9c9f) {
    const raw = v instanceof Uint8Array ? v : new Uint8Array(v);
    return clean(new TextDecoder('utf-16le').decode(raw));
  }
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return clean(latin1.decode(v)) || formatBytes(v.length);
  const n = v[0];
  if (tag === 0x829a) return n >= 1 ? `${n} s` : `1/${Math.round(1 / n)} s`;
  if (tag === 0x829d) return `f/${+n.toFixed(1)}`;
  if (tag === 0x920a) return `${+n.toFixed(1)} mm`;
  return String(n);
}

function userComment(v) {
  if (!(v instanceof Uint8Array) || v.length < 8) return '';
  const head = latin1.decode(v.subarray(0, 8));
  const body = v.subarray(8);
  if (head.startsWith('UNICODE')) {
    // piexif writes UTF-16BE; some tools write LE. Guess from where the zero bytes sit.
    const be = body.length > 1 && body[0] === 0 && body[1] !== 0;
    return clean(new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(body));
  }
  return clean(utf8.decode(body));
}

// ---- XMP ------------------------------------------------------------------

export function readXmp(x, r, bytes = x.length) {
  r.group('xmp').bytes += bytes;
  const get = (name) => {
    const attr = x.match(new RegExp(`${name}="([^"]*)"`));
    if (attr) return decodeEntities(attr[1]);
    const el = x.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    if (!el) return '';
    return decodeEntities(el[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  };
  const fields = [
    ['xmp:CreatorTool', 'camera', 'Made with'], ['tiff:Make', 'camera', 'Make'], ['tiff:Model', 'camera', 'Model'],
    ['xmp:CreateDate', 'camera', 'Created'], ['photoshop:DateCreated', 'camera', 'Created'],
    ['dc:creator', 'author', 'Creator'], ['dc:rights', 'author', 'Rights'], ['photoshop:Credit', 'author', 'Credit'],
    ['dc:title', 'author', 'Title'], ['dc:description', 'text', 'Description'], ['dc:subject', 'author', 'Keywords'],
    ['photoshop:City', 'gps', 'City'], ['photoshop:Country', 'gps', 'Country'],
    ['Iptc4xmpCore:Location', 'gps', 'Place'], ['xmpMM:DocumentID', 'xmp', 'Document ID'],
    ['xmpMM:OriginalDocumentID', 'xmp', 'Original document ID'],
  ];
  const seen = new Set();
  for (const [name, key, label] of fields) {
    const v = get(name);
    if (!v || seen.has(label + v)) continue;
    seen.add(label + v);
    r.add(key, label, clip(v));
  }
  const lat = get('exif:GPSLatitude'), lon = get('exif:GPSLongitude');
  if (lat && lon) r.add('gps', 'Coordinates', `${lat}, ${lon}`);
  const hist = (x.match(/stEvt:action/g) || []).length;
  if (hist) r.add('xmp', 'Edit history', `${hist} steps`);
  const src = x.match(/DigitalSourceType[^>]*?(?:="|>)\s*([^"<\s]+)/);
  if (src) {
    const kind = src[1].split('/').pop();
    r.add(AI_SOURCE.test(kind) ? 'ai' : 'xmp', 'Source type', kind);
  }
  r.noteAI(x);
  if (!r.groups.get('xmp').items.length) r.add('xmp', 'XMP packet', formatBytes(bytes));
}

const decodeEntities = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

// ---- Photoshop / IPTC -----------------------------------------------------

const IPTC = {
  5: ['author', 'Title'], 25: ['author', 'Keywords'], 55: ['camera', 'Date created'], 80: ['author', 'By-line'],
  85: ['author', 'By-line title'], 90: ['gps', 'City'], 92: ['gps', 'Sublocation'], 95: ['gps', 'State'],
  101: ['gps', 'Country'], 105: ['author', 'Headline'], 110: ['author', 'Credit'], 115: ['author', 'Source'],
  116: ['author', 'Copyright'], 118: ['author', 'Contact'], 120: ['text', 'Caption'], 122: ['author', 'Caption writer'],
};

function readPhotoshop(d, r, bytes) {
  r.add('author', '', '', bytes);
  let i = 14; // after "Photoshop 3.0\0"
  let resources = 0;
  while (i + 12 <= d.length && startsWith(d, i, '8BIM')) {
    const id = u16be(d, i + 4);
    let p = i + 6;
    const nameLen = d[p];
    p += 1 + nameLen + ((1 + nameLen) % 2);
    const size = u32be(d, p);
    p += 4;
    if (id === 0x0404) readIim(d.subarray(p, p + size), r);
    else resources++;
    i = p + size + (size % 2);
  }
  if (resources) r.add('other', 'Photoshop resources', `${resources}`);
}

function readIim(d, r) {
  const words = new Map();
  for (let i = 0; i + 5 <= d.length && d[i] === 0x1c; ) {
    const rec = d[i + 1], ds = d[i + 2], len = u16be(d, i + 3);
    if (len & 0x8000) break;
    if (rec === 2 && IPTC[ds]) {
      const v = clean(utf8.decode(d.subarray(i + 5, i + 5 + len)));
      if (v) {
        const k = IPTC[ds];
        if (!words.has(k)) words.set(k, []);
        words.get(k).push(v);
      }
    }
    i += 5 + len;
  }
  for (const [[key, label], vals] of words) {
    r.add(key, label, clip(vals.join(', ')));
    r.noteAI(vals.join(' '));
  }
}

// ---- C2PA -----------------------------------------------------------------

function readC2pa(d, r) {
  r.add('c2pa', '', '', d.length);
  const s = latin1.decode(d);
  const gen = cborTextAfter(d, s, 'claim_generator') || nameInfo(d, s);
  if (gen) { r.add('c2pa', 'Made with', clip(gen, 120)); r.noteAI(gen); }
  const signer = s.match(/(?:CN|O)=?[\x00-\x20]{0,3}([A-Za-z][\x20-\x7e]{2,60})/);
  const issuers = s.match(/(Adobe|OpenAI|Google|Microsoft|Truepic|Leica|Sony|Nikon|Canon|Samsung|Qualcomm|Meta|Shutterstock|Getty)[\x20-\x7e]{0,30}/);
  if (issuers) r.add('c2pa', 'Signed by', clip(issuers[0].trim(), 60));
  else if (signer) r.add('c2pa', 'Signed by', clip(signer[1].trim(), 60));
  const actions = [...new Set((s.match(/c2pa\.(created|opened|edited|placed|converted|resized|cropped|color_adjustments|filtered|drawing|published|transcoded)/g) || []))];
  if (actions.length) r.add('c2pa', 'Recorded actions', actions.map((a) => a.slice(5).replace('_', ' ')).join(', '));
  if (AI_SOURCE.test(s)) r.add('c2pa', 'AI disclosure', 'Says the image was made with AI');
  r.noteAI(s);
  if (!r.groups.get('c2pa').items.length) r.add('c2pa', 'Manifest', formatBytes(d.length));
}

function cborTextAfter(d, s, key) {
  for (let at = s.indexOf(key); at >= 0; at = s.indexOf(key, at + 1)) {
    const v = cborTextAt(d, at + key.length);
    if (v) return v;
  }
  return '';
}

// C2PA 2.x moved the generator into claim_generator_info: [{ name: ... }].
function nameInfo(d, s) {
  const at = s.indexOf('claim_generator_info');
  if (at < 0) return '';
  const n = s.indexOf('name', at);
  return n > 0 && n - at < 64 ? cborTextAt(d, n + 4) : '';
}

function cborTextAt(d, p) {
  const h = d[p];
  let len = -1, start = p + 1;
  if (h >= 0x61 && h <= 0x77) len = h - 0x60;
  else if (h === 0x78) { len = d[p + 1]; start = p + 2; }
  return len > 0 ? clean(utf8.decode(d.subarray(start, start + len))) : '';
}

// ---- PNG ------------------------------------------------------------------

export const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI']);

export function pngChunks(b) {
  const out = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = str(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) break;
    out.push({ type, start: i, end, data: b.subarray(i + 8, i + 8 + len) });
    i = end;
    if (type === 'IEND') break;
  }
  return { chunks: out, trailer: b.length - i };
}

async function inflate(data) {
  try {
    const ds = new DecompressionStream('deflate');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

const AI_KEYS = /^(parameters|prompt|workflow|negative_prompt|sd-metadata|invokeai_metadata|invokeai_graph|dream|generation_data|comfyui|ai_metadata|aesthetic_score|seed)$/i;

async function readPng(b, r) {
  const { chunks, trailer } = pngChunks(b);
  for (const c of chunks) {
    const size = c.end - c.start;
    if (PNG_KEEP.has(c.type)) continue;
    if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const t = await pngText(c);
      if (!t) { r.add('text', c.type, formatBytes(size), size); continue; }
      if (t.key === 'XML:com.adobe.xmp') { readXmp(t.text, r, size); continue; }
      if (t.key === 'Raw profile type exif' || t.key === 'Raw profile type APP1') {
        r.add('camera', 'EXIF (text form)', formatBytes(size), size);
        continue;
      }
      const isAI = AI_KEYS.test(t.key) || (t.key === 'Software' && AI_WORDS.test(t.text)) || (t.key === 'Comment' && /"(prompt|uc|steps|sampler)"/.test(t.text)) || (t.key === 'Description' && /--(v|ar|style|seed) /.test(t.text));
      r.add(isAI ? 'ai' : 'text', t.key, clip(t.text, isAI ? 600 : 400), size);
      if (isAI) {
        if (t.key === 'workflow' || t.key === 'prompt' && t.text.startsWith('{')) r.ai.add('ComfyUI');
        else if (t.key === 'parameters') r.ai.add('Stable Diffusion settings');
        else if (t.key === 'Comment') r.ai.add('NovelAI');
        else r.ai.add('AI prompt');
      }
      r.noteAI(t.text);
    } else if (c.type === 'eXIf') readTiff(c.data, r, size);
    else if (c.type === 'caBX') readC2pa(c.data, r);
    else if (c.type === 'tIME') {
      const d = c.data;
      r.add('camera', 'Last changed', `${u16be(d, 0)}-${pad(d[2])}-${pad(d[3])} ${pad(d[4])}:${pad(d[5])}`, size);
    } else if (c.type === 'iCCP') {
      const z = c.data.indexOf(0);
      r.add('icc', 'ICC profile', latin1.decode(c.data.subarray(0, z)) || 'Embedded', size);
    } else r.add('other', `${c.type} chunk`, formatBytes(size), size);
  }
  if (trailer > 0) r.add('thumb', 'Data after the image', formatBytes(trailer), trailer);
}
const pad = (n) => String(n).padStart(2, '0');

async function pngText(c) {
  const d = c.data;
  const z = d.indexOf(0);
  if (z < 0) return null;
  const key = latin1.decode(d.subarray(0, z));
  if (c.type === 'tEXt') return { key, text: latin1.decode(d.subarray(z + 1)) };
  if (c.type === 'zTXt') {
    const raw = await inflate(d.subarray(z + 2));
    return { key, text: raw ? latin1.decode(raw) : '(compressed)' };
  }
  const compressed = d[z + 1] === 1;
  let p = z + 3;
  p = d.indexOf(0, p) + 1; // language tag
  p = d.indexOf(0, p) + 1; // translated keyword
  if (p <= 0) return { key, text: '' };
  const body = d.subarray(p);
  const raw = compressed ? await inflate(body) : body;
  return { key, text: raw ? utf8.decode(raw) : '(compressed)' };
}

// ---- WebP -----------------------------------------------------------------

export const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

export function webpChunks(b) {
  const out = [];
  let i = 12;
  const end = Math.min(b.length, 8 + u32le(b, 4));
  while (i + 8 <= end) {
    const type = str(b, i, 4);
    const len = u32le(b, i + 4);
    const next = i + 8 + len + (len % 2);
    out.push({ type, start: i, end: Math.min(next, b.length), data: b.subarray(i + 8, Math.min(i + 8 + len, b.length)) });
    i = next;
  }
  return { chunks: out, trailer: b.length - Math.min(i, b.length) };
}

function readWebp(b, r) {
  const { chunks, trailer } = webpChunks(b);
  for (const c of chunks) {
    const size = c.end - c.start;
    if (WEBP_KEEP.has(c.type)) continue;
    if (c.type === 'EXIF') readTiff(startsWith(c.data, 0, 'Exif\0') ? c.data.subarray(6) : c.data, r, size);
    else if (c.type === 'XMP ') readXmp(utf8.decode(c.data), r, size);
    else if (c.type === 'C2PA') readC2pa(c.data, r);
    else if (c.type === 'ICCP') r.add('icc', 'ICC profile', iccName(c.data) || 'Embedded', size);
    else r.add('other', `${c.type.trim()} chunk`, formatBytes(size), size);
  }
  if (trailer > 0) r.add('thumb', 'Data after the image', formatBytes(trailer), trailer);
}

// ---- GIF ------------------------------------------------------------------

// Walks GIF blocks. Calls visit(kind, start, end, info) for every block so the cleaner can reuse it.
export function gifBlocks(b, visit) {
  let i = 13;
  if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1));
  visit('head', 0, i);
  const skipSubBlocks = (p) => { while (p < b.length && b[p] !== 0) p += b[p] + 1; return p + 1; };
  while (i < b.length) {
    const start = i;
    if (b[i] === 0x3b) { visit('end', i, i + 1); return; }
    if (b[i] === 0x2c) {
      let p = i + 10;
      if (b[i + 9] & 0x80) p += 3 * (1 << ((b[i + 9] & 7) + 1));
      p = skipSubBlocks(p + 1);
      visit('image', start, p);
      i = p;
    } else if (b[i] === 0x21) {
      const label = b[i + 1];
      let id = '';
      if (label === 0xff && b[i + 2] === 11) id = str(b, i + 3, 11);
      const p = skipSubBlocks(i + 2);
      const kind = label === 0xf9 ? 'gce' : label === 0x01 ? 'text' : label === 0xfe ? 'comment' : label === 0xff ? (/^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(id) ? 'loop' : 'app') : 'ext';
      visit(kind, start, p, { id, data: b.subarray(i + 2, p) });
      i = p;
    } else return;
  }
}

function readGif(b, r) {
  gifBlocks(b, (kind, start, end, info) => {
    if (kind === 'comment') {
      let t = '';
      for (let p = 0; p < info.data.length && info.data[p]; p += info.data[p] + 1) t += latin1.decode(info.data.subarray(p + 1, p + 1 + info.data[p]));
      r.add('comment', 'Comment', clip(clean(t)) || 'Empty', end - start);
      r.noteAI(t);
    } else if (kind === 'app') {
      if (info.id.startsWith('XMP Data')) {
        const xs = indexOf(b, '<x:xmpmeta', start, end);
        const xe = indexOf(b, '</x:xmpmeta>', start, end);
        if (xs >= 0 && xe > xs) readXmp(utf8.decode(b.subarray(xs, xe + 12)), r, end - start);
        else r.add('xmp', 'XMP packet', formatBytes(end - start), end - start);
      } else if (info.id.startsWith('ICCRGBG1')) r.add('icc', 'ICC profile', 'Embedded', end - start);
      else if (/c2pa/i.test(info.id)) readC2pa(info.data, r);
      else r.add('other', `${info.id.trim() || 'App'} block`, formatBytes(end - start), end - start);
    }
  });
}

// ---- AVIF, HEIC and anything else: scan for known payloads -----------

function readByScan(b, r) {
  // HEIF also names its Exif item type "Exif", so look for the copy followed by a TIFF header.
  for (let ex = indexOf(b, 'Exif\0\0'); ex >= 0; ex = indexOf(b, 'Exif\0\0', ex + 1)) {
    if (startsWith(b, ex + 6, 'MM\0*') || startsWith(b, ex + 6, 'II*\0')) { readTiff(b.subarray(ex + 6), r, 0); break; }
  }
  const xs = indexOf(b, '<x:xmpmeta');
  if (xs >= 0) {
    const xe = indexOf(b, '</x:xmpmeta>', xs);
    if (xe > 0) readXmp(utf8.decode(b.subarray(xs, xe + 12)), r, xe + 12 - xs);
  }
  const jumb = indexOf(b, 'c2pa');
  if (jumb >= 0 && indexOf(b, 'jumb', Math.max(0, jumb - 64), jumb + 64) >= 0) readC2pa(b.subarray(Math.max(0, jumb - 64)), r);
  if (r.format === 'heic' || r.format === 'avif') {
    const ic = indexOf(b, 'colr');
    if (ic >= 0 && (startsWith(b, ic + 4, 'prof') || startsWith(b, ic + 4, 'rICC'))) r.add('icc', 'ICC profile', 'Embedded');
  }
}
