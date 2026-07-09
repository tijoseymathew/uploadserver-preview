/* uploadserver-preview — explorer shell.
   Turns the server-rendered directory listing into a small SPA: expand/collapse
   folders in the tree (lazily fetching /__index__ JSON) and load files into the
   content pane in place via window.PreviewViewer.load() — no full navigation.
   Progressive enhancement: without this script the tree and file links still
   work as plain server-rendered links. */
(function () {
  'use strict';

  var VIEW_ROUTE = '/__view__';

  var tree = document.getElementById('tree');
  if (!tree || !window.PreviewViewer) return; // nothing to enhance

  var content = document.getElementById('content');
  var rawlink = document.getElementById('rawlink');
  var kindEl = document.getElementById('kind');
  var metaEl = document.getElementById('meta');
  var toggle = document.getElementById('viewtoggle');
  var placeholder = content ? content.innerHTML : '';

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

  // ---------- folder expand / collapse ----------
  function toggleDir(row) {
    var twist = row.querySelector('.twist');
    var children = row.nextElementSibling;
    if (!twist || !children || !children.classList.contains('tchildren')) return;

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
    fetch('/__index__?path=' + encodeURIComponent(row.dataset.path), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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

  // ---------- file selection ----------
  function pathFromView(view) {
    var q = view.indexOf('?');
    var params = new URLSearchParams(q >= 0 ? view.slice(q + 1) : '');
    return params.get('path');
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
    window.PreviewViewer.load(filePath);
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
    if (anchor) { ev.preventDefault(); loadView(anchor.getAttribute('data-view'), anchor, true); return; }

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

  // Deep-link: if the shell was opened with ?view=<path>, load that file.
  var initial = new URLSearchParams(location.search).get('view');
  if (initial) {
    var a0 = tree.querySelector('a.tname[data-view*="' + encodeURIComponent(initial) + '"]');
    loadView(VIEW_ROUTE + '?path=' + encodeURIComponent(initial), a0, false);
  }
})();
