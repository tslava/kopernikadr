# Stage 3a + emoji: frame strip, editing, phone upkeep, OpenMoji stickers

Rev 2 (2026-10-27): revised after the auto plan review. Changes:
- runtime frame expiry;
- per-entry delete;
- two stage canvases + `seekTo`;
- export sprite preload and snapshots;
- serialized reclaim;
- one phone parent entry point;
- tablet quarantine path;
- `node:test` for scripts;
- no `full` in the strip;
- 500-frame acceptance.

## Overview
Stage 3 was split (owner, 2026-10-27). This plan is **3a + emoji**:

- **Tablet editing.** The movie screen gets a frame strip. On it you can:
  - view a frame big;
  - delete a frame with Undo;
  - duplicate a frame;
  - hold a frame (per-frame duration);
  - move frames;
  - turn a frame off ("not in the movie", non-destructive);
  - trim the start and the end (= turn those frames off);
  - undo edits.
- **Emoji stickers.** Bundled OpenMoji SVGs:
  - place, move, resize and rotate a sticker;
  - a sticker stays on a range of frames;
  - the same renderer draws stickers in playback and in export.
- **Phone upkeep:**
  - 7-day reclaim of acked frames;
  - `ScreenPolicy` dim after 2 min;
  - a parent action to show and clear `quarantine/`, on both the phone and the tablet.

**Not in this plan:**
- 3b: insert a frame in the middle, reshoot frame N. This needs capture/protocol changes.
- Comics, particles, filters, motion, transitions.
- "Shoot on twos". The owner dropped it: the speed slider plus per-frame hold already cover it.
- Copy/paste frames and reverse a range (ROADMAP "Next by priority" §3). Deferred to 3b.

**Owner decisions (2026-10-27):**
- Trim and "remove from movie" never delete: the frame turns grey on the strip and can be turned back on. Only "Delete" removes a frame for good (5 s Undo, then a tombstone → ack → the phone may delete it).
- Emoji: a curated subset of about 200 OpenMoji, grouped into categories. Not the full ~4000.

**Protocol:** PROTOCOL v1 is unchanged. Edits and stickers are tablet-only data in `project.json`.

## Context (from discovery)
- **Project model** (`remote/lib/projects/model.ts`):
  - `Project.frames: FrameEntry[]` is ordered by `seq` and keyed by `frameId`;
  - `hiddenUntil` drives the 5 s delete Undo;
  - `expireFrames` moves expired frames to `deletedFrameIds`.
  - Additive optional fields already exist (`geometryFrozen?`). Invalid non-critical fields fall back instead of making the project unreadable (`fps`).
- **Reducers** (`remote/lib/projects/reducers.ts`):
  - pure, with time injected;
  - `mergeFrame` inserts by `seq`;
  - `hideFrame`/`unhideFrame`/`expireFrames` exist, but no UI calls them yet.
  - ⚠️ (review) `expireFrames` runs **only in the startup sweep** (`sweep.ts:158`, which also unlinks files there). No runtime frame-expiry orchestrator exists. `ProjectDeletion` (`deletion.ts`) handles projects only.
- **Store:** `ProjectStore.updateProject(id, fn)` serializes and persists through `writeTextAtomic`.
- **Playback** (`remote/lib/play/player.ts`): `playableFrames()` is local, visible, available, in seq order. A ring of 8 bitmaps is keyed by frameId. `draw(bitmap)` is injected.
- **Export:**
  - `remote/lib/export/projectExport.ts` + `mediabunnyExport.ts`. `add(image, timestamp, duration)` already takes a per-sample duration.
  - `exportGate` counts visible frames that are still downloading or unavailable.
- **Frame files:** `frames.ts` gives `play`/`thumb`/`full` urls with a 10 s absent TTL. Thumbs exist on the tablet.
- **Long-press:** `LongPressButton` gates parent controls (fixed today: slop 24 px, tap hint).
- **Phone:**
  - `SpoolReclaimer` reclaims acked frames, oldest `ackedAt` first, only under low space;
  - `Spool` has `ackedAt` and `reclaimedAt`;
  - `MainActivity` sets `FLAG_KEEP_SCREEN_ON`; no dim yet;
  - `DiagnosticsScreen` is in the `probe` source set only;
  - `StatusScreen` is variant C.
- **OpenMoji** on npm: `openmoji@17.0.0` (2026-04-23, satisfies the 14-day rule). License CC BY-SA 4.0, attribution required.
- **Tests:**
  - remote: vitest, node env, no DOM;
  - camera: JVM tests in `:core`;
  - E2E: `remote/e2e/flow.cdp.mjs` (emulator + fake camera).
  - New this session: the real tablet is driven with `adb shell input` + WebView CDP (see the memory note "self-test-on-device").

## Development Approach
- **Testing approach: mixed** (as in stages 1+2):
  - **pure modules TDD:** timeline, edit reducers, sticker geometry, history, reclaim timer, ScreenPolicy state machine;
  - **UI and glue code first**, then tests where logic lives;
  - **every UI task ends with a run on the real tablet** (adb input + CDP), done by the agent, not the owner.
