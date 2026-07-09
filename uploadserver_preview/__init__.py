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
import mimetypes
import os
import posixpath
import urllib.parse

import uploadserver

__all__ = ["PreviewHTTPRequestHandler", "main", "serve"]

ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
ASSET_ROUTE = "/__preview_asset__/"
VIEW_ROUTE = "/__view__"

# Files we are willing to serve from the assets directory (basename whitelist).
_ASSET_FILES = frozenset(
    f for f in os.listdir(ASSETS_DIR) if os.path.isfile(os.path.join(ASSETS_DIR, f))
)

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


def _kind_tag(name, is_dir):
    """Return (css_class, short_label) for the type-glyph tag in listings."""
    if is_dir:
        return "dir", "dir"
    lower = name.lower()
    ext = lower.rsplit(".", 1)[-1] if "." in lower else ""
    if lower in _NO_EXT_NAMES or ext == "":
        if lower in ("readme",):
            return "doc", "doc"
        return "code", "txt"
    if ext in _IMAGE_EXT:
        return "img", ext
    if ext in _DIFF_EXT:
        return "diff", ext
    if ext in _DATA_EXT:
        return "data", ext
    if ext in _DOC_EXT:
        return "doc", ext
    if ext in _TEXT_EXT:
        return "code", ext
    return "", ext or "bin"


def _is_previewable(name):
    lower = name.lower()
    if lower in _NO_EXT_NAMES:
        return True
    ext = lower.rsplit(".", 1)[-1] if "." in lower else ""
    return ext in PREVIEWABLE


def get_viewer_page(theme):
    """The static viewer shell. The path is read client-side from ?path=."""
    color_scheme = uploadserver.COLOR_SCHEME.get(theme, "light dark")

    if theme == "light":
        hljs_css = '<link rel="stylesheet" href="%shljs-github.min.css">' % ASSET_ROUTE
    elif theme == "dark":
        hljs_css = '<link rel="stylesheet" href="%shljs-github-dark.min.css">' % ASSET_ROUTE
    else:  # auto — follow the OS preference
        hljs_css = (
            '<link rel="stylesheet" href="%shljs-github.min.css" media="(prefers-color-scheme: light)">\n'
            '<link rel="stylesheet" href="%shljs-github-dark.min.css" media="(prefers-color-scheme: dark)">'
            % (ASSET_ROUTE, ASSET_ROUTE)
        )

    scripts = "\n".join(
        '<script defer src="%s%s"></script>' % (ASSET_ROUTE, s) for s in _SCRIPTS
    )

    return (
        """<!DOCTYPE html>
<html lang="en" data-theme="%(theme)s">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="%(color_scheme)s">
<title>Preview</title>
<link rel="stylesheet" href="%(route)sapp.css">
<link rel="stylesheet" href="%(route)sdiff2html.min.css">
%(hljs_css)s
</head>
<body>
<header class="topbar">
  <a class="back" id="backlink" href="/" title="Back to folder" aria-label="Back to folder">&larr;</a>
  <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
  <span class="spacer"></span>
  <span class="badge" id="kind"></span>
  <span class="meta" id="meta"></span>
  <a class="raw" id="rawlink" href="#">raw</a>
</header>
<main id="content" class="content"><div class="loading">Loading&hellip;</div></main>
%(scripts)s
</body>
</html>"""
        % {
            "theme": theme,
            "color_scheme": color_scheme,
            "route": ASSET_ROUTE,
            "hljs_css": hljs_css,
            "scripts": scripts,
        }
    ).encode("utf-8")


def _render_listing(handler, fs_path, names):
    """Build an enhanced directory listing (returns HTML str)."""
    theme = getattr(uploadserver.args, "theme", "auto")
    url_path = urllib.parse.unquote(handler.path.split("?", 1)[0])
    if not url_path.endswith("/"):
        url_path += "/"

    # dirs first, then files; case-insensitive
    entries = []
    for name in names:
        full = os.path.join(fs_path, name)
        is_dir = os.path.isdir(full)
        entries.append((name, is_dir, full))
    entries.sort(key=lambda e: (not e[1], e[0].lower()))

    esc = _html_escape

    # breadcrumb across the current path
    crumb_parts = ['<a href="/">~</a>']
    acc = ""
    segs = [s for s in url_path.strip("/").split("/") if s]
    for i, seg in enumerate(segs):
        acc += "/" + urllib.parse.quote(seg)
        crumb_parts.append('<span class="sep">/</span>')
        if i < len(segs) - 1:
            crumb_parts.append('<a href="%s/">%s</a>' % (acc, esc(seg)))
        else:
            crumb_parts.append('<span class="here">%s</span>' % esc(seg))
    crumbs = "".join(crumb_parts)

    rows = []
    for name, is_dir, full in entries:
        tag_cls, tag_label = _kind_tag(name, is_dir)
        display = name + ("/" if is_dir else "")
        quoted = urllib.parse.quote(name)
        if is_dir:
            href = quoted + "/"
            rows.append(
                '<div class="row isdir">'
                '<span class="name"><span class="tag %s">%s</span>'
                '<a href="%s">%s</a></span>'
                '<span class="size">&mdash;</span>'
                '<span class="raw-link"></span>'
                "</div>"
                % (tag_cls, esc(tag_label), href, esc(display))
            )
        else:
            try:
                size = os.path.getsize(full)
                size_h = _human_size(size)
            except OSError:
                size_h = ""
            abs_url = url_path + quoted
            if _is_previewable(name):
                name_href = VIEW_ROUTE + "?path=" + urllib.parse.quote(abs_url, safe="")
            else:
                name_href = quoted  # direct download
            rows.append(
                '<div class="row">'
                '<span class="name"><span class="tag %s">%s</span>'
                '<a href="%s">%s</a></span>'
                '<span class="size">%s</span>'
                '<a class="raw-link" href="%s" target="_blank" rel="noopener">raw</a>'
                "</div>"
                % (tag_cls, esc(tag_label), name_href, esc(display), size_h, quoted)
            )

    body_rows = "".join(rows) if rows else '<div class="empty">This folder is empty.</div>'

    return """<!DOCTYPE html>
<html lang="en" data-theme="%(theme)s">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="%(color_scheme)s">
<title>%(title)s</title>
<link rel="stylesheet" href="%(route)sapp.css">
</head>
<body>
<div class="dir">
  <div class="dir-head">
    <nav class="dir-title" aria-label="Breadcrumb">%(crumbs)s</nav>
    <div class="dir-actions">
      <a class="btn btn-accent" href="/upload">Upload files</a>
    </div>
  </div>
  <div class="rows">
%(rows)s
  </div>
</div>
</body>
</html>""" % {
        "theme": theme,
        "color_scheme": uploadserver.COLOR_SCHEME.get(theme, "light dark"),
        "title": esc(url_path),
        "route": ASSET_ROUTE,
        "crumbs": crumbs,
        "rows": body_rows,
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
            body = _render_listing(self, path, names).encode("utf-8", "surrogateescape")
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
