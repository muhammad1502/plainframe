import { inspect, formatBytes } from './meta.js';
import { cleanImage, canEncodeAvif, LOSSLESS, LOOKS_SAME } from './clean.js';
import { makeZip } from './zip.js';
import { removeSet, CATEGORIES, CATEGORY_NAMES, CATEGORY_GROUPS } from './keep.js';
import { isVideo, inspectVideo, cleanVideo } from './video.js';

const $ = (s) => document.querySelector(s);
// Present only inside the Android app.
const native = window.PlainframeAndroid || null;
const items = [];
let nextId = 1;
let busy = false;

const FORMAT_NAMES = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', avif: 'AVIF', heic: 'HEIC', gif: 'GIF', tiff: 'TIFF', bmp: 'BMP', ico: 'ICO', video: 'Video', other: 'Image' };
const GROUP_ICONS = { ai: 'cpu', c2pa: 'badge', gps: 'pin', camera: 'camera', dates: 'text', author: 'user', xmp: 'text', text: 'text', comment: 'text', thumb: 'layers', icc: 'palette', other: 'dots' };
const FLAG_NAMES = { gps: 'Location', ai: 'AI data', c2pa: 'Content Credentials', camera: 'Camera', author: 'Author' };

// ---- Settings -------------------------------------------------------------

const QUALITIES = ['smart', '90', '70', '50'];
const defaults = {
  mode: 'lossless', format: 'same', quality: 'smart', fingerprint: false, keepIcc: true, rename: true,
  remove: 'all', rm_location: true, rm_camera: true, rm_dates: true, rm_author: true, rm_ai: true,
};
const settings = { ...defaults, ...load('settings') };
if (!QUALITIES.includes(String(settings.quality))) settings.quality = 'smart';

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {}
}

function bindSettings() {
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === settings.mode;
    r.addEventListener('change', () => { settings.mode = r.value; settingsChanged(); });
  }
  for (const r of document.querySelectorAll('input[name=remove]')) {
    r.checked = r.value === settings.remove;
    r.addEventListener('change', () => { settings.remove = r.value; settingsChanged(); });
  }
  for (const sw of document.querySelectorAll('[data-rm]')) {
    const key = `rm_${sw.dataset.rm}`;
    sw.checked = settings[key] !== false;
    sw.addEventListener('change', () => { settings[key] = sw.checked; settingsChanged(); });
  }
  for (const r of document.querySelectorAll('input[name=quality]')) {
    r.checked = r.value === String(settings.quality);
    r.addEventListener('change', () => { settings.quality = r.value; settingsChanged(); });
  }
  const bind = (id, key, read) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = settings[key];
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => { settings[key] = read(el); settingsChanged(); });
  };
  bind('#format', 'format', (el) => el.value);
  bind('#fingerprint', 'fingerprint', (el) => el.checked);
  bind('#keep-icc', 'keepIcc', (el) => el.checked);
  bind('#rename', 'rename', (el) => el.checked);
  canEncodeAvif().then((ok) => {
    $('#avif-option').hidden = !ok;
    if (!ok && settings.format === 'avif') { settings.format = 'same'; $('#format').value = 'same'; }
  });
  renderSettings();
}

function renderSettings() {
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== settings.mode;
  $('#custom-list').hidden = settings.remove !== 'custom';
  const rm = removeSet(settings);
  const keep = CATEGORIES.filter((c) => !rm.has(c)).map((c) => CATEGORY_NAMES[c].toLowerCase());
  $('#remove-help').textContent = settings.remove === 'all'
    ? 'All metadata comes off.'
    : settings.remove === 'location'
      ? 'Only where it was taken comes off. Camera details, dates and captions stay.'
      : keep.length ? `Keeps ${keep.join(', ')}. Everything else comes off.` : 'All metadata comes off.';
  $('#quality-help').textContent = settings.quality === 'smart'
    ? 'Finds the smallest file that still looks the same as the original. PNG stays lossless.'
    : `Saves at ${settings.quality}% for a smaller file. Each photo is checked afterwards. PNG stays lossless.`;
  $('#mode-help').textContent = settings.mode === 'lossless'
    ? 'Removes metadata and keeps every pixel and animation. HEIC, AVIF, TIFF and BMP are redrawn.'
    : 'Paints a brand-new image, so nothing old can come along. Animations keep only the first frame.';
}