- Complete each task fully before the next. Small focused changes.
- **CRITICAL: every task MUST include new/updated tests** for its code changes.
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan when scope changes.**
- Backward compatibility:
  - `project.json` stays `version: 1`;
  - new fields are optional;
  - a project without them behaves exactly as today.
- Safety rules:
  - frames leave the phone only through `ack`;
  - eligibility rules are unchanged. "Off" never writes a tombstone and never unlinks files. An off frame that is `local` is acked like any other, so after the phone's 7-day reclaim the tablet holds the only copy (as for every frame);
  - the agent never deletes the kid's spool;
  - phone quarantine clear is an explicit parent action with confirmation.

## Testing Strategy
- **Unit tests:**
  - remote: vitest (`cd remote && npm test`). Its include is `lib/**` and `components/**` only, so script tests (`remote/scripts/*.test.mjs`) use `node --test` via a new `npm run test:scripts`;
  - remote typecheck: `npm run typecheck`;
  - camera: `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`.
- **E2E on the emulator** (`remote/e2e/flow.cdp.mjs` + fake camera): extended with an edit + sticker + export step. It checks:
  - the exported duration = Σ hold / fps;
  - the export finishes with stickers.
- **Real tablet:** every UI task ends with a scripted touch run on the TB328FU:
  - `adb input` taps, holds and drags;
  - state is read through CDP;
  - a `screencap` goes into the task notes when layout matters.

## Progress Tracking
- Mark completed items `[x]` immediately.
- Add new tasks with the ➕ prefix and blockers with the ⚠️ prefix.
- Keep the plan in sync with the work.

## Solution Overview

### Edit list over the frame pool
`frames` stays what it is today: the pool of captured frames, ordered by seq, owned by capture, transfer, reconcile and ack. Edits never reorder or remove pool entries. They live in a new optional field:

```ts
interface CutEntry {
  id: string;        // == frameId for a frame's first entry; a new ULID for a duplicate
  frameId: string;
  hold: number;      // 1..8 ticks (a tick = 1/fps)
  off?: true;        // not in the movie (trim / "remove from movie"); the frame is kept
}
Project.cut?: CutEntry[]  // absent until the first edit
```

`timeline(project)` (pure) derives what plays:
1. The `cut` entries whose frame is still in `frames`, in `cut` order.
2. Then every frame not referenced by any entry, in seq order, as `{id: frameId, frameId, hold: 1}`. These are new captures after the last edit, so new shots land at the end automatically. No merge/reconcile code changes.

**Why the first entry's id equals its frameId:** an implicit entry and the same entry after materialization have the same id. Stickers that point at entry ids survive the first edit.

**Materialize:** the first edit writes `cut = timeline(project)` and then applies the change.

**Playback and export** use only the entries that are on, local, visible and available. Each entry shows for `hold` ticks.

**Invariant (review):** every frame in `frames` that is not hidden has at least one cut entry, or `cut` is absent. Otherwise `timeline()` step 2 would silently re-append a frame the kid removed. Every edit reducer keeps this invariant, and a test checks it after every reducer.

**What an entry looks like on the strip:**

| Frame state | On the strip |
|---|---|
| hidden (Undo window) | marked "deleting" |
| turned off (`off`) | grey |
| `pending` / unavailable | "downloading" |

**Delete is per entry (review):**
- **A duplicate entry** (other entries share its frameId) is removed from `cut` only. There is no tombstone, and Cofnij brings it back.
- **The last entry of a frame** runs the frame delete: `hideFrame` gives the 5 s Undo (the toast is shared with project delete), then expiry.
- Without this, deleting a copy would hide the frameId and lose the original for good.

**Frame expiry at runtime (new, review):** `FrameDeletion` (`lib/projects/frameDeletion.ts`) is modeled on `ProjectDeletion`:
1. a timer fires at the earliest `hiddenUntil` over all projects;
2. `store.updateProject(expireFrames)` commits, which also drops the frame's cut entries and prunes the stickers' `on` (an empty sticker is removed);
3. THEN `full`/`play`/`thumb` are unlinked;
4. THEN `transfer.ackNow(expired, projectOf)`.

It re-schedules on construction, so a deadline left pending from a previous run fires. The startup sweep stays as the crash backstop. While an export runs, expiry waits until it ends, because the export may be loading those files.

**Edit history:** an in-memory undo stack (last 30 `{cut, stickers}` snapshots per project, not persisted). It backs the "Cofnij" button and covers every edit except a frame Delete, which has its own Undo. A duplicate-entry delete IS in history.

Restoring a snapshot runs inside `updateProject` against the CURRENT project. It re-prunes against the current `frames`: dead entries are dropped, and a sticker with no live entries is removed. A frame that expired after the snapshot was taken never comes back.

