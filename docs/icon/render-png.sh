#!/usr/bin/env bash
# Renders the launcher foreground (icon-108.svg without its plum background) to a 648x648 PNG with
# headless Chrome. Launchers that rasterize a sideloaded app's icon at the device density (Google
# Kids Space) upscale a vector foreground and blur it; a large nodpi bitmap keeps it sharp.
#   docs/icon/render-png.sh  → writes drawable-nodpi/ic_launcher_foreground_hires.png in both apps
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
for app in remote/android/app camera-android/app; do
  mkdir -p "$root/$app/src/main/res/drawable-nodpi"
  cp "$tmp/fg.png" "$root/$app/src/main/res/drawable-nodpi/ic_launcher_foreground_hires.png"
done
rm -rf "$tmp"
echo "ok"