function settingsChanged() {
  save();
  renderSettings();
  let stale = false;
  for (const it of items) if (it.out) { it.out = null; it.status = 'ready'; stale = true; }
  if (stale) renderList();
  updateActions();
}

// ---- Adding files ---------------------------------------------------------

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f && (f.type.startsWith('image/') || isVideo(f) || /\.(jpe?g|png|webp|avif|heic|heif|gif|tiff?|bmp|ico)$/i.test(f.name)));
  if (!files.length) { toast('Those files are not photos or videos'); return; }
  const added = files.map((file) => ({ id: nextId++, file, video: isVideo(file), status: 'reading', info: null, out: null, thumb: null }));
  items.push(...added);
  $('#photos').hidden = false;
  renderList();
  updateActions();
  // One file at a time, and nothing kept but the report and a small thumbnail, so a big batch
  // uses about as much memory as a single photo.
  for (const it of added) {
    if (!items.includes(it)) continue;
    try {
      if (it.video) it.info = await inspectVideo(it.file);
      else it.info = await inspect(new Uint8Array(await it.file.arrayBuffer()));
      it.status = 'ready';
    } catch {
      it.status = 'error';
      it.error = 'Could not read this file';
    }
    renderRow(it);
    it.thumb = await makeThumb(it);
    renderRow(it);
  }
  renderSummary();
  updateActions();
  announce(`${files.length} ${plural(files.length, 'file')} added`);
}

const plural = (n, w) => (n === 1 ? w : `${w}s`);

// A 96px preview drawn once, so the list never holds full-size images.
async function makeThumb(it) {
  try {
    const src = it.video ? await videoFrame(it.file) : await imageSource(it.file);
    if (!src) return null;
    const w = 96, h = Math.max(1, Math.round((96 * src.height) / src.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(src.source, 0, 0, w, h);
    src.done();
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

async function imageSource(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 192, resizeQuality: 'medium' });
    return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
  } catch {}
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

function videoFrame(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (r) => { clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { URL.revokeObjectURL(url); done(null); }, 4000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => done({ source: v, width: v.videoWidth, height: v.videoHeight, done: () => { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); } });
    v.onerror = () => { URL.revokeObjectURL(url); done(null); };
    v.src = url;
  });
}

// ---- List -----------------------------------------------------------------

function renderList() {
  const list = $('#list');
  const keep = new Set(items.map((i) => i.id));
  for (const li of [...list.children]) if (!keep.has(+li.dataset.id)) li.remove();
  for (const it of items) renderRow(it);
  renderSummary();
}

function renderRow(it) {
  const list = $('#list');
  let li = list.querySelector(`[data-id="${it.id}"]`);
  if (!li) {
    li = document.createElement('li');
    li.className = 'photo-row';
    li.dataset.id = it.id;
    li.innerHTML = `<button class="photo-open" type="button" aria-haspopup="dialog">
      <span class="thumb-icon" aria-hidden="true"><svg><use href="#i-${it.video ? 'video' : 'image'}"/></svg></span>
      <span class="row-main"><span class="row-title"></span><span class="row-sub"></span></span>
      <span class="badge"></span><svg class="chev" aria-hidden="true"><use href="#i-chev"/></svg></button>`;
    li.querySelector('button').addEventListener('click', () => openSheet(it));
    list.append(li);
  }
  if (it.thumb && !li.querySelector('img.thumb')) {
    const img = el('img', 'thumb');
    img.alt = '';
    img.src = it.thumb;
    li.querySelector('.thumb-icon').replaceWith(img);
  }
  li.classList.toggle('is-working', it.status === 'working' || it.status === 'reading');
  li.querySelector('.row-title').textContent = it.out ? it.out.name : it.file.name;
  const sub = li.querySelector('.row-sub');
  const badge = li.querySelector('.badge');
  badge.classList.remove('is-clean');
  let label;
  if (it.status === 'reading') { sub.textContent = 'Reading'; badge.textContent = '…'; label = 'reading'; }
  else if (it.status === 'error') { sub.textContent = it.error; badge.textContent = '!'; label = 'error'; }
  else if (it.status === 'working') { sub.textContent = 'Cleaning'; badge.textContent = '…'; label = 'cleaning'; }
  else if (it.out) {
    const left = leftovers(it).length;
    const kept = keptNames(it);
    sub.textContent = left ? 'Some data left, see details' : kept.length ? `Cleaned · kept ${kept.join(', ').toLowerCase()}` : `Clean · ${formatBytes(it.out.blob.size)}`;
    badge.classList.add('is-clean');
    badge.innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
    label = left ? 'cleaned with notes' : 'clean';
  } else {
    const n = it.info.count;
    const flags = it.info.flags.map((f) => FLAG_NAMES[f]).filter(Boolean);
    sub.textContent = n ? flags.slice(0, 3).join(' · ') || `${n} ${plural(n, 'item')} found` : 'No metadata found';
    badge.textContent = n;
    label = `${n} metadata ${plural(n, 'item')} found`;
  }
  li.querySelector('button').setAttribute('aria-label', `${it.out ? it.out.name : it.file.name}, ${label}, show details`);
}

