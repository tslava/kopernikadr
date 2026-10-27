# Stage 3a + emoji — emulator acceptance run, 2026-10-27

**The real tablet (TB328FU) and the real Pixel / phone run is still to do tomorrow.** Neither was
connected today. Everything below ran on the Android 12 emulator `emulator-5584` (a TB328FU twin:
1920x1200, density 240, CSS viewport 1280x728, dpr 1.5), with the remote debug app
`pl.slava.kopernikadr.remote.debug` built from this branch, real `adb input` touches (no synthetic
JS clicks for the checks that matter) and the fake camera (`10.0.2.2:8765`). Screencaps are in the
session scratchpad (`acc-*.png`), not committed.

## 1. Overview items on the emulator

| Item | Result |
|---|---|
| Frame strip, view a frame big | PASS. Tap a tile selects it (stage shows it); a second tap opens the full-screen big view; a tap closes it. 500-frame strip is virtualised (about 15-19 tiles in the DOM). |
| Duplicate | PASS. `cut` gets a new entry right after the source (same frame, hold). |
| Hold (Dluzej / Krocej) | PASS. hold 1 -> 2; the tile shows "x2"; Krocej is disabled at 1. |
| Move (Wczesniej / Pozniej) | PASS. entry order in `cut` changes, frame files untouched. |
| Turn off (Wylacz) | PASS. entry gets `off: true`, tile is grey; Cofnij turns it back. No file touched. |
| Trim (Od tego / Do tego) | PASS. Od tego on frame 2 turned frame 1 off; Do tego on frame 7 turned frame 8 off. Two Cofnij restored both. |
| Delete + Undo | PASS. Usun on the last entry of a frame shows "Cofnij (n s)"; tapping it inside the window brought the frame back (8 tiles again). Past the window: gone, ack after expiry (flow step 10, 11/11 acked). |
| Undo edits (Cofnij) | PASS. 7 Cofnij taps walked the history back one edit at a time (off, move, hold, duplicate). |
| Sticker: place | PASS. + Emoji, picker, pick: dog placed at the centre, size 0.25, on the selected frame. |
| Sticker: move | PASS. swipe from the centre moved it from (0.50, 0.50) to (0.30, 0.29). |
| Sticker: resize + rotate | PASS. one drag on the handle: size 0.25 -> 0.40 and rot 0 -> -4.4 degrees. |
| Sticker range | PASS. Naklejka od/do tego kadru changed `on` (blue bar under the tiles); sticker visible only on those frames in playback (5 screencaps in a row, `acc-27-play-strip.png`). |
| Same renderer in playback and export | PASS. Edited movie (12 entries, 1 off, hold 4, sticker on 5 entries) exported with duration 1.750 s = sum(hold)/fps within one tick (`remote/e2e/flow.cdp.mjs` step 8, ffprobe). |
| Tablet parent: quarantine show / clear + O aplikacji | PASS. Hold on the wrench 3.3 s: "Kwarantanna zdjec" showed "2 pliki, 4 MB"; Wyczysc -> confirm -> Usun: "Usunieto 2 pliki", directory empty on disk. "O aplikacji" shows the OpenMoji CC BY-SA 4.0 attribution. |
| Phone: 7-day reclaim | PASS (Task 11 run, same code, same emulator, not repeated): one acked frame backdated 8 days, restart logged "age reclaim 1 frame", files gone + 404, the other acked and the unacked frames intact. |
| Phone: ScreenPolicy dim | PASS (Task 12 run, same code): waiting card no dim; session open + 15 s idle with the preview running dims, preview alone does not undim, a capture brightens. Not repeated today. |
| Phone: quarantine show / clear (parent) | PASS (Task 13 run) and spot-checked today: the phone parent screen (3 s hold on the title) shows the Kwarantanna card, "Usunieto: 2", Diagnostyka and Zamknij (`acc-50-phone-home.png`). |

Full E2E (`remote/e2e/flow.cdp.mjs`, 10 steps incl. edit + sticker + export and delete past the Undo
window) was re-run on this build: 10/10 PASS.

## 2. 500-frame project (ARCHITECTURE section 8 acceptance)

Seeded project "Test 500": 500 local frames copied from one real frame of Film 2 (full 1.87 MB, play
239 KB, thumb 11 KB, so about 1 GB on the emulator), unique ULID-like ids, `bytes`/`sha256` of the
copied file, fps 8. Sampled with `scripts/meminfo-sampler.sh --serial emulator-5584 --package
pl.slava.kopernikadr.remote.debug` (app PSS + WebView renderer PSS, 1 s).

