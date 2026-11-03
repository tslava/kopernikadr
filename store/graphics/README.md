# Play graphics

- `icon-512.png`: the Play icon for both apps, a copy of `remote/android/app/src/main/res/mipmap-nodpi/ic_launcher.png`
  (square full-bleed; Play applies its own mask). Regenerate the source with `docs/icon/render-png.sh`.
- `feature-remote.png` and `feature-camera.png`: 1024x500 feature graphics. They are language-neutral (only the name).
  Render them from `src/` with:

  ```sh
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1024,500 \
    --screenshot=store/graphics/feature-remote.png "file://$PWD/store/graphics/src/feature-remote.html"
  ```
- Screenshots: `screens/` (tablet for the remote, phone for the camera). Use Test movies only, never the kid's films.