function renderSummary() {
  const ready = items.filter((i) => i.info);
  const total = ready.reduce((n, i) => n + i.info.count, 0);
  const done = items.filter((i) => i.out).length;
  const gps = ready.filter((i) => i.info.flags.includes('gps')).length;
  const ai = ready.filter((i) => i.info.flags.includes('ai') || i.info.flags.includes('c2pa')).length;
  const bits = [`${items.length} ${plural(items.length, 'file')}`];
  if (done) bits.push(`${done} cleaned`);
  else {
    bits.push(`${total} ${plural(total, 'item')} found`);
    if (gps) bits.push(`${gps} with location`);
    if (ai) bits.push(`${ai} with AI or C2PA data`);
  }
  $('#summary').textContent = bits.join(' · ');
}

// ---- Cleaning -------------------------------------------------------------

async function cleanAll() {
  if (busy) return;
  busy = true;
  updateActions();
  const todo = items.filter((i) => i.status === 'ready' && !i.out);
  let n = 0;
  for (const it of todo) {
    it.status = 'working';
    renderRow(it);
    $('#run-label').textContent = `Cleaning ${++n} of ${todo.length}`;
    await new Promise(requestAnimationFrame);
    try {
      let out;
      if (it.video) {
        const blob = await cleanVideo(it.file, removeSet(settings));
        const ext = (it.file.name.match(/\.[^.]+$/) || ['.mp4'])[0].toLowerCase();
        const base = settings.rename ? `video-${Math.random().toString(16).slice(2, 10)}` : it.file.name.replace(/\.[^.]+$/, '');
        out = { blob, format: 'video', lossless: true, kept: [], notes: [], removed: removeSet(settings), name: base + ext };
        out.verify = await inspectVideo(new File([blob], out.name, { type: blob.type }));
      } else {
        // Read the original only for as long as this one file takes.
        const bytes = new Uint8Array(await it.file.arrayBuffer());
        out = await cleanImage(bytes, it.file, it.info, settings);
        out.verify = await inspect(new Uint8Array(await out.blob.arrayBuffer()));
      }
      out.file = new File([out.blob], out.name, { type: out.blob.type, lastModified: Date.now() });
      it.out = out;
      it.status = 'done';
    } catch (err) {
      it.status = 'error';
      it.error = err.message || 'Could not clean this file';
    }
    renderRow(it);
  }
  busy = false;
  renderSummary();
  updateActions();
  const ok = items.filter((i) => i.out).length;
  toast(`${ok} ${plural(ok, 'file')} cleaned`);
}

function updateActions() {
  const has = items.length > 0;
  $('#actions').hidden = !has;
  document.body.classList.toggle('has-actions', has);
  if (!has) return;
  const pending = items.filter((i) => i.status === 'ready' && !i.out).length;
  const done = items.filter((i) => i.out);
  const run = $('#run');
  const zip = $('#zip');
  run.disabled = busy || items.some((i) => i.status === 'reading');
  if (busy) return;
  if (pending) {
    run.dataset.action = 'clean';
    run.querySelector('use').setAttribute('href', '#i-eraser');
    $('#run-label').textContent = `Clean ${pending} ${plural(pending, 'file')}`;
    zip.hidden = true;
  } else if (done.length) {
    run.dataset.action = 'save';
    run.querySelector('use').setAttribute('href', '#i-save');
    $('#run-label').textContent = done.length === 1 ? 'Save file' : `Save ${done.length} files`;
    zip.hidden = done.length < 2;
  } else {
    run.disabled = true;
    $('#run-label').textContent = 'Clean files';
    zip.hidden = true;
  }
}

