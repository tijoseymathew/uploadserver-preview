/* uploadserver-preview — theme bootstrap.
   Runs synchronously in <head> (before first paint and before the deferred
   viewer scripts) so the reader's saved theme is applied without a flash and
   `data-mode` is set before viewer.js reads it.

   A "theme" is a data-theme value understood by themes.css; `auto` follows the
   OS. The reader's choice is stored per-origin in localStorage and overrides
   the server's --theme default. hljs highlighting is client-side, so the
   matching code-theme stylesheet is toggled here rather than server-side. */
(function () {
  'use strict';

  var KEY = 'ups-theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  // Ordered list the picker surfaces: value + human label.
  var THEMES = [
    { id: 'auto',  label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark',  label: 'Dark' },
    { id: 'dim',   label: 'Dim' },
    { id: 'sepia', label: 'Sepia' }
  ];
  // Named themes that resolve to a dark mode (drives the hljs sheet + data-mode).
  var DARK = { dark: 1, dim: 1 };

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function store(id) {
    try { localStorage.setItem(KEY, id); } catch (e) {}
  }
  function known(id) {
    for (var i = 0; i < THEMES.length; i++) { if (THEMES[i].id === id) return true; }
    return false;
  }
  // Effective light/dark mode for a theme id (auto resolves via the OS).
  function modeOf(id) {
    if (id === 'auto') return (mq && mq.matches) ? 'dark' : 'light';
    return DARK[id] ? 'dark' : 'light';
  }

  function applyHljs(mode) {
    var l = document.getElementById('hljs-light');
    var d = document.getElementById('hljs-dark');
    if (l) l.disabled = (mode !== 'light');
    if (d) d.disabled = (mode !== 'dark');
  }

  function apply(id) {
    if (!known(id)) id = 'auto';
    var mode = modeOf(id);
    root.setAttribute('data-theme', id);
    root.setAttribute('data-mode', mode);
    applyHljs(mode);
  }

  function current() {
    var s = saved();
    if (known(s)) return s;
    return root.getAttribute('data-theme') || 'auto';
  }
  function notify() {
    try {
      document.dispatchEvent(new CustomEvent('ups:themechange',
        { detail: { theme: current(), mode: root.getAttribute('data-mode') } }));
    } catch (e) {}
  }

  // Initial paint: the reader's saved choice wins, else the server default.
  apply(current());

  // Follow the OS while in auto (CSS vars recolour instantly; also swap the
  // hljs sheet and let the viewer re-theme its rendered components).
  if (mq) {
    var onOS = function () {
      if (current() === 'auto') { apply('auto'); notify(); }
    };
    if (mq.addEventListener) mq.addEventListener('change', onOS);
    else if (mq.addListener) mq.addListener(onOS);
  }

  window.PreviewTheme = {
    themes: THEMES,
    current: current,
    mode: function () { return root.getAttribute('data-mode'); },
    set: function (id) {
      if (!known(id)) return;
      store(id);
      apply(id);
      notify();
    }
  };
})();
