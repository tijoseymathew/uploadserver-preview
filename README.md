# uploadserver-preview

An in-browser previewer bolted onto [`uploadserver`](https://github.com/Densaugeo/uploadserver).
Browse a directory over HTTP and click a file to see it **rendered** instead of
downloaded: Markdown as formatted prose, JSON as a collapsible tree, source code
with syntax highlighting and line numbers, CSV/TSV as tables, unified diffs the
way GitHub shows them, and images inline.

Everything renders **client-side with vendored JavaScript** — no build step, no
CDN, no outbound network. It works on an air-gapped LAN, which is where a file
server like this usually lives. Uploads and every other `uploadserver` feature
(basic auth, TLS/mTLS, `--directory`, `--theme`, ...) are untouched.

## Install

```bash
pip install ./uploadserver-preview      # from this folder
# or, once published:
# pip install uploadserver-preview
```

This pulls in `uploadserver` as a dependency. Python 3.9+.

## Use

Exactly like `uploadserver` — same arguments, same behaviour, plus previews:

```bash
uploadserver-preview                 # serve ./ on :8000
uploadserver-preview 9000 -d /srv    # port 9000, serve /srv
uploadserver-preview --theme dark
uploadserver-preview --basic-auth me:secret
python -m uploadserver_preview 8080  # module form also works
```

Then open `http://<host>:8000/`, browse, and click a file. Each row shows a small
type tag (`md`, `json`, `py`, `csv`, …); previewable files open in the viewer,
anything else downloads. Every file also has a **raw** link.

### Flags

All of `uploadserver`'s flags are accepted (`port`, `--directory/-d`,
`--bind/-b`, `--theme`, `--allow-replace`, `--server-certificate/-c`,
`--client-certificate`, `--basic-auth`, `--basic-auth-upload`, `--cgi`), plus:

| Flag | Effect |
|------|--------|
| `--no-preview` | Disable the previewer; behave like plain `uploadserver`. |

`--cgi` also disables the previewer (CGI mode is left to stock `uploadserver`).

## What it renders

| Type | Extensions | Rendered as |
|------|-----------|-------------|
| Markdown | `.md .markdown .mdown .mkd` | Sanitized HTML prose; fenced code highlighted |
| JSON | `.json .geojson .ipynb` | Collapsible tree (falls back to highlighted source if invalid) |
| Config | `.yaml .yml .toml .ini .cfg .conf` | Highlighted source (comments preserved) |
| Code | `.py .js .ts .tsx .rs .go .java .c .cpp .rb .php .lua .sql .sh` and more | Highlighted, line-numbered |
| Tables | `.csv .tsv` | Sortable-width HTML table with row numbers |
| Diffs | `.diff .patch` | Line-by-line diff view |
| Images | `.png .jpg .jpeg .gif .webp .bmp .ico .avif .svg` | Inline, with dimensions |
| Markup | `.html .htm .xml .xhtml` | **Source only** — never executed |

Unrecognized extensions are shown as text when they look textual, and flagged as
binary otherwise. Text rendering is capped at 3 MB and tables at 5,000 rows to
keep the browser responsive; the raw link always serves the full file.

## How it works

`uploadserver` exposes its request handler as a module-level name that
`serve_forever()` resolves at call time. This package subclasses that handler and
swaps it in before serving, so uploads and auth keep working while a few extra
routes are added:

- `GET /__view__?path=…` returns a small static shell. The shell reads `path`
  from the query string on the client, fetches the file same-origin, dispatches
  on extension, and renders it. The server never reflects `path` into HTML.
- `GET /__preview_asset__/<name>` serves the vendored JS/CSS by basename from a
  fixed whitelist (traversal-proof).
- Directory listings are replaced with a richer, themed listing that adds view
  and raw links and the type tags.

Everything else — raw files, `/upload`, redirects — falls through to
`uploadserver` unchanged.

## Security notes

- **Uploaded content is untrusted.** Markdown is sanitized with DOMPurify before
  it touches the DOM. Code, JSON, YAML, CSV, and diffs are escaped or inserted as
  text. HTML/SVG/XML files are shown as **source and never executed**; images are
  loaded via `<img>`, where scripts do not run.
- A strict **Content-Security-Policy** is sent on preview pages: `script-src
  'self'` (all JS is external — there are no inline scripts), `default-src 'self'`,
  `object-src 'none'`. Inline styles are permitted because the JSON component and
  highlight/diff themes rely on them.
- Preview routes and assets are behind the same **basic auth** as the rest of the
  server, so nothing is exposed before authentication.
- This is still a simple file server. Don't expose it to the public internet
  without auth + TLS, exactly as with stock `uploadserver`.

## Offline / vendored assets

All rendering libraries live under `uploadserver_preview/assets/` and are served
locally, so the previewer needs no internet access. Bundled: highlight.js
(common languages + Dockerfile), marked, DOMPurify, PapaParse, diff2html (core),
and `@andypf/json-viewer`. See `LICENSE` for their licenses.

## Limitations

- No preview for PDF or Office documents (they open via the raw link, and modern
  browsers render PDFs natively).
- Diffs are colored by line; intra-line syntax highlighting inside diffs is
  omitted to keep the bundle small.
- CGI mode (`--cgi`) is served by stock `uploadserver` without previews.