### Stickers
```ts
interface Sticker {
  id: string;
  emoji: string;     // OpenMoji hexcode, e.g. "1F436"
  x: number; y: number;   // centre, 0..1 of the 4:3 frame
  size: number;      // width as a fraction of the frame width (0.05..1)
  rot: number;       // degrees
  on: string[];      // CutEntry ids it is shown on
}
Project.stickers?: Sticker[]   // drawn in array order (last = on top)
```

The sticker's entry list is a set of entry ids, not a seq range:
- reorder: the sticker follows its frames;
- duplicate: the copy inherits the stickers of its source entry;
- delete: drops the entry from the list.

The "range" UI picks entries between two strip positions at that moment.

"Until the end" means the end at placement time. Frames shot later are not in `on` (see Post-Completion: owner question).

### One renderer
`lib/render/compose.ts` has two passes, `drawFrame(ctx, bitmap)` and `drawStickers(ctx, stickers, entryId, sprites)`. Both work through a minimal 2D-context interface.

**On the stage:** two stacked canvases.
- The player draws the frame canvas. The ring closes the shown bitmap right after drawing (`player.ts` refill), so the frame cannot be redrawn later.
- The sticker canvas is redrawn by `drawStickers` on every sticker, selection or entry change. A sticker drag while paused never needs the frame bitmap.

**In export:** both passes run on one OffscreenCanvas inside `source.load`, which runs ahead by one. The result is returned as a snapshot (`new VideoFrame(canvas)`), so the prefetch never overwrites a frame that is still being encoded.

**Unit tests:** use a recording fake context.

The sticker transform math is pure and tested in `stickerGeometry.ts`: normalized → px, hit-testing, handle drag → size/rotation.

**Sprites:** `lib/render/sprites.ts` rasterizes an OpenMoji SVG to an `ImageBitmap` per (hexcode, size bucket 128/256/512/1024).
- OpenMoji SVGs have only a `viewBox` and no intrinsic size, so `createImageBitmap(img)` throws in Chrome. The `<img>` is drawn onto a canvas at the bucket size, then `createImageBitmap(canvas)`.
- The LRU is capped by bytes (32 MB), not by count.
- The export uses the 1024 bucket: a full-width sticker is 1440 px.
- **Export preloads every sprite** the timeline uses before encoding. A sprite that fails to load fails the export with a clear message instead of silently dropping the sticker.

### OpenMoji subset
- A dev script `remote/scripts/openmoji-subset.mjs` reads a curated list `remote/scripts/openmoji-list.json`. The list has ~200 hexcodes in categories: animals, faces, food, nature/weather, transport, objects/toys, magic/space, hearts and symbols.
- The script takes the SVGs from the `openmoji@17.0.0` package (a devDependency, pinned) and writes:
  - `remote/public/openmoji/<hexcode>.svg`;
  - `remote/public/openmoji/catalog.json` (categories → hexcodes, with pl/ru category names);
  - `remote/public/openmoji/LICENSE.txt`.
- The output is committed, so the app build doesn't need the package.
- An attribution line goes on a new "O aplikacji" section in the parent drawer.

### Phone upkeep
- **7-day reclaim** (`SpoolReclaimer`): besides low space, a periodic pass reclaims acked frames whose `ackedAt` is ≤ now − 7 days, for any clientId.
  - It is wired in `camera-android/app/.../host/ServerHost.kt`: it starts only after `spool.recover()`, then runs every hour, and is cancelled in `stop()`.
  - It uses the same commit-then-delete path.
  - **All reclaim passes are serialized by one reclaimer-level mutex.** Today `spool.failedDeletes` is a shared plain list, cleared and read under the per-frame lock only. The capture-admission pass (`ServerHost.kt:188`) and the hourly pass would otherwise race on it.
  - **The first launch after the upgrade reclaims every frame acked more than 7 days ago in one go**, including frames acked by an earlier native-remote install. It logs the count. This is why the g05 spool backup (stages 1+2 Task 21) must come first, and the README/ARCHITECTURE §4.6 say so.
- **ScreenPolicy:** a pure state machine in `:core` (`ScreenPolicy`, with clock and activity events), wired in `MainActivity`.
  - Activity:
    - a touch on the phone;
    - a remote command (capture, controls, session open). It comes as a callback from `ServerHost.kt`, fed by the server/session events.
    - The live preview stream alone is not activity.
  - It never dims while the waiting card shows the QR, because a parent may be about to scan it.
  - After 2 min idle the window brightness goes to ~0.05; any activity restores it.
  - `FLAG_KEEP_SCREEN_ON` stays, so NSD keeps advertising.
- **Quarantine (phone):**
  - **Where:** a parent screen in the MAIN source set, so it exists in release too. The status header hold (today `onTitleHeld` → Diagnostics in probe/debug only) becomes the ONE entry point. It opens the parent screen, which has a "Diagnostyka" button when `diagnosticsScreen != null`. This avoids a hold that triggers two things.
  - **Kid safety:** this is the first destructive action on the kid's phone, and a quarantined file may be the only copy of a photo.
    - The header hold becomes 3 s.
    - "Wyczyść" opens a confirmation where the parent must type the number of files shown.
  - **What it shows:** file count, total size, the newest ≤ 12 files as downsampled thumbnails.
  - **Name rule:** the one used by `SpoolFiles.quarantine`/`SpoolFiles.NAME`, including `.dupN` and the `.tmp`/`.<uuid>.tmp` forms, so the cleared count matches `integrityErrors`.
  - **No lock needed:** `recover()` runs once per process before the server starts, so nothing writes `quarantine/` while this screen is open.
