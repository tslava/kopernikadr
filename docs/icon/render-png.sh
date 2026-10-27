#!/usr/bin/env bash
# Renders the launcher foreground (icon-108.svg without its plum background) to a 648x648 PNG with
# headless Chrome. Launchers that rasterize a sideloaded app's icon at the device density (Google
# Kids Space) upscale a vector foreground and blur it; a large nodpi bitmap keeps it sharp.
# The tablet remote instead ships a square full-bleed 512px legacy icon (mipmap-nodpi): Kids Space
# masks an adaptive icon with a larger corner radius than its own white tile, leaving white corners,
# while a square bitmap gets the tile's radius like the Play-installed apps next to it.
#   docs/icon/render-png.sh  → camera: drawable-nodpi/ic_launcher_foreground_hires.png;
#                              remote: mipmap-nodpi/ic_launcher{,_round}.png
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
tmp="$(mktemp -d)"
python3 - "$here/icon-108.svg" "$tmp/fg.html" <<'PY'
import re, sys
svg = open(sys.argv[1]).read()
fg = re.sub(r'<rect width="108" height="108" fill="#2d1b3d"/>', '', svg, count=1).replace('<svg ', '<svg width="648" height="648" ', 1)
open(sys.argv[2], 'w').write('<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>' + fg + '</body></html>')
PY
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=648,648 --default-background-color=00000000 \
  --screenshot="$tmp/fg.png" "file://$tmp/fg.html" 2>/dev/null
cp "$tmp/fg.png" "$root/camera-android/app/src/main/res/drawable-nodpi/ic_launcher_foreground_hires.png"
python3 - "$here/icon-108.svg" "$tmp/sq.html" <<'PY'
import sys
svg = open(sys.argv[1]).read().replace('viewBox="0 0 108 108"', 'viewBox="18 18 72 72" width="512" height="512"', 1)
open(sys.argv[2], 'w').write('<!doctype html><html><head><style>html,body{margin:0}svg{display:block}</style></head><body>' + svg + '</body></html>')
PY
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=512,512 --screenshot="$tmp/sq.png" "file://$tmp/sq.html" 2>/dev/null
for name in ic_launcher ic_launcher_round; do
  cp "$tmp/sq.png" "$root/remote/android/app/src/main/res/mipmap-nodpi/$name.png"
done
rm -rf "$tmp"
echo "ok"
