/* uploadserver-preview — explorer shell.
   Turns the server-rendered directory listing into a small SPA: expand/collapse
   folders in the tree (lazily fetching /__index__ JSON) and load files into the
   content pane in place via window.PreviewViewer.load() — no full navigation.
   Also tracks the last-interacted directory and exposes window.PreviewExplorer
   (getLastDir / refreshDir) for the upload modal.
   Progressive enhancement: without this script the tree and file links still
   work as plain server-rendered links. */
(function () {
  'use strict';

  var VIEW_ROUTE = '/__view__';

  var tree = document.getElementById('tree');
  if (!tree) return; // nothing to enhance

  var content = document.getElementById('content');
  var rawlink = document.getElementById('rawlink');
  var kindEl = document.getElementById('kind');
  var metaEl = document.getElementById('meta');
  var toggle = document.getElementById('viewtoggle');
  var footEl = document.getElementById('exp-foot');
  var placeholder = content ? content.innerHTML : '';

  // The directory this shell was rendered for, and the folder the user last
  // touched (expanded or picked a file from). The upload modal defaults its
  // destination to lastDir.
  var cwd = tree.dataset.cwd || '/';
  var lastDir = cwd;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Build a tree row from an /__index__ entry. Mirrors _tree_row_html() server-side.
  function rowHtml(e, depth) {
    var style = ' style="--depth:' + depth + '"';
    if (e.is_dir) {
      return '<div class="trow isdir" data-path="' + esc(e.path) + '"' + style + '>' +
             '<button class="twist glyph ' + esc(e.glyph_cls) + '" type="button" ' +
             'aria-expanded="false" aria-label="Toggle ' + esc(e.name) + '">' + esc(e.glyph) + '</button>' +
             '<span class="tname">' + esc(e.name) + '</span>' +
             '</div><div class="tchildren" hidden></div>';
    }
    var anchor = e.view
      ? '<a class="tname" href="' + esc(e.view) + '" data-view="' + esc(e.view) + '">' + esc(e.name) + '</a>'
      : '<a class="tname" href="' + esc(e.raw) + '" download>' + esc(e.name) + '</a>';
    return '<div class="trow isfile"' + style + '>' +
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

    lastDir = row.dataset.path || lastDir;

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
        if (footEl) footEl.textContent = entries.length + ' item' + (entries.length === 1 ? '' : 's');
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
  function pathFromView(view) {
    var q = view.indexOf('?');
    var params = new URLSearchParams(q >= 0 ? view.slice(q + 1) : '');
    return params.get('path');
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

  function loadView(view, anchor, push) {
    var filePath = pathFromView(view);
    if (!filePath) return;
    if (window.PreviewViewer) window.PreviewViewer.load(filePath);
    if (anchor) lastDir = parentDirOf(anchor);
    if (rawlink) rawlink.hidden = false;
    markActive(anchor);
    if (push) {
      history.pushState({ view: filePath }, '', location.pathname + '?view=' + encodeURIComponent(filePath));
    }
  }

  function showPlaceholder() {
    if (content) content.innerHTML = placeholder;
    if (rawlink) rawlink.hidden = true;
    if (kindEl) kindEl.textContent = '';
    if (metaEl) metaEl.textContent = '';
    if (toggle) toggle.hidden = true;
    markActive(null);
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

  window.addEventListener('popstate', function () {
    var v = new URLSearchParams(location.search).get('view');
    if (v) {
      var anchor = tree.querySelector('a.tname[data-view*="' + encodeURIComponent(v) + '"]');
      loadView(VIEW_ROUTE + '?path=' + encodeURIComponent(v), anchor, false);
    } else {
      showPlaceholder();
    }
  });

  // Expose a tiny surface for the upload modal.
  window.PreviewExplorer = {
    getCwd: function () { return cwd; },
    getLastDir: function () { return lastDir; },
    refreshDir: refreshDir
  };

  // Deep-link: if the shell was opened with ?view=<path>, load that file.
  var initial = new URLSearchParams(location.search).get('view');
  if (initial && window.PreviewViewer) {
    var a0 = tree.querySelector('a.tname[data-view*="' + encodeURIComponent(initial) + '"]');
    loadView(VIEW_ROUTE + '?path=' + encodeURIComponent(initial), a0, false);
  }
})();
