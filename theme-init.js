// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var mode = null;
  try { mode = localStorage.getItem('theme-mode'); } catch (e) {}
  if (mode !== 'light' && mode !== 'dark') {
    mode = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', mode);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#190207' : '#fff6f8');
})();
