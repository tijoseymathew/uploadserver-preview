/* uploadserver-preview — git surfaces.
   Fetches /__git__ and drives everything git-shaped in the UI: the titlebar
   branch chip, the sidebar gitbar ("Comparing <base> ← <branch>" + the base
   picker + the +N/−M counts), per-file M/A/D badges and folder change-dots in
   the explorer tree, and the changed-file signal the viewer's Diff toggle
   needs (window.PreviewGit). Outside a git repo (or without git) the server
   answers {enabled:false} and every surface stays hidden. */
(function () {
  'use strict';

  var chipEl = document.getElementById('git-chip');
  var gitbar = document.getElementById('gitbar');
  var baseSel = document.getElementById('git-base');
  var branchEl = document.getElementById('git-branch');
  var countsEl = document.getElementById('git-counts');
  var tree = document.getElementById('tree');

  var STATE = { enabled: false, branch: null, base: null, branches: [], changes: {} };

  function decode(p) { try { return decodeURIComponent(p); } catch (e) { return p; } }

  // The directory this page's git queries are scoped to: the explorer's cwd,
  // or the viewed file's directory on the standalone viewer page. The change
  // map /__git__ returns is relative to this scope.
  var scope = (function () {
    if (tree) return decode(tree.dataset.cwd || '/');
    var p = new URLSearchParams(location.search).get('path');
    if (p) return decode(p).replace(/[^\/]*$/, '') || '/';
    return '/';
  })();

  // "/sub/file.py" -> the change-map key: the path relative to the scope dir.
  function relKey(urlPath) {
    var p = decode(urlPath);
    if (p.indexOf(scope) === 0) p = p.slice(scope.length);
    return p.replace(/^\/+/, '');
  }

  // ---------- public surface (used by viewer.js) ----------
  // changeFor("/sub/file.py") -> "M" | "A" | "D" | null
  function changeFor(urlPath) {
    if (!STATE.enabled || !urlPath) return null;
    return STATE.changes[relKey(urlPath)] || null;
  }

  function fetchDiff(urlPath) {
    var url = '/__diff__?path=' + encodeURIComponent(decode(urlPath)) +
              (STATE.base ? '&base=' + encodeURIComponent(STATE.base) : '');
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
      return r.text();
    });
  }

  window.PreviewGit = {
    changeFor: changeFor,
    fetchDiff: fetchDiff,
    base: function () { return STATE.base; },
    refresh: refresh
  };

  // ---------- status ----------
  function refresh(base) {
    var url = '/__git__?path=' + encodeURIComponent(scope) +
              (base ? '&base=' + encodeURIComponent(base) : '');
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        STATE.enabled = !!data.enabled;
        STATE.branch = data.branch || null;
        STATE.base = data.base || null;
        STATE.branches = data.branches || [];
        STATE.changes = data.changes || {};
        STATE.insertions = data.insertions || 0;
        STATE.deletions = data.deletions || 0;
        render();
      })
      .catch(function () { /* leave whatever was server-rendered */ });
  }

  function render() {
    if (!STATE.enabled) {
      if (gitbar) gitbar.hidden = true;
      applyTree();
      syncViewer();
      return;
    }
    if (chipEl) chipEl.textContent = '⎇ ' + STATE.branch;
    if (gitbar) {
      gitbar.hidden = false;
      if (branchEl) branchEl.textContent = STATE.branch;
      if (baseSel) {
        baseSel.innerHTML = '';
        var names = STATE.branches.slice();
        if (names.indexOf('HEAD') < 0) names.push('HEAD'); // "uncommitted only"
        if (STATE.base && names.indexOf(STATE.base) < 0) names.unshift(STATE.base);
        names.forEach(function (name) {
          var o = document.createElement('option');
          o.value = name; o.textContent = name;
          o.selected = name === STATE.base;
          baseSel.appendChild(o);
        });
      }
      if (countsEl) {
        countsEl.innerHTML = '';
        var add = document.createElement('span');
        add.className = 'gc-add'; add.textContent = '+' + (STATE.insertions || 0);
        var del = document.createElement('span');
        del.className = 'gc-del'; del.textContent = '−' + (STATE.deletions || 0);
        countsEl.appendChild(add); countsEl.appendChild(del);
      }
    }
    applyTree();
    syncViewer();
  }

  function syncViewer() {
    if (window.PreviewViewer && window.PreviewViewer.syncGit) window.PreviewViewer.syncGit();
  }

  if (baseSel) {
    baseSel.addEventListener('change', function () { refresh(baseSel.value); });
  }

  // ---------- tree badges ----------
  // A file row's url path = its parent directory (nearest .tchildren's owning
  // dir row, else the tree's cwd) + the row's name. Mirrors explorer.js.
  function rowDir(row) {
    var container = row.closest('.tchildren');
    if (container) {
      var dirRow = container.previousElementSibling;
      if (dirRow && dirRow.classList.contains('isdir') && dirRow.dataset.path) {
        return dirRow.dataset.path;
      }
    }
    return (tree && tree.dataset.cwd) || '/';
  }

  function hasChangeUnder(dirKey) {
    var prefix = dirKey.replace(/\/+$/, '') + '/';
    for (var k in STATE.changes) {
      if (STATE.changes.hasOwnProperty(k) && k.indexOf(prefix) === 0) return true;
    }
    return false;
  }

  function applyTree() {
    if (!tree) return;
    var rows = tree.querySelectorAll('.trow');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var old = row.querySelector('.gbadge');
      if (old) old.remove();
      row.classList.remove('gchanged');
      if (!STATE.enabled) continue;
      if (row.classList.contains('isdir')) {
        var dirKey = relKey(row.dataset.path || '');
        if (dirKey && hasChangeUnder(dirKey)) row.classList.add('gchanged');
        continue;
      }
      var nameEl = row.querySelector('.tname');
      if (!nameEl) continue;
      var st = STATE.changes[relKey(rowDir(row)) + nameEl.textContent];
      if (!st) continue;
      var b = document.createElement('span');
      b.className = 'gbadge gbadge-' + st.toLowerCase();
      b.textContent = st;
      b.title = { M: 'Modified', A: 'Added', D: 'Deleted' }[st] || st;
      row.insertBefore(b, row.querySelector('.tsize'));
    }
  }

  // Re-badge when the explorer injects rows (folder expand, upload refresh).
  // Ignore mutations that are only our own badges to avoid a feedback loop.
  if (tree && window.MutationObserver) {
    var scheduled = false;
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        var nodes = Array.prototype.slice.call(m.addedNodes)
          .concat(Array.prototype.slice.call(m.removedNodes));
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.nodeType === 1 && n.classList.contains('gbadge')) continue;
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(function () { scheduled = false; applyTree(); });
          return;
        }
      }
    });
    mo.observe(tree, { childList: true, subtree: true });
  }

  refresh();
})();
