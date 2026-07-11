# Regenerating `docs/demo.gif`

The README demo GIF is generated from the live app — re-run this after a UI
change instead of editing the GIF by hand.

```bash
docs/demo/build.sh            # writes docs/demo.gif
docs/demo/build.sh /tmp/x.gif # or a custom output path
```

It starts the server against this repo, screenshots every view with Playwright
(desktop previews, a mobile layout, and an animated launch terminal), and
stitches the frames into a GIF with ffmpeg. All temporary files go to a scratch
dir that is removed on exit.

## Requirements

- `uv`, `node`, `ffmpeg`, `git`
- Playwright + Chromium. If it isn't already on the machine (the script also
  finds an `npx` cache copy), install it once:
  ```bash
  cd docs/demo && npm i -D playwright && npx playwright install chromium
  ```

## Knobs

- `PORT` (default `8791`) — server port used during capture.
- `WIDTH` (default `1200`) — output GIF width in px.

## What gets captured

| Frame | Source |
|-------|--------|
| Launch terminal (typed) | `terminal.html` |
| Markdown / Code / Config / Git diff | the running app, framed by `desktop.html` |
| Hidden-files toggle (off → on) | the explorer's eye toggle, framed by `desktop.html` |
| Theme cycle (README under each theme) | the topbar theme picker, framed by `desktop.html` |
| Mobile explorer + previews | the app at a phone viewport, composed by `showcase.html` |

Edit the captions, timing, or which files are shown in `capture.mjs`; frame
durations live in `build.sh`.

## The git-diff frame

It reflects **your** git state. If a previewable file already has uncommitted
changes, that diff is shown. Otherwise the script makes a throwaway edit to one
source file purely for the screenshot and reverts it on exit — it refuses to
touch a file you already have pending changes in.
