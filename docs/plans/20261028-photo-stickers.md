# "Zrób naklejkę": stickers from a photo of a toy

Rev 2 (2026-10-28): revised after the auto plan review.
- **Export.** Export stays fail-loud for missing sprites.
- **Sweep.** No sweep GC of the movies' sticker copies.
- **Camera and picker results:** an activity-result and process-death policy, plus a `NO_APP` error.
- **Segmenter:**
  - its own executor;
  - a GPU-crash marker;
  - a raw mask instead of a PNG;
  - session files deleted by the session itself (the JS sweep already empties `tmp/`).
- **Files.** Binary writes go via `tmp/` plus the existing `installFile`.
- **Model:** a Gradle check of the model and a cache outside the repo.
- **Builds:**
  - arm64 only (the emulator is arm64 too);
  - a transitive dependency audit.
- **Tests:** JVM tests only for pure logic; the device flow in `flow.cdp.mjs` with a debug import hook.
- **Library and ids:** small thumbnails for "Moje"; `my:<uuid>` ids.
- **Order.** The PNG-with-transparency path (Hello Kitty/Stitch) comes first, before any MediaPipe work.

## Overview
The kid photographs a toy with the tablet camera or picks a picture from the tablet gallery. She taps or
draws a stroke over the toy, and the tablet cuts it out on the device. She fixes the edge with "Dodaj"
and "Usuń" brushes, picks a style, and saves it. The result is a sticker in a new **"Moje"** tab of the
emoji picker. From there it works exactly like an OpenMoji sticker:
- place, move, resize, rotate;
- show it on a range of frames;
- the same canvas renderer draws it in playback and in export.

A ready PNG/WebP with transparency, such as a Hello Kitty or Stitch picture the parent downloaded,
skips the cut-out step and goes straight to the style step.

**Owner decisions (2026-10-28):**
- **Cut-out.** On the device with MediaPipe Interactive Segmenter. No cloud, no network.
- **Styles in this plan.** "Naklejka" (white die-cut outline and a drop shadow, the default) and
  "Komiks" (fewer colours and a dark outline). "Pufy" (puffy) and "Błysk" (shiny) come later.
- **Sources in this plan.** The tablet camera (system camera app) and the tablet gallery (photos and
  PNG/WebP). Picking a frame of the movie comes later.
- **Storage.** A sticker library on the tablet, `stickers/`. When a sticker is placed in a movie, its
  WebP is **copied into the movie folder**. Deleting a sticker from "Moje" never breaks a movie.
- **Not in the repo.** Custom stickers stay only on the tablet. Character art (Sanrio, Disney) is
  never committed.

**Not in this plan:**
- cloud "draw it as a cartoon";
- "Pufy" and "Błysk" styles;
- a movie frame as the source;
- "get into the cartoon" (selfie segmentation);
- hand-in-frame warning;
- clap-to-shoot.

These go to `docs/ROADMAP.md`.

**Protocol:** PROTOCOL v1 and the camera app are unchanged. This is tablet-only.

## Context (from discovery)
- **Spike** (2026-10-28, real TB328FU: Unisoc T610, API 31, arm64-v8a). Code is at
  `/private/tmp/claude-501/-Users-ts-projects-sandbox-kopernikadr/51f83c27-23d4-43fc-9442-9c84bea9a31f/scratchpad/segspike`
  (`app/src/main/java/spike/Main.kt`).
  - **API.** `com.google.mediapipe:tasks-vision:1.1.1` (released 2026-10-14) uses the **new stroke
    API**: `InteractiveSegmenter.createFromOptions(ctx, options)`, then `setImage(MPImage)`, then
    `segment(List<Stroke>)`, which returns an `MPImage` float confidence mask the size of the input.
    - Each `Stroke` has a `BrushMode` (`POSITIVE` / `NEGATIVE` / `LASSO`), a list of
      `NormalizedKeypoint` points, and `completed`.
    - The old ROI API is now `interactivesegmenterlegacy.InteractiveSegmenterLegacy`, and its
      `magic_touch.tflite` gave garbage on our frames. **Do not use it.**
  - **Model.** `https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task`
    (30 525 312 bytes, an encoder plus a decoder in a zip).
  - **Speed** at a 1024 px long side:
    - GPU: first `segment` 3.3–7 s (warm-up), then ~0.4 s.
    - CPU: ~1.8–2.1 s per call.
    - Decoding and downscaling the 3264×2448 tablet photo: ~0.2 s.
  - **Quality:**
    - A single tap cut out 3D toys cleanly: the fox from "Film 2", a plush elephant and a plastic
      elephant on a wooden table.
    - A flat cardboard tree with a single tap selected the whole sheet; a short stroke over it fixed it.
    - The plastic elephant kept a small patch of table between trunk and body, which needs an erase stroke.
  - **APK size.** arm64 adds ~14 MB of `libmediapipe_tasks_jni.so` plus the 30 MB model, which is
    stored uncompressed (to be verified for `.task`; the spike only had `noCompress "tflite"`).
  - **Outline without AI.** A chamfer distance transform of the alpha, a white fill where distance ≤ r,
    and an offset translucent shadow (spike `write()`).
