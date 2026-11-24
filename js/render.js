// Paints an image into a fresh canvas, optionally changes its fingerprint, and encodes it.
// The same code runs in a worker (OffscreenCanvas) or on the page, so a slow photo never freezes the screen
// where workers are available.

export const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

// Measured on brightness, which the eye is most sensitive to: JPEG and WebP store colour at lower
// resolution by design, so an RGB score would call almost every photo "visibly worse".
// 42 dB is a strict line for "looks the same"; it is an estimate from the full-resolution centre
// of the photo, not a guarantee.
export const LOOKS_SAME = 42;

export function pageCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
export const workerCanvas = (w, h) => new OffscreenCanvas(w, h);

const encode = (c, type, q) =>
  c.convertToBlob ? c.convertToBlob({ type: MIME[type], quality: q }) : new Promise((res) => c.toBlob(res, MIME[type], q));

// Tries full size first; older iOS caps a canvas at 16.7 million pixels and returns no context.
export async function render(source, w, h, target, opts, makeCanvas) {
  let outW = w, outH = h;
  if (opts.fingerprint) {
    const f = 0.985 + Math.random() * 0.01;
    outW = Math.round(w * f);
    outH = Math.round(h * f);
  }
  for (const cap of [64e6, 16.7e6, 8e6]) {
    let tw = outW, th = outH;
    if (tw * th > cap) {
      const k = Math.sqrt(cap / (tw * th));
      tw = Math.floor(tw * k);
      th = Math.floor(th * k);
    }
    let r = null;
    try {
      r = await paint(source, tw, th, target, opts, makeCanvas);
    } catch {
      r = null;
    }
    if (r) return { ...r, scaled: tw !== outW };
  }
  return null;
}

async function paint(source, w, h, target, opts, makeCanvas) {
  const c = makeCanvas(w, h);
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
    const t = Math.abs((deg * Math.PI) / 180);
    const s = Math.max(Math.cos(t) + (h / w) * Math.sin(t), Math.cos(t) + (w / h) * Math.sin(t));
    ctx.translate(w / 2, h / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.scale(s, s);
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    addNoise(ctx, w, h);
  } else {
    ctx.drawImage(source, 0, 0, w, h);
  }
  try {
    const r = target === 'png'
      ? { blob: await encode(c, 'png'), quality: null, match: null }
      : await compress(c, ctx, target, opts.quality, makeCanvas);
    return r.blob && r.blob.size > 0 ? r : null;
  } finally {
    c.width = c.height = 0; // frees the backing store right away on iOS
  }
}

async function compress(c, ctx, target, setting, makeCanvas) {
  const r = region(c.width, c.height);
  const ref = ctx.getImageData(r[0], r[1], r[2], r[3]).data;
  const tried = new Map();
  const at = async (q) => {
    if (!tried.has(q)) {
      const blob = await encode(c, target, q / 100);
      tried.set(q, { blob, quality: q, match: blob ? await psnr(ref, blob, r, makeCanvas) : 0 });
    }
    return tried.get(q);
  };
  if (setting !== 'smart') return at(Number(setting) || 90);
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
async function psnr(ref, blob, r, makeCanvas) {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(r[2], r[3]);
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
