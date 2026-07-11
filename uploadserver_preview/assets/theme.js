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
    { id: 'auto',       label: 'System' },
    { id: 'light',      label: 'Light' },
    { id: 'dark',       label: 'Dark' },
    { id: 'catppuccin', label: 'Catppuccin' },
    { id: 'tokyonight', label: 'Tokyo Night' },
    { id: 'gruvbox',    label: 'Gruvbox' },
    { id: 'everforest', label: 'Everforest' }
  ];
  // Named themes that resolve to a dark mode (drives the hljs sheet + data-mode).
  var DARK = { dark: 1, catppuccin: 1, tokyonight: 1, gruvbox: 1, everforest: 1 };

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

  // The topbar picker: a quiet icon button that opens a small popover of the
  // themes. Built here from THEMES so the list has a single source of truth.
  function initMenu() {
    var wrap = document.getElementById('theme-menu');
    var btn = document.getElementById('theme-btn');
    var pop = document.getElementById('theme-pop');
    if (!wrap || !btn || !pop) return;

    pop.textContent = '';
    THEMES.forEach(function (t) {
      var opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'theme-opt';
      opt.setAttribute('role', 'menuitemradio');
      opt.setAttribute('data-theme-id', t.id);
      opt.innerHTML = '<span class="swatch" aria-hidden="true"></span>' +
                      '<span class="opt-lbl"></span>' +
                      '<span class="opt-check" aria-hidden="true">✓</span>';
      opt.querySelector('.opt-lbl').textContent = t.label;
      opt.addEventListener('click', function () {
        window.PreviewTheme.set(t.id);
        mark();
        close();
        btn.focus();
      });
      pop.appendChild(opt);
    });

    function mark() {
      var cur = current();
      var opts = pop.querySelectorAll('.theme-opt');
      for (var i = 0; i < opts.length; i++) {
        opts[i].setAttribute('aria-checked',
          String(opts[i].getAttribute('data-theme-id') === cur));
      }
    }
    function open() {
      mark();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDoc, true);
      document.addEventListener('keydown', onKey);
    }
    function close() {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey);
    }
    function onDoc(e) { if (!wrap.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { close(); btn.focus(); } }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) open(); else close();
    });
    mark();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMenu);
  } else {
    initMenu();
  }
})();
