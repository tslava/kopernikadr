# Photo stickers — tablet acceptance run, 2026-10-28

Run by the orchestrator by hand through adb + CDP (not by `remote/e2e/stickers.cdp.mjs`; the script is
written but its first run is still to do). Device: Lenovo TB328FU (HA21J9XT), Unisoc T610, Android 12,
WebView; remote debug build of branch `photo-stickers`. Test movie "Film 3"
(`2e949ac9-32fc-4128-9e5f-c8116396f7fa`), shot from the Mac fake camera (`adb reverse tcp:8765`, manual
address `127.0.0.1:8765`). The kid's "Film 2" was not touched.

## 1. Sources

| Item | Result |
|---|---|
| Gallery picker | PASS. "Z galerii" opens the system PhotoPickerActivity. A transparent PNG goes straight to the style step. A JPEG (2448x3264 portrait toy photo) goes to the cut step with the right orientation. |
| Camera | PASS. "Zrób zdjęcie" opens `com.google.android.apps.cameralite` CaptureActivity; after the shutter the photo shows in the cut step with the right orientation. The photo does not appear in the tablet gallery. |
| Process death | PASS. `am kill` of the app while the camera was in front, then shutter: the app restarts on the projects screen, no crash, the photo is lost (as designed). |

## 2. Cut

- One tap cut out a cable (camera photo) and a red plastic elephant toy cleanly. GPU delegate.
- First run per picture (engine warm-up): 7.9 s, 3.6 s, 7.5 s. Later runs: 0.49-0.53 s.
- "Usuń" brush stroke over the tusk removed the tusk plus part of the head (model granularity); "Cofnij" restored it.

## 3. Styles

"Naklejka" (white outline + shadow) looks right. "Komiks" first showed black blotches on a plush;
fixed in b046e14 (smoothed edges, HSV posterize). After the fix both the plush and the plastic elephant
look like cartoons.

## 4. Save speed

- First measurement: about 10-12 s with PNG. A CPU profile showed the main thread idle.
- Tablet benchmark, 1024x1024 `convertToBlob`: PNG 4.0 s, WebP q0.92 0.34 s (220 KB vs 747 KB),
  WebP q1 1.6 s. base64 3 ms, sha256 2 ms.
- After switching to WebP (1cb61db): save takes 0.62 s; sticker file 45 KB WebP vs 547 KB PNG;
  thumbnail 8.6 KB.

## 5. Library and movie

- Placing a "Moje" sticker copies the file into `projects/<pid>/stickers/`.
- Deleting it from "Moje" (confirm dialog) removes the library files. The movie still renders it after
  an app restart.
- Export (MP4 in Movies/Kopernikadr) contains the sticker with transparency (a frame extracted with ffmpeg).

## 6. Findings

- **Export with a missing sticker file** (an old `.png` from before the WebP switch) fails with "Nie
  udało się wczytać jednej z naklejek. Film nie został zapisany." The missing sticker is invisible on
  the stage (only a selection box on tap and a broken-image chip), so it is hard to find and delete.
  Follow-up for the review.
- UI: the selected style chip is now a check-mark outline, distinct from the orange "Zapisz"; the tile
  x label ("Usuń z „Moje”") is distinct from the edit-tools "Usuń naklejkę".

## 7. Memory

App PSS 125 MB after the segmentation sessions closed; 184 MB after export. (No `meminfo-sampler.sh`
baseline-vs-after table was recorded in this run; the 60 MB target of the plan is not verified
numerically.)

## 8. Not done / left

- First run of `remote/e2e/stickers.cdp.mjs` (written, unit-tested helpers only).
- Cleanup of the test movie "Film 3", its stickers and exports is left to the orchestrator.

## Scripted run (`remote/e2e/stickers.cdp.mjs`)

2026-10-28, same tablet, movie renamed to "Test naklejki". All 6 steps PASS:

| Step | Result |
|---|---|
| 0 safety | "Test naklejki", 4 frames |
| 1 JPEG toy: import → cut → tap | first run 4172 ms |
| 2 erase stroke, Cofnij, Dalej | later run 905 ms |
| 3 Komiks, Zapisz, place | save 694 ms; `my:` sticker placed, movie copy exists |
| 4 delete from "Moje" | library files gone, movie copy and entry intact |
| 5 transparent PNG | alpha → style, saved and removed |
