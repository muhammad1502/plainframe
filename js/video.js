// MP4 and MOV metadata, read and removed without re-encoding.
//
// Only the small boxes are read into memory: everything else stays in the original file and is
// copied by reference with Blob.slice. Removal never changes the file's layout. A metadata box is
// renamed to 'free' and its contents zeroed, dates are zeroed in place, so every offset into the
// media data stays valid. Players skip 'free' boxes.

import { Report, readXmp, formatBytes } from './meta.js';

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const enc = new TextEncoder();

export const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|3gp|3g2|qt)$/i.test(f.name);

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf']);
const MAX_MOOV = 96 * 1024 * 1024;

async function bytesAt(file, start, len) {
  return new Uint8Array(await file.slice(start, start + len).arrayBuffer());
}

const u32 = (b, i) => b[i] * 16777216 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const u64 = (b, i) => u32(b, i) * 4294967296 + u32(b, i + 4);
const type4 = (b, i) => latin1.decode(b.subarray(i, i + 4));

// Top-level boxes, read from headers only.
async function topLevel(file) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= file.size) {
    const h = await bytesAt(file, off, 16);
    let size = u32(h, 0);
    const type = type4(h, 4);
    let head = 8;
    if (size === 1) { size = u64(h, 8); head = 16; }
    else if (size === 0) size = file.size - off;
    if (size < head || off + size > file.size || !/^[\x20-\x7e\xa9]{4}$/.test(type)) break;
    boxes.push({ type, start: off, end: off + size, head });
    off += size;
  }
  return { boxes, trailer: off < file.size ? { start: off, end: file.size } : null };
}

// Child boxes inside a buffer region.
function children(b, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = u32(b, off);
    let head = 8;
    if (size === 1) { size = u64(b, off + 8); head = 16; }
    else if (size === 0) size = end - off;
    if (size < head || off + size > end) break;
    out.push({ type: type4(b, off + 4), start: off, end: off + size, head });
    off += size;
  }
  return out;
}

// QuickTime 'meta' is a plain box; ISO 'meta' is a FullBox with 4 extra bytes. Tell them apart by
// whether a valid child header follows immediately.
function metaBody(b, box) {
  const at = box.start + box.head;
  const t = type4(b, at + 4);
  return /^(hdlr|keys|ilst|mhdr)$/.test(t) ? at : at + 4;
}