// ---- Saving ---------------------------------------------------------------

const canShareFiles = (files) => {
  try { return !!navigator.canShare && navigator.canShare({ files }); } catch { return false; }
};
// Phones save to the photo library through the share sheet; desktops download.
const preferShare = () => matchMedia('(pointer: coarse)').matches;

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Streams a blob to the Android app in 3 MB pieces, so a long video never becomes one huge string.
async function nativeWrite(target, name, mime, blob) {
  const id = native.openOutput(target, name, mime || 'application/octet-stream');
  if (id < 0) return false;
  const CHUNK = 3 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += CHUNK) {
    if (!native.writeChunk(id, await toBase64(blob.slice(at, at + CHUNK)))) { native.abortOutput(id); return false; }
  }
  return native.closeOutput(id) ? id : false;
}

async function saveFiles(list) {
  if (native) {
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      if (list.length > 1) toast(`Saving ${i + 1} of ${list.length}`);
      if (await nativeWrite('media', list[i].out.name, list[i].out.blob.type, list[i].out.blob)) ok++;
    }
    const where = list.every((i) => i.video) ? 'Movies/Plainframe' : list.some((i) => i.video) ? 'Pictures and Movies' : 'Pictures/Plainframe';
    toast(ok === list.length ? `Saved to ${where}` : `Saved ${ok} of ${list.length}`);
    return;
  }
  const files = list.map((i) => i.out.file);
  if (preferShare() && canShareFiles(files)) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  if (files.length === 1) download(files[0], files[0].name);
  else {
    for (const f of files) { download(f, f.name); await new Promise((r) => setTimeout(r, 250)); }
  }
}

const canShare = () => !!native || (preferShare() && canShareFiles([new File([''], 'x.jpg', { type: 'image/jpeg' })]));

async function shareFiles(list) {
  if (native) {
    native.clearShareCache();
    const ids = [];
    for (const it of list) {
      const id = await nativeWrite('share', it.out.name, it.out.blob.type, it.out.blob);
      if (id !== false) ids.push(id);
    }
    if (!ids.length || !native.shareOutputs(JSON.stringify(ids))) toast('Could not open sharing');
    return;
  }
  try { await navigator.share({ files: list.map((i) => i.out.file) }); } catch {}
}