- **Quarantine (tablet):**
  - a parent drawer section for `kopernikadr/quarantine/` only (the sweep writes `{project}-{frameId}-{time}.full.jpg` there; there are no per-project folders);
  - thumbnails for the newest ≤ 12 files only, decoded downsampled (they are 8 MP fulls).

## Technical Details
- **Parsing:**
  - `parseProject` reads `cut` and `stickers` leniently. A malformed entry is dropped, and so is a later duplicate entry id.
  - A malformed whole field becomes `undefined` (logged), so the project stays readable. The store then keeps a copy of the original file as `project.json.corrupt-<ts>` before its next write, following the existing convention, so edits are not lost silently.
  - Unknown emoji hexcodes are kept in the file and skipped by the renderer.
  - Clamps: `hold` 1..8; `size` 0.05..1; `x`/`y` −0.25..1.25 (a sticker may hang partly off-frame).
- **Player:**
  - `setTimeline(items: {entryId, frameId, hold}[])` replaces `setFrames`.
  - Ring keys stay frameIds: duplicates share one bitmap.
  - `status().shown` becomes the entryId.
  - `draw(bitmap, entryId)`: the frame canvas is drawn, and the entry id drives the sticker canvas.
  - New `seekTo(entryId)`: pause, then show that entry. The strip uses it.
- **Export:**
  - `exportGate` counts only frames referenced by on-entries; off frames don't block.
  - Each on-entry is encoded once with `duration = hold / fps`; timestamps are cumulative.
  - Stickers are composed before encoding.
  - ⚠️ To check: the encoded file plays at the right speed in the system player and Google Photos (variable sample durations in MP4). Fallback: repeat the sample `hold` times.
- **Strip UI** (`components/FrameStrip.tsx`):
  - horizontal scroller of 112 px thumbs. Fallback: thumb → play → placeholder, **never `full`** (32 MB decoded each). The big view uses `play` (1440×1080);
  - a `×N` badge for hold;
  - grey for off, a "deleting" overlay for hidden;
  - a colored bar under the frames that carry the selected sticker;
  - tap selects; tap again opens the big view;
  - virtualized by index window (500-frame projects).
- **Movie screen layout:**
  - **left:** the stage (frame + stickers);
  - **right:** the play controls (existing);
  - **bottom:** the strip;
  - **tools row:** appears when a frame is selected: Delete, Duplicate, Hold −/+, Move ←/→, Off/On, "Start here", "End here", Cofnij, + Emoji. It is disabled while an export runs.
  - Big buttons (≥ 72 px), no page scroll (100dvh).
- **Sticker UI:**
  - **Picker:** a dialog with category tabs and a 6-column grid.
  - **Placing:** a sticker goes onto the selected entry and every entry after it up to the end of the movie. This default means a kid's sticker "stays", and the range can be shortened.
  - **Editing:** drag the body to move; a corner handle to scale and rotate together; a trash button.
  - **Range:** "Od tego kadru" / "Do tego kadru" with the sticker selected and another frame tapped.
  - Edits commit on pointerup (one `updateProject`, one history entry).
- **i18n:** every new string in pl and ru.

## What Goes Where
- **Implementation Steps:** code, tests, docs, E2E, and the agent's own device runs.
- **Post-Completion:** the owner's real use with the kid; the g05 install (Task 21 of stages 1+2 still applies).

## Implementation Steps

### Task 1: Edit model — `cut`, `stickers`, `timeline()` (TDD)

**Files:**
- Modify: `remote/lib/projects/model.ts`
- Create: `remote/lib/projects/timeline.ts`
- Create: `remote/lib/projects/timeline.test.ts`
- Modify: `remote/lib/projects/projects.test.ts`

- [ ] write tests first:
  - `timeline()` with no `cut` = frames in seq order, `id == frameId`, hold 1;
  - with `cut`: cut order, then unreferenced frames appended in seq order;
  - entries of frames gone from `frames` are skipped;
  - `playableItems()` filters off, hidden, pending and unavailable.
- [ ] write parse tests:
  - `cut`/`stickers` absent → undefined;
  - a valid round-trip;
  - a malformed entry is dropped;
  - a malformed field → undefined, project still readable;
  - clamps;
  - a later duplicate entry id is dropped.
- [ ] add the `CutEntry` and `Sticker` types and the optional `Project.cut?`/`stickers?`; extend `parseProject` (lenient).
- [ ] implement `timeline(project)` and `playableItems(project)` in `timeline.ts`.
- [ ] run tests — must pass before Task 2.

### Task 2: Edit reducers + history (TDD)

