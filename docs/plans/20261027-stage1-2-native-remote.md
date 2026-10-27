# Stages 1+2: native tablet remote — shooting, projects, playback + export

## Overview
- The native tablet app (`remote/`, Next.js static export + Capacitor 8) becomes the kid's remote
  and **replaces remote-lite**. After this plan she can, in one app:
  - pick or create a movie;
  - connect to the camera;
  - shoot with live preview and onion skin;
  - watch the movie;
  - export it to the tablet gallery.
- Merges ARCHITECTURE §8 stages **1** (shooting) and **2** (verified transfer, projects, retention).
  It also takes the **minimal playback + export** from stage 3, using the Mediabunny module
  proven in 0b. Owner decision, 2026-10-27.
- The frame strip, frame delete/Undo and the editing features (ROADMAP "Editing") stay in stage 3.
  Effects (OpenMoji, comics) and cloud AI come after.
- **Not in scope**:
  - importing movies shot with remote-lite: owner decision, they stay on the phone and remain
    reachable through remote-lite;
  - the QR deep link (NSD works on the tablet, and manual entry stays);
  - new camera features.
- remote-lite keeps working unchanged as a fallback until the owner retires it.

## Context (from discovery)
- **Specs:**
  - `docs/ARCHITECTURE.md`: §4.5–4.6 (capture path, recovery, retention), §5.1–5.8 (shell,
    CameraClient, preview, project model, ProjectStore, capture/transfer/ack, playback/export,
    deletion/Undo/recovery), §8 rows 1–3.
  - `protocol/PROTOCOL.md`: v1, frozen in 0b Task 15.
  - `docs/diagnostics/20261027-tablet.md`: the measured tablet facts.
- **Already built:**
  - camera app (`camera-android/`): durable spool with operation rows, admission under a mutex,
    `getOperation`, `listFrames`/`ack`/`getStatus`, derived `play`/`thumb` caches, sessions/BUSY,
    NSD advertiser, permission screen, keep-screen-on;
  - remote-core: `CameraConnection` (hello/session/ping/backoff/close codes), `PreviewLoop` (pull
    loop), protocol helpers, `nsd.js`;
  - remote (`remote/`): `KopernikadrNative` (`writeTextAtomic`, `installFile`, `freeBytes`, video
    writer + gallery publish, startup sweep), `KopernikadrNsd` + `lib/discovery.ts`,
    `lib/export/*` (codec ladder, Mediabunny export, native writer, `runExportBenchmark`),
    `lib/probes/*`, Diagnostics screen, i18n (pl/ru).
- **remote-lite** (`camera-android/core/src/main/resources/remote-lite/lib/`): reference for
  `captures.js` (outstanding captures), `store.js`, `frame-loader.js`, `video.js`,
  `export-core.js`, and for the kid-facing UX that works today.
- **Gaps on the camera side** (confirmed by the PROTOCOL v1 audit, 0b Task 15):
  - **`Spool.recover()` is not implemented** ("No recovery in 0a"). After a crash mid-capture
    the row stays `pending` and `getOperation` answers `pending` forever. The new remote polls
    outstanding requests, so this must be fixed first (Task 1);
  - acked frames are never reclaimed: `ack` only sets `ackedAt`, nothing writes `reclaimedAt`;
  - `orphanCount` and `integrityErrors` in `getStatus` are hardcoded to 0;
  - admission rejections (`GEOMETRY_MISMATCH`, `STORAGE_LOW`, `CAMERA_NOT_READY`,
    `CAPTURE_IN_PROGRESS`) leave no operation row, so `getOperation` answers `unknown`. A
    `failed` reqId replays its error, so every new capture press needs a new reqId;
  - `focusOk: false` also appears briefly while autofocus is still confirming, so the wire can't
    tell a transient miss from a timed-out lock (PROTOCOL v1 §6);
  - the 2-minute dim of `ScreenPolicy` is unverified.
- **Dependencies:** none new expected. Any new one must be a stable release at least 14 days old.
  The orchestrator serializes every `package-lock.json` change.

