"""uploadserver-preview

A thin extension of the `uploadserver` package that adds an in-browser previewer
for developer files: Markdown, JSON, YAML/TOML/INI, source code (syntax
highlighted), CSV/TSV tables, unified diffs, and images.

Rendering happens entirely client-side with vendored JavaScript libraries (no
build step, no CDN, no network) so it works on an isolated LAN. Uploads and every
other `uploadserver` feature (auth, TLS, --directory, --theme, ...) are unchanged.

The extension works by monkeypatching `uploadserver.SimpleHTTPRequestHandler`
with a subclass before calling `uploadserver.serve_forever()`. `serve_forever`
resolves that name from the module namespace at call time, so the subclass is
used for every request.
"""

import http
import http.server
import io
import json
import mimetypes
import os
import pathlib
import posixpath
import urllib.parse

import uploadserver

__all__ = ["PreviewHTTPRequestHandler", "main", "serve"]

ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
ASSET_ROUTE = "/__preview_asset__/"
VIEW_ROUTE = "/__view__"
INDEX_ROUTE = "/__index__"

# Files we are willing to serve from the assets directory (basename whitelist).
_ASSET_FILES = frozenset(
    f for f in os.listdir(ASSETS_DIR) if os.path.isfile(os.path.join(ASSETS_DIR, f))
)


def _compute_asset_version():
    """A short fingerprint of the bundled assets (size + mtime of each file).

    Appended to asset URLs as ?v=... so a long browser cache never serves a
    stale stylesheet/script after the assets change: a change flips the token,
    which flips the URL, which forces a refetch. Computed once at import.
    """
    import hashlib

    h = hashlib.sha1()
    for f in sorted(_ASSET_FILES):
        try:
            st = os.stat(os.path.join(ASSETS_DIR, f))
            h.update(("%s:%d:%d;" % (f, st.st_mtime_ns, st.st_size)).encode("utf-8"))
        except OSError:
            pass
    return h.hexdigest()[:10]


ASSET_VERSION = _compute_asset_version()


def _asset_url(name):
    """URL for a bundled asset, cache-busted by the current asset fingerprint."""
    return "%s%s?v=%s" % (ASSET_ROUTE, name, ASSET_VERSION)