async function saveZip() {
  const done = items.filter((i) => i.out);
  if (!done.length) return;
  toast('Making ZIP');
  let blob;
  try {
    blob = await makeZip(done.map((i) => ({ name: i.out.name, blob: i.out.blob })));
  } catch (err) {
    toast(err.message);
    return;
  }
  const name = `plainframe-${done.length}-files.zip`;
  if (native) {
    toast((await nativeWrite('downloads', name, 'application/zip', blob)) !== false ? 'ZIP saved to Downloads' : 'Could not save the ZIP');
    return;
  }
  download(blob, name);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---- Details sheet --------------------------------------------------------

let sheetItem = null;
let opener = null;

function openSheet(it) {
  sheetItem = it;
  opener = document.activeElement;
  renderSheet();
  const d = $('#sheet');
  if (!d.open) d.showModal();
  document.documentElement.style.overflow = 'hidden';
  $('#sheet-body').scrollTop = 0;
}

function closeSheet() {
  const d = $('#sheet');
  if (d.open) d.close();
}

function renderSheet() {
  const it = sheetItem;
  const body = $('#sheet-body');
  body.textContent = '';
  const info = it.info;
  const head = el('div', 'sheet-head');
  const img = el('img');
  if (it.thumb) img.src = it.thumb;
  img.alt = '';
  const hgroup = el('div');
  const h = el('h2', '', it.file.name);
  h.id = 'sheet-title';
  const fmt = info ? FORMAT_NAMES[info.format] : '';
  hgroup.append(h, el('p', '', [fmt, formatBytes(it.file.size)].filter(Boolean).join(' · ')));
  head.append(img, hgroup);
  body.append(head);

  if (it.status === 'error') body.append(el('p', 'empty-note', it.error));
  if (!info) return;

  if (info.ai.length || info.flags.length) {
    const chips = el('div', 'chips');
    for (const f of info.flags) if (f !== 'ai' && FLAG_NAMES[f]) chips.append(el('span', `chip${f === 'gps' ? ' is-hot' : ''}`, FLAG_NAMES[f]));
    for (const a of info.ai) chips.append(el('span', `chip${a === 'Marked as AI-made' ? ' is-hot' : ''}`, a));
    body.append(chips);
  }

  if (it.out) body.append(verdict(it));
  if (it.out && !it.video) body.append(compareView(it));

  if (it.out && info.groups.length) body.append(el('h3', 'sheet-sub', 'Found in the original'));
  if (!info.groups.length) body.append(el('p', 'empty-note', 'No metadata found in this file. You can still clean it to get a fresh copy.'));
  for (const g of info.groups) {
    const sec = el('section', 'meta-group');
    const h3 = el('h3');
    h3.innerHTML = `<svg aria-hidden="true"><use href="#i-${GROUP_ICONS[g.key] || 'dots'}"/></svg>`;
    h3.append(document.createTextNode(g.title + (g.key === 'icc' && settings.keepIcc && settings.mode === 'lossless' ? ' (kept)' : '')));
    const dl = el('dl', 'meta-table');
    const rows = g.items.length ? g.items : [['Size', formatBytes(g.bytes)]];
    for (const [k, v] of rows) {
      const row = el('div');
      const dd = el('dd', String(v).length > 80 ? 'mono' : '', String(v));
      row.append(el('dt', '', k), dd);
      dl.append(row);
    }
    sec.append(h3, dl);
    body.append(sec);
  }

  const actions = el('div', 'sheet-actions');
  if (it.out) {
    const save = button('Save', 'save', '');
    save.addEventListener('click', () => saveFiles([it]));
    actions.append(save);
    if (canShare()) {
      const share = button('Share', 'share', 'button-secondary');
      share.addEventListener('click', () => shareFiles([it]));
      actions.append(share);
    }
  }
  const remove = button('Remove', 'trash', 'button-secondary');
  remove.addEventListener('click', () => { removeItem(it); closeSheet(); });
  actions.append(remove);
  body.append(actions);
}

// Groups still in the cleaned file that the person asked to remove.
function leftovers(it) {
  const allowed = new Set(['icc']);
  for (const c of CATEGORIES) if (!it.out.removed.has(c)) for (const g of CATEGORY_GROUPS[c]) allowed.add(g);
  return it.out.verify.groups.filter((g) => !allowed.has(g.key));
}

function keptNames(it) {
  const present = new Set(it.out.verify.groups.map((g) => g.key));
  return CATEGORIES.filter((c) => !it.out.removed.has(c) && CATEGORY_GROUPS[c].some((g) => g !== 'xmp' && present.has(g))).map((c) => CATEGORY_NAMES[c]);
}

function verdict(it) {
  const left = leftovers(it);
  const box = el('div', `verdict${left.length ? '' : ' is-ok'}`);
  const icon = el('span', 'row-icon');
  icon.innerHTML = `<svg aria-hidden="true"><use href="#i-${left.length ? 'dots' : 'check'}"/></svg>`;
  const text = el('div');
  const size = it.video ? `${formatBytes(it.out.blob.size)}, same layout as the original` : `${formatBytes(it.file.size)} to ${formatBytes(it.out.blob.size)}`;
  let how = it.video ? 'Not re-encoded' : it.out.lossless ? 'Pixels untouched' : `Redrawn as ${FORMAT_NAMES[it.out.format]}`;
  if (it.out.quality) {
    const m = it.out.match;
    const look = m >= LOOKS_SAME ? 'looks the same as the original' : m >= 37 ? 'small differences up close' : 'some loss is visible';
    how += ` at ${it.out.quality}% quality, ${look} (${m >= 99 ? 'exact' : `${m.toFixed(1)} dB`})`;
  }
  const keptCats = keptNames(it);
  if (left.length) {
    text.append(el('strong', '', 'Checked, some data left'), el('p', '', `${left.map((g) => g.title).join(', ')}.${it.video ? '' : ' Try Redraw for a fully fresh file.'}`));
  } else if (keptCats.length) {
    text.append(el('strong', '', 'Checked: removed what you chose'), el('p', '', `${how}. ${size}.`));
  } else {
    text.append(el('strong', '', 'Checked: no metadata left'), el('p', '', `${how}. ${size}.`));
  }
  const kept = [...keptCats, ...it.out.kept];
  for (const n of it.out.notes || []) text.append(el('p', '', `${n}.`));
  if (it.video && settings.mode === 'redraw') text.append(el('p', '', 'Videos are always cleaned without re-encoding.'));
  if (!it.video && !it.out.lossless && it.out.blob.size > it.file.size * 1.05) text.append(el('p', '', 'This file came out larger than the original. For graphics and screenshots, Keep quality or PNG usually stays smaller.'));
  if (it.out.scaled) kept.push('Resized to fit the browser’s canvas limit');
  if (it.out.fellBack) kept.push(`Saved as ${FORMAT_NAMES[it.out.format]} because this browser cannot write ${FORMAT_NAMES[it.out.fellBack]}`);
  if (kept.length) text.append(el('p', '', `Kept: ${kept.join('; ')}.`));
  box.append(icon, text);
  return box;
}

function el(tag, cls = '', text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, icon, cls) {
  const b = el('button', `button ${cls}`.trim());
  b.type = 'button';
  b.innerHTML = `<svg aria-hidden="true"><use href="#i-${icon}"/></svg>`;
  b.append(el('span', '', label));
  return b;
}

// Before and after, with a divider you drag and a 1:1 zoom to judge compression up close.
function compareView(it) {
  const sec = el('section', 'compare');
  sec.append(el('h3', 'sheet-sub', 'Compare'));
  const box = el('div', 'cmp-box');
  const stage = el('div', 'cmp-stage');
  const before = el('img');
  const after = el('img');
  const line = el('div', 'cmp-line');
  before.alt = 'Original';
  after.alt = 'Cleaned';
  const a = URL.createObjectURL(it.file);
  const b = URL.createObjectURL(it.out.blob);
  sheetUrls.push(a, b);
  stage.style.aspectRatio = '3 / 2';
  stage.append(before, after, line);
  box.append(stage);
  const tags = el('div', 'cmp-tags');
  tags.append(el('span', '', 'Original'), el('span', '', 'Cleaned'));
  const controls = el('div', 'cmp-controls');
  const range = el('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.value = '50';
  range.setAttribute('aria-label', 'Divider between original and cleaned');
  const zoom = el('button', 'text-button', 'Zoom to 100%');
  zoom.type = 'button';
  zoom.setAttribute('aria-pressed', 'false');
  controls.append(range, zoom);
  const set = () => {
    after.style.clipPath = `inset(0 0 0 ${range.value}%)`;
    line.style.left = `${range.value}%`;
  };
  range.addEventListener('input', set);
  set();
  after.onload = () => {
    stage.style.aspectRatio = `${after.naturalWidth} / ${after.naturalHeight}`;
    stage.style.setProperty('--zw', `${after.naturalWidth / (devicePixelRatio || 1)}px`);
  };
  before.onerror = () => {
    sec.replaceChildren(el('h3', 'sheet-sub', 'Compare'), el('p', 'empty-note', 'This browser cannot show the original format, so there is nothing to compare against.'));
  };
  zoom.addEventListener('click', () => {
    const on = !box.classList.contains('is-zoomed');
    box.classList.toggle('is-zoomed', on);
    zoom.textContent = on ? 'Fit' : 'Zoom to 100%';
    zoom.setAttribute('aria-pressed', String(on));
    if (on) requestAnimationFrame(() => {
      box.scrollLeft = (box.scrollWidth - box.clientWidth) / 2;
      box.scrollTop = (box.scrollHeight - box.clientHeight) / 2;
    });
  });
  before.src = a;
  after.src = b;
  sec.append(box, tags, controls);
  return sec;
}

const sheetUrls = [];

function removeItem(it) {
  const i = items.indexOf(it);
  if (i >= 0) items.splice(i, 1);
  if (it.thumb) URL.revokeObjectURL(it.thumb);
  if (!items.length) $('#photos').hidden = true;
  renderList();
  updateActions();
}

function setupSheet() {
  const d = $('#sheet');
  $('#sheet-close').addEventListener('click', closeSheet);
  d.addEventListener('click', (e) => { if (e.target === d) closeSheet(); });
  d.addEventListener('close', () => {
    while (sheetUrls.length) URL.revokeObjectURL(sheetUrls.pop());
    $('#sheet-body').textContent = '';
    document.documentElement.style.overflow = '';
    d.style.translate = '';
    sheetItem = null;
    if (opener && opener.isConnected) opener.focus();
    else $('#main').focus();
  });

  // Swipe down to dismiss on phones: 110px drag or a quick flick.
  let startY = 0, startT = 0, dy = 0, dragging = false;
  const body = $('#sheet-body');
  d.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || matchMedia('(min-width: 735px)').matches) return;
    if (body.contains(e.target) && body.scrollTop > 0) return;
    dragging = true; startY = e.clientY; startT = performance.now(); dy = 0;
  });
  d.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    if (dy > 4) d.style.translate = `0 ${dy}px`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const speed = dy / (performance.now() - startT);
    if (dy > 110 || (dy > 24 && speed > 0.6)) {
      if (navigator.vibrate) navigator.vibrate(8);
      closeSheet();
    } else d.style.translate = '';
  };
  d.addEventListener('pointerup', end);
  d.addEventListener('pointercancel', end);
}

