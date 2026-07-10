# uploadserver-preview

An in-browser file explorer and previewer bolted onto
[`uploadserver`](https://github.com/Densaugeo/uploadserver). Browse a directory
over HTTP in a persistent file-tree, click a file, and see it **rendered**
instead of downloaded: Markdown as prose, JSON as a collapsible tree, source
code with syntax highlighting, CSV/TSV as tables, unified diffs GitHub-style,
and images inline.

Everything renders **client-side with vendored JavaScript** — no build step, no
CDN, no outbound network. It works on an air-gapped LAN, which is where a file
server like this usually lives. Uploads and every other `uploadserver` feature
(basic auth, TLS/mTLS, `--directory`, `--theme`, …) are untouched.

## Install

Published on PyPI as [`uploadserver-preview`](https://pypi.org/project/uploadserver-preview/).

With [`uv`](https://docs.astral.sh/uv/) (no separate install step):

```bash
uvx uploadserver-preview             # run once, in an ephemeral environment
uvx uploadserver-preview 9000 -d /srv
```

Or install it properly, with `uv` or `pip`:

```bash
uv tool install uploadserver-preview
pip install uploadserver-preview
```

This pulls in `uploadserver` as a dependency. Python 3.9+.

## Use

Exactly like `uploadserver` — same arguments, same behaviour, plus the explorer:

```bash
uploadserver-preview                 # serve ./ on :8000
uploadserver-preview 9000 -d /srv    # port 9000, serve /srv
uploadserver-preview --theme dark
uploadserver-preview --basic-auth me:secret
python -m uploadserver_preview 8080  # module form also works
```

Open `http://<host>:8000/` and you get a two-pane explorer: a file-tree on the
left (folders expand in place, a coloured glyph marks each file's kind, an eye
toggle reveals hidden and git-ignored files) and a preview pane on the right.
Previewable files open in the pane; anything else downloads. Every file has a
**download** link, and the pane's toggle switches between **Rendered** and
**Raw**.

Navigating a browser straight to a file's URL opens it in the explorer too;
`curl`/`wget`, `fetch()`, and any URL with `?raw` still get the raw bytes, so
scripted downloads behave like stock `uploadserver`.

**Uploads.** Drag files anywhere onto the page (or use the Upload button) and
they land in the folder you're browsing, not just the served root.

**Git.** When you browse inside a git work tree, a branch chip appears and you
can compare the working tree against a base branch: changed files are marked in
the tree, and any file with changes gains a **Diff** view. Read-only git
commands only; outside a repo these surfaces simply don't show.

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
| Config | `.yaml .yml .toml .ini .cfg .conf` | Highlighted source |
| Code | `.py .js .ts .tsx .rs .go .java .c .cpp .rb .php .lua .sql .sh` and more | Highlighted, line-numbered |
| Tables | `.csv .tsv` | HTML table with row numbers |
| Diffs | `.diff .patch` | Line-by-line diff view |
| Images | `.png .jpg .jpeg .gif .webp .bmp .ico .avif .svg` | Inline, with dimensions |
| Markup | `.html .htm .xml .xhtml` | **Source only** — never executed |

Unrecognized extensions are shown as text when they look textual, and flagged as
binary otherwise. Text rendering is capped at 3 MB and tables at 5,000 rows to
keep the browser responsive; the raw link always serves the full file.

## Security notes

- **Uploaded content is untrusted.** Markdown is sanitized with DOMPurify before
  it touches the DOM. Code, JSON, YAML, CSV, and diffs are escaped or inserted as
  text. HTML/SVG/XML files are shown as **source and never executed**; images are
  loaded via `<img>`, where scripts do not run.
- A strict **Content-Security-Policy** is sent on preview pages (`default-src
  'self'`, `script-src 'self'` — all JS is external, no inline scripts —
  `object-src 'none'`). Inline styles are permitted because the JSON component
  and the highlight/diff themes rely on them.
- Preview routes, assets, and uploads are behind the same **basic auth** as the
  rest of the server, so nothing is exposed before authentication.
- Git integration runs **read-only** git commands only, scoped to the served
  directory; the compare base is validated against the repo's real branch list.
- This is still a simple file server. Don't expose it to the public internet
  without auth + TLS, exactly as with stock `uploadserver`.

## Offline / vendored assets

All rendering libraries live under `uploadserver_preview/assets/` and are served
locally, so the previewer needs no internet access. Bundled: highlight.js,
marked, DOMPurify, PapaParse, diff2html, and `@andypf/json-viewer`. See
`LICENSE` for their licenses.

## Limitations

- No preview for PDF or Office documents (they open via the raw link; modern
  browsers render PDFs natively).
- Diffs are colored by line; intra-line syntax highlighting is omitted.
- CGI mode (`--cgi`) is served by stock `uploadserver` without previews.
</content>
</invoke>