# Same-origin only. No inline scripts (all JS is external), so script-src stays
# 'self'. 'unsafe-inline' is allowed for styles because the JSON web component and
# the highlight/diff themes inject inline styles.
CSP = (
    "default-src 'self'; "
    "img-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)

# The <script defer> load order matters: hljs before its extra language, and
# diff2html core after hljs is present as a global.
_SCRIPTS = (
    "hljs.min.js",
    "hljs-dockerfile.min.js",
    "marked.umd.js",
    "purify.min.js",
    "papaparse.min.js",
    "diff2html.core.min.js",
    "json-viewer.js",
    "viewer.js",
)

# Extensions that open in the rich viewer. Everything else in a listing is a
# plain download link. Mirrors (loosely) the client's KIND table.
_TEXT_EXT = {
    "md", "markdown", "mdown", "mkd", "json", "geojson", "ipynb", "yml", "yaml",
    "toml", "ini", "cfg", "conf", "csv", "tsv", "diff", "patch", "html", "htm",
    "xhtml", "xml", "py", "pyw", "js", "mjs", "cjs", "jsx", "ts", "tsx", "sh",
    "bash", "zsh", "rs", "go", "java", "kt", "c", "h", "cpp", "cc", "cxx", "hpp",
    "hh", "rb", "php", "lua", "sql", "css", "scss", "less", "swift", "r", "pl",
    "txt", "text", "log",
}
_IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"}
_DIFF_EXT = {"diff", "patch"}
_DATA_EXT = {"json", "geojson", "ipynb", "yml", "yaml", "toml", "ini", "cfg", "conf", "csv", "tsv", "xml"}
_DOC_EXT = {"md", "markdown", "mdown", "mkd", "txt", "text", "log", "html", "htm", "xhtml"}
_NO_EXT_NAMES = {"dockerfile", "makefile", ".gitignore", ".gitattributes", ".env", "readme", "license"}

PREVIEWABLE = _TEXT_EXT | _IMAGE_EXT


_DIR_GLYPH = "▸"    # ▸
_FILE_GLYPH = "◆"   # ◆
_MARKUP_EXT = {"html", "htm", "xhtml", "xml"}


def _kind_glyph(name, is_dir):
    """Return (css_class, glyph_char) for the coloured file-kind glyph.

    The class picks the glyph colour from the theme tokens (--g-*); the char is
    a folder caret for directories and a diamond for files.
    """
    if is_dir:
        return "dir", _DIR_GLYPH
    lower = name.lower()
    ext = lower.rsplit(".", 1)[-1] if "." in lower else ""
    if lower in _NO_EXT_NAMES or ext == "":
        if lower in ("readme",):
            return "doc", _FILE_GLYPH
        return "code", _FILE_GLYPH
    if ext in _IMAGE_EXT:
        return "img", _FILE_GLYPH
    if ext in _DIFF_EXT:
        return "diff", _FILE_GLYPH
    if ext in _MARKUP_EXT:
        return "html", _FILE_GLYPH
    if ext in _DATA_EXT:
        return "data", _FILE_GLYPH
    if ext in _DOC_EXT:
        return "doc", _FILE_GLYPH
    if ext in _TEXT_EXT:
        return "code", _FILE_GLYPH
    return "bin", _FILE_GLYPH


def _is_previewable(name):
    lower = name.lower()
    if lower in _NO_EXT_NAMES:
        return True
    ext = lower.rsplit(".", 1)[-1] if "." in lower else ""
    return ext in PREVIEWABLE


def _list_entries(fs_path, names):
    """Sort a directory's names: dirs first, then files, case-insensitive.

    Returns a list of (name, is_dir, full_fs_path) tuples.
    """
    entries = []
    for name in names:
        full = os.path.join(fs_path, name)
        entries.append((name, os.path.isdir(full), full))
    entries.sort(key=lambda e: (not e[1], e[0].lower()))
    return entries


def _entry_json(url_path, name, is_dir, full):
    """Describe one listing entry as JSON-serialisable data for the explorer.

    `url_path` is the (unquoted) URL of the containing directory, ending in "/".
    Mirrors the fields the client's row builder in explorer.js expects.
    """
    quoted = urllib.parse.quote(name)
    glyph_cls, glyph_ch = _kind_glyph(name, is_dir)
    d = {"name": name, "is_dir": is_dir, "glyph_cls": glyph_cls, "glyph": glyph_ch}
    if is_dir:
        d["path"] = url_path + quoted + "/"
    else:
        try:
            d["size_h"] = _human_size(os.path.getsize(full))
        except OSError:
            d["size_h"] = ""
        abs_url = url_path + quoted
        d["raw"] = abs_url
        if _is_previewable(name):
            d["view"] = VIEW_ROUTE + "?path=" + urllib.parse.quote(abs_url, safe="")
        else:
            d["view"] = None
    return d


def _dir_index(handler, url_path):
    """Return the JSON index dict for the directory at `url_path` (ends in "/").

    Raises OSError if the directory can't be listed.
    """
    # translate_path unquotes its argument, so hand it a quoted path (url_path is
    # already unquoted) to avoid corrupting names containing '%'.
    fs_path = handler.translate_path(urllib.parse.quote(url_path))
    names = os.listdir(fs_path)
    entries = _list_entries(fs_path, names)
    return {
        "path": url_path,
        "entries": [_entry_json(url_path, n, d, f) for (n, d, f) in entries],
    }


def _hljs_css_links(theme):
    """The highlight.js theme stylesheet link(s) for the given --theme."""
    if theme == "light":
        return '<link rel="stylesheet" href="%s">' % _asset_url("hljs-github.min.css")
    if theme == "dark":
        return '<link rel="stylesheet" href="%s">' % _asset_url("hljs-github-dark.min.css")
    # auto — follow the OS preference
    return (
        '<link rel="stylesheet" href="%s" media="(prefers-color-scheme: light)">\n'
        '<link rel="stylesheet" href="%s" media="(prefers-color-scheme: dark)">'
        % (_asset_url("hljs-github.min.css"), _asset_url("hljs-github-dark.min.css"))
    )


def _head_links(theme):
    """The full <link> set shared by the viewer and explorer pages."""
    return "\n".join(
        [
            '<link rel="stylesheet" href="%s">' % _asset_url("themes.css"),
            '<link rel="stylesheet" href="%s">' % _asset_url("app.css"),
            '<link rel="stylesheet" href="%s">' % _asset_url("diff2html.min.css"),
            _hljs_css_links(theme),
        ]
    )


def _script_tags(scripts):
    return "\n".join(
        '<script defer src="%s"></script>' % _asset_url(s) for s in scripts
    )


def get_viewer_page(theme):
    """The static viewer shell. The path is read client-side from ?path=."""
    color_scheme = uploadserver.COLOR_SCHEME.get(theme, "light dark")
    head_links = _head_links(theme)
    scripts = _script_tags(_SCRIPTS)

    return (
        """<!DOCTYPE html>
<html lang="en" data-theme="%(theme)s">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="%(color_scheme)s">
<title>Preview</title>
%(head_links)s
</head>
<body>
<div class="app">
  <div class="titlebar">
    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="title" id="titlelabel">preview</span>
    <span class="chip"><span class="led" aria-hidden="true"></span>local</span>
  </div>
  <header class="topbar">
    <a class="back" id="backlink" href="/" title="Back to folder" aria-label="Back to folder">&larr;</a>
    <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
    <span class="spacer"></span>
    <span class="badge" id="kind"></span>
    <span class="meta" id="meta"></span>
    <div class="segmented" id="viewtoggle" role="group" aria-label="View mode" hidden>
      <button id="btn-rendered" type="button" aria-pressed="true">Rendered</button>
      <button id="btn-raw" type="button" aria-pressed="false">Raw</button>
    </div>
    <a class="raw" id="rawlink" href="#">raw &#8599;</a>
  </header>
  <main id="content" class="content"><div class="loading">Loading&hellip;</div></main>
</div>
%(scripts)s
</body>
</html>"""
        % {
            "theme": theme,
            "color_scheme": color_scheme,
            "head_links": head_links,
            "scripts": scripts,
        }
    ).encode("utf-8")


def _tree_row_html(url_path, name, is_dir, full, depth):
    """One row of the explorer file-tree. Mirrors rowHtml() in explorer.js.

    Directories render a twist/caret button and a lazy-loaded `.tchildren`
    container; files render a name link (previewable ones carry data-view so the
    shell loads them into the content pane in place).
    """
    esc = _html_escape
    glyph_cls, glyph_ch = _kind_glyph(name, is_dir)
    quoted = urllib.parse.quote(name)
    style = ' style="--depth:%d"' % depth
    if is_dir:
        dpath = url_path + quoted + "/"
        return (
            '<div class="trow isdir" data-path="%s"%s>'
            '<button class="twist glyph %s" type="button" aria-expanded="false" '
            'aria-label="Toggle %s">%s</button>'
            '<span class="tname">%s</span>'
            '</div><div class="tchildren" hidden></div>'
            % (esc(dpath), style, glyph_cls, esc(name), glyph_ch, esc(name))
        )
    try:
        size_h = _human_size(os.path.getsize(full))
    except OSError:
        size_h = ""
    abs_url = url_path + quoted
    if _is_previewable(name):
        view = VIEW_ROUTE + "?path=" + urllib.parse.quote(abs_url, safe="")
        anchor = '<a class="tname" href="%s" data-view="%s">%s</a>' % (
            esc(view), esc(view), esc(name)
        )
    else:
        anchor = '<a class="tname" href="%s" download>%s</a>' % (esc(quoted), esc(name))
    return (
        '<div class="trow isfile"%s>'
        '<span class="twist-spacer" aria-hidden="true"></span>'
        '<span class="glyph %s" aria-hidden="true">%s</span>'
        '%s<span class="tsize">%s</span>'
        "</div>"
        % (style, glyph_cls, glyph_ch, anchor, size_h)
    )


def _breadcrumbs_html(url_path):
    """Breadcrumb trail for the directory at `url_path` (unquoted, ends in '/')."""
    esc = _html_escape
    parts = ['<a href="/">~</a>']
    acc = ""
    for i, seg in enumerate(s for s in url_path.strip("/").split("/") if s):
        acc += "/" + urllib.parse.quote(seg)
        parts.append('<span class="sep">/</span>')
        parts.append('<a href="%s/">%s</a>' % (acc, esc(seg)))
    # mark the last crumb as current
    if len(parts) > 1:
        segs = [s for s in url_path.strip("/").split("/") if s]
        last = esc(segs[-1])
        parts[-1] = '<span class="here">%s</span>' % last
    return "".join(parts)


def _render_shell(handler, fs_path, names):
    """The unified explorer shell: a persistent file-tree beside a content pane.

    The tree for the current directory is rendered server-side (so it works
    without JS); explorer.js then takes over — expanding folders and loading
    files into the pane via fetch(), without a full navigation.
    """
    theme = getattr(uploadserver.args, "theme", "auto")
    url_path = urllib.parse.unquote(handler.path.split("?", 1)[0])
    if not url_path.endswith("/"):
        url_path += "/"

    entries = _list_entries(fs_path, names)
    esc = _html_escape

    crumbs = _breadcrumbs_html(url_path)
    rows = "".join(_tree_row_html(url_path, n, d, f, 0) for (n, d, f) in entries)
    if not rows:
        rows = '<div class="empty">This folder is empty.</div>'

    segs = [s for s in url_path.strip("/").split("/") if s]
    folder = segs[-1] if segs else "~"
    n = len(entries)
    footer = "%d item%s" % (n, "" if n == 1 else "s")

    scripts = _script_tags(_SCRIPTS + ("explorer.js", "upload.js"))

    return """<!DOCTYPE html>
<html lang="en" data-theme="%(theme)s">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="%(color_scheme)s">
<title>%(title)s</title>
%(head_links)s
</head>
<body>
<div class="app app--shell">
  <div class="titlebar">
    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="title" id="titlelabel">%(folder)s &mdash; explorer</span>
    <span class="chip"><span class="led" aria-hidden="true"></span>local</span>
  </div>
  <div class="shell">
    <aside class="sidebar">
      <div class="side-head">
        <span class="exp-label">Explorer</span>
        <a class="btn btn-accent btn-sm" id="upload-open" href="/upload">&#8593; Upload</a>
      </div>
      <div class="tree" id="tree" data-cwd="%(cwd)s">
        <div class="tree-inner">
%(rows)s
        </div>
      </div>
      <div class="exp-foot" id="exp-foot">%(footer)s</div>
    </aside>
    <section class="pane">
      <header class="topbar">
        <nav class="crumbs" id="crumbs" aria-label="Breadcrumb">%(crumbs)s</nav>
        <span class="spacer"></span>
        <span class="badge" id="kind"></span>
        <span class="meta" id="meta"></span>
        <div class="segmented" id="viewtoggle" role="group" aria-label="View mode" hidden>
          <button id="btn-rendered" type="button" aria-pressed="true">Rendered</button>
          <button id="btn-raw" type="button" aria-pressed="false">Raw</button>
        </div>
        <a class="raw" id="rawlink" href="#" hidden>raw &#8599;</a>
      </header>
      <main id="content" class="content"><div class="empty-pane">Select a file to preview.</div></main>
    </section>
  </div>
  <div class="drop-overlay" id="drop-overlay" hidden aria-hidden="true">
    <div class="drop-overlay-inner"><span class="do-glyph" aria-hidden="true">&#8593;</span>Drop files to upload</div>
  </div>
  <div class="modal-backdrop" id="upload-modal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <div class="modal-head">
        <h2 class="modal-title" id="upload-title">Upload files</h2>
        <button class="modal-close" id="upload-close" type="button" aria-label="Close">&times;</button>
      </div>
      <p class="modal-dest">Uploading to <span class="dest-path" id="upload-dest">~</span></p>
      <div class="dropzone" id="upload-drop">
        <span class="dz-glyph" aria-hidden="true">&#8593;</span>
        <p class="dz-text">Drag &amp; drop files here</p>
        <p class="dz-sub">or <button type="button" class="linkbtn" id="upload-browse">browse&hellip;</button></p>
      </div>
      <ul class="filelist" id="upload-filelist"></ul>
      <div class="modal-foot">
        <span class="upload-status" id="upload-status" role="status" aria-live="polite"></span>
        <span class="spacer"></span>
        <button class="btn" id="upload-cancel" type="button">Cancel</button>
        <button class="btn btn-accent" id="upload-confirm" type="button" disabled>Upload</button>
      </div>
      <input type="file" id="upload-input" multiple hidden>
    </div>
  </div>
</div>
%(scripts)s
</body>
</html>""" % {
        "theme": theme,
        "color_scheme": uploadserver.COLOR_SCHEME.get(theme, "light dark"),
        "title": esc(url_path),
        "head_links": _head_links(theme),
        "folder": esc(folder),
        "crumbs": crumbs,
        "cwd": esc(url_path),
        "rows": rows,
        "footer": footer,
        "scripts": scripts,
    }


def _human_size(n):
    units = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    size = float(n)
    while size >= 1024 and i < len(units) - 1:
        size /= 1024.0
        i += 1
    if i == 0:
        return "%d B" % n
    return ("%.1f %s" if size < 10 else "%.0f %s") % (size, units[i])


def _html_escape(s):
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _resolve_upload_dir(handler, dir_param):
    """Resolve the upload destination for `?dir=<url-path>` to a filesystem path.

    The stock uploadserver drops every file into the served root; this lets the
    explorer upload into the folder the user last interacted with. `dir_param`
    is a URL path (e.g. "/sub/dir/"); we translate it and confirm it stays
    inside the served root (defends against symlink/`..` escapes) and is an
    existing directory. Returns the absolute fs path, or None if invalid.
    """
    root = os.path.realpath(getattr(uploadserver.args, "directory", os.getcwd()))
    url_path = urllib.parse.unquote(dir_param or "/")
    if not url_path.startswith("/"):
        url_path = "/" + url_path
    # translate_path unquotes its argument and already collapses '..'; hand it a
    # quoted path so names containing '%' survive.
    fs_path = handler.translate_path(urllib.parse.quote(url_path))
    real = os.path.realpath(fs_path)
    if real != root and not real.startswith(root + os.sep):
        return None
    if not os.path.isdir(real):
        return None
    return real


def _receive_upload(handler, dest_dir):
    """Receive a multipart upload into `dest_dir` (an already-validated fs path).

    Mirrors uploadserver.receive_upload but writes into an arbitrary directory
    rather than the fixed served root. Reuses uploadserver's PersistentFieldStorage
    (which streams large parts to temp files) and auto_rename/--allow-replace
    conflict handling. Returns an (HTTPStatus, message) tuple.
    """
    result = (http.HTTPStatus.INTERNAL_SERVER_ERROR, "Server error")
    name_conflict = False

    form = uploadserver.PersistentFieldStorage(
        fp=handler.rfile, headers=handler.headers, environ={"REQUEST_METHOD": "POST"}
    )
    if "files" not in form:
        return (http.HTTPStatus.BAD_REQUEST, 'Field "files" not found')

    fields = form["files"]
    if not isinstance(fields, list):
        fields = [fields]
    if not all(field.file and field.filename for field in fields):
        return (http.HTTPStatus.BAD_REQUEST, "No files selected")

    allow_replace = getattr(uploadserver.args, "allow_replace", False)
    for field in fields:
        filename = pathlib.Path(field.filename).name if (field.file and field.filename) else None
        if not filename:
            continue
        destination = pathlib.Path(dest_dir) / filename
        if os.path.exists(destination):
            if allow_replace and os.path.isfile(destination):
                os.remove(destination)
            else:
                destination = uploadserver.auto_rename(destination)
                name_conflict = True
        # Large parts are spilled to a NamedTemporaryFile we can rename into
        # place; small ones stay in an in-memory buffer we copy out.
        if hasattr(field.file, "name"):
            source = field.file.name
            field.file.close()
            os.rename(source, destination)
        else:
            with open(destination, "wb") as f:
                f.write(field.file.read())
        handler.log_message('[Uploaded] "%s" --> %s', filename, destination)
        result = (
            http.HTTPStatus.NO_CONTENT,
            "Some filename(s) changed due to name conflict" if name_conflict else "Files accepted",
        )
    return result


class PreviewHTTPRequestHandler(uploadserver.SimpleHTTPRequestHandler):
    """uploadserver's handler plus preview routes and a richer directory listing."""

    server_version = "uploadserver-preview"

    def do_GET(self):
        # Enforce auth exactly like uploadserver does (idempotent if it passes).
        if not uploadserver.check_http_authentication(self):
            return
        if self._route_preview():
            return
        # /upload, raw files, redirects, and directory listings fall through to
        # uploadserver (which re-checks auth, harmlessly).
        super().do_GET()

    def do_HEAD(self):
        if not uploadserver.check_http_authentication(self):
            return
        if self._route_preview():  # our senders omit the body for HEAD
            return
        super().do_HEAD()

    def do_POST(self):
        # /upload accepts an optional ?dir=<url-path> so the explorer can drop
        # files into the folder the user is looking at, not just the served root.
        if not uploadserver.check_http_authentication(self):
            return
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/upload":
            dir_param = (urllib.parse.parse_qs(parsed.query).get("dir") or [None])[0]
            dest = _resolve_upload_dir(self, dir_param)
            if dest is None:
                self.send_error(http.HTTPStatus.BAD_REQUEST, "Invalid upload directory")
                return
            status, message = _receive_upload(self, dest)
            if status < http.HTTPStatus.BAD_REQUEST:
                self.send_response(status, message)
                self.end_headers()
            else:
                self.send_error(status, message)
            return
        super().do_POST()

    def do_PUT(self):
        self.do_POST()

    def _route_preview(self):
        """Handle preview-specific routes. Returns True if the request was served."""
        route = urllib.parse.urlsplit(self.path).path
        if route == VIEW_ROUTE:
            self._send_bytes(
                get_viewer_page(getattr(uploadserver.args, "theme", "auto")),
                "text/html; charset=utf-8",
                cache=False,
                csp=True,
            )
            return True
        if route == INDEX_ROUTE:
            self._serve_index()
            return True
        if route.startswith(ASSET_ROUTE):
            self._serve_asset(route[len(ASSET_ROUTE):])
            return True
        return False

    # Our own directory listing. Because we fully override this, uploadserver's
    # copyfile/flush_headers injection never runs.
    def list_directory(self, path):
        try:
            names = os.listdir(path)
        except OSError:
            self.send_error(http.HTTPStatus.NOT_FOUND, "No permission to list directory")
            return None
        try:
            body = _render_shell(self, path, names).encode("utf-8", "surrogateescape")
        except Exception:
            # If anything goes wrong, fall back to uploadserver's plain listing.
            return super().list_directory(path)

        self.send_response(http.HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        return io.BytesIO(body)

    # ---------- helpers ----------
    def _serve_index(self):
        """Serve a directory's listing as JSON (drives the explorer tree)."""
        query = urllib.parse.urlsplit(self.path).query
        raw = (urllib.parse.parse_qs(query).get("path") or ["/"])[0]
        url_path = urllib.parse.unquote(raw)
        if not url_path.startswith("/"):
            url_path = "/" + url_path
        if not url_path.endswith("/"):
            url_path += "/"
        try:
            data = _dir_index(self, url_path)
        except OSError:
            self.send_error(http.HTTPStatus.NOT_FOUND, "No permission to list directory")
            return
        body = json.dumps(data).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", cache=False, csp=True)

    def _serve_asset(self, name):
        safe = posixpath.basename(urllib.parse.unquote(name))
        fpath = os.path.join(ASSETS_DIR, safe)
        if safe not in _ASSET_FILES or not os.path.isfile(fpath):
            self.send_error(http.HTTPStatus.NOT_FOUND, "Asset not found")
            return
        if safe.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif safe.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        else:
            ctype = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        try:
            with open(fpath, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(http.HTTPStatus.NOT_FOUND, "Asset not found")
            return
        self.send_response(http.HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_bytes(self, data, ctype, cache=True, csp=False):
        self.send_response(http.HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if csp:
            self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "public, max-age=86400" if cache else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def serve(enable_preview=True):
    """Launch the server, optionally with preview enabled.

    Assumes `uploadserver.args` and the auth globals are already set (as
    `main()` does). Monkeypatches the handler and delegates to
    `uploadserver.serve_forever()`.
    """
    if enable_preview and not getattr(uploadserver.args, "cgi", False):
        uploadserver.SimpleHTTPRequestHandler = PreviewHTTPRequestHandler
    uploadserver.serve_forever()


def _build_parser():
    import argparse

    parser = argparse.ArgumentParser(
        prog="uploadserver-preview",
        description="uploadserver + an in-browser previewer for developer files.",
    )
    # Mirror uploadserver's arguments so this is a drop-in replacement.
    parser.add_argument("port", type=int, default=8000, nargs="?",
                        help="Specify alternate port [default: 8000]")
    parser.add_argument("--cgi", action="store_true", help="Run as CGI server (disables preview)")
    parser.add_argument("--allow-replace", action="store_true", default=False,
                        help="Replace existing file if uploaded file has the same name. "
                             "Auto rename by default.")
    parser.add_argument("--bind", "-b", metavar="ADDRESS",
                        help="Specify alternate bind address [default: all interfaces]")
    parser.add_argument("--directory", "-d", default=os.getcwd(),
                        help="Specify alternative directory [default: current directory]")
    parser.add_argument("--theme", type=str, default="auto", choices=["light", "auto", "dark"],
                        help="Light or dark theme [default: auto]")
    parser.add_argument("--server-certificate", "--certificate", "-c",
                        help="Specify HTTPS server certificate to use [default: none]")
    parser.add_argument("--client-certificate",
                        help="Specify HTTPS client certificate to accept for mutual TLS [default: none]")
    parser.add_argument("--basic-auth",
                        help="Specify user:pass for basic authentication (downloads and uploads)")
    parser.add_argument("--basic-auth-upload",
                        help="Specify user:pass for basic authentication (uploads only)")
    # Our addition.
    parser.add_argument("--no-preview", action="store_true",
                        help="Disable the previewer and behave like plain uploadserver")
    return parser


def main():
    import ipaddress

    parser = _build_parser()
    args = parser.parse_args()
    if not hasattr(args, "directory"):
        args.directory = os.getcwd()
    if args.bind:
        try:
            ipaddress.ip_address(args.bind)
        except ValueError:
            parser.error(
                "Invalid -b/--bind address. Expected an IP address (no port). "
                "Example: -b 192.168.1.10 and pass the port as a separate argument."
            )

    # Publish state onto the uploadserver module (its code reads these globals).
    uploadserver.args = args
    if args.basic_auth:
        u, p = args.basic_auth.split(":", 1)
        uploadserver.basic_auth = (bytes(u, "utf8"), bytes(p, "utf8"))
    if args.basic_auth_upload:
        u, p = args.basic_auth_upload.split(":", 1)
        uploadserver.basic_auth_upload = (bytes(u, "utf8"), bytes(p, "utf8"))

    serve(enable_preview=not args.no_preview)


if __name__ == "__main__":
    main()
