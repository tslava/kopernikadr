# Emulator E2E (plan Task 20)

`flow.cdp.mjs` drives the debug build of the remote in the Android emulator over Chrome DevTools
Protocol (no dependencies, Node >= 22) against `protocol/tools/probe-client/fake-camera.mjs`.
Steps: create a movie, connect, shoot 10, kill the app mid-transfer and relaunch (all 10 local and
acked), dropped capture response, play, export to the gallery, edit (duplicate, hold x3, off, a sticker
with a range) + export again with the gallery file's duration checked against Sum(hold)/fps (+-1 tick,
`ffprobe` on the pulled file, MediaStore `duration` if ffprobe is missing) and `project.json` read via
`run-as`, delete + Undo, delete past the window (all frames acked). It prints `PASS`/`FAIL` per step, then a JSON summary; exit code 1 on any FAIL.

## Run

1. Fake camera on the Mac (the emulator reaches it as `10.0.2.2:8765`):
   `node protocol/tools/probe-client/fake-camera.mjs --port 8765`
   (it listens on 127.0.0.1, which the emulator reaches via 10.0.2.2).
2. Build and install the debug APK, start the app once:
   ```
   cd remote && npm ci && npm run android:debug
   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
   adb shell am start -n pl.slava.kopernikadr.remote/.MainActivity
   ```
3. Forward the WebView devtools socket (pid changes at every launch):
   ```
   PID=$(adb shell pidof pl.slava.kopernikadr.remote)
   adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
   ```
4. Run (from the repo root). `--adb-restart` force-stops and starts the app; `--reforward` redoes
   step 3 after the restart (new pid) and must print nothing:
   ```
   node remote/e2e/flow.cdp.mjs --devtools 9222 --camera http://127.0.0.1:8765 \
     --adb-restart "adb shell 'am force-stop pl.slava.kopernikadr.remote; am start -n pl.slava.kopernikadr.remote/.MainActivity'" \
     --reforward "sh -c 'sleep 4; adb forward tcp:9222 localabstract:webview_devtools_remote_\$(adb shell pidof pl.slava.kopernikadr.remote | tr -d \"\\r\") >/dev/null'"
   ```
   Also pass `--adb "adb -s emulator-5584"` (the adb command used for `run-as` and MediaStore; default `adb`)
   and `--package pl.slava.kopernikadr.remote.debug` (default; the debug build, `run-as` needs it).
   Optional: `--camera-from-app 10.0.2.2:8765` (address typed into the connect view when the app is not online).

## After the run

Step 7 prints the expected MediaStore display name (`kopernikadr-Film_N-<date>.mp4`, also in the
JSON as `expectedGalleryName`). Pull it and check the frame count with ffprobe, e.g.
`adb shell content query --uri content://media/external/video/media --projection _display_name,_data | grep kopernikadr-Film_N`.

## Notes

- Selectors: aria-labels (Polish strings from `lib/i18n/pl.ts`), classes, and `data-testid`:
  `movie-card` (+ `data-project-id`), `frame-count`, `connect-address`.
- Parent long-press buttons (delete) are driven with synthetic `pointerdown`, a 1.8 s wait, `pointerup`.
- "All 10 local" after the relaunch is checked as: UI counter 10 and all 10 acked on the camera
  (the app acks only after the full is local and verified). Use a fresh fake camera or ignore old
  frames: only frames of the movie the script created are counted.
- The unit test of the helpers: `node --test remote/e2e/lib.test.mjs`.

## Photo stickers on the tablet (`stickers.cdp.mjs`)

`stickers.cdp.mjs` drives the photo-sticker flow on a real tablet over CDP: open a movie, select frame 1,
"+ Emoji" -> "Moje" -> "Zrób naklejkę", import via the debug hook `__testImportImage` (the script redirects the
plugin's `pickImage` to it, so the "Z galerii" button is the real UI path), cut (tap the toy, wait for
"Chwilka…" to go; the first run per picture takes up to about 10 s), "Usuń" brush stroke, "Cofnij", "Dalej",
"Komiks", "Zapisz", place the new "Moje" tile, assert `project.json` has a `my:<uuid>` sticker and
`projects/<id>/stickers/<uuid>.webp` exists, then delete the tile from "Moje" (tile x + confirm) and assert
the library file is gone while the movie copy and the `project.json` entry stay. With `--png` it also checks
that a transparent PNG goes straight to the style step (and removes the sticker it made).

Safety: `--project <uuid>` is mandatory (no movie is ever picked automatically) and the script refuses to
run unless that movie's name starts with "Test".

```
adb -s <serial> push toy.jpg /sdcard/Download/toy.jpg
adb -s <serial> push alpha.png /sdcard/Download/alpha.png      # optional
adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_$(adb -s <serial> shell pidof pl.slava.kopernikadr.remote.debug | tr -d '\r')
node remote/e2e/stickers.cdp.mjs --devtools 9222 --adb "adb -s <serial>" --project <uuid of a Test movie> \
  --photo /sdcard/Download/toy.jpg --toy 0.5,0.55 [--png /sdcard/Download/alpha.png] [--package pl.slava.kopernikadr.remote.debug]
```

`--toy x,y` is the toy's centre as fractions (0..1) of the cut image. Needs a debug build (the hook exists
only there) and a Test movie with at least one frame. Remove the pushed files afterwards.
