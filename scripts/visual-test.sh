#!/usr/bin/env bash
#
# Visual test: render index.html headlessly at a spread of desktop (and one
# mobile) viewport sizes so layout changes can be eyeballed after each edit.
#
# Output goes to ./.screenshots (gitignored), wiped at the start of every run.
# Open that folder to inspect the PNGs.
#
# Usage:
#   bash scripts/visual-test.sh                 # default size spread
#   bash scripts/visual-test.sh 1280x720 1920x1080   # only these sizes
#   BROWSER="/path/to/chrome" bash scripts/visual-test.sh   # force a browser
#
set -euo pipefail

# Repo root (this script lives in scripts/).
cd "$(dirname "$0")/.."

OUT=".screenshots"
PROFILE="$OUT/.chrome-profile"

# --- locate a Chromium-based browser (Edge or Chrome) -----------------------
find_browser() {
  if [ -n "${BROWSER:-}" ]; then echo "$BROWSER"; return 0; fi
  local candidates=(
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe"
    "/c/Program Files/Google/Chrome/Application/chrome.exe"
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
    "/usr/bin/google-chrome"
    "/usr/bin/chromium"
    "/usr/bin/chromium-browser"
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -f "$c" ] || [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

if ! BROWSER_BIN="$(find_browser)"; then
  echo "error: no Chrome/Edge found. Set BROWSER=/path/to/chrome and retry." >&2
  exit 1
fi

# --- file:// URL to the app (handle Windows paths via cygpath) ---------------
if command -v cygpath >/dev/null 2>&1; then
  URL="file:///$(cygpath -m "$PWD/index.html")"
else
  URL="file://$PWD/index.html"
fi

# Chromium on Windows only honours absolute, native paths for --screenshot and
# --user-data-dir (a relative path silently writes nothing). Convert when we can.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi
}

# --- viewport sizes (override by passing WxH args) --------------------------
# Note: headless Chromium/Edge enforces a ~500px minimum window width. Requesting
# a narrower width (e.g. 390) still lays out at ~476px CSS but writes the image at
# the requested width, cropping the right edge — a screenshot artifact, not a real
# overflow. So the mobile entry uses 500 (the smallest width it renders honestly);
# to eyeball true phone widths, use a real browser's responsive mode.
if [ "$#" -gt 0 ]; then
  SIZES=("$@")
else
  SIZES=(1280x720 1366x768 1440x900 1536x864 1600x900 1920x1080 2560x1440 500x900)
fi

# --- fresh output dir -------------------------------------------------------
rm -rf "$OUT"
mkdir -p "$PROFILE"

echo "browser: $BROWSER_BIN"
echo "url:     $URL"
echo "output:  $OUT/"
PROFILE_WIN="$(winpath "$PWD/$PROFILE")"
for s in "${SIZES[@]}"; do
  w="${s%x*}"; h="${s#*x}"
  "$BROWSER_BIN" \
    --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --user-data-dir="$PROFILE_WIN" \
    --virtual-time-budget=3500 \
    --screenshot="$(winpath "$PWD/$OUT/$s.png")" \
    --window-size="$w,$h" \
    "$URL" >/dev/null 2>&1 || echo "  ! failed: $s" >&2
  [ -f "$OUT/$s.png" ] && echo "  $s -> $OUT/$s.png"
done

rm -rf "$PROFILE"
echo "done."
