import { render, workerCanvas } from './render.js';

self.onmessage = async (e) => {
  const { id, bitmap, w, h, target, opts } = e.data;
  try {
    const r = await render(bitmap, w, h, target, opts, workerCanvas);
    self.postMessage({ id, result: r });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  } finally {
    bitmap.close();
  }
};