- **Stickers today:**
  - `remote/lib/projects/model.ts:40`: `Sticker {id, emoji: hexcode, x, y, size, rot, on}`.
    `parseStickers` is lenient (it drops bad entries). `store.ts` keeps the original as
    `project.json.corrupt-<ts>` when edits are dropped.
  - Ids come from `crypto.randomUUID()`; there is no ULID generator in `remote/`.
- **Rendering:**
  - `remote/lib/render/sprites.ts`: `SpriteCache` keyed by `emoji@bucket`, `load`/`preload` call
    `spriteUrl(hexcode)` internally. `rasterizeSvg` draws any `<img>`-loadable URL (PNG too) into a
    square bucket. There is a negative cache.
  - **`preload` rejects if any sprite fails.** `projectExport.ts` turns that into `SpriteLoadError`
    and fails the export on purpose. Only playback (`PlayView.tsx` ~99–114) skips an unknown sprite.
- **Picker:** `remote/components/EmojiPicker.tsx`, categories from `public/openmoji/catalog.json`,
  `onPick(hexcode)`.
- **Files:**
  - `remote/lib/projects/files.ts` `FileAdapter` is text-only (small JSON) and has no binary write or
    copy.
  - ARCHITECTURE §5.4: images never pass through `Filesystem.readFile/writeFile`.
  - The only binary paths are the native `installFile(tmp, dest, bytes, sha256)` (atomic, verified
    rename) and `videoWriteAt`.
  - `remote/lib/projects/sweep.ts` empties **all of `tmp/`** on every start, before the UI.
  - Frame file URLs: `resolveFrameBaseUri()` + `Capacitor.convertFileSrc` (`remote/lib/app/frames.ts`).
- **Native plugin** (`remote/android/app/src/main/java/pl/slava/kopernikadr/remote/native/`):
  - `KopernikadrNativePlugin.kt` adapts `PluginCall` to `BridgeArgs` and calls `NativeApi.kt`, which
    is JVM-testable. All methods run on **one shared single-thread executor**.
  - There is no `startActivityForResult` usage yet.
  - The FileProvider (`${applicationId}.fileprovider`, `cache-path .`) already exists.
  - JVM tests have no Robolectric, so `org.json`, `Bitmap`, `BitmapFactory` and `ExifInterface` are
    stubs there.
- **Builds:**
  - Build paths: `scripts/build.sh`, `npm run android:debug`, `remote/android/gradlew-jbr`, Android
    Studio.
  - Dependencies must be stable, at least 14 days old and pinned, and are recorded in `remote/VERSIONS.md`.
  - The Mac is arm64. The emulator `kopernikadr-tab` (`emulator-5584`) is an arm64-v8a API 31 image.
