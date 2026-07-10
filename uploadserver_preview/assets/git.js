/* uploadserver-preview — git surfaces.
   Fetches /__git__ and drives everything git-shaped in the UI: the context
   branch chip, the topbar gitbar ("Comparing <base> ← <branch>" + the base
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

  var STATE = { enabled: false, branch: null, base: null, branches: [], changes: {}, prefix: '/' };

  function decode(p) { try { return decodeURIComponent(p); } catch (e) { return p; } }

  // The directory this page's git queries are scoped to: initially the
  // explorer's cwd (or the viewed file's directory on the standalone viewer
  // page), then re-scoped by the explorer as the user moves around the tree —
  // expanding a folder or opening a file makes that directory the git path.
  var scope = (function () {
    if (tree) return decode(tree.dataset.cwd || '/');
    var p = new URLSearchParams(location.search).get('path');
    if (p) return decode(p).replace(/[^\/]*$/, '') || '/';
    return '/';
  })();

  // The base the user explicitly picked. It sticks while moving around the
  // same repo but resets when the scope lands in a *different* repo (tracked
  // by the server-reported repo prefix, which survives non-repo interludes).
  var userBase = null;
  var lastPrefix = null;

  function setScope(dir) {
    if (!dir) return;
    dir = decode(dir);
    if (dir.charAt(dir.length - 1) !== '/') dir += '/';
    if (dir === scope) return;
    scope = dir;
    refresh(userBase);
  }

  // "/repo/sub/file.py" -> the change-map key: the path relative to the repo
  // prefix /__git__ reported ("" for the repo dir itself), or null when the
  // path lies outside that repo. Keys are repo-relative, so badges cover the
  // whole repo regardless of which of its subdirectories set the scope.
  function relKey(urlPath) {
    var p = decode(urlPath);
    if (p.indexOf(STATE.prefix) !== 0) return null;
    return p.slice(STATE.prefix.length).replace(/^\/+/, '');
  }

  // ---------- public surface (used by viewer.js and explorer.js) ----------
  // changeFor("/sub/file.py") -> "M" | "A" | "D" | null
  function changeFor(urlPath) {
    if (!STATE.enabled || !urlPath) return null;
    var key = relKey(urlPath);
    return key ? STATE.changes[key] || null : null;
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
    setScope: setScope,
    refresh: refresh
  };

  // ---------- status ----------
  function refresh(base) {
    var url = '/__git__?path=' + encodeURIComponent(scope) +
              (base ? '&base=' + encodeURIComponent(base) : '');
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        if (data.enabled) {
          var switched = lastPrefix !== null && (data.prefix || '/') !== lastPrefix;
          lastPrefix = data.prefix || '/';
          if (switched && base) {
            // a base picked in another repo doesn't carry over — even if a
            // branch of that name exists here, ask again for this repo's default
            userBase = null;
            return refresh(null);
          }
        }
        STATE.enabled = !!data.enabled;
        STATE.branch = data.branch || null;
        STATE.base = data.base || null;
        STATE.branches = data.branches || [];
        STATE.changes = data.changes || {};
        STATE.prefix = data.prefix || '/';
        STATE.insertions = data.insertions || 0;
        STATE.deletions = data.deletions || 0;
        render();
      })
      .catch(function () { /* leave whatever was server-rendered */ });
  }

  function render() {
    if (!STATE.enabled) {
      if (gitbar) gitbar.hidden = true;
      if (chipEl) chipEl.textContent = 'local';
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
        if (STATE.base && names.indexOf(STATE.base) < 0) names.unshift(STATE.base); // detached: "HEAD"
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
    baseSel.addEventListener('change', function () {
      userBase = baseSel.value;
      refresh(userBase);
    });
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
    // "" is the repo dir itself — any change at all counts
    var prefix = dirKey ? dirKey.replace(/\/+$/, '') + '/' : '';
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
        if (dirKey != null && hasChangeUnder(dirKey)) row.classList.add('gchanged');
        continue;
      }
      var nameEl = row.querySelector('.tname');
      if (!nameEl) continue;
      var parentKey = relKey(rowDir(row)); // null: the row is outside the scope
      var st = parentKey == null ? null : STATE.changes[parentKey + nameEl.textContent];
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