const QT_DATE = (s) => (s > 0 ? new Date((s - 2082844800) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '');

// Names inside mdta 'keys' and the category each belongs to.
function keyCategory(k) {
  // Judge the short name: every Apple key starts with "com.apple.quicktime", which contains "time".
  const s = k.toLowerCase().replace(/^com\.(apple\.quicktime|android)\./, '');
  if (s.includes('location') || s.includes('gps')) return 'location';
  if (/(creation|date|time)/.test(s)) return 'dates';
  if (/(author|artist|copyright|description|title|comment|displayname|keywords|publisher|information)/.test(s)) return 'author';
  return 'camera';
}

function udtaCategory(t) {
  if (t === '©xyz' || t === 'loci' || t === 'gps ' || t === '©gps') return 'location';
  if (t === '©day' || t === 'date') return 'dates';
  if (/^(©ART|©aut|©cpy|©nam|©cmt|©des|©inf|desc|cprt|auth|titl|dscp|perf|kywd|©wrt|©dir|©prd)$/.test(t)) return 'author';
  if (/^(©mak|©mod|©swr|©too|©enc|©fmt|©src|manu|modl|ldes)$/.test(t)) return 'camera';
  return 'other';
}

const LABEL = {
  '©xyz': 'Coordinates', loci: 'Location', '©day': 'Date', '©mak': 'Make', '©mod': 'Model', '©swr': 'Software',
  '©too': 'Encoder', '©ART': 'Artist', '©aut': 'Author', '©cpy': 'Copyright', '©nam': 'Title', '©cmt': 'Comment', '©des': 'Description',
};

function qtText(b, box) {
  // Classic QuickTime text item: 16-bit length, 16-bit language, text.
  const at = box.start + box.head;
  const len = (b[at] << 8) | b[at + 1];
  if (len > 0 && at + 4 + len <= box.end) return utf8.decode(b.subarray(at + 4, at + 4 + len));
  // iTunes-style item holding a 'data' box.
  const d = children(b, at, box.end).find((c) => c.type === 'data');
  if (d) return utf8.decode(b.subarray(d.start + d.head + 8, d.end));
  return '';
}

const GROUP = { location: 'gps', camera: 'camera', dates: 'dates', author: 'author', other: 'other' };

// Walks moov and returns every piece of metadata with where it lives, for both reading and removal.
function walkMoov(b, base) {
  const found = []; // { cat, label, value, kind: 'box'|'time', start, end }
  const timeBox = (box, label) => {
    const v = b[box.start + box.head];
    const at = box.start + box.head + 4;
    const created = v === 1 ? u64(b, at) : u32(b, at);
    const modified = v === 1 ? u64(b, at + 8) : u32(b, at + 4);
    const len = v === 1 ? 16 : 8;
    if (created || modified) found.push({ cat: 'dates', label, value: QT_DATE(created || modified), kind: 'time', start: base + at, end: base + at + len });
  };
  const items = (box, where) => {
    for (const c of children(b, box.start + box.head, box.end)) {
      if (c.type === 'free' || c.type === 'skip') continue;
      if (c.type === 'meta') { metaItems(c); continue; }
      if (c.type === 'loci') {
        found.push({ cat: 'location', label: 'Coordinates', value: loci(b, c), kind: 'box', start: base + c.start, end: base + c.end });
        continue;
      }
      const cat = udtaCategory(c.type);
      const text = cat === 'other' ? '' : qtText(b, c).replace(/\0+$/, '');
      found.push({ cat, label: LABEL[c.type] || (cat === 'other' ? `${c.type.trim()} box` : c.type), value: text || formatBytes(c.end - c.start), kind: 'box', start: base + c.start, end: base + c.end, where });
    }
  };
  const metaItems = (meta) => {
    const kids = children(b, metaBody(b, meta), meta.end);
    const keysBox = kids.find((k) => k.type === 'keys');
    const ilst = kids.find((k) => k.type === 'ilst');
    const keys = [];
    if (keysBox) {
      let p = keysBox.start + keysBox.head + 8;
      while (p + 8 <= keysBox.end) {
        const size = u32(b, p);
        if (size < 8) break;
        keys.push(latin1.decode(b.subarray(p + 8, p + size)));
        p += size;
      }
    }
    if (!ilst) {
      if (!keysBox) found.push({ cat: 'other', label: 'Metadata box', value: formatBytes(meta.end - meta.start), kind: 'box', start: base + meta.start, end: base + meta.end });
      return;
    }
    for (const item of children(b, ilst.start + ilst.head, ilst.end)) {
      if (item.type === 'free' || item.type === 'skip') continue;
      const idx = u32(b, item.start + 4);
      const name = keysBox && idx >= 1 && idx <= keys.length ? keys[idx - 1] : item.type;
      const cat = keysBox ? keyCategory(name) : udtaCategory(item.type);
      const d = children(b, item.start + item.head, item.end).find((c) => c.type === 'data');
      let value = '';
      if (d) {
        const raw = b.subarray(d.start + d.head + 8, d.end);
        const wellKnown = u32(b, d.start + d.head) & 0xffffff;
        value = wellKnown === 1 ? utf8.decode(raw) : formatBytes(raw.length);
      }
      const short = name.replace(/^com\.(apple\.quicktime|android)\./, '');
      found.push({ cat: cat === 'other' ? 'camera' : cat, label: LABEL[name] || short, value, kind: 'box', start: base + item.start, end: base + item.end });
    }
  };
  const walk = (start, end, path) => {
    for (const c of children(b, start, end)) {
      if (c.type === 'mvhd') timeBox(c, 'Created');
      else if (c.type === 'tkhd') timeBox(c, 'Track created');
      else if (c.type === 'mdhd') timeBox(c, 'Media created');
      else if (c.type === 'udta') items(c, path);
      else if (c.type === 'meta') metaItems(c);
      else if (c.type === 'trak' && isTimedMetadata(b, c)) {
        found.push({ cat: 'never', label: 'Timed metadata track', value: 'May hold GPS or sensor data', kind: 'track', start: base + c.start, end: base + c.end, trak: c });
      } else if (CONTAINERS.has(c.type)) walk(c.start + c.head, c.end, `${path}/${c.type}`);
    }
  };
  walk(0, b.length, '');
  return found;
}

// 3GPP location box: language, place name, role, then 16.16 fixed longitude, latitude, altitude.
function loci(b, box) {
  let p = box.start + box.head + 4 + 2;
  while (p < box.end && b[p] !== 0) p++;
  p += 2;
  if (p + 12 > box.end) return 'Present';
  const fixed = (i) => (u32(b, i) | 0) / 65536;
  return `${fixed(p + 4).toFixed(5)}, ${fixed(p).toFixed(5)}`;
}

function isTimedMetadata(b, trak) {
  const s = latin1.decode(b.subarray(trak.start, Math.min(trak.end, trak.start + 4096)));
  const h = s.indexOf('hdlr');
  if (h < 0) return false;
  const handler = s.slice(h + 12, h + 16);
  return handler === 'meta' || /gpmd|camm|mebx/.test(s);
}

export async function inspectVideo(file) {
  const r = new Report('video');
  const { boxes, trailer } = await topLevel(file);
  const moov = boxes.find((x) => x.type === 'moov');
  let found = [];
  if (moov && moov.end - moov.start <= MAX_MOOV) {
    const b = await bytesAt(file, moov.start, moov.end - moov.start);
    found = walkMoov(b, moov.start);
  }
  for (const f of found) {
    if (f.cat === 'never') r.add('other', f.label, f.value);
    else if (f.cat === 'location' && /^[+-]\d/.test(f.value)) r.add('gps', 'Coordinates', iso6709(f.value));
    else r.add(GROUP[f.cat], f.label, f.value.slice(0, 300));
  }
  for (const x of boxes) {
    if (x.type === 'uuid') {
      const id = [...(await bytesAt(file, x.start + 8, 16))].map((n) => n.toString(16).padStart(2, '0')).join('');
      if (id === XMP_UUID) {
        if (x.end - x.start < 8 * 1024 * 1024) readXmp(utf8.decode(await bytesAt(file, x.start + 24, x.end - x.start - 24)), r);
        else r.add('xmp', 'XMP packet', formatBytes(x.end - x.start));
      } else if (id === C2PA_UUID) r.add('c2pa', 'Manifest', formatBytes(x.end - x.start));
      else r.add('other', 'Vendor box', formatBytes(x.end - x.start));
    } else if (x.type === 'meta' || x.type === 'udta') r.add('other', `Top-level ${x.type}`, formatBytes(x.end - x.start));
  }
  if (trailer) r.add('thumb', 'Data after the video', formatBytes(trailer.end - trailer.start));
  const report = r.finish();
  report.isVideo = true;
  report.layout = { boxes, trailer, moov };
  return report;
}

function iso6709(s) {
  const m = s.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
  return m ? `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}${m[3] ? `, ${Math.round(+m[3])} m` : ''}` : s;
}

// Removes what the person chose. Returns a Blob made of slices of the original plus small patches.
export async function cleanVideo(file, remove) {
  const { boxes, trailer } = await topLevel(file);
  const patches = []; // { start, bytes }
  // Rename to 'free' and zero the payload; the size header (8 or 16 bytes) and position stay the same.
  const blank = (start, end, head) => {
    patches.push({ start, end, make: async () => {
      const out = new Uint8Array(end - start);
      out.set(await bytesAt(file, start, head), 0);
      out.set(enc.encode('free'), 4);
      return out;
    } });
  };
  const moov = boxes.find((x) => x.type === 'moov');
  if (moov && moov.end - moov.start <= MAX_MOOV) {
    const b = await bytesAt(file, moov.start, moov.end - moov.start);
    for (const f of walkMoov(b, moov.start)) {
      const drop = f.cat === 'never' || f.cat === 'other' || remove.has(f.cat);
      if (!drop) continue;
      if (f.kind === 'time') patches.push({ start: f.start, end: f.end, make: async () => new Uint8Array(f.end - f.start) });
      else if (f.kind === 'track') {
        blank(f.start, f.end, headLen(b, f.start - moov.start));
        for (const [s, e] of trackSamples(b, f.trak)) patches.push({ start: s, end: e, make: async () => new Uint8Array(e - s) });
      } else blank(f.start, f.end, headLen(b, f.start - moov.start));
    }
  }
  for (const x of boxes) {
    if (x.type === 'uuid' || x.type === 'meta' || x.type === 'udta') blank(x.start, x.end, x.head);
  }
  // Drop patches nested inside another (a blanked box already zeroes its insides).
  patches.sort((a, c) => a.start - c.start || c.end - a.end);
  const flat = [];
  for (const p of patches) if (!flat.length || p.start >= flat[flat.length - 1].end) flat.push(p);
  const parts = [];
  let at = 0;
  const end = trailer ? trailer.start : file.size;
  for (const p of flat) {
    if (p.start > at) parts.push(file.slice(at, p.start));
    parts.push(await p.make());
    at = p.end;
  }
  if (at < end) parts.push(file.slice(at, end));
  return new Blob(parts, { type: file.type || 'video/mp4' });
}

const headLen = (b, at) => (u32(b, at) === 1 ? 16 : 8);

// Byte ranges of a track's samples in the media data, from its chunk offsets, sample-to-chunk and sizes.
function trackSamples(b, trak) {
  const find = (start, end, path) => {
    let box = { start, end, head: 0 };
    for (const t of path) {
      box = children(b, box.start + box.head, box.end).find((c) => c.type === t);
      if (!box) return null;
    }
    return box;
  };
  const stbl = find(trak.start + trak.head, trak.end, ['mdia', 'minf', 'stbl']);
  if (!stbl) return [];
  const kids = children(b, stbl.start + stbl.head, stbl.end);
  const get = (t) => kids.find((c) => c.type === t);
  const stco = get('stco') || get('co64');
  const stsz = get('stsz');
  const stsc = get('stsc');
  if (!stco || !stsz || !stsc) return [];
  const wide = stco.type === 'co64';
  const nChunks = u32(b, stco.start + stco.head + 4);
  const offsets = [];
  for (let i = 0; i < nChunks; i++) offsets.push(wide ? u64(b, stco.start + stco.head + 8 + i * 8) : u32(b, stco.start + stco.head + 8 + i * 4));
  const fixed = u32(b, stsz.start + stsz.head + 4);
  const nSamples = u32(b, stsz.start + stsz.head + 8);
  const sizeOf = (i) => (fixed || u32(b, stsz.start + stsz.head + 12 + i * 4));
  const runs = [];
  const nRuns = u32(b, stsc.start + stsc.head + 4);
  for (let i = 0; i < nRuns; i++) {
    const p = stsc.start + stsc.head + 8 + i * 12;
    runs.push([u32(b, p), u32(b, p + 4)]);
  }
  const ranges = [];
  let sample = 0;
  for (let c = 0; c < nChunks && sample < nSamples; c++) {
    let per = 0;
    for (const [first, count] of runs) if (c + 1 >= first) per = count;
    let off = offsets[c];
    for (let k = 0; k < per && sample < nSamples; k++, sample++) {
      const s = sizeOf(sample);
      ranges.push([off, off + s]);
      off += s;
    }
  }
  return ranges;
}