**Files:**
- Create: `remote/lib/projects/edit.ts`
- Create: `remote/lib/projects/edit.test.ts`
- Create: `remote/lib/projects/history.ts`
- Create: `remote/lib/projects/history.test.ts`
- Create: `remote/lib/projects/frameDeletion.ts`
- Create: `remote/lib/projects/frameDeletion.test.ts`
- Modify: `remote/lib/projects/reducers.ts` (`expireFrames` pruning)
- Modify: `remote/lib/app/app.ts` (wire `FrameDeletion`)

- [ ] write tests first:
  - the first edit materializes `cut` from `timeline()`;
  - duplicate inserts a new entry right after the source and copies its sticker membership;
  - hold ± is clamped to 1..8;
  - move left/right;
  - delete of a duplicate entry removes only that entry; delete of the last entry of a frame returns "hide the frame" (the caller runs `hideFrame`);
  - **the invariant**: after every reducer, every non-hidden frame has ≥ 1 cut entry;
  - off/on;
  - "start here" turns off everything before the entry, "end here" everything after;
  - every reducer returns the SAME reference when nothing changes;
  - a new capture after edits appears at the end.
- [ ] write `expireFrames` tests:
  - removes the cut entries of expired frames;
  - prunes stickers' `on`;
  - drops empty stickers;
  - the tombstone behavior is unchanged.
- [ ] write history tests:
  - push/undo, no redo, a cap of 30, per project;
  - no-op edits don't push;
  - restoring re-prunes against the current frames (a frame expired after the snapshot does not come back; an emptied sticker stays gone).
- [ ] write `FrameDeletion` tests (fake timers, fake store/fs/transfer):
  - fires at the earliest `hiddenUntil`;
  - commits, THEN unlinks the three files, THEN calls `ackNow` with the projectOf map;
  - Undo before the deadline cancels;
  - a pending deadline from a previous run fires after construction;
  - it waits while an export is busy;
  - an unlink failure doesn't block the ack (the sweep retries the unlink at next start).
- [ ] implement `edit.ts` (pure, ids injected), `history.ts`, the pruning in `expireFrames`, and `lib/projects/frameDeletion.ts` (wired in `lib/app/app.ts` next to `ProjectDeletion`).
- [ ] run tests — must pass before Task 3.

### Task 3: Sticker reducers + geometry (TDD)

**Files:**
- Create: `remote/lib/projects/stickers.ts`
- Create: `remote/lib/projects/stickers.test.ts`
- Create: `remote/lib/render/stickerGeometry.ts`
- Create: `remote/lib/render/stickerGeometry.test.ts`

- [ ] write tests first for the reducers:
  - `addSticker` on the entry and every later entry;
  - `updateSticker` (x/y/size/rot clamped);
  - `removeSticker`;
  - `setRange(stickerId, fromEntryId, toEntryId)` in timeline order, either direction;
  - adding a sticker materializes `cut` (ids stay stable).
- [ ] write geometry tests:
  - normalized → px for 1440×1080 and for an arbitrary canvas;
  - a hit-test with rotation;
  - the corner-handle drag → size + rotation;
  - `rot` normalized to −180..180.
- [ ] implement both modules.
- [ ] run tests — must pass before Task 4.

### Task 4: OpenMoji subset + sprite loader

**Files:**
- Create: `remote/scripts/openmoji-list.json`
- Create: `remote/scripts/openmoji-subset.mjs`
- Create: `remote/scripts/openmoji-subset.test.mjs` (`node:test`, run by `npm run test:scripts`)
- Create: `remote/public/openmoji/` (generated SVGs, `catalog.json`, `LICENSE.txt`)
- Create: `remote/lib/render/sprites.ts`
- Create: `remote/lib/render/sprites.test.ts`
- Create: `remote/lib/render/catalog.ts`
- Modify: `remote/package.json` (devDependency `openmoji@17.0.0`, scripts `openmoji` and `test:scripts`)

- [ ] curate about 200 hexcodes in 8 categories. All must be kid-appropriate: no weapons beyond toy-like ones, no alcohol. Add pl/ru category names.
- [ ] write `openmoji-subset.mjs`:
  - copies the SVGs, writes `catalog.json`, copies the license;
  - fails loudly on a missing hexcode;
  - deterministic output.
- [ ] write `catalog.ts`, a typed loader for `catalog.json`.
- [ ] write `sprites.ts`:
  - SVG url → `<img>` → canvas at the bucket size (128/256/512/1024) → ImageBitmap;
  - an LRU capped at 32 MB, close on eviction;
  - `preload(hexcodes, bucket)` for the export;
  - the image-loading seam is injected.
- [ ] tests:
  - the script on a fixture dir (missing hexcode → error; output shape);
  - the sprite LRU and bucket choice with a fake loader;
  - catalog validation.
- [ ] run `npm run openmoji`, commit the output, check its size (expect < 2 MB).
- [ ] tablet WebView check (CDP): rasterize 3 SVGs at 1024 and check that the bitmap size and pixels are not blank.
- [ ] run tests — must pass before Task 5.