// ---- Drag and drop, paste -------------------------------------------------

function setupDrop() {
  const veil = $('#veil');
  const card = $('#drop');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; veil.classList.add('is-on'); card.classList.add('is-over'); });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; veil.classList.remove('is-on'); card.classList.remove('is-over'); } });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.classList.remove('is-on');
    card.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });
  addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });
}

// ---- Theme ----------------------------------------------------------------

function setupTheme() {
  const btn = $('#theme');
  const sync = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    document.querySelector('meta[name=theme-color]').content = dark ? '#190207' : '#fff6f8';
    if (native) native.setDark(dark);
  };
  const apply = (mode) => {
    const go = () => { document.documentElement.dataset.theme = mode; sync(); };
    if (document.startViewTransition) document.startViewTransition(go);
    else go();
  };
  btn.addEventListener('click', () => {
    const mode = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme-mode', mode); } catch {}
    apply(mode);
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    let stored = null;
    try { stored = localStorage.getItem('theme-mode'); } catch {}
    if (!stored) apply(e.matches ? 'light' : 'dark');
  });
  sync();
}

// ---- Offline, install and share target ------------------------------------

function setupApp() {
  if (native) {
    $('#offline-status').textContent = 'Runs on this phone with no internet permission. Nothing is ever uploaded.';
    window.plainframeBack = () => {
      if ($('#sheet').open) { closeSheet(); return true; }
      return false;
    };
    window.plainframeReceiveShared = receiveNativeShared;
    receiveNativeShared();
    return;
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      $('#offline-status').textContent = 'Runs on this device and works offline. Nothing is ever uploaded.';
    }).catch(() => {});
  }
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#install').hidden = false;
  });
  $('#install').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    $('#install').hidden = true;
  });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('#ios-tip').hidden = !(ios && !standalone);
}

