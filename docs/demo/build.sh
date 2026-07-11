#!/usr/bin/env bash
#
# Re-record and rebuild docs/demo.gif from the live app.
#
#   docs/demo/build.sh [output.gif]
#
# Starts the server against this repo, screenshots every view (desktop +
# mobile + an animated launch terminal) with Playwright, and stitches the
# frames into an animated GIF with ffmpeg. Everything temporary lands in a
# scratch dir that is removed on exit.
#
# The git-diff frame uses your real git state: if a previewable file already
# has uncommitted changes it is shown as-is; otherwise a throwaway edit is
# made to one source file and reverted on exit (never touches a file you have
# pending changes in).
#
# Requires: uv, node, ffmpeg, and Playwright + Chromium. If Playwright is not
# already available (e.g. via `npx playwright`), install it once with:
#   npm i -D playwright && npx playwright install chromium   # in docs/demo/
#
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$DEMO_DIR" rev-parse --show-toplevel)"
cd "$ROOT"

OUT_GIF="${1:-$ROOT/docs/demo.gif}"
PORT="${PORT:-8791}"
WIDTH="${WIDTH:-1200}"

# --- preflight ---------------------------------------------------------------
for tool in uv node ffmpeg git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found on PATH" >&2; exit 1; }
done

# Locate Playwright: local install, node resolution, then the npx cache.
PW=""
if [ -f "$DEMO_DIR/node_modules/playwright/index.js" ]; then
  PW="$DEMO_DIR/node_modules/playwright/index.js"
fi
if [ -z "$PW" ]; then
  PW="$(node -e "try{process.stdout.write(require.resolve('playwright'))}catch(e){}" 2>/dev/null || true)"
fi
if [ -z "$PW" ]; then
  PW="$(ls -d "$HOME"/.npm/_npx/*/node_modules/playwright/index.js 2>/dev/null | head -1 || true)"
fi
if [ -z "$PW" ]; then
  echo "error: Playwright not found. Install it once:" >&2
  echo "  (cd '$DEMO_DIR' && npm i -D playwright && npx playwright install chromium)" >&2
  exit 1
fi
export PW_MODULE="file://$PW"

WORK="$(mktemp -d)"
SERVER_PID=""
REVERT_FILE=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$REVERT_FILE" ] && git checkout -- "$REVERT_FILE" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- pick the file for the git-diff frame ------------------------------------
# Prefer an already-changed previewable file (shows your real edit); otherwise
# inject a temporary edit into a clean source file and revert it on exit.
PREVIEWABLE='\.(md|markdown|json|ya?ml|toml|ini|cfg|conf|csv|tsv|diff|patch|py|js|ts|tsx|jsx|sh|go|rs|c|h|cpp|rb|php|lua|sql|css|html?|xml)$'
DIFF_FILE="$(git diff --name-only --diff-filter=ACMR | grep -iE "$PREVIEWABLE" | head -1 || true)"

if [ -z "$DIFF_FILE" ]; then
  DIFF_FILE="uploadserver_preview/gitinfo.py"
  if ! git diff --quiet -- "$DIFF_FILE"; then
    echo "error: $DIFF_FILE has uncommitted changes; commit/stash or pass a changed file" >&2
    exit 1
  fi
  echo "note: injecting a throwaway edit into $DIFF_FILE for the diff frame"
  python3 - "$DIFF_FILE" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text(); orig = s
s = re.sub(r'_GIT_TIMEOUT = \d+[^\n]*',
           '_GIT_TIMEOUT = 8           # seconds; a cold-cache repo on a slow disk can lag',
           s, count=1)
s = re.sub(r'(_SHORTSTAT_RE = re\.compile\([^\n]*\)\n)',
           r'\1\n# A tiny cache so repeated listings in the same directory don\'t re-shell to git.\n_HEAD_CACHE = {}\n',
           s, count=1)
if s == orig:  # fallback so the frame always has a diff
    s = orig + "\n\n# demo: illustrate the git diff view\n_DEMO_MARKER = True\n"
p.write_text(s)
PY
  REVERT_FILE="$DIFF_FILE"
fi
export DIFF_URLPATH="/$DIFF_FILE"
echo "diff frame: $DIFF_URLPATH"

# --- start the server --------------------------------------------------------
uv run uploadserver-preview "$PORT" -d "$ROOT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
BASE="http://127.0.0.1:$PORT"
export BASE OUT="$WORK"

echo "waiting for $BASE ..."
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "$BASE/"; then ready=1; break; fi
  sleep 0.2
done
[ "${ready:-}" = 1 ] || { echo "error: server did not come up" >&2; cat "$WORK/server.log" >&2; exit 1; }

# --- capture -----------------------------------------------------------------
cp "$DEMO_DIR"/terminal.html "$DEMO_DIR"/desktop.html "$DEMO_DIR"/showcase.html "$WORK/"
node "$DEMO_DIR/capture.mjs"

# --- assemble the GIF --------------------------------------------------------
CONCAT="$WORK/concat.txt"
{
  emit() { printf "file '%s'\nduration %s\n" "$WORK/$1" "$2"; }
  emit term-00.png 0.55
  for i in 01 02 03 04 05 06 07 08 09 10 11 12; do emit "term-$i.png" 0.08; done
  emit term-13.png 0.7
  emit term-14.png 2.8
  emit d-markdown.png 2.6
  emit d-code.png 2.5
  emit d-config.png 2.4
  emit d-diff.png 2.7
  emit d-hidden-off.png 1.9
  emit d-hidden-on.png 2.4
  emit d-theme-open.png 2.0
  emit d-theme-dark.png 0.9
  emit d-theme-light.png 0.9
  emit d-theme-catppuccin.png 0.9
  emit d-theme-tokyonight.png 0.9
  emit d-theme-gruvbox.png 0.9
  emit d-theme-everforest.png 1.8
  emit mobile-1.png 3.0
  emit mobile-2.png 3.0
  printf "file '%s'\n" "$WORK/mobile-2.png"   # concat quirk: last frame needs no duration
} > "$CONCAT"

PALETTE="$WORK/palette.png"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$CONCAT" \
  -vf "scale=$WIDTH:-1:flags=lanczos,palettegen=stats_mode=diff" "$PALETTE"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$CONCAT" -i "$PALETTE" \
  -lavfi "scale=$WIDTH:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" "$OUT_GIF"

SIZE="$(du -h "$OUT_GIF" | cut -f1)"
echo "wrote $OUT_GIF ($SIZE)"
