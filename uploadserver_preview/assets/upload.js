/* uploadserver-preview — upload modal.
   Wires the Upload button and drag-and-drop into a confirmation modal that
   POSTs files (multipart, field name "files") to /upload?dir=<target>, shows
   progress, then refreshes the affected folder in the tree via
   window.PreviewExplorer.refreshDir().

   The destination defaults to the folder the user last interacted with
   (window.PreviewExplorer.getLastDir()); dropping files anywhere over the
   explorer shows a "Drop files to upload" overlay and opens the modal
   pre-populated with those files for confirmation — nothing uploads until the
   user hits Upload. Progressive enhancement: with JS off, the Upload button is
   a plain link to /upload. */
(function () {
  'use strict';

  var modal = document.getElementById('upload-modal');
  var explorer = window.PreviewExplorer;
  if (!modal || !explorer) return; // nothing to wire

  var openBtn = document.getElementById('upload-open');
  var closeBtn = document.getElementById('upload-close');
  var cancelBtn = document.getElementById('upload-cancel');
  var confirmBtn = document.getElementById('upload-confirm');
  var browseBtn = document.getElementById('upload-browse');
  var input = document.getElementById('upload-input');
  var dropzone = document.getElementById('upload-drop');
  var fileList = document.getElementById('upload-filelist');
  var destEl = document.getElementById('upload-dest');
  var statusEl = document.getElementById('upload-status');
  var overlay = document.getElementById('drop-overlay');

  var selected = [];   // File objects queued for upload
  var targetDir = '/'; // URL path the current batch will upload into
  var uploading = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function humanSize(n) {
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0, size = n;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    if (i === 0) return n + ' B';
    return (size < 10 ? size.toFixed(1) : Math.round(size)) + ' ' + units[i];
  }

  // A human-readable rendering of a URL path: "~" for root, "~/a/b" otherwise.
  function prettyDir(dir) {
    var s = dir;
    try { s = decodeURIComponent(dir); } catch (e) { /* keep raw */ }
    s = s.replace(/^\/+|\/+$/g, '');
    return s ? '~/' + s : '~';
  }

  // ---------- file queue ----------
  function addFiles(files) {
    for (var i = 0; i < files.length; i++) selected.push(files[i]);
    renderList();
  }

  function removeAt(i) {
    selected.splice(i, 1);
    renderList();
  }

  function renderList() {
    if (!selected.length) {
      fileList.innerHTML = '';
    } else {
      fileList.innerHTML = selected.map(function (f, i) {
        return '<li class="fileitem">' +
               '<span class="fi-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
               '<span class="fi-size">' + esc(humanSize(f.size)) + '</span>' +
               '<button type="button" class="fi-remove" data-i="' + i + '" aria-label="Remove ' + esc(f.name) + '">&times;</button>' +
               '</li>';
      }).join('');
    }
    confirmBtn.disabled = uploading || selected.length === 0;
    var n = selected.length;
    confirmBtn.textContent = n > 1 ? 'Upload ' + n + ' files' : 'Upload';
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'upload-status' + (kind ? ' is-' + kind : '');
  }

  // ---------- modal open / close ----------
  function openModal(files) {
    targetDir = explorer.getLastDir() || explorer.getCwd() || '/';
    destEl.textContent = prettyDir(targetDir);
    destEl.title = targetDir;
    if (files && files.length) addFiles(files);
    else renderList();
    setStatus('');
    modal.hidden = false;
    document.addEventListener('keydown', onKeydown);
    // Focus the primary control for keyboard users.
    (selected.length ? confirmBtn : browseBtn).focus();
  }

  function closeModal() {
    if (uploading) return; // don't abandon an in-flight upload
    modal.hidden = true;
    selected = [];
    renderList();
    setStatus('');
    input.value = '';
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); closeModal(); }
  }

  // ---------- upload ----------
  function doUpload() {
    if (uploading || !selected.length) return;
    uploading = true;
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    setStatus('Uploading' + (selected.length > 1 ? ' ' + selected.length + ' files' : '') + '…', 'busy');

    var fd = new FormData();
    selected.forEach(function (f) { fd.append('files', f, f.name); });

    var dir = targetDir;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload?dir=' + encodeURIComponent(dir));
    xhr.timeout = 3600000;
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable && e.total) {
        setStatus('Uploading… ' + Math.round((e.loaded / e.total) * 100) + '%', 'busy');
      }
    };
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== XMLHttpRequest.DONE) return;
      uploading = false;
      cancelBtn.disabled = false;
      if (xhr.status >= 200 && xhr.status < 300) {
        var n = selected.length;
        setStatus('Uploaded ' + n + ' file' + (n === 1 ? '' : 's') + '.', 'ok');
        selected = [];
        renderList();
        input.value = '';
        Promise.resolve(explorer.refreshDir(dir)).then(function () {
          setTimeout(function () { if (!uploading) closeModal(); }, 700);
        });
      } else {
        var msg = xhr.status ? (xhr.status + ' ' + (xhr.statusText || 'Upload failed')) : 'Connection failed';
        setStatus(msg, 'err');
        confirmBtn.disabled = selected.length === 0;
      }
    };
    xhr.send(fd);
  }

  // ---------- wiring ----------
  if (openBtn) {
    openBtn.addEventListener('click', function (ev) { ev.preventDefault(); openModal(); });
  }
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', doUpload);

  if (browseBtn) browseBtn.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () {
    if (input.files && input.files.length) addFiles(input.files);
    input.value = ''; // allow re-selecting the same file
  });

  fileList.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.fi-remove');
    if (btn) removeAt(parseInt(btn.dataset.i, 10));
  });

  // Click on the backdrop (outside the dialog) closes.
  modal.addEventListener('click', function (ev) { if (ev.target === modal) closeModal(); });

  // Dropzone inside the modal.
  ['dragenter', 'dragover'].forEach(function (t) {
    dropzone.addEventListener(t, function (ev) { ev.preventDefault(); dropzone.classList.add('is-over'); });
  });
  ['dragleave', 'dragend'].forEach(function (t) {
    dropzone.addEventListener(t, function () { dropzone.classList.remove('is-over'); });
  });
  dropzone.addEventListener('drop', function (ev) {
    ev.preventDefault();
    dropzone.classList.remove('is-over');
    if (ev.dataTransfer && ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files);
  });

  // ---------- window-wide drag & drop over the explorer ----------
  function hasFiles(ev) {
    var dt = ev.dataTransfer;
    if (!dt) return false;
    var types = dt.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }

  var dragDepth = 0;
  window.addEventListener('dragenter', function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth++;
    if (modal.hidden && overlay) overlay.hidden = false; // don't cover the open modal
  });
  window.addEventListener('dragover', function (ev) {
    if (hasFiles(ev)) ev.preventDefault(); // required to allow a drop
  });
  window.addEventListener('dragleave', function (ev) {
    if (!hasFiles(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.hidden = true;
  });
  window.addEventListener('drop', function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.hidden = true;
    if (ev.target.closest && ev.target.closest('#upload-drop')) return; // handled by the dropzone
    var files = ev.dataTransfer.files;
    if (!files || !files.length) return;
    if (modal.hidden) openModal(files);       // confirm before upload
    else addFiles(files);
  });
})();