### Task 5: Compositor + timeline playback

**Files:**
- Create: `remote/lib/render/compose.ts`
- Create: `remote/lib/render/compose.test.ts`
- Modify: `remote/lib/play/player.ts`
- Modify: `remote/lib/play/player.test.ts`
- Modify: `remote/components/PlayView.tsx`

- [ ] write tests first for `compose()` with a recording fake context:
  - the frame is drawn letterboxed into the canvas;
  - only the stickers whose `on` contains the entry id are drawn, in array order;
  - the transform matches the geometry;
  - a missing sprite is skipped.
- [ ] write the player tests:
  - `setTimeline` with holds: an entry stays `hold` ticks;
  - duplicates share one ring bitmap;
  - `shown` is the entryId;
  - loop/no-loop/seek still pass (the existing tests are ported);
  - `seekTo(entryId)` pauses and shows that entry, including a duplicate entry (the right id is shown);
  - a frame that becomes local mid-play is picked up.
- [ ] implement `compose.ts` (two passes), the player timeline API + `seekTo`, and the two stacked stage canvases in PlayView (frame by the player, stickers by `drawStickers`).
- [ ] run tests — must pass before Task 6.

### Task 6: Export on the timeline with stickers

**Files:**
- Modify: `remote/lib/export/projectExport.ts`
- Modify: `remote/lib/export/projectExport.test.ts`
- Modify: `remote/lib/export/mediabunnyExport.ts` (only if a compose hook is needed)
- Modify: `remote/lib/export/mediabunnyExport.test.ts`

- [ ] write tests first:
  - `exportGate` ignores off frames and counts only frames used by on-entries;
  - export order = timeline order;
  - durations = hold/fps with cumulative timestamps;
  - a duplicate decodes once (or at most per ring rules);
  - stickers are composed (fake context records it), inside `source.load`, as snapshots: two prefetched frames don't share a canvas;
  - sprites are preloaded before the first frame: a sticker whose sprite was not loaded yet is still in exported frame 1; a failed sprite fails the export with a clear message;
  - an empty timeline → the existing "no frames" gate.
- [ ] implement it: the timeline drives the export loop; frame bitmap → `compose` on an OffscreenCanvas → sample.
- [ ] export on the tablet a project with holds of 1 and 4 at 8 fps (seed the holds through CDP + a store mutation; the UI comes in Task 8). Check `ffprobe` duration and frame timing. Check that it plays at the right speed in the system player. If variable durations misbehave, switch to repeated samples (decide here, record ➕).
- [ ] run tests — must pass before Task 7.

### Task 7: Frame strip + movie screen layout

**Files:**
- Create: `remote/components/FrameStrip.tsx`
- Create: `remote/lib/app/stripModel.ts`
- Create: `remote/lib/app/stripModel.test.ts`
- Modify: `remote/components/PlayView.tsx` (strip → `player.seekTo`)
- Modify: `remote/components/AppShell.tsx`
- Modify: `remote/app/globals.css`
- Modify: `remote/lib/i18n/pl.ts`, `remote/lib/i18n/ru.ts`

- [ ] write the `stripModel.ts` tests first:
  - tile state (on/off/hidden/downloading/unavailable/hold badge/sticker bar);
  - the visible index window for virtualization;
  - selection survives timeline changes (by entry id) and clears when the entry is gone;
  - tile image choice: thumb → play → placeholder, never full.
- [ ] implement the strip:
  - tap selects and pauses playback, and shows that frame on the stage;
  - a second tap opens the big view (full frame + stickers, Back closes; it joins the overlay stack).
- [ ] layout: stage left, controls right, strip bottom, 100dvh, no page scroll at 1280×754.
- [ ] tablet run:
  - open a 5-frame movie, tap tiles, open and close the big view, Back;
  - check `scrollHeight == innerHeight`;
  - screencap.
- [ ] run tests — must pass before Task 8.

### Task 8: Edit tools (delete/Undo, duplicate, hold, move, off, trim, Cofnij)

**Files:**
- Create: `remote/components/EditTools.tsx`
- Create: `remote/lib/app/editController.ts`
- Create: `remote/lib/app/editController.test.ts`
- Modify: `remote/components/PlayView.tsx`
- Modify: `remote/components/ProjectsView.tsx` (share the Undo toast component)
- Modify: `remote/lib/i18n/pl.ts`, `remote/lib/i18n/ru.ts`

- [ ] write the `editController` tests first:
  - every tool calls the right reducer through `store.updateProject`;
  - pushes history;
  - Cofnij restores the previous `{cut, stickers}`;
  - Delete of a duplicate entry removes the entry (in history); Delete of the last entry uses `hideFrame` + the Undo toast and expires through `FrameDeletion` (Task 2);
  - the tools are disabled while an export runs;
  - tools are disabled when they make no sense (move at the edge, hold at 8).