- **Tests:**
  - `cd remote && npm test` (vitest);
  - `npm run test:scripts`;
  - `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - the device flow `remote/e2e/flow.cdp.mjs` (helpers unit-tested by `e2e/lib.test.mjs`);
  - memory with `scripts/meminfo-sampler.sh`.

## Development Approach
- **testing approach**: Regular (code first, then tests), as in 3a.
- Complete each task fully before moving to the next. Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task. Tests cover
  success and error cases.
- **CRITICAL: all tests must pass before starting next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- **Backward compatibility.** project.json stays v1.
  - The 3a app plays a movie with `my:` stickers (an unknown sprite is skipped) but **fails to export**
    it (`SpriteLoadError`).
  - Document this in the ARCHITECTURE §5.4 downgrade caveat. It is fine because there is only one
    tablet and it gets the new build.
- **Kid's data:**
  - Never touch the real g05 phone (ZT322XLJ6J).
  - On the tablet (HA21J9XT), never edit or delete "Film 2" or any project the agent did not create.
  - Test on the tablet only, in a test movie created by the agent.

## Testing Strategy
- **Unit (vitest):**
  - stickerize image ops on small synthetic `ImageData`;
  - library store;
  - model parsing and id validation;
  - copy-on-place;
  - sprite URL resolution;
  - export with custom stickers.
- **JVM (Android), pure logic only:**
  - stroke validation (after the adapter turned `JSONArray` into plain lists);
  - target-size math;
  - the session state machine with a fake engine (open / run / close / idle / GPU→CPU marker);
  - the raw mask byte layout;
  - the image-import copy with a byte cap over fake streams;
  - activity-result mapping (OK / cancel / 0-byte / no app / null call).

  No Robolectric.
- **Device e2e** (`flow.cdp.mjs` or a new `stickers.cdp.mjs`), **on the real tablet only** (owner,
  2026-10-28: no emulator for this plan):
  - a debug-only `__testImportImage({path})` hook replaces the system picker for scripted runs;
  - the real camera and picker intents, driven with `adb shell uiautomator dump` plus `input tap`;
  - the orchestrator also taps through the UI by hand (adb input + CDP);
  - memory with `scripts/meminfo-sampler.sh`.
- **Review:** one Codex review of the whole branch at the end (owner, 2026-10-28).

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues and blockers with ⚠️ prefix.
- Keep the plan in sync with the actual work.

## Solution Overview
1. **The native side does only what needs native code:**
   - take a photo;
   - pick an image;
   - decode it with EXIF orientation and downscale;
   - run the segmenter.

   It returns files in `tmp/`, so no big base64 crosses the bridge. The segmenter has its own executor,
   so frame downloads and project saves never wait behind it.
2. **The web side does all pixel styling** on canvas, as pure functions over `ImageData`. Every step is
   then unit-testable and identical in playback and export. The web side:
   - turns mask + image into a cut-out;
   - trims to the bounding box;
   - pads to a square;
   - draws the outline, shadow or comic style;
   - encodes the WebP (PNG encode took 4 s on the tablet).
3. **Custom stickers are square transparent WebPs** (≤ 1024 px; WebP, PNG encode took 4 s on the tablet). The renderer keeps drawing square
   sprites, so `drawStickers` geometry does not change. `SpriteCache` gets an injected
   `urlOf(emoji)`, bound per project. The key stays `emoji@bucket`, because `my:` images are
   immutable and each `SpriteCache` instance is per project already.
4. **Reference.**
   - A custom sticker in a project is `emoji: "my:<uuid>"`. The id is validated by a strict regex
     wherever a path is built.
   - On place, the library WebP is copied to `projects/{pid}/stickers/<uuid>.webp`.
   - Deleting from the library deletes only `stickers/<uuid>.webp`, its thumbnail and its index row.
   - Movie copies are never garbage-collected. They go away with the movie.
5. **Binary files go through `tmp/` + `installFile`.**
   - The new WebP goes to `tmp/` (base64 via `Filesystem.writeFile`, ≤ ~1 MB; a documented exception to
     §5.4, like `videoWriteAt`), then `installFile(tmp, dest, bytes, sha256)` moves it into place
     atomically and verifies it.
   - Copy-on-place is `Filesystem.copy` → `tmp/`, then `installFile` into the movie. Its
     `ALREADY_INSTALLED` makes it idempotent and self-healing after a crash.

## Technical Details
**Native API** (`NativeApi.kt`, `native.ts`). All paths are relative to `filesDir/kopernikadr/` and are
checked by `PathGuard`.
- `pickImage()` → `{path, mime}`.
  - The intent is built by `ActivityResultContracts.PickVisualMedia().createIntent(ctx,
    PickVisualMediaRequest(ImageOnly))`, which already picks the platform picker, the Play-services
    backport, or `ACTION_OPEN_DOCUMENT`.
  - It is passed to Capacitor `startActivityForResult(call, intent, "pickResult")`.
  - The result is copied **on the segmenter executor** to `tmp/pick-<uuid>.<ext>`. Bytes are counted
    while copying, with a 40 MB cap (`TOO_LARGE`).
  - Mime jpeg / png / webp / heic / heif. Anything else is `UNSUPPORTED`.
- `takePhoto()` → `{path}`.
  - Uses `MediaStore.ACTION_IMAGE_CAPTURE`. `EXTRA_OUTPUT` is a **per-request** file
    `cacheDir/capture/photo-<uuid>.jpg` (remembered by the call id; a result consumes only its own) via `packageName + ".fileprovider"`.
  - On `RESULT_OK` with a non-empty file, the file is moved on the segmenter executor to
    `tmp/photo-<uuid>.jpg`.
  - Errors:
    - cancel or a 0-byte file → `CANCELLED`;
    - `ActivityNotFoundException` → `NO_APP`.
  - The merged manifest must not declare `CAMERA`. If it did, the intent would throw
    `SecurityException`. Checked in Task 6.
- **Process death** while the camera or picker is in front:
  - the photo is lost;
  - the plugin clears `cacheDir/capture/` at `load()`;
  - a callback with a null call is ignored;
  - the app opens on its default route and never crashes.
  - Tested with the null-call path. A full restore via `appRestoredResult` is out of scope.
- `takePhoto` and `pickImage` close any open segmenter session first, to free memory while the other
  app is in front.
- `segOpen({path, maxSide: 1024})` → `{handle, image: tmpPath, width, height, hasAlpha}`.
  - `ImageDecoder` with a target size: one call applies EXIF orientation for JPEG/HEIF and downscales.
  - It writes `tmp/seg-<handle>.png`, the exact image the mask refers to, and **deletes the source
    file**.
  - `hasAlpha` is true when any pixel has alpha < 250. Then the web side skips segmentation and
    calls `segClose`.
  - **No engine is created here.**
- `segRun({handle, strokes: [{mode: 'add'|'erase', points: [[x,y],...]}]})` → `{mask: tmpPath, width, height, ms, delegate}`.
  - The first run creates the engine:
    - **GPU-crash marker:** before GPU init, write `noBackupFilesDir/seg-gpu-attempt`, and delete it
      after the first successful GPU run. If the marker is present at start (a native crash last
      time), use CPU from then on and record `gpuDisabled` in a prefs file.
    - A Java exception from GPU create or run → recreate on CPU, then `setImage` again, then retry once.
  - The whole stroke list is sent every time; the segmenter is stateless per call.
  - The plugin adapter turns the `JSONArray` into `List<Map>` before `BridgeArgs`.
  - Limits: ≤ 50 strokes, 1..2000 points each, coordinates within 0..1.
  - The mask is **raw bytes** `w*h` uint8 (confidence × 255) in a single
    `tmp/seg-<handle>.mask`, overwritten each run. The web side reads it with
    `fetch(convertFileSrc(...)).arrayBuffer()`.
  - Each result `MPImage` is closed and each `Bitmap` recycled.
- `segClose({handle})`.
  - Idempotent. Deletes `tmp/seg-<handle>.*` and closes the engine.
  - Also runs after 5 min idle (a scheduled task on the segmenter executor) and in `handleOnDestroy`.
  - StickerMaker calls it on unmount, cancel and save.
- **Segmenter executor:** a dedicated single-thread `ScheduledExecutorService` in the plugin,
  separate from the shared one. Shut down in `handleOnDestroy`. Documented in the plugin KDoc.
- **Error codes added** in `NativeErrors.kt` and `native.ts`: `CANCELLED`, `NO_APP`, `TOO_LARGE`,
  `UNSUPPORTED`, `SEG_FAILED`, `MODEL_MISSING`, `NO_SESSION`.

**Build:**
- `remote/android/app/build.gradle`:
  - `implementation "com.google.mediapipe:tasks-vision:1.1.1"`;
  - `noCompress 'task'` (Groovy form, kept consistent with the existing `aaptOptions`);
  - `ndk { abiFilters 'arm64-v8a' }` in `defaultConfig` (both the tablet and the emulator are arm64).
- **Model:**
  - `remote/scripts/fetch-models.mjs` downloads the pinned URL into a cache
    `~/.kopernikadr/models/<sha256>.task`, verifies sha256, and copies it to the git-ignored
    `remote/android/app/src/main/assets/mediapipe/interactive_segmentation.task`. It skips the
    download when the cached hash matches.
  - The file is listed in `remote/android/.gitignore`.
  - A Gradle task `checkSegModel`, hooked to `preBuild`, verifies the asset's sha256 and fails with
    "run `node scripts/fetch-models.mjs` in remote/". So `npm run android:debug`, Android Studio and
    plain gradlew cannot build an APK without the model.
  - `scripts/build.sh` and `npm run android:debug` run the fetch first.
  - At runtime a missing asset gives `MODEL_MISSING`.
- **Versions.** URL, size and sha256 are recorded in `remote/VERSIONS.md`, together with the
  transitive dependency audit:
  - `./gradlew-jbr :app:dependencies --configuration releaseRuntimeClasspath`, diffed against the
    current state;
  - every new or bumped artifact must be stable and at least 14 days old;
  - the merged manifest must have no `CAMERA` permission.

**Library** (`remote/lib/stickers/library.ts`):
- Layout:
  - `stickers/index.json` = `{v: 1, items: [{id, created, bytes, sha256}]}` in newest-first order;
  - `stickers/<uuid>.webp` is the sticker (≤ 1024 square);
  - `stickers/<uuid>.thumb.webp` is a 160 px thumbnail for the "Moje" tiles.
- Add writes both WebPs through `tmp/` + `installFile`, then writes the index atomically
  (`writeTextAtomic`).
- `list()` filters out rows whose file is missing. Orphan WebPs are harmless and left alone.
- Up to 200 stickers. Over 200, the kid is asked to delete one first.

**Project model:**
- `Sticker.emoji` accepts a hexcode or `my:<uuid>` (strict regex). Anything else that is not a
  catalog hexcode is "unknown sprite".
- Copy-on-place runs in `stickerController`:
  - after the `exporting` check;
  - outside the store mutation;
  - before the project write.
  - If the copy fails, nothing is placed and the kid sees "Nie udało się dodać naklejki".
  - `StickerControllerDeps` gets a `copySticker(id, pid)` dep.
- **No sweep GC** of `projects/{pid}/stickers/`. Project delete removes the folder as now.
- Export keeps the fail-loud `SpriteLoadError` for every sprite. The export error message names the
  missing sticker, so the kid can delete it from the movie.

**Stickerize** (`remote/lib/stickers/stickerize.ts`, pure functions over `{width, height, data: Uint8ClampedArray}`):
- `cutout(image, mask, threshold)`. Alpha = mask. Pixels under 0.15 are cleared.
- `trimToContent(img, pad)`.
- `padSquare(img)`.
- `distanceToInside` (chamfer).
- `outline(img, {radiusPx, color})`.
- `shadow(img, {dx, dy, alpha, blurPx})`.
- `comic(img, {levels: 5, edgePx})`. Posterizes, then draws a dark outline from the alpha edge and
  luminance edges (Sobel threshold).
- `naklejka = shadow ∘ outline(white, r = 3% of side)`.
- `komiks = shadow ∘ outline(black, r = 2%) ∘ comic`.
- Output ≤ 1024 px square, plus the 160 px thumbnail. Encoded by
  `OffscreenCanvas.convertToBlob({type: 'image/webp', quality: 0.92})` (WebP, PNG encode took 4 s on the tablet).
- Both presets are computed once per cut-out and cached. A chip tap only swaps the preview. Move it to
  a Worker only if the device run shows jank.

**UI** (`remote/components/StickerMaker.tsx`, full screen):
1. **Source:** two big buttons, "Zrób zdjęcie" and "Z galerii".
2. **Cut**, only for images without transparency:
   - The image is shown fitted. The kid taps or draws a stroke over the toy.
   - Brush toggle: "Dodaj" (default) / "Usuń". Plus "Cofnij" and "Od nowa".
   - The current cut-out is shown on a checkerboard, with the rest of the image dimmed.
   - A spinner shows during the first run (warm-up) and each run.
   - Hint: if the mask covers > 55% of the image, the screen shows "Przeciągnij palcem po zabawce".
3. **Style:** "Naklejka" / "Komiks" chips with a live preview, then "Zapisz".

Then the picker opens on "Moje" with the new sticker first.
- **"Moje" tab, always the first tab of `EmojiPicker.tsx`:**
  - the first tile is "＋ Zrób naklejkę";
  - the tiles are the library thumbnails;
  - a ✕ on a tile opens a confirm dialog "Usunąć naklejkę?" (the same pattern as the project delete).
- All strings in pl and ru (`lib/i18n`). Touch targets ≥ 48 CSS px. Gestures use pointer capture and
  `touch-action: none` (3a lessons).

## What Goes Where
- **Implementation Steps:** code, tests, docs in this repo.
- **Post-Completion:** owner checks with the kid, Family Link behaviour of the camera and picker
  intents in Kids Space.

## Implementation Steps

### Task 1: Stickerize image operations
**Files:**
- Create: `remote/lib/stickers/stickerize.ts`, `remote/lib/stickers/stickerize.test.ts`

- [x] Implement `cutout`, `trimToContent`, `padSquare`, `distanceToInside`, `outline`, `shadow`,
      `comic`, the presets `naklejka` and `komiks`, and the thumbnail downscale. Cap the output at 1024 px.
- [x] Tests on tiny synthetic images:
  - cutout alpha from the mask;
  - trim bbox;
  - square padding keeps the centre;
  - outline radius;
  - shadow offset;
  - comic level count;
  - an empty mask → `null` ("nothing cut");
  - a full-image mask still works;
  - an already transparent PNG goes through trim, pad and style unchanged in shape.
- [x] Run tests (`cd remote && npm test`); they must pass before Task 2.

### Task 2: Sticker library store
**Files:**
- Create: `remote/lib/stickers/library.ts`, `remote/lib/stickers/library.test.ts`, `remote/lib/stickers/binaryFiles.ts` (tmp write + `installFile`, `Filesystem.copy` + `installFile`), `binaryFiles.test.ts`
- Modify: `remote/lib/projects/fakeFs.testutil.ts` (binary + install support in the fake)

- [x] `binaryFiles`:
  - `writeBinary(dest, blob)`: base64 → `tmp/<uuid>.bin` → sha256 → `installFile`;
  - `copyFile(src, dest)`: `Filesystem.copy` → tmp → `installFile`, with `ALREADY_INSTALLED` = OK.
  - Document the §5.4 exception in the module header.
- [x] `StickerLibrary`:
  - `list()` filters missing files;
  - `add(webp, thumb)` → id: both WebPs first, then `writeTextAtomic` of the index;
  - `remove(id)`;
  - `fileUri(id)` / `thumbUri(id)`;
  - the 200 limit;
  - ids from `crypto.randomUUID()`.
- [x] Tests:
  - add/list/remove;
  - newest-first order;
  - the limit;
  - a crash between the WebPs and the index (an orphan is ignored);
  - a row with a missing file is hidden;
  - a corrupt index → empty list + warning, files kept;
  - `copyFile` is idempotent.
- [x] Run tests; they must pass before Task 3.

### Task 3: Custom stickers in projects, playback and export
**Files:**
- Modify:
  - `remote/lib/projects/model.ts`;
  - `remote/lib/app/stickerController.ts`;
  - `remote/lib/render/sprites.ts`;
  - `remote/lib/render/catalog.ts`;
  - `remote/components/PlayView.tsx`;
  - `remote/lib/export/projectExport.ts` (+ the export controller that builds its `SpriteCache`);
  - `remote/lib/app/frames.ts` (a shared file-URL helper if needed).
- Modify tests: the `model`, `stickers`, `stickerController`, `sprites` and `projectExport` tests.

- [x] `MY_STICKER_RE = /^my:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`,
      `isCustomSticker()`, accepted by `parseStickers`. Paths are built only from validated ids.
- [x] `SpriteCache` takes `urlOf(emoji)`:
  - a hexcode gives the OpenMoji SVG;
  - `my:` gives the project copy via `resolveFrameBaseUri()` + `convertFileSrc`;
  - an invalid id gives no URL (unknown sprite).

  The key stays `emoji@bucket`. PlayView and the export build their cache with the project's
  `urlOf`.
- [x] Copy-on-place in `stickerController` through a `copySticker(id, pid)` dep: after the
      `exporting` check, outside the store mutation, before the write. A failure places nothing and
      shows an error.
- [x] Export: the `SpriteLoadError` message names the missing sticker. Behaviour is otherwise
      unchanged (fail-loud).
- [x] Tests:
  - parse/validate;
  - `urlOf` for the three kinds of id;
  - copy-on-place, including the failure path;
  - removing the library sticker leaves the movie drawable (the copy is used);
  - export with a custom sticker;
  - export with a missing copy fails with the named error;
  - playback skips a missing copy.
- [x] Run tests; they must pass before Task 4.

### Task 4: Native image picker, activity results and the TS bridge
**Files:**
- Create: `remote/android/app/src/main/java/pl/slava/kopernikadr/remote/native/ImageImport.kt`, `ActivityResults.kt` (pure result → outcome mapping)
- Modify: `KopernikadrNativePlugin.kt` (segmenter executor, `pickImage`, `@ActivityCallback`, `__testImportImage` in debug), `NativeApi.kt`, `NativeErrors.kt`, `remote/lib/native.ts`, `remote/lib/native.test.ts`
- Create tests: `remote/android/app/src/test/.../ImageImportTest.kt`, `ActivityResultsTest.kt`, `NativeApiImageTest.kt`

- [x] Add the dedicated segmenter `ScheduledExecutorService`, shut down in `handleOnDestroy`, and
      document it in the KDoc.
- [x] `pickImage` via `PickVisualMedia().createIntent(...)` and `startActivityForResult(call, intent,
      "pickResult")`. The copy runs on the segmenter executor with a byte-counted 40 MB cap. Mime check
      (heic and heif are both accepted).
- [x] `ActivityResults`: OK / cancel / empty / no-app / null-call → outcome. A null call (process
      death) is ignored.
- [x] Add the new error codes to `NativeErrors.kt` and `native.ts`.
- [x] Debug-only `__testImportImage({path})`: copies a file from `/sdcard/Download/` to `tmp/` like a
      pick would, for scripted tablet runs.
- [x] Tests:
  - `ImageImport` copy, cap, unsupported mime;
  - `ActivityResults` mapping, including the null call;
  - `native.ts` error-code parsing.
- [x] Run tests (`npm test`, `:app:testDebugUnitTest`); they must pass before Task 5.

### Task 5: StickerMaker (source + style) and the "Moje" tab
**Files:**
- Create: `remote/components/StickerMaker.tsx`, `remote/lib/app/stickerMakerModel.ts` (pure state machine), `remote/lib/app/stickerMakerModel.test.ts`, `remote/lib/stickers/pickerTabs.ts` + test
- Modify: `remote/components/EmojiPicker.tsx`, `remote/components/PlayView.tsx`, `remote/app/globals.css`, `remote/lib/i18n/*` (pl, ru)

- [x] State machine: `source → loading → (cut) → style → saving → done`, plus cancel/error at each
      step.
  - In this task an image without transparency shows "Wkrótce: wycinanie" and returns. The cut step
    comes in Task 9.
  - "Zrób zdjęcie" is hidden until Task 7. (Only "Z galerii" is shown; the camera tile comes with Task 7.)
- [x] Style step: "Naklejka" / "Komiks" chips with a cached live preview. "Zapisz" adds the sticker
      to the library and opens the picker on "Moje".
- [x] "Moje" is always the first tab:
  - the first tile is "＋ Zrób naklejkę";
  - thumbnail tiles;
  - ✕ → confirm → `remove`;
  - picking a tile places `my:<uuid>` via Task 3.
- [x] Tests:
  - model transitions (cancel, picker error, an image with alpha → style, without alpha → "soon");
  - tab order;
  - the delete confirm flow;
  - pick → place with a `my:` id.
- [x] Run tests; they must pass before Task 6. **Checkpoint:** a PNG with transparency (Hello
      Kitty/Stitch case) works end to end on the tablet, in an agent-created test movie. (deferred to the orchestrator's tablet run)

### Task 6: MediaPipe dependency, model fetch and build checks
**Files:**
- Create: `remote/scripts/fetch-models.mjs`, `remote/scripts/fetch-models.test.mjs`
- Modify: `remote/android/app/build.gradle` (dependency, `noCompress 'task'`, `abiFilters 'arm64-v8a'`, `checkSegModel` on `preBuild`), `remote/android/.gitignore`, `remote/package.json` (`android:debug` runs the fetch), `scripts/build.sh`, `remote/VERSIONS.md`

- [x] Fetch script:
  - pinned URL + sha256;
  - the cache `~/.kopernikadr/models/<sha>.task`;
  - copied into assets;
  - a hash match skips, a mismatch fails and deletes.
- [x] Gradle `checkSegModel` fails the build with a clear message when the asset is missing or wrong.
- [x] Add the dependency, `noCompress` and the ABI filter. Run the transitive dependency audit (all
      new or bumped artifacts stable and ≥ 14 days old) and record it in `remote/VERSIONS.md`. Check
      that the merged manifest has no `CAMERA` permission.
- [x] Build the debug APK; check `unzip -lv` (the model is stored uncompressed, only arm64 `.so`
      files) and record the APK size delta.
- [x] Tests for the fetch script (injected fetch: skip on match, fail on mismatch,
      download-then-verify, cache reuse).
- [x] Run tests (`npm run test:scripts`, `npm test`); they must pass before Task 7.

### Task 7: Native photo capture
**Files:**
- Modify: `KopernikadrNativePlugin.kt` (`takePhoto`, `cameraResult`, `cacheDir/capture/` clear at `load()`), `NativeApi.kt`, `ActivityResults.kt`, `remote/lib/native.ts`, `StickerMaker.tsx` (show "Zrób zdjęcie")
- Modify tests: `ActivityResultsTest.kt`, `NativeApiImageTest.kt`, `stickerMakerModel.test.ts`

- [x] `takePhoto`:
  - `ACTION_IMAGE_CAPTURE`, with a per-request `cacheDir/capture/photo-<uuid>.jpg` (by call id) via
    `packageName + ".fileprovider"`;
  - the move to `tmp/photo-<uuid>.jpg` runs on the segmenter executor;
  - 0-byte → `CANCELLED`, no camera app → `NO_APP`;
  - closes any segmenter session first.
- [x] `load()` clears `cacheDir/capture/`. A null call in the callback is ignored.
- [x] Tests: the result mapping for the camera (OK, cancel, 0 bytes, no app, null call); the
      StickerMaker camera path.
- [x] Run tests; they must pass before Task 8.

### Task 8: Native segmenter session
**Files:**
- Create: `remote/android/app/src/main/java/pl/slava/kopernikadr/remote/native/SegEngine.kt` (interface + MediaPipe impl), `SegSession.kt`, `ImageLoad.kt` (`ImageDecoder` target size + alpha check), `SegStrokes.kt` (validation)
- Modify: `NativeApi.kt`, `KopernikadrNativePlugin.kt` (`segOpen`/`segRun`/`segClose` on the segmenter executor; `JSONArray` → plain lists), `NativeErrors.kt`, `remote/lib/native.ts`
- Create: `remote/lib/stickers/segClient.ts` (+ `FakeSegClient`), `segClient.test.ts`; JVM tests `SegSessionTest.kt`, `SegStrokesTest.kt`, `ImageLoadSizeTest.kt`

- [x] `ImageLoad`:
  - `ImageDecoder` with a target long side of 1024;
  - writes `tmp/seg-<handle>.png`;
  - deletes the source;
  - `hasAlpha`.
- [x] `SegSession`:
  - the engine is created lazily on the first run;
  - the GPU-crash marker, and the CPU fallback with re-`setImage` and one retry;
  - the raw mask goes to `tmp/seg-<handle>.mask`;
  - `MPImage`s are closed and Bitmaps recycled;
  - idle close after 5 min;
  - `close` deletes the session files;
  - `MODEL_MISSING` and `NO_SESSION`.
- [x] `segClient`:
  - serializes calls;
  - a newer run supersedes a queued one;
  - reads the mask via `fetch(convertFileSrc).arrayBuffer()`;
  - `segClose` runs on dispose.
- [x] JVM tests (pure, fake engine):
  - stroke validation;
  - target-size math;
  - open/run/close;
  - the GPU exception → CPU path;
  - the marker present → CPU;
  - idle close;
  - a run after close.
- [x] Vitest: `segClient` queue/supersede, error mapping, close on dispose.
- [x] Run tests; they must pass before Task 9.

### Task 9: Cut step in StickerMaker
**Files:**
- Modify: `remote/components/StickerMaker.tsx`, `remote/lib/app/stickerMakerModel.ts` (+ test), css, i18n

- [x] Cut view:
  - pointer strokes in normalized coordinates (a tap = a one-point stroke);
  - "Dodaj"/"Usuń";
  - Cofnij (re-runs with the remaining strokes);
  - Od nowa;
  - the checkerboard cut-out preview;
  - a spinner for warm-up and runs;
  - the > 55% hint.

  Then "Dalej" to the style step.
- [x] `segClose` on unmount, cancel and save (and on "Dalej", since back from style goes to the source step).
- [x] ➕ Native lifetime fix (`SegEngine.kt`): `MediaPipeEngine` keeps the `MPImage` and its Bitmap alive until `close()` (segmenter closed first). `setImage` only keeps a reference, the encoder runs lazily inside `segment`. The CPU-fallback path closes the old engine and binds a fresh decode of the same session PNG. JVM tests unchanged and green (the fakes never touched MediaPipe).
- [x] ➕ Transparent reopen after the 5-minute idle close: the native close deletes `seg-<handle>.png`, so the cut step keeps the decoded picture (`Img`, <= 1024 px) in memory, and on `NO_SESSION` writes it back to `tmp/seg-src-<uuid>.png`, calls `segOpen` and retries the run once (`cutSession.ts`: `runCut`, `reopenFrom`).
- [x] ➕ Fix: custom stickers are stored as WebP (`stickers/<uuid>.webp`, `.thumb.webp`, `projects/{pid}/stickers/<uuid>.webp`), encoded with `convertToBlob({type: 'image/webp', quality: 0.92})`: the PNG encode took 4 s on the tablet (WebP 0.3 s). The `my:<uuid>` id is unchanged; old `.png` files are not migrated (they fail as an unknown sprite). The native segmenter engine is kept across `segOpen` sessions (see Task 6 area: `SegSession`/`SegEngine`).
- [x] Removed the Task 5 "Wkrótce: wycinanie" path (`soon` notice and strings).
- [x] Tests:
  - model: strokes and undo;
  - the hint threshold;
  - an error from `segRun` stays in the cut step with a retry;
  - the empty mask message.
- [x] Run tests; they must pass before Task 10. (vitest 882, tsc, test:scripts 13, gradle :app:testDebugUnitTest)

### Task 10: Device e2e on the tablet
**Files:**
- Create: `remote/e2e/stickers.cdp.mjs` (or extend `flow.cdp.mjs`), `docs/diagnostics/20261028-photo-stickers.md`
- Modify: `remote/e2e/README.md`

- [x] **Tablet** (HA21J9XT), on an agent-created test movie only. No emulator. (Run by the orchestrator by hand via adb+CDP on 2026-10-28.)
  - Scripted run with `__testImportImage` and a toy photo pushed to `/sdcard/Download/`: tap, erase
    stroke, "Komiks", save, place, play, export, delete it from "Moje", the movie still plays. (script written; the same flow was done by hand on 2026-10-28; first scripted run the same day: all 6 steps PASS, first cut 4.2 s, later 0.9 s, save 0.7 s)
  - The transparent-PNG path, which skips the cut. (done by hand; also in `stickers.cdp.mjs` via `--png`)
  - The real camera and picker intents, driven via `uiautomator dump` + `input tap`;
  - warm-up and run times;
  - memory with `scripts/meminfo-sampler.sh`. Target: PSS back within 60 MB of baseline after
    `segClose`. (by hand: app PSS 125 MB after sessions closed, 184 MB after export; sampler table not recorded)
- [x] Record the results in `docs/diagnostics/20261028-photo-stickers.md`.
- [x] Remove the agent's test movies, stickers and exports from the tablet afterwards. Never touch
      the kid's. (deferred to the orchestrator's tablet run)

### Task 11: Verify acceptance criteria
- [x] ➕ Tablet findings: a missing `my:` sticker file is visible and fixable. Playback/editing draws a
      "?" placeholder (`stickerPaint` in `lib/render/compose.ts`, stage only); the EditTools chip
      shows the same "?" on an `<img>` error; the export fails loud with `export.errStickerMissing`
      (pl/ru) when a failed id is `my:`.
- [x] ➕ The segmenter warm-up is hidden: `SegClient.warm()` queues a dummy centre-stroke run (result
      discarded, no mask read) right after the cut step opens; the first real tap waits behind it in
      the serialized queue (the "Chwilka…" spinner shows then). Client-side only: the dummy run also
      warms the first inference, which a native `segWarm` would not.
- [x] Every Overview requirement is implemented. Both sources work. Both styles work. A PNG with alpha
      skips the cut. "Moje" add and delete work. Movies survive a library delete.
      (verified against the code; device items verified by the orchestrator, see
      `docs/diagnostics/20261028-photo-stickers.md` sections 1-5 and the scripted run)
- [x] Edge cases (code + JVM/vitest tests: `ActivityResultsTest` cancel/NO_APP/null call, `ImageImportTest`
      cap 40 MB + HEIC/HEIF, `stickerize.test.ts` empty mask, `SegSessionTest` GPU→CPU, `sweep.test.ts`
      tmp/ emptied; camera cancel and process death also verified on the tablet by the orchestrator):
  - camera cancel;
  - no camera app;
  - a huge image;
  - HEIC;
  - no mask;
  - a GPU failure → CPU;
  - process death during camera/pick (no crash);
  - app killed mid-session (`tmp/` emptied by the sweep).
- [x] Full suites (all green: vitest, test:scripts, tsc, 187 JVM tests with --rerun-tasks, e2e lib 10):
  - `cd remote && npm test && npm run test:scripts`;
  - `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - `node --test e2e/lib.test.mjs`.
- [x] Builds (debug via `scripts/build.sh --remote-only --variant debug` OK; release refuses cleanly without
      `~/.kopernikadr/keystore.properties` with the expected-file message, no keystore created, so a signed
      release APK is left to the owner; APK delta in VERSIONS.md is measured on debug, +50.3 MB arm64):
  - the release APK builds via `scripts/build.sh`;
  - a plain `./gradlew-jbr assembleDebug` without the model fails with the fetch hint.

### Task 12: [Final] Update documentation
- [x] `docs/ARCHITECTURE.md`:
  - the custom-sticker storage and reference (`my:<uuid>`, copy-on-place, no GC);
  - the §5.4 binary exception (tmp + `installFile`) and the downgrade caveat (the 3a app cannot
    export `my:` stickers);
  - the native segmenter, its executor and the GPU marker;
  - the activity-result / process-death policy.
- [x] `docs/ROADMAP.md`:
  - "Zrób naklejkę" done;
  - add the later items: Pufy/Błysk styles, the movie frame as source, cloud "cartoon", "get into
    the cartoon" (selfie segmentation), hand-in-frame (MediaPipe hands), clap-to-shoot (MediaPipe
    audio).
- [x] The "O aplikacji" screen: MediaPipe (Apache 2.0) and the MagicTouch model credit.
      `README.md` / `remote/e2e/README.md`: the model fetch step.
- [ ] Move this plan to `docs/plans/completed/`. (moved by the orchestrator after the Codex review)

## Post-Completion
*Requires the owner or the kid; informational only.*

**Manual verification:**
- the kid makes a sticker from her own toy, places it, exports, watches it in the gallery;
- whether "Naklejka" and "Komiks" look good to her;
- whether the brush is easy enough.

**Family Link / Kids Space:**
- check that the system camera and photo picker intents open from the app inside Kids Space. If they
  are blocked, the parent allows them.

**Later:**
- the Pufy/Błysk styles;
- a movie frame as the source;
- a full `appRestoredResult` restore after process death;
- the MediaPipe interactive segmenter "v2 interface" may change again. Re-check the API on the next
  version bump.