## Development Approach
- **Testing approach: mixed.**
  - TDD (tests first) for logic: ProjectStore reducers and persistence, CameraClient, the capture
    flow, transfer/reconcile/ack eligibility, camera-side retention.
  - Code first, then tests for UI components.
- Complete each task fully before moving to the next; small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for its code changes, covering success
  and error paths.
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- **Execution rules:**
  - one subagent at a time, model Sonnet, in its own worktree;
  - the orchestrator merges, runs device checks, commits and pushes at checkpoints.
- **Safety rules (unchanged):**
  - never `adb uninstall` or `pm clear` the camera app; upgrade with `install -r` only;
  - frames are deleted on the phone **only** through `ack` by their own clientId, and only when
    ack-eligible (§5.6);
  - remote-lite must keep working: run its tests after any remote-core or server change.
- **Test commands:**
  - `npm test --workspaces` (root);
  - `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - `node --test camera-android/core/src/test/remote-lite/*.test.mjs` (after
    `:core:processResources`);
  - `scripts/test/run.sh`.

## Testing Strategy
- **Unit (vitest):** pure reducers, mutation queue ordering, CameraClient state machine with a fake
  socket, transfer and reconcile with fake native + fake camera, playback scheduler, export
  orchestration.
- **Integration (vitest + `fake-camera.mjs`):** connect → capture → transfer → ack →
  reconnect → reconcile against the real fake camera over HTTP/WS. It uses an in-memory fake of
  the native file APIs that behaves like `installFile`/`writeTextAtomic`, including crash points.
- **Kotlin (`:core`):** retention/reclaim in the spool; admission under low space.
- **E2E on the emulator** (orchestrator): a CDP-driven script that runs the main flow against the
  fake camera. Screenshots + report.
- **Hardware** (owner, Post-Completion): the §8 row 2 failure list on the tablet + phone.

## Progress Tracking
- Mark completed items `[x]` immediately; ➕ for new tasks, ⚠️ for blockers.
- Keep the plan in sync with the actual work.

## Solution Overview
- **Data lives on the tablet** under `filesDir/kopernikadr/` (ARCHITECTURE §5.4).
  - `ProjectStore` is the only writer of `index.json` and `project.json`.
  - Every change is a pure function applied inside one async mutation queue and written with
    `writeTextAtomic`.
  - UI state is derived from the store through `useSyncExternalStore`. This is a small own store,
    like remote-lite's `store.js`; no zustand. It deviates from §5.1, and Task 18 records it.
- **CameraClient** wraps remote-core `CameraConnection` and adds:
  - discovery: NSD, then the remembered camera, then manual `/info`;
  - the single reconnect loop with connection generations;
  - app pause/resume;
  - hooks after every (re)connect: `resolveOutstanding()`, then `Transfer.reconcile()`.
- **Capture → transfer → ack** follows §5.6 exactly:
  - outstanding entries are durable before the network send;
  - frames are downloaded one at a time, `full` verified by size + sha256, then `installFile`;
  - `state: local` is committed **before** any ack;
  - `reconcile()` covers frames the tablet missed.
- **Playback** decodes `play` (1440×1080) into a ring buffer of 8 `ImageBitmap`s at the project's
  fps.
- **Export** reuses `lib/export/mediabunnyExport.ts` + `nativeWriter.ts`, fed from local
  **`play`** files. This is the 0b decision (≈3× faster than decoding 8 MP `full`). Transfers
  pause while it runs; Cancel only in `encoding`.
- **Camera side:**
  - small additions only: acked-frame reclaim (7 days / low space, `reclaimedAt` first) and the
    phone's dim policy;
  - the protocol stays at v1. If a protocol change turns out to be needed, it is a ⚠️ blocker for
    the owner, not a silent edit.

## Technical Details
- **Directories** (`filesDir/kopernikadr/`):
  - `index.json`, `projects/{id}/project.json`;
  - `projects/{id}/frames/{frameId}.{full|play|thumb}.jpg`;
  - `tmp/` (downloads), `exports/` (video writer), `probe/` (diagnostics).
- **Schemas:**
  - `index.json` = `{version: 1, clientId, rememberedCamera: {cameraId, host, port} | null,
    projects: [{id, name, createdAt}], deletedProjects: [id], pendingProjectDeletes: [{id,
    deadline}]}`;
  - `project.json` as in §5.4, plus `version: 1`.
  - Unknown future `version` → read-only + a parent warning. Corrupt JSON → keep the file
    renamed to `*.corrupt-<ts>`, rebuild from the directory listing (recovery) and warn the parent.
- **Constants:**

  | Constant | Value |
  |---|---|
  | ping | every 2 s |
  | offline after | 5 s without a reply |
  | reconnect backoff | 0.5 → 5 s |
  | preview watchdog | 3 s |
  | `resolveOutstanding` poll | 1 s |
  | Undo window | 5 s |
  | download reserve | 300 MB + the frame's `full` + 1 MB |
  | export reserve | 300 MB (native) |
  | phone reclaim of acked frames | after 7 days or under low space (spool reserve 500 MB) |
  | fps | default 8, per project, choices 5/8/12 |

- **Ack eligibility:** `state == local` ∨ `frameId ∈ deletedFrameIds` ∨ project ∈
  `deletedProjects`. Nothing else is ever acked.
- **Startup sequence:**
  1. the native sweep (`videoCleanupAbandoned`, at plugin load);
  2. ProjectStore load + startup sweep (§5.8);
  3. UI;
  4. connect;
  5. `resolveOutstanding`;
  6. `reconcile`.

## What Goes Where
- **Implementation Steps:** code, tests, docs and emulator runs in this repo.
- **Post-Completion:** the tablet + phone session with the owner (failure list, the kid's first
  real use, Family Link).

## Implementation Steps

Order (one agent at a time): 1 → 2 → 3 → … → 18. Tasks 1–3 (camera) are independent of the
remote tasks but go first, because Task 9 (capture flow) relies on Task 1.

### Task 1: Camera: spool recovery at process start (TDD)

**Files:**
- Modify: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/spool/{Spool.kt,SpoolFrameStore.kt}`, the process-start wiring in `:app` (before the server opens)
- Create/Modify: tests in `camera-android/core/src/test/kotlin/.../spool/`

- [ ] tests first, then `Spool.recover()` per ARCHITECTURE §4.6, run once per process before
      the server accepts commands:
  - `pending` + valid `full` (SOI/EOI, decodable) → sha256 → `committed`;
  - `pending` without a valid file → delete leftovers → `failed(INTERRUPTED)`;
  - `committed`, unacked, file missing → mark `lost`, counted as `integrityErrors`;
  - `reclaimedAt` set but files exist → delete the files;
  - `*.tmp` and files with no row → delete
- [ ] `getOperation` for a recovered row answers `done`/`failed(INTERRUPTED)`, never a stale
      `pending`
- [ ] `getStatus`: real `integrityErrors` and `orphanCount` (unacked frames of other clientIds)
      instead of the hardcoded 0
- [ ] write tests: each table row, a crash between rename and the commit, idempotent double run,
      other clients' frames untouched
- [ ] **the kid's existing spool**: recovery only promotes or fails `pending` rows and deletes
      junk; it never deletes a committed frame's files. Write a test proving that
- [ ] run the camera + remote-lite tests — must pass before Task 2

### Task 2: Camera: reclaim acked frames (retention)

**Files:**
- Modify: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/spool/Spool.kt`, `SpoolFrameStore.kt`, the capture admission (`SpoolCaptureService.kt`), the host wiring in `:app`
- Create/Modify: tests in `camera-android/core/src/test/kotlin/.../spool/`

- [ ] tests first:
  - acked frames older than 7 days are reclaimed;
  - unacked frames are never touched;
  - `reclaimedAt` is written before the files are deleted;
  - a crash between the two is finished by `recover()`;
  - other clients' frames are never reclaimed unless acked by their owner
- [ ] `Spool.reclaimAcked(olderThan, now)`; run it at process start (after `recover()`) and
      every hour while started
- [ ] admission step 2: under low space, reclaim acked frames oldest-first until
      `free − 500 MB ≥ 2 × expected full`, else `STORAGE_LOW`
- [ ] tests for the low-space path (fake disk) and for `STORAGE_LOW`
- [ ] run the camera + remote-lite tests — must pass before Task 3

### Task 3: Camera: dim policy + orphans on the diagnostics screen

**Files:**
- Modify: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/MainActivity.kt` (or a new `ScreenPolicy.kt`), `ui/StatusScreen.kt`, the diagnostics screen
- Create: a `:core` test for the pure inactivity timer

- [ ] `ScreenPolicy`:
  - keep-screen-on while started;
  - after 2 min without remote commands or touches, window brightness drops to ~5%;
  - any command or touch restores it.

  The timer logic is pure in `:core`, so it can be unit-tested.
- [ ] the phone diagnostics screen shows the orphan count and size (from the spool stats,
      real values after Task 1)
- [ ] write tests for the timer (activity resets, the threshold, a command from the server
      counts as activity)
- [ ] run tests — must pass before Task 4

### Task 4: Remote app shell: views, store hook, i18n, layout

**Files:**
- Create: `remote/lib/state/{store.ts,useStore.ts}`, `remote/components/{AppShell.tsx,ProjectsView.tsx,ConnectView.tsx,CaptureView.tsx,PlayView.tsx}` (stubs)
- Modify: `remote/app/page.tsx`, `remote/components/Home.tsx`, `remote/lib/i18n/{pl,ru}.ts`, `remote/app/globals.css`

- [ ] hash views `#/projects` (default), `#/connect`, `#/capture/<id>`, `#/play/<id>`,
      `#/diagnostics`; Android back button through `@capacitor/app`
- [ ] a tiny observable store + `useSyncExternalStore` hook (no new dependency)
- [ ] the kid-facing layout baseline:
  - landscape 1920×1200;
  - big touch targets, at least 64 px;
  - icons over text;
  - Polish and Russian strings;
  - parent-only things behind a long-press, like the camera app
- [ ] write tests: router parsing, store subscribe/notify, i18n key parity pl/ru
- [ ] run tests — must pass before Task 5

### Task 5: ProjectStore: model + pure reducers (TDD)

**Files:**
- Create: `remote/lib/projects/{model.ts,reducers.ts}` + tests

- [ ] tests first, then the types for `index.json`/`project.json` (version 1) and validation
      (unknown version, missing fields, bad types)
- [ ] reducers, all pure:
  - create/rename project;
  - add/remove outstanding;
  - merge frame (monotonic, tombstone-aware, keyed by `frameId`, ordered by `seq`);
  - set local;
  - bind camera + freeze geometry on the first capture;
  - hide/unhide/expire project;
  - recovered project from `FrameInfo`
- [ ] ack eligibility as a pure function
- [ ] write tests: the monotonic-merge table (§5.5), tombstones, duplicate results via capture
      + reconcile, geometry freeze, camera binding
- [ ] run tests — must pass before Task 6

### Task 6: ProjectStore: persistence, mutation queue, startup sweep (TDD)

**Files:**
- Create: `remote/lib/projects/{store.ts,files.ts,sweep.ts}` + tests, `remote/lib/projects/fakeFs.testutil.ts`

- [ ] tests first, then one async mutation queue:
  - load → reducer → `writeTextAtomic`;
  - a mutation's promise resolves after the write;
  - a failed write leaves memory and disk consistent (the reducer result is applied only after
    the write succeeds);
  - mutations are serialized
- [ ] file access through an injected adapter: `KopernikadrNative` + `Filesystem` (listing,
      `getUri`, delete) in the app, an in-memory fake in tests
- [ ] corrupt/unknown-version handling as in Technical Details
- [ ] startup sweep (§5.8):
  - promote matching `pending` installs;
  - empty `tmp/`;
  - delete unreferenced files under `frames/`;
  - remove tombstoned dirs;
  - re-add missing project dirs;
  - expire past deadlines
- [ ] write tests incl. crash points (kill after `installFile` before `local`, kill between
      tombstone commit and unlink)
- [ ] run tests — must pass before Task 7

### Task 7: CameraClient: discovery, single reconnect loop, lifecycle (TDD)

**Files:**
- Create: `remote/lib/camera/{client.ts,discover.ts}` + tests
- Modify (only if needed, JSDoc-level or additive): `packages/remote-core/src/connection.js`

- [ ] tests first, then target selection:
  - a project bound to a `cameraId` looks for that one;
  - otherwise the remembered camera, else the single one found;
  - else the connect screen.

  Manual `host:port` is checked with `GET /info`. The remembered camera is saved in `index.json`.
- [ ] connection generations, so callbacks from a superseded socket are ignored:
  - `4001` → stop and show "Przejmij" (take over);
  - `4002` → reconnect only if this socket still owns the current generation;
  - `4003 BUSY` → retry after `retryAfterMs`;
  - app pause/resume (`@capacitor/app`) and timeouts reuse the same loop
- [ ] observable status: `searching | connecting | online | offline | busy | replaced |
      wrong-camera`; `bootId` changes are surfaced, so preview and outstanding restart
- [ ] after every (re)connect: hooks run `resolveOutstanding()` then `reconcile()`; they are
      injected, wired in Tasks 9–10
- [ ] write tests with a fake socket/discovery: every close code, a superseded socket, resume
      during backoff, wrong camera, BUSY retry
- [ ] if a remote-core change is needed: run the remote-lite tests too
- [ ] run tests — must pass before Task 8

### Task 8: Connect view + preview with watchdog + onion skin

**Files:**
- Create: `remote/components/{ConnectView.tsx,Preview.tsx,OnionSkin.tsx}`, `remote/lib/camera/previewController.ts` + test

- [ ] the connect view:
  - found cameras (NSD) and their status;
  - a manual address field;
  - "Przejmij" after `4001`;
  - plain messages for BUSY and wrong-camera
- [ ] `previewController` wraps remote-core `PreviewLoop`:
  - the 3 s watchdog;
  - restart on resume / new `bootId` / new session;
  - closes the previous bitmap.

  Preview quality is a parent setting.
- [ ] onion skin: the last frame's local `play` (or `thumb` until `play` arrives) over the live
      view, opacity slider, toggle; a 3×3 grid toggle
- [ ] write tests for `previewController` (watchdog fires, restart on new bootId, no double
      loops) with a fake loop
- [ ] run tests — must pass before Task 9

### Task 9: Capture flow: outstanding, results, resolveOutstanding (TDD)

**Files:**
- Create: `remote/lib/capture/{capture.ts,outstanding.ts}` + tests

- [ ] tests first, then capture:
  1. mutation `add outstanding{reqId}` (awaited);
  2. send `capture{projectId, rotation}`;
  3. on the result, mutation: remove outstanding + merge the frame, bind the camera and freeze
     geometry on the first frame;
  4. enqueue the download (Task 10)
- [ ] error mapping, never auto-retaking:
  - `CAPTURE_IN_PROGRESS`, `CAMERA_NOT_READY`, `STORAGE_LOW`, `GEOMETRY_MISMATCH` and others
    → kid-level messages;
  - for `failed`/`unknown`, drop the entry and show "nie wyszło, spróbuj jeszcze raz"
- [ ] `resolveOutstanding()`: `getOperation` per entry → `done` → result, `pending` → poll every
      1 s, `failed/unknown` → drop (admission rejections answer `unknown`, PROTOCOL v1 §6)
- [ ] every shutter press uses a **new** reqId; a retry after `failed` is a new capture
- [ ] a project bound to another `cameraId` → shooting is blocked with a "new movie needed"
      message; watch/export still work
- [ ] write tests: lost response then reconnect, duplicate result via reconcile, capture during
      offline, rotation mismatch
- [ ] run tests — must pass before Task 10

### Task 10: Transfer: verified download, install, ack, reconcile (TDD)

**Files:**
- Create: `remote/lib/transfer/{queue.ts,download.ts,reconcile.ts}` + tests, `remote/lib/transfer/integration.test.ts` (fake camera)

- [ ] tests first, then a one-at-a-time download queue (ids, not bytes), priority to the newest
      frame:
  - `thumb` → `play` → `full` via `@capacitor/file-transfer` into `tmp/`;
  - `full` verified by size + sha256 (`fetch(convertFileSrc)` + `crypto.subtle`);
  - caches checked by Content-Length + decode and regenerated from `full` if unavailable
- [ ] install mutation:
  - re-check tombstones;
  - `installFile` → `state: local`, committed;
  - **then** ack (batched)
- [ ] admission:
  - `freeBytes` ≥ 300 MB + `full` + 1 MB, else pause with "Tablet storage full" for the parent;
  - ENOSPC → pause + delete the tmp file;
  - the queue pauses while an export runs
- [ ] `reconcile()` over `listFrames` (our clientId, unacked, paged):
  - ack-eligible → ack;
  - pending → resume;
  - unknown in a live project → merge + download;
  - unknown `projectId` not tombstoned → "Odzyskany <date>" project
- [ ] write tests:
  - the ack-eligibility table;
  - a sha256 mismatch → retry, never ack;
  - kill points (after download, after install, before ack);
  - Wi-Fi drop mid-download;
  - storage full;
  - the integration flow capture → transfer → ack → reconnect → reconcile against
    `fake-camera.mjs`
- [ ] run tests — must pass before Task 11

### Task 11: Capture view + parent drawer

**Files:**
- Modify: `remote/components/CaptureView.tsx`
- Create: `remote/components/{ShutterButton.tsx,ParentDrawer.tsx,ConnectionBadge.tsx}` + tests (component tests with the fake client)

- [ ] the kid UI:
  - preview + onion skin;
  - a big shutter with the sound and flash feedback (reuse remote-lite's `sound.js` idea);
  - the frame counter;
  - pending-capture placeholders;
  - a connection badge;
  - error toasts;
  - "play" and "back to movies" buttons
- [ ] the parent drawer (long-press):
  - exposure/WB/focus lock with `confirmed`/`settling`; "lock failed" via remote-core
    `isLockFailed`, shown only once `settling` is false (focus `focusOk:false` is transient while
    confirming);
  - exposure compensation (only when not frozen);
  - rotation 0/180 for empty projects only;
  - preview quality;
  - fps;
  - camera info and the transfer queue status
- [ ] keep-awake while the capture view is open
- [ ] write component tests: shutter disabled while offline / outstanding at the limit, drawer
      rules (rotation locked after the first frame, compensation hidden when frozen)
- [ ] run tests — must pass before Task 12

### Task 12: Projects view: create, rename, delete + Undo

**Files:**
- Modify: `remote/components/ProjectsView.tsx`
- Create: `remote/lib/projects/deletion.ts` + test

- [ ] the movies list:
  - big cards with a cover (the first frame's `thumb`), name, frame count;
  - a "new movie" card;
  - tap → capture or play
- [ ] rename (parent long-press or a simple dialog); delete:
  - `pendingProjectDeletes` with a 5 s Undo;
  - expiry → tombstone → commit → remove the dir;
  - after the commit, the project's unacked frames become ack-eligible and are acked by the
    next reconcile
- [ ] write tests: Undo inside the window, expiry at startup for past deadlines, acking after
      delete
- [ ] run tests — must pass before Task 13

### Task 13: Playback view

**Files:**
- Modify: `remote/components/PlayView.tsx`
- Create: `remote/lib/play/{player.ts,ring.ts}` + tests

- [ ] a canvas player:
  - a ring buffer of 8 `ImageBitmap`s from local `play` (`fetch(convertFileSrc)` →
    `createImageBitmap`), closed on eviction;
  - rAF timing at the project's fps;
  - play/pause, loop
- [ ] frames that are not local yet are skipped, with a "N klatek jeszcze się pobiera" note
- [ ] the ring buffer is released before an export starts and when leaving the view
- [ ] write tests: the scheduler (fps timing with a fake clock), eviction closes bitmaps,
      skipping non-local frames
- [ ] run tests — must pass before Task 14

### Task 14: Export from the app

**Files:**
- Create: `remote/lib/export/projectExport.ts` + test, `remote/components/ExportDialog.tsx`
- Modify: `remote/components/PlayView.tsx`

- [ ] `projectExport`:
  - requires all frames `local`, else "waiting for N frames";
  - pauses transfers;
  - builds the source from local `play` files;
  - `pickCodec` → `exportVideo` → native writer → publish `kopernikadr-<name>-<date>.mp4`;
  - resumes transfers afterwards
- [ ] the dialog:
  - progress;
  - Cancel only in `encoding`;
  - "Zapisano w galerii" at the end;
  - a plain error with a retry
- [ ] write tests: the state machine (cancel only in encoding, publish/abort exclusive),
      transfers paused/resumed, the not-all-local gate
- [ ] run tests — must pass before Task 15

### Task 15: App lifecycle wiring + startup

**Files:**
- Create: `remote/lib/app/{boot.ts,lifecycle.ts}` + tests
- Modify: `remote/components/AppShell.tsx`

- [ ] boot: ProjectStore load + sweep → UI → CameraClient → `resolveOutstanding` →
      `reconcile` (the native export sweep already ran at plugin load)
- [ ] pause/resume:
  - preview stops on pause;
  - the client reuses its loop on resume;
  - transfers continue while foreground only;
  - keep-awake is held only in the capture view and during an export
- [ ] the Diagnostics view stays reachable for the parent; probes keep working
- [ ] write tests for the boot order (fakes) and resume behaviour
- [ ] run tests — must pass before Task 16

### Task 16: Emulator E2E + install on the tablet

**Files:**
- Create: `remote/e2e/flow.cdp.mjs` (a CDP-driven script, like the 0b probes driver), `docs/diagnostics/<date>-stage1-2-emulator.md`
- Modify: `remote/android/app/build.gradle` (`versionCode`/`versionName` bump)

- [ ] emulator against `fake-camera.mjs`:
  1. create a movie;
  2. connect;
  3. shoot 10 frames;
  4. kill the app mid-transfer;
  5. relaunch → reconcile completes;
  6. play;
  7. export → in the gallery (ffprobe check);
  8. delete a movie + Undo;
  9. delete → its frames get acked
- [ ] install the debug build on the tablet (owner connects it) and smoke against the Pixel or
      g05
- [ ] fix what's found (➕ tasks if larger)
- [ ] run the full suite — must pass before Task 17

### Task 17: Verify acceptance criteria
- [ ] every Overview bullet works on the emulator; tablet smoke done
- [ ] the safety rules hold:
  - no ack outside eligibility (grep + tests);
  - remote-lite tests green;
  - the camera never deletes unacked frames
- [ ] full suite:
  - `npm test --workspaces`;
  - `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - the remote-lite node tests;
  - `scripts/test/run.sh`
- [ ] a Codex review of the batch; fix the material findings

### Task 18: [Final] Update documentation
- [ ] `docs/ARCHITECTURE.md`:
  - §5 matches what was built (own store instead of zustand, hash views, export from `play`,
    no deep link);
  - §8 stages 1–2 done
- [ ] `README.md`:
  - how the kid uses the tablet app;
  - the parent drawer;
  - where movies are;
  - "uninstalling the remote deletes movies";
  - remote-lite as the fallback
- [ ] `docs/ROADMAP.md`: stages 1+2 done; next = stage 3 (strip + editing) and the effects layer
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Hardware session (owner, tablet + g05):** the §8 row 2 failure list:
- Wi-Fi off mid-transfer;
- the phone locked during a capture;
- each app killed around capture / install / ack;
- a lost capture response;
- low storage on each side;
- locks holding across phone lock/unlock;
- the onion skin lining up in the grid test.

**First real use with the kid:** a short movie start to finish in the app; collect UX notes for
stage 4.

**Release:**
- the owner creates the release keystore;
- a release build is installed on the tablet;
- Family Link "Always allowed" for both apps.
