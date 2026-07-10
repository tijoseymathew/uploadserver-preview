/* uploadserver-preview — client viewer.
   Reads ?path= from the URL, fetches the file same-origin, and renders it by type.
   All libraries are loaded as globals before this runs (see the page's <script defer> order):
   hljs, marked, DOMPurify, Papa, Diff2Html, and the <andypf-json-viewer> element. */
(function () {
  'use strict';

  var content = document.getElementById('content');

  var DARK = (function () {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  })();

  var MAX_TEXT = 3 * 1024 * 1024;   // 3 MB cap for text rendering
  var MAX_ROWS = 5000;              // row cap for CSV/TSV tables

  // extension -> { type, label, lang }
  // type drives the renderer; label is the badge; lang is the hljs grammar.
  var KIND = {
    md: mk('markdown', 'markdown'), markdown: mk('markdown', 'markdown'),
    mdown: mk('markdown', 'markdown'), mkd: mk('markdown', 'markdown'),
    json: mk('json', 'json'), geojson: mk('json', 'geojson'), ipynb: mk('json', 'notebook'),
    yml: mk('code', 'yaml', 'yaml'), yaml: mk('code', 'yaml', 'yaml'),
    toml: mk('code', 'toml', 'ini'),
    ini: mk('code', 'ini', 'ini'), cfg: mk('code', 'ini', 'ini'), conf: mk('code', 'conf', 'ini'),
    csv: mk('csv', 'csv'), tsv: mk('tsv', 'tsv'),
    diff: mk('diff', 'diff'), patch: mk('diff', 'patch'),
    html: mk('html-source', 'html', 'xml'), htm: mk('html-source', 'html', 'xml'),
    xhtml: mk('html-source', 'xhtml', 'xml'), xml: mk('code', 'xml', 'xml'),
    py: mk('code', 'python', 'python'), pyw: mk('code', 'python', 'python'),
    js: mk('code', 'javascript', 'javascript'), mjs: mk('code', 'javascript', 'javascript'),
    cjs: mk('code', 'javascript', 'javascript'), jsx: mk('code', 'jsx', 'javascript'),
    ts: mk('code', 'typescript', 'typescript'), tsx: mk('code', 'tsx', 'typescript'),
    sh: mk('code', 'bash', 'bash'), bash: mk('code', 'bash', 'bash'), zsh: mk('code', 'zsh', 'bash'),
    rs: mk('code', 'rust', 'rust'), go: mk('code', 'go', 'go'),
    java: mk('code', 'java', 'java'), kt: mk('code', 'kotlin', 'kotlin'),
    c: mk('code', 'c', 'c'), h: mk('code', 'c', 'c'),
    cpp: mk('code', 'cpp', 'cpp'), cc: mk('code', 'cpp', 'cpp'), cxx: mk('code', 'cpp', 'cpp'),
    hpp: mk('code', 'cpp', 'cpp'), hh: mk('code', 'cpp', 'cpp'),
    rb: mk('code', 'ruby', 'ruby'), php: mk('code', 'php', 'php'),
    lua: mk('code', 'lua', 'lua'), sql: mk('code', 'sql', 'sql'),
    css: mk('code', 'css', 'css'), scss: mk('code', 'scss', 'scss'), less: mk('code', 'less', 'less'),
    swift: mk('code', 'swift', 'swift'), r: mk('code', 'r', 'r'),
    pl: mk('code', 'perl', 'perl'), makefile: mk('code', 'make', 'makefile'),
    dockerfile: mk('code', 'docker', 'dockerfile'),
    txt: mk('code', 'text', null), text: mk('code', 'text', null), log: mk('code', 'log', null),
    png: mk('image', 'png'), jpg: mk('image', 'jpg'), jpeg: mk('image', 'jpeg'),
    gif: mk('image', 'gif'), webp: mk('image', 'webp'), bmp: mk('image', 'bmp'),
    ico: mk('image', 'ico'), avif: mk('image', 'avif'), svg: mk('image', 'svg')
  };

  // filenames without an extension that we still recognise
  var NAME_MAP = {
    'dockerfile': KIND.dockerfile, 'makefile': KIND.makefile,
    '.gitignore': mk('code', 'gitignore', 'bash'),
    '.gitattributes': mk('code', 'gitattr', 'bash'),
    '.env': mk('code', 'env', 'ini'),
    'license': mk('code', 'text', null), 'readme': mk('markdown', 'markdown')
  };

  function mk(type, label, lang) { return { type: type, label: label, lang: lang || null }; }

  // ---------- helpers ----------
  function decode(p) { try { return decodeURIComponent(p); } catch (e) { return p; } }
  function baseName(p) { p = p.replace(/\/+$/, ''); var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function extOf(name) { var i = name.lastIndexOf('.'); return i <= 0 ? '' : name.slice(i + 1); }
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function humanSize(n) {
    if (!isFinite(n) || n < 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  }
  function elem(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function noticeEl(msg) { return elem('div', 'notice', msg); }

  function setError(title, msg, rawHref) {
    content.innerHTML = '';
    var box = elem('div', 'errorbox');
    box.appendChild(elem('h2', null, title));
    if (msg) box.appendChild(elem('p', null, msg));
    if (rawHref) {
      var a = elem('a', null, 'Open raw file');
      a.href = rawHref; a.target = '_blank'; a.rel = 'noopener noreferrer';
      box.appendChild(a);
    }
    content.appendChild(box);
  }

  // ---------- header / breadcrumb ----------
  function buildCrumbs(urlPath) {
    var crumbs = document.getElementById('crumbs');
    crumbs.innerHTML = '';
    var home = elem('a', null, '~'); home.href = '/'; home.title = 'server root';
    crumbs.appendChild(home);
    var decoded = decode(urlPath).replace(/^\/+/, '');
    var parts = decoded.split('/').filter(Boolean);
    var acc = '';
    parts.forEach(function (seg, idx) {
      crumbs.appendChild(elem('span', 'sep', '/'));
      acc += '/' + encodeURIComponent(seg);
      if (idx < parts.length - 1) {
        var a = elem('a', null, seg); a.href = acc + '/';
        crumbs.appendChild(a);
      } else {
        crumbs.appendChild(elem('span', 'current', seg));
      }
    });
  }

  // ---------- renderers ----------
  function renderMarkdown(text) {
    var raw;
    try { raw = marked.parse(text, { gfm: true, breaks: false }); }
    catch (e) { return renderCode(text, null, 'Could not parse Markdown; showing source.'); }
    var clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
    var div = elem('div', 'markdown-body'); div.innerHTML = clean;
    div.querySelectorAll('pre code').forEach(function (b) { try { hljs.highlightElement(b); } catch (e) {} });
    div.querySelectorAll('a[href]').forEach(function (a) {
      a.setAttribute('rel', 'noopener noreferrer nofollow');
      if (/^https?:/i.test(a.getAttribute('href') || '')) a.setAttribute('target', '_blank');
    });
    content.appendChild(div);
  }

  function renderJson(text, kind) {
    var obj;
    try { obj = JSON.parse(text); }
    catch (e) { return renderCode(text, 'json', 'Not valid JSON (' + e.message + ') — showing source.'); }
    if (!('customElements' in window) || !customElements.get('andypf-json-viewer')) {
      // graceful fallback: pretty-print + highlight
      return renderCode(JSON.stringify(obj, null, 2), 'json');
    }
    var size = text.length;
    var expand = size < 20000 ? 4 : size < 200000 ? 2 : 1;
    var v = document.createElement('andypf-json-viewer');
    v.setAttribute('expanded', String(expand));
    v.setAttribute('indent', '2');
    v.setAttribute('show-data-types', 'true');
    v.setAttribute('show-toolbar', 'true');
    v.setAttribute('show-copy', 'true');
    v.setAttribute('show-size', 'true');
    v.setAttribute('theme', DARK ? 'default-dark' : 'default-light');
    content.appendChild(v);
    try { v.data = obj; } catch (e) { try { v.setAttribute('data', text); } catch (e2) {} }
  }

  function renderTable(text, delim) {
    var parsed = Papa.parse(text.replace(/\r\n?/g, '\n'), { delimiter: delim, skipEmptyLines: 'greedy' });
    var rows = parsed.data || [];
    if (!rows.length) return renderCode(text, null, 'Empty table.');
    var truncated = rows.length > MAX_ROWS;
    if (truncated) rows = rows.slice(0, MAX_ROWS);

    if (truncated) content.appendChild(noticeEl('Large file — showing the first ' + MAX_ROWS.toLocaleString() + ' rows.'));

    var wrap = elem('div', 'tablewrap');
    var table = elem('table', 'data');
    var thead = elem('thead'), htr = elem('tr');
    htr.appendChild(elem('th', 'rownum', '#'));
    (rows[0] || []).forEach(function (c) { htr.appendChild(elem('th', null, c)); });
    thead.appendChild(htr); table.appendChild(thead);

    var tbody = elem('tbody');
    for (var i = 1; i < rows.length; i++) {
      var tr = elem('tr');
      tr.appendChild(elem('td', 'rownum', String(i)));
      var cols = rows[i];
      var width = (rows[0] || []).length;
      for (var c = 0; c < Math.max(width, cols.length); c++) {
        tr.appendChild(elem('td', null, cols[c] != null ? cols[c] : ''));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    content.appendChild(wrap);
  }

  function renderDiff(text) {
    if (!window.Diff2Html || typeof Diff2Html.html !== 'function') {
      return renderCode(text, 'diff');
    }
    var wrap = elem('div', 'diffwrap' + (DARK ? ' d2h-dark-color-scheme' : ''));
    var html;
    try {
      html = Diff2Html.html(text, {
        drawFileList: true, matching: 'lines',
        outputFormat: 'line-by-line', colorScheme: DARK ? 'dark' : 'light'
      });
    } catch (e) { return renderCode(text, 'diff', 'Could not parse as a diff; showing source.'); }
    wrap.innerHTML = html; // diff2html escapes file content and names
    content.appendChild(wrap);
  }

  function renderImage(href, name) {
    var wrap = elem('div', 'imagewrap');
    var img = new Image();
    img.alt = name; img.decoding = 'async';
    img.onload = function () { setMeta(null, null, img.naturalWidth + '\u00d7' + img.naturalHeight); };
    img.onerror = function () { setError('Could not display image', 'The file may be corrupt or not a supported image format.', href); };
    img.src = href;
    wrap.appendChild(img);
    content.appendChild(wrap);
  }

  // A transient toast anchored under the "Open ↗" button, plus a short pulse on
  // the button itself — the unobtrusive replacement for the old sandbox banner.
  function flashOpenHint() {
    var openlink = document.getElementById('openlink');
    if (!openlink || openlink.hidden) return;

    var prev = document.querySelector('.open-toast');
    if (prev) prev.remove();

    openlink.classList.remove('pulse');
    void openlink.offsetWidth;      // restart the animation on repeat loads
    openlink.classList.add('pulse');

    var toast = elem('div', 'open-toast', 'Scripts are blocked in this preview — open ↗ to run the page in a new tab.');
    document.body.appendChild(toast);
    var r = openlink.getBoundingClientRect();
    toast.style.top = (r.bottom + 8) + 'px';
    toast.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    requestAnimationFrame(function () { toast.classList.add('show'); });
    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 260);
    }, 4000);
  }

  // Live HTML preview in a locked-down <iframe sandbox>. The empty sandbox token
  // blocks scripts, forms, popups and same-origin access, so the uploaded page
  // renders (markup + styles) but can neither run code nor touch this session.
  // "Open ↗" (see load) is the opt-in, un-sandboxed escape hatch in a new tab.
  function renderHtmlPreview(path, kind) {
    var wrap = elem('div', 'htmlpreview');
    var frame = document.createElement('iframe');
    frame.className = 'htmlframe';
    frame.title = (kind && kind.label ? kind.label : 'HTML') + ' preview';
    frame.setAttribute('sandbox', '');               // most restrictive: no scripts/forms/same-origin
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.src = path;
    wrap.appendChild(frame);
    content.appendChild(wrap);
    flashOpenHint();
  }

  function renderCode(text, lang, notice) {
    if (text.length > MAX_TEXT) {
      notice = (notice ? notice + ' ' : '') + 'File is large — showing the first ' + humanSize(MAX_TEXT) + '.';
      text = text.slice(0, MAX_TEXT);
    }
    var value;
    try {
      if (lang && hljs.getLanguage(lang)) value = hljs.highlight(text, { language: lang }).value;
      else value = hljs.highlightAuto(text).value;
    } catch (e) { value = esc(text); }

    var lines = value.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    var numbers = [];
    for (var i = 0; i < lines.length; i++) numbers.push(i + 1);

    if (notice) content.appendChild(noticeEl(notice));
    var wrap = elem('div', 'codewrap');
    var gutter = elem('pre', 'gutter'); gutter.setAttribute('aria-hidden', 'true');
    gutter.textContent = numbers.join('\n');
    var pre = elem('pre', 'code');
    var code = document.createElement('code');
    code.className = 'hljs' + (lang ? ' language-' + lang : '');
    code.innerHTML = lines.join('\n'); // hljs output is already escaped/safe
    pre.appendChild(code);
    wrap.appendChild(gutter); wrap.appendChild(pre);
    content.appendChild(wrap);
  }

  // ---------- meta line ----------
  function setMeta(bytes, text, override) {
    var m = document.getElementById('meta');
    if (override) { m.textContent = override; return; }
    var bits = [];
    if (bytes != null && bytes > 0) bits.push(humanSize(bytes));
    if (text != null) {
      var lc = text.length ? text.split('\n').length : 0;
      bits.push(lc.toLocaleString() + (lc === 1 ? ' line' : ' lines'));
    }
    m.textContent = bits.join(' · ');
  }

  function looksBinary(text) {
    var n = Math.min(text.length, 4000);
    for (var i = 0; i < n; i++) if (text.charCodeAt(i) === 0) return true;
    return false;
  }

  // ---------- Rendered/Raw view toggle ----------
  // Only meaningful for kinds that have a distinct rendered form; plain code and
  // images look the same either way. VIEW holds the currently-loaded file so the
  // toggle can re-render it and so load() can be called again for a new file.
  var HAS_RENDERED = { markdown: 1, json: 1, csv: 1, tsv: 1, diff: 1, 'html-source': 1 };
  var VIEW = { text: null, mode: 'rendered', kind: null, path: null };

  var toggle = document.getElementById('viewtoggle');
  var btnRendered = document.getElementById('btn-rendered');
  var btnRaw = document.getElementById('btn-raw');

  function renderCurrent() {
    content.innerHTML = '';
    var text = VIEW.text, kind = VIEW.kind;
    if (!kind) return;
    if (VIEW.mode === 'raw') { return renderCode(text, kind.lang); }
    switch (kind.type) {
      case 'markdown': return renderMarkdown(text);
      case 'json': return renderJson(text, kind);
      case 'csv': return renderTable(text, ',');
      case 'tsv': return renderTable(text, '\t');
      case 'diff': return renderDiff(text);
      case 'html-source': return renderHtmlPreview(VIEW.path, kind);
      default: return renderCode(text, kind.lang);
    }
  }

  function setMode(m) {
    if (VIEW.mode === m) return;
    VIEW.mode = m;
    if (btnRendered) btnRendered.setAttribute('aria-pressed', String(m === 'rendered'));
    if (btnRaw) btnRaw.setAttribute('aria-pressed', String(m === 'raw'));
    renderCurrent();
  }
  if (btnRendered) btnRendered.addEventListener('click', function () { setMode('rendered'); });
  if (btnRaw) btnRaw.addEventListener('click', function () { setMode('raw'); });

  // ---------- load a file into the content pane ----------
  // Fetches `path` same-origin and renders it, updating the header (title,
  // breadcrumb, kind badge, raw link, meta). Callable repeatedly — this is the
  // seam the unified explorer shell uses to swap the content pane in place.
  function load(path) {
    if (!path) { setError('No file specified', 'This page expects a ?path= parameter.'); return; }

    // reset per-file header + view state
    content.innerHTML = '<div class="loading">Loading…</div>';
    VIEW.text = null; VIEW.mode = 'rendered'; VIEW.path = path;
    if (btnRendered) btnRendered.setAttribute('aria-pressed', 'true');
    if (btnRaw) btnRaw.setAttribute('aria-pressed', 'false');
    if (toggle) toggle.hidden = true;

    var name = baseName(decode(path));
    document.title = name + ' · preview';
    var titlelabel = document.getElementById('titlelabel');
    if (titlelabel) titlelabel.textContent = name;

    var raw = document.getElementById('rawlink');
    if (raw) { raw.href = path; raw.target = '_blank'; raw.rel = 'noopener noreferrer'; }
    var back = document.getElementById('backlink');
    if (back) { var dir = decode(path).replace(/[^\/]*$/, ''); back.href = dir || '/'; }
    buildCrumbs(path);

    var lower = name.toLowerCase();
    var ext = extOf(lower);
    var kind = KIND[ext] || NAME_MAP[lower] || null;
    if (!kind) kind = mk('code', ext || 'file', null); // unknown -> try as text
    VIEW.kind = kind;

    var kindEl = document.getElementById('kind');
    if (kindEl) kindEl.textContent = kind.label;

    // "Open ↗": for HTML only, open the page in a new tab where the sandbox
    // used by the in-pane preview does not apply (scripts run, full navigation).
    var openlink = document.getElementById('openlink');
    if (openlink) {
      if (kind.type === 'html-source') {
        openlink.href = path; openlink.target = '_blank';
        openlink.rel = 'noopener noreferrer'; openlink.hidden = false;
      } else {
        openlink.hidden = true; openlink.removeAttribute('href');
      }
    }

    fetch(path, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      var len = parseInt(res.headers.get('Content-Length') || '0', 10);

      if (kind.type === 'image') { content.innerHTML = ''; return renderImage(path, name); }

      return res.text().then(function (text) {
        content.innerHTML = '';
        var isText = kind.type !== 'image';
        if (isText && (kind.lang == null) && looksBinary(text) && !(ext in KIND) && !(lower in NAME_MAP)) {
          setMeta(len, null);
          return setError('Binary file', 'This does not look like a text file, so there is nothing to format.', path);
        }
        setMeta(len, text);
        VIEW.text = text;
        if (toggle && HAS_RENDERED[kind.type]) toggle.hidden = false;
        renderCurrent();
      });
    }).catch(function (e) {
      setError('Could not load file', e.message, path);
    });
  }

  // Public API for the explorer shell.
  window.PreviewViewer = { load: load };

  // Standalone viewer page (/__view__): auto-load the ?path= file. Skipped when a
  // #tree is present — there the explorer shell drives loading instead.
  if (content && !document.getElementById('tree')) {
    var params = new URLSearchParams(location.search);
    load(params.get('path'));
  }
})();