- [ ] implement the tools row. Kid-sized buttons with icons + short labels. Delete is NOT long-press (it has Undo), the rest are plain taps.
- [ ] tablet run, 5 frames:
  - duplicate frame 2, hold frame 3 ×4, move frame 5 to first;
  - off frame 4; start here at 2; Cofnij ×2;
  - delete the duplicate of frame 2 (the original stays); delete frame 1 and Undo; delete frame 1 and let it expire (files gone, tombstone, ack sent to the camera — check the Pixel's `getStatus` counts);
  - check `project.json` via CDP and the playback order/timing.
- [ ] run tests — must pass before Task 9.

### Task 9: Sticker UI

**Files:**
- Create: `remote/components/EmojiPicker.tsx`
- Create: `remote/components/StickerLayer.tsx`
- Create: `remote/lib/app/stickerController.ts`
- Create: `remote/lib/app/stickerController.test.ts`
- Modify: `remote/components/PlayView.tsx`
- Modify: `remote/components/Icon.tsx`
- Modify: `remote/lib/i18n/pl.ts`, `remote/lib/i18n/ru.ts`

- [ ] write the controller tests first:
  - pointer drag → move;
  - handle drag → scale + rotate;
  - one commit + one history entry per gesture;
  - selection; range from/to; delete;
  - a pointercancel restores the pre-gesture state.
- [ ] picker: category tabs, a grid of SVG `<img>`s (lazy), a tap adds to the selected frame through the end.
- [ ] sticker layer over the stage: handles shown only for the selected sticker; the strip shows that sticker's frames.
- [ ] tablet run:
  - add 🐶 on frame 2, drag it, scale and rotate it with the handle, set the range 2–4;
  - play: it shows only on 2–4;
  - move frame 3 to the end: the sticker follows it;
  - delete the sticker; Cofnij;
  - screencap.
- [ ] run tests — must pass before Task 10.

### Task 10: Tablet parent: quarantine show/clear + "O aplikacji" attribution

**Files:**
- Create: `remote/lib/app/quarantine.ts`
- Create: `remote/lib/app/quarantine.test.ts`
- Modify: `remote/components/ParentDrawer.tsx` (or `Diagnostics.tsx`, wherever the parent sections live)
- Modify: `remote/lib/i18n/pl.ts`, `remote/lib/i18n/ru.ts`

- [ ] write tests first (fake fs):
  - list `kopernikadr/quarantine/` files with sizes, newest first;
  - clear removes only files inside the quarantine dirs (path guard);
  - a missing dir = empty;
  - a partial failure is reported.
- [ ] UI: count, size, downsampled thumbnails for the newest ≤ 12 `.jpg` files; "Wyczyść" with a confirm dialog that names the count and size.
- [ ] "O aplikacji": app version, the OpenMoji attribution text (exact string from ROADMAP), the license link as text.
- [ ] tablet run: seed a fake file into quarantine via the debug build, show it, clear it, check that it's gone.
- [ ] run tests — must pass before Task 11.

### Task 11: Phone — 7-day reclaim

**Files:**
- Modify: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/spool/SpoolReclaimer.kt`
- Modify: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/spool/Spool.kt` (query: acked before T)
- Modify: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/host/ServerHost.kt` (start after `recover()`, hourly, cancel in `stop()`)
- Modify: `camera-android/core/src/test/kotlin/pl/slava/kopernikadr/camera/spool/SpoolReclaimTest.kt`
- Modify: `README.md`, `docs/ARCHITECTURE.md` §4.6 (the first-launch warning)

- [ ] write tests first:
  - only frames acked ≥ 7 days ago (injected clock) are reclaimed;
  - unacked frames, frames acked < 7 days ago, and already reclaimed frames are never touched;
  - `reclaimedAt` is committed before the delete;
  - the low-space path is unchanged;
  - a clock earlier than `ackedAt` reclaims nothing;
  - an age pass and a low-space pass running at the same time are serialized (no lost or false `failedDeletes`).
- [ ] implement the age pass, the reclaimer-level mutex, and the schedule in `ServerHost`. Log a summary line with the count.
- [ ] Pixel run (probe build, never the g05):
  - backdate `ackedAt` of 2 acked test frames via `run-as` + sqlite;
  - restart the app and check the log count, that the files are gone, and that unacked frames are untouched.
- [ ] run the camera tests — must pass before Task 12.

### Task 12: Phone — ScreenPolicy dim

**Files:**
- Create: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/screen/ScreenPolicy.kt`
- Create: its test in `:core`
- Modify: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/MainActivity.kt`
- Modify: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/host/ServerHost.kt` (an activity callback fed by the server/session events: capture, controls, session open)

- [ ] write tests first (fake clock):
  - bright → dim after 2 min idle;
  - any activity → bright and the timer restarts;
  - the preview stream alone does not count;
  - an Activity pause/resume resets to bright;
  - no dim while the waiting card (QR) is shown.
- [ ] wire it: `window.attributes.screenBrightness` 0.05 / `BRIGHTNESS_OVERRIDE_NONE`, touches through `dispatchTouchEvent`, commands from the server. `FLAG_KEEP_SCREEN_ON` stays.
- [ ] Pixel run:
  - idle 2 min → dim (`dumpsys window` brightness / screencap);
  - a capture from the tablet → bright;
  - NSD still visible from the tablet while dim.
- [ ] run tests — must pass before Task 13.

### Task 13: Phone — quarantine show/clear (parent)

**Files:**
- Create: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/spool/QuarantineStore.kt` (+ test)
- Create: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/ui/QuarantineScreen.kt`
- Create: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/ui/ParentScreen.kt` (quarantine + a "Diagnostyka" button when available)
- Modify: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/ui/StatusScreen.kt` (the header hold becomes 3 s and is always on → the parent screen)
- Modify: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/MainActivity.kt` (`onTitleHeld` → the parent screen; Diagnostics is reached from there)

- [ ] write tests first:
  - list (the `SpoolFiles` name rule incl. `.dupN`, `.tmp`, `.<uuid>.tmp`; sizes; newest first);
  - clear deletes only files directly in `spool/quarantine/` that match the name rule, and nothing else (a stray file and a subdirectory survive);
  - the cleared count equals what the list showed.
- [ ] (no lock: `recover()` runs once per process before the server starts; record this in the KDoc.)
- [ ] UI: count, size, ≤ 12 newest downsampled thumbnails; "Wyczyść" → a confirmation where the parent types the file count.
- [ ] Pixel run:
  - put a test file into the probe build's quarantine via `run-as`;
  - open the screen with a 3 s hold (a 1.5 s hold opens nothing); "Diagnostyka" opens diagnostics;
  - clear it with the typed count and check that it's gone.
  - **Never on the g05.**
- [ ] run tests — must pass before Task 14.

### Task 14: E2E on the emulator — edit + sticker + export

**Files:**
- Modify: `remote/e2e/flow.cdp.mjs`
- Modify: `remote/e2e/lib.mjs`
- Modify: `remote/e2e/lib.test.mjs`
- Modify: `remote/e2e/README.md`

- [ ] add a step after capture:
  - duplicate, hold ×3, off one frame, add a sticker with a range;
  - export;
  - check the gallery file exists and that its duration = Σ hold / fps ± 1 tick (via `ffprobe` on the pulled file);
  - check that `project.json` matches.
- [ ] add the pure helper `expectedDurationS(items, fps)` + a unit test.
- [ ] run the full E2E flow on the emulator (all steps PASS).

### Task 15: Verify acceptance criteria
- [ ] Every item in the Overview works on the real tablet + Pixel (agent-run touch scripts, screencaps in `docs/diagnostics/<date>-stage3a-tablet.md`).
- [ ] A 500-frame project (ARCHITECTURE §8 acceptance): the strip scrolls smoothly; playback memory stays flat (8-bitmap ring + 32 MB sprite LRU, measured with `scripts/meminfo-sampler.sh`); export with stickers finishes.
- [ ] A project without `cut`/`stickers` behaves exactly as before.
- [ ] Downgrade caveat (documented, not fixed): an older app opens a new project file but its first write drops `cut`/`stickers`.
- [ ] Ack eligibility is unchanged: off never writes tombstones or unlinks files; a deleted frame → tombstone → ack only after expiry (runtime `FrameDeletion` and the startup sweep).
- [ ] Full suites:
  - `cd remote && npm test && npm run typecheck`;
  - `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - remote android build;
  - `cd remote && npm run test:scripts`;
  - `remote-core`, `probe-client`, `remote-lite`, `scripts` tests.
- [ ] A review by a Claude `code-reviewer` agent on the stage diff; fix the findings.

### Task 16: [Final] Update documentation
- [ ] `docs/ARCHITECTURE.md`:
  - §5.4: `cut`, `stickers`, `timeline()`;
  - §4.6: the 7-day reclaim and ScreenPolicy as built;
  - §8: stage 3 split into 3a+emoji / 3b;
  - decisions: trim is non-destructive, a curated OpenMoji set, "shoot on twos" dropped.
- [ ] `docs/ROADMAP.md`: mark 3a + emoji done; the next steps are 3b and the rest of the effects layer.
- [ ] `README.md`: how to edit a movie and add emoji; where quarantine is cleared.
- [ ] Move this plan to `docs/plans/completed/`.

## Post-Completion
*Items requiring manual intervention or external systems — informational only*

**Owner and kid:**
- Real use: shoot, edit, add emoji, export, watch in the gallery.
- Whether the "sticker until the end" default and the strip size suit a 9-year-old.
- Should a sticker placed "until the end" also cover frames shot AFTER it was placed? Today it does not.
- Is the 3 s hold + typed count enough to keep the kid away from phone quarantine clear, or is a parent PIN needed?

**Hardware:**
- g05: the camera upgrade waits for stages 1+2 Task 21, which goes first: back up the spool read-only, `install -r`, smoke test. The 7-day reclaim starts deleting acked frames on the g05 only after that install. The backup must be done before it.
- Family Link "Always allowed" for both apps; the release keystore (owner).
