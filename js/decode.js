// Turns any supported file into something a canvas can draw.
// The browser handles most formats. TIFF and (outside Safari) HEIC need a bundled decoder,
// loaded from this app's own folder only when such a file shows up.

export async function decodeImage(file, bytes, format) {
  if (format !== 'tiff' || /Safari/.test(navigator.userAgent) && !/Chrome|Android/.test(navigator.userAgent)) {
    try {
      return await viaBrowser(file);
    } catch (err) {
      if (format !== 'heic' && format !== 'tiff') throw err;
    }
  }
  if (format === 'tiff') return viaUtif(bytes);
  if (format === 'heic' || format === 'avif') return viaLibheif(bytes);
  throw new Error('This browser cannot open this image type.');
}

function viaBrowser(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    const url = URL.createObjectURL(file);
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This browser cannot open this image type.')); };
    img.src = url;
  });
}

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error('Could not load the decoder.')); };
      document.head.append(s);
    }));
  }
  return loaded.get(src);
}

async function viaUtif(bytes) {
  await loadScript('vendor/utif/pako_inflate.min.js');
  await loadScript('vendor/utif/UTIF.js');
  const UTIF = window.UTIF;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ifds = UTIF.decode(buf);
  // Pick the largest image: TIFFs and DNGs often carry a small preview first.
  let best = null;
  for (const ifd of ifds) {
    if (!ifd.t256 || !ifd.t257) continue;
    if (!best || ifd.t256[0] * ifd.t257[0] > best.t256[0] * best.t257[0]) best = ifd;
  }
  if (!best) throw new Error('This TIFF has no image the decoder understands.');
  UTIF.decodeImage(buf, best, ifds);
  const rgba = UTIF.toRGBA8(best);
  const c = rgbaCanvas(rgba, best.width, best.height);
  const o = best.t274 ? best.t274[0] : 1;
  const out = o > 1 ? orient(c, o) : c;
  return { source: out, width: out.width, height: out.height, done: () => { c.width = 0; out.width = 0; } };
}

let heifModule;
async function viaLibheif(bytes) {
  if (!heifModule) {
    await loadScript('vendor/libheif/libheif.js');
    const wasmBinary = await (await fetch('vendor/libheif/libheif.wasm')).arrayBuffer();
    heifModule = await window.libheif({ wasmBinary });
  }
  const decoder = new heifModule.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images || !images.length) throw new Error('Could not read this HEIC file.');
  const image = images[0];
  const w = image.get_width(), h = image.get_height();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const data = ctx.createImageData(w, h);
  await new Promise((resolve, reject) => image.display(data, (d) => (d ? resolve() : reject(new Error('Could not read this HEIC file.')))));
  ctx.putImageData(data, 0, 0);
  for (const im of images) im.free?.();
  decoder.decoder && heifModule.heif_context_free?.(decoder.decoder);
  return { source: c, width: w, height: h, done: () => { c.width = 0; } };
}

function rgbaCanvas(rgba, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  return c;
}

// Applies an EXIF orientation value (2 to 8) to a canvas.
function orient(src, o) {
  const w = src.width, h = src.height;
  const swap = o >= 5;
  const c = document.createElement('canvas');
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const ctx = c.getContext('2d');
  const t = {
    2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
  }[o];
  if (t) ctx.setTransform(...t);
  ctx.drawImage(src, 0, 0);
  src.width = 0;
  return c;
}
