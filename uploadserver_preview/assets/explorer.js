/* uploadserver-preview — explorer shell.
   Turns the server-rendered directory listing into a small SPA: expand/collapse
   folders in the tree (lazily fetching /__index__ JSON) and load files into the
   content pane in place via window.PreviewViewer.load() — no full navigation.
   URLs follow uploadserver's own paths: opening a file pushes its real URL
   path (the server answers a navigation there with this same shell), no
   ?view= query. Also tracks the last-interacted directory and exposes
   window.PreviewExplorer (getLastDir / refreshDir) for the upload modal.
   Progressive enhancement: without this script the tree and file links still
   work as plain server-rendered links. */
(function () {
  'use strict';

  var tree = document.getElementById('tree');
  if (!tree) return; // nothing to enhance

  var content = document.getElementById('content');
  var rawlink = document.getElementById('rawlink');
  var openlink = document.getElementById('openlink');
  var kindEl = document.getElementById('kind');
  var metaEl = document.getElementById('meta');
  var toggle = document.getElementById('viewtoggle');
  var footEl = document.getElementById('exp-foot');
  var placeholder = content ? content.innerHTML : '';

  // The directory this shell was rendered for, and the folder the user last
  // touched (expanded or picked a file from). The upload modal defaults its
  // destination to lastDir, and the git layer follows it too — moving around
  // the tree re-scopes /__git__ to the directory being looked at.
  var cwd = tree.dataset.cwd || '/';
  var lastDir = cwd;

  function setLastDir(dir) {
    if (!dir) return;
    lastDir = dir;
    if (window.PreviewGit && window.PreviewGit.setScope) window.PreviewGit.setScope(dir);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function decode(p) { try { return decodeURIComponent(p); } catch (e) { return p; } }

  // Build a tree row from an /__index__ entry. Mirrors _tree_row_html() server-side.
  function rowHtml(e, depth) {
    var style = ' style="--depth:' + depth + '"';
    var hid = e.hidden ? ' is-hidden' : '';
    if (e.is_dir) {
      return '<div class="trow isdir' + hid + '" data-path="' + esc(e.path) + '"' + style + '>' +
             '<button class="twist glyph ' + esc(e.glyph_cls) + '" type="button" ' +
             'aria-expanded="false" aria-label="Toggle ' + esc(e.name) + '">' + esc(e.glyph) + '</button>' +
             '<span class="tname">' + esc(e.name) + '</span>' +
             '</div><div class="tchildren" hidden></div>';
    }
    var anchor = e.view
      ? '<a class="tname" href="' + esc(e.view) + '" data-view="' + esc(e.view) + '">' + esc(e.name) + '</a>'
      : '<a class="tname" href="' + esc(e.raw) + '" download>' + esc(e.name) + '</a>';
    return '<div class="trow isfile' + hid + '"' + style + '>' +
           '<span class="twist-spacer" aria-hidden="true"></span>' +
           '<span class="glyph ' + esc(e.glyph_cls) + '" aria-hidden="true">' + esc(e.glyph) + '</span>' +
           anchor + '<span class="tsize">' + esc(e.size_h || '') + '</span>' +
           '</div>';
  }

  function depthOf(row) {
    return (parseInt(row.style.getPropertyValue('--depth'), 10) || 0);
  }

  function fetchIndex(path) {
    return fetch('/__index__?path=' + encodeURIComponent(path), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function findDirRow(path) {
    var rows = tree.querySelectorAll('.trow.isdir');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.path === path) return rows[i];
    }
    return null;
  }

  // ---------- folder expand / collapse ----------
  function toggleDir(row) {
    var twist = row.querySelector('.twist');
    var children = row.nextElementSibling;
    if (!twist || !children || !children.classList.contains('tchildren')) return;

    setLastDir(row.dataset.path);

    if (twist.getAttribute('aria-expanded') === 'true') {
      twist.setAttribute('aria-expanded', 'false');
      row.classList.remove('open');
      children.hidden = true;
      return;
    }

    twist.setAttribute('aria-expanded', 'true');
    row.classList.add('open');
    children.hidden = false;
    if (row.dataset.loaded) return; // already fetched — just reveal

    var depth = depthOf(row) + 1;
    children.innerHTML = '<div class="tnote" style="--depth:' + depth + '">Loading&hellip;</div>';
    fetchIndex(row.dataset.path)
      .then(function (data) {
        var html = (data.entries || []).map(function (e) { return rowHtml(e, depth); }).join('');
        children.innerHTML = html || '<div class="tnote" style="--depth:' + depth + '">empty</div>';
        row.dataset.loaded = '1';
      })
      .catch(function () {
        // leave it collapsed and retryable
        children.innerHTML = '';
        children.hidden = true;
        twist.setAttribute('aria-expanded', 'false');
        row.classList.remove('open');
      });
  }

  // Re-fetch a directory's listing and rebuild its rows in place. Used after an
  // upload lands in `path`. Handles the root tree and any expanded subfolder.
  function refreshDir(path) {
    if (!path) path = cwd;
    if (path.charAt(path.length - 1) !== '/') path += '/';

    if (path === cwd) {
      var inner = tree.querySelector('.tree-inner');
      if (!inner) return Promise.resolve();
      return fetchIndex(path).then(function (data) {
        var entries = data.entries || [];
        inner.innerHTML = entries.map(function (e) { return rowHtml(e, 0); }).join('') ||
          '<div class="empty">This folder is empty.</div>';
        if (footEl) {
          var nHidden = entries.filter(function (e) { return e.hidden; }).length;
          footEl.textContent = entries.length + ' item' + (entries.length === 1 ? '' : 's') +
            (nHidden ? ' · ' + nHidden + ' hidden' : '');
        }
      }).catch(function () {});
    }

    var row = findDirRow(path);
    if (!row) return Promise.resolve();
    var children = row.nextElementSibling;
    var depth = depthOf(row) + 1;
    delete row.dataset.loaded;
    if (row.classList.contains('open') && children) {
      return fetchIndex(path).then(function (data) {
        var html = (data.entries || []).map(function (e) { return rowHtml(e, depth); }).join('');
        children.innerHTML = html || '<div class="tnote" style="--depth:' + depth + '">empty</div>';
        row.dataset.loaded = '1';
      }).catch(function () {});
    }
    return Promise.resolve();
  }

  // ---------- file selection ----------
  // The tree anchor for a file path (data-view is the encoded URL path); also
  // matches decoded forms so legacy ?view= deep-links still find their row.
  function findFileAnchor(path) {
    var dec = decode(path);
    var anchors = tree.querySelectorAll('a.tname[data-view]');
    for (var i = 0; i < anchors.length; i++) {
      var v = anchors[i].getAttribute('data-view');
      if (v === path || decode(v) === dec) return anchors[i];
    }
    return null;
  }

  // The directory containing a file row: for depth-0 files that's the cwd; for
  // deeper files it's the dir row preceding the enclosing .tchildren block.
  function parentDirOf(anchor) {
    var container = anchor.closest('.tchildren');
    if (container) {
      var dirRow = container.previousElementSibling;
      if (dirRow && dirRow.classList.contains('isdir') && dirRow.dataset.path) {
        return dirRow.dataset.path;
      }
    }
    return cwd;
  }

  function markActive(anchor) {
    var prev = tree.querySelector('.trow.active');
    if (prev) prev.classList.remove('active');
    if (anchor) {
      var row = anchor.closest('.trow');
      if (row) row.classList.add('active');
    }
  }

  // `filePath` is the file's URL path (encoded, as carried in data-view).
  function loadView(filePath, anchor, push) {
    if (!filePath) return;
    if (window.PreviewViewer) window.PreviewViewer.load(filePath);
    if (anchor) setLastDir(parentDirOf(anchor));
    if (rawlink) rawlink.hidden = false;
    markActive(anchor);
    // on mobile, fold the navigator sheet so the file is what you land on
    if (window.PreviewNav) window.PreviewNav.close();
    if (push) {
      history.pushState({ view: filePath }, '', filePath);
    }
  }

  function showPlaceholder() {
    if (content) content.innerHTML = placeholder;
    if (rawlink) rawlink.hidden = true;
    if (openlink) openlink.hidden = true;
    if (kindEl) kindEl.textContent = '';
    if (metaEl) metaEl.textContent = '';
    if (toggle) toggle.hidden = true;
    markActive(null);
    // nothing to show — surface the navigator by default on mobile
    if (window.PreviewNav) window.PreviewNav.open();
  }

  // ---------- events ----------
  tree.addEventListener('click', function (ev) {
    var twist = ev.target.closest('.twist');
    if (twist) { ev.preventDefault(); toggleDir(twist.closest('.trow.isdir')); return; }

    var anchor = ev.target.closest('a.tname[data-view]');
    if (anchor && window.PreviewViewer) { ev.preventDefault(); loadView(anchor.getAttribute('data-view'), anchor, true); return; }

    var dirRow = ev.target.closest('.trow.isdir');
    if (dirRow) { toggleDir(dirRow); return; }
    // non-previewable file links fall through to their normal download behaviour
  });

  // The file shown at a given history entry is the URL path itself (a path not
  // ending in "/"); legacy ?view= deep-links keep working.
  function fileFromLocation() {
    var legacy = new URLSearchParams(location.search).get('view');
    if (legacy) return legacy;
    return location.pathname.slice(-1) === '/' ? null : location.pathname;
  }

  window.addEventListener('popstate', function () {
    var p = fileFromLocation();
    if (p) loadView(p, findFileAnchor(p), false);
    else showPlaceholder();
  });

  // ---------- hidden & git-ignored files ----------
  // Rows arrive with an is-hidden class (dotfiles + gitignored, marked
  // server-side); the tree's hide-hidden class keeps them display:none. The
  // side-head ".*" button flips that, and the choice sticks via localStorage.
  var hidToggle = document.getElementById('hid-toggle');
  var HID_KEY = 'preview.show-hidden';
  function applyHidden(show) {
    tree.classList.toggle('hide-hidden', !show);
    if (hidToggle) hidToggle.setAttribute('aria-pressed', String(!!show));
  }
  var showHidden = false;
  try { showHidden = localStorage.getItem(HID_KEY) === '1'; } catch (e) {}
  applyHidden(showHidden);
  if (hidToggle) {
    hidToggle.addEventListener('click', function () {
      showHidden = !showHidden;
      applyHidden(showHidden);
      try { localStorage.setItem(HID_KEY, showHidden ? '1' : '0'); } catch (e) {}
    });
  }

  // ---------- resizable sidebar width ----------
  // A drag gutter between the sidebar and the content pane sets --sidebar-w
  // (read by .sidebar in app.css); the chosen width sticks via localStorage.
  // Disabled on the mobile layout, where the sidebar is a bottom sheet.
  var resizer = document.getElementById('col-resizer');
  var sidebar = document.getElementById('nav-sheet');
  var WIDTH_KEY = 'preview.sidebar-w';
  var MIN_W = 190, MAX_W = 640;

  function curWidth() {
    return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || 300;
  }
  function applyWidth(w, persist) {
    w = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    if (resizer) resizer.setAttribute('aria-valuenow', String(w));
    if (persist) { try { localStorage.setItem(WIDTH_KEY, String(w)); } catch (e) {} }
    return w;
  }
  (function () {
    var saved = 0;
    try { saved = parseInt(localStorage.getItem(WIDTH_KEY), 10) || 0; } catch (e) {}
    if (saved) applyWidth(saved, false);
  })();

  if (resizer && sidebar) {
    var isMobile = function () {
      return window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    };
    var onMove = function (ev) {
      applyWidth(ev.clientX - sidebar.getBoundingClientRect().left, false);
    };
    var onUp = function () {
      resizer.classList.remove('dragging');
      document.body.classList.remove('col-resizing');
      applyWidth(curWidth(), true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    resizer.addEventListener('pointerdown', function (ev) {
      if (isMobile()) return; // bottom-sheet layout — nothing to resize
      ev.preventDefault();
      resizer.classList.add('dragging');
      document.body.classList.add('col-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    // keyboard affordance for the separator role
    resizer.addEventListener('keydown', function (ev) {
      var step = ev.key === 'ArrowLeft' ? -16 : ev.key === 'ArrowRight' ? 16 : 0;
      if (!step) return;
      ev.preventDefault();
      applyWidth(curWidth() + step, true);
    });
  }

  // Expose a tiny surface for the upload modal and the in-pane link router.
  window.PreviewExplorer = {
    getCwd: function () { return cwd; },
    getLastDir: function () { return lastDir; },
    refreshDir: refreshDir,
    // Load a file URL path into the content pane in place (used by rendered
    // markdown's relative links so they preview instead of navigating away).
    openPath: function (path) { loadView(path, findFileAnchor(path), true); }
  };

  // Deep-link: the shell may have been served for a file URL (or a legacy
  // ?view= link) — load that file into the pane.
  var initial = fileFromLocation();
  if (initial && window.PreviewViewer) {
    loadView(initial, findFileAnchor(initial), false);
  }
})();