| Phase | App PSS | Renderer PSS | Total |
|---|---|---|---|
| project list, idle (first samples) | 102 MB | 106 MB | 208 MB (settles to about 272 MB with the WebView warm) |
| 500-frame play view open | 105 MB | 165 MB | 271 MB |
| strip scrolled end to end (about 160 adb swipes, 0 -> 58776 of 59992 px) | peak 118 MB | peak 180 MB | peak 298 MB |
| play 30 s from the start (8 fps) | peak 151 MB | peak 195 MB | peak 330 MB |
| export 500 frames, 2 stickers (about 28 s, 62.5 s mp4 = 500 / 8 fps) | peak 188 MB | peak 302 MB | **peak 463 MB** (the run's overall peak) |
| play 120 s with loop after the export (8 fps) | 170 MB flat | 270 MB flat | 436-441 MB flat from 30 s to 120 s |

- Strip: scrolls end to end with fling swipes without a frame count growing (tiles in the DOM stay at
  15-19); no jank measured, only eyeballed through screencaps (not a frame-time measurement).
- Playback memory is flat: 30 s to 120 s of looped playback moves the total by 5 MB (436 -> 441 -> 436).
  The first 30 s climb is the ring/LRU filling (app PSS 106 -> 150-170 MB); it drops back to 110 MB
  after pause when nothing else is going on.
- Export with 2 stickers finished (kopernikadr-Test_500-2026-10-27.mp4, MediaStore duration 62500 ms).
  After the export the renderer stays at about 270 MB instead of returning to about 180 MB (retained
  encoder / GC), flat afterwards.
- The seeded project was deleted through the app (Usun film, confirm); `projects/` is back to 3
  directories, 1 GB reclaimed. The exported mp4 and the temp seed files were removed with adb.
- This is an emulator number (software H.264, no real GPU); the real tablet figure is still to measure.

## 3. A project without `cut` / `stickers` behaves as before

PASS. Film 1 (9 local frames, shot before the stage, no `cut` and no `stickers` keys) opens, strip
shows 9 tiles with no sticker marks, plays all 9 frames, and `project.json` still has neither key
after opening and playing (nothing writes until an edit). Covered by unit tests (`timeline()` for a
project with no `cut`).

## 4. Downgrade caveat

Documented, not fixed: ARCHITECTURE section 5.4 now has the note. An older app opens a project file
with `cut` / `stickers`, ignores them, and its first write drops them (frames and files untouched).
Not run on a device: it needs the old APK.

## 5. Ack eligibility unchanged

PASS. `eligibility.ts`, `sweep.ts` and the transfer code are untouched on this branch (git diff
against main), `FrameDeletion` is the only expiry path. New tests (this task):
`frameDeletion.test.ts` "off and trim never tombstone, unlink or ack" (all entries off, 60 s later:
no tombstone, no unlink, no ack, frames still ack-eligible as `local`), `sweep.test.ts` "frames that
are off (trimmed) are live" (startup sweep keeps all files of an off frame, no tombstone). On the
emulator: Film 2 keeps all its files with entries turned off, and delete past the Undo window ->
tombstone -> 11/11 acked (flow step 10).

## 6. Full suites

| Suite | Result |
|---|---|
| `cd remote && npm test` (vitest) | 61 files, 752 tests passed (750 before this task + 2 new) |
| `cd remote && npm run typecheck` | clean |
| `cd remote && npm run test:scripts` | 5 passed |
| `camera-android ./gradlew-jbr :core:test :app:testDebugUnitTest` | core 446 + app 15, 0 failures |
| remote android build (`npm run android:debug`) | BUILD SUCCESSFUL, installed on the emulator |
| `packages/remote-core` (`npm test`) | 42 passed |
| `protocol/tools/probe-client` (`npm test`) | 45 passed |
| remote-lite (`camera-android/core/src/test/remote-lite`, `node --test`) | 28 passed |
| `scripts/test/run.sh` | 36 passed, 0 failed |
| `remote/e2e/lib.test.mjs` | 7 passed (Task 14) |

## Observations (not fixed, for the backlog)

- Some fast synthetic swipes that start on a tile are taken as a tap (selected a tile and, on the
  selected one, opened the big view) during the end-to-end strip scroll. adb `input swipe` with a 120 ms
  duration is harsher than a finger, so this may not reproduce by hand; to check on the real tablet.
- "Od poczatku" resets the play head to frame 1 but leaves the selected tile where it was, so the
  stage and the selection can disagree (stage shows frame 1, tools act on the selected tile).
- The sticker selection outline and handle stay drawn while playing.
- A programmatic `click()` on the export button from the CDP script did not open the dialog while a
  real touch on it did; likely the script's selector, not the app.

## Still to do tomorrow (real devices)

- Run the Overview list on the real tablet and the Pixel / phone with agent-run touch scripts, and
  attach screencaps (`docs/diagnostics/<date>-stage3a-tablet.md`).
- Re-measure the 500-frame memory and strip smoothness on the real tablet.
- Real phone: confirm the 7-day reclaim wording and the dim timing by hand.