async function receiveNativeShared() {
  try {
    const list = JSON.parse(native.sharedFiles());
    const files = [];
    for (let i = 0; i < list.length; i++) {
      const blob = await (await fetch(`/shared/${i}`)).blob();
      files.push(new File([blob], list[i].name, { type: list[i].type || blob.type }));
    }
    native.clearShared();
    if (files.length) addFiles(files);
  } catch {}
}

async function receiveShared() {
  if (native) return;
  const url = new URL(location.href);
  if (!url.searchParams.has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', url.pathname);
  try {
    const cache = await caches.open('plainframe-shared');
    const keys = await cache.keys();
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('x-name') || 'shared'), { type: blob.type }));
      await cache.delete(req);
    }
    if (files.length) addFiles(files);
  } catch {}
}

// ---- Feedback -------------------------------------------------------------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2200);
}
function announce(msg) {
  // The toast region is the live region, so a quiet announce only needs a toast when nothing else spoke.
  if (!$('#toast').classList.contains('is-on')) toast(msg);
}

// ---- Start ----------------------------------------------------------------

bindSettings();
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('is-ready')));
setupSheet();
setupDrop();
setupTheme();
setupApp();
receiveShared();

$('#picker').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
$('#run').addEventListener('click', () => {
  if ($('#run').dataset.action === 'save') saveFiles(items.filter((i) => i.out));
  else cleanAll();
});
$('#zip').addEventListener('click', saveZip);
$('#clear').addEventListener('click', () => {
  for (const it of items) if (it.thumb) URL.revokeObjectURL(it.thumb);
  items.length = 0;
  $('#photos').hidden = true;
  renderList();
  updateActions();
  toast('Cleared');
});
