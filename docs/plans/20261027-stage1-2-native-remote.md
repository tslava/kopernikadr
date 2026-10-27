# Stages 1+2: native tablet remote — shooting, projects, playback + export

Rev 2 (2026-10-27): revised after the plan review (all critical and important findings accepted;
the 7-day reclaim timer and the phone dim policy deferred to stage 3).

## Overview
- The native tablet app (`remote/`, Next.js static export + Capacitor 8) becomes the kid's remote
  and **replaces remote-lite**. After this plan she can, in one app:
  - pick or create a movie;
  - connect to the camera;
  - shoot with live preview and onion skin;
  - watch the movie;
  - export it to the tablet gallery.
- Merges ARCHITECTURE §8 stages **1** (shooting) and **2** (verified transfer, projects,
  retention). It also takes the **minimal playback + export** from stage 3, using the Mediabunny
  module proven in 0b. Owner decision, 2026-10-27.
- The frame strip, frame delete/Undo and the editing features (ROADMAP "Editing") stay in stage 3.
  Effects (OpenMoji, comics) and cloud AI come after.
- **Not in scope**:
  - importing movies shot with remote-lite: owner decision, they stay on the phone and remain
    reachable through remote-lite;
  - the QR deep link (NSD works on the tablet, and manual entry stays);
  - new camera features;
  - deferred to stage 3: the 7-day reclaim timer and the phone dim policy (`ScreenPolicy`).
- remote-lite keeps working unchanged as a fallback until the owner retires it.

## Context (from discovery)
- **Specs:**
  - `docs/ARCHITECTURE.md`: §4.5–4.6, §5.1–5.8, §7, §8 rows 1–3;
  - `protocol/PROTOCOL.md`: v1, frozen 2026-10-27. Its "Today" notes describe the current camera
    and are updated when this plan changes camera behaviour;
  - `docs/diagnostics/20261027-tablet.md`: the measured tablet facts.
- **Already built:**
  - camera app (`camera-android/`): durable spool with operation rows, admission under a mutex,
    `getOperation`, `listFrames`/`ack`/`getStatus`, derived `play`/`thumb` caches, sessions/BUSY,
    NSD advertiser, permission screen, keep-screen-on;
  - remote-core:
    - `CameraConnection`: hello/session/ping, the token-based single reconnect loop, backoff,
      BUSY `retryAfterMs`, `closeAction`, `reconnectNow()`;
    - `PreviewLoop`, protocol helpers incl. `isLockFailed`, `nsd.js`;
  - remote (`remote/`):
    - `KopernikadrNative`: `writeTextAtomic`, `installFile` (verifies size + sha256 natively),
      `freeBytes`, video writer + gallery publish, startup sweep;
    - `KopernikadrNsd` + `lib/discovery.ts`;
    - `lib/export/*`: codec ladder, Mediabunny export, native writer;
    - `lib/probes/*`, the Diagnostics screen, i18n (pl/ru);
  - `protocol/tools/probe-client/fake-camera.mjs`: the fake camera. It has `/fake/kick` and
    `/fake/drop-capture`, but no switches for a `cameraId` change, `STORAGE_LOW` or a 404 `full`.
- **remote-lite** (`camera-android/core/src/main/resources/remote-lite/`) is the reference for the
  kid-facing UX that works today: `captures.js`, `store.js`, `frame-loader.js`, `video.js`,
  `export-core.js`.
  - remote-lite **never acks** and uses its own `clientId` from localStorage. To the camera, all
    its movies are unacked frames of another client.
- **Gaps on the camera side** (confirmed by the PROTOCOL v1 audit, 0b Task 15):
  - **`Spool.recover()` is not implemented**: after a crash mid-capture the row stays `pending`
    and `getOperation` answers `pending` forever;
  - acked frames are never reclaimed;
  - `orphanCount` and `integrityErrors` in `getStatus` are hardcoded to 0;
  - admission rejections (`GEOMETRY_MISMATCH`, `STORAGE_LOW`, `CAMERA_NOT_READY`,
    `CAPTURE_IN_PROGRESS`) leave no operation row (`getOperation` → `unknown`). A `failed` reqId
    replays its error, so every capture press needs a new reqId;
  - `focusOk: false` also appears briefly while autofocus is still confirming;
  - `ScreenPolicy` (the dim after 2 min) is not implemented; deferred.
- **Dependencies:** none new expected. Any new one must be a stable release at least 14 days old;
  the orchestrator serializes `package-lock.json` changes.

## Development Approach
- **Testing approach: mixed.**
  - TDD (tests first) for logic: spool recovery and reclaim, ProjectStore, CameraClient, the
    capture flow, transfer/reconcile/ack eligibility.
  - Code first, then tests for UI components.
- Complete each task fully before moving to the next; small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for its code changes, covering success
  and error paths.
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- **Execution rules:**
  - one subagent at a time, model Sonnet, in its own worktree;
  - the orchestrator merges, runs device checks, commits and pushes at checkpoints.
- **Safety rules:**
  - never `adb uninstall` or `pm clear` the camera app; upgrade with `install -r` only;
  - frames are removed on the phone **only** through `ack` by their own clientId when
    ack-eligible (§5.6), and then only under low space (Task 2);
  - the camera never deletes a `full` file it can't account for: it quarantines it;
  - **before the first install of a camera build with Task 1 or 2 on the g05**, the orchestrator
    backs up the kid's spool (Task 21);
  - remote-lite must keep working: run its tests after any remote-core or server change.
- **Test commands:**
  - `npm test --workspaces` (root);
  - `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - `node --test camera-android/core/src/test/remote-lite/*.test.mjs` (after
    `:core:processResources`);
  - `scripts/test/run.sh`.

## Testing Strategy
- **Unit (vitest):**
  - pure reducers and the mutation queue ordering;
  - CameraClient target selection with fakes;
  - capture, transfer and reconcile with a fake native layer and a fake camera;
  - the playback scheduler and the export orchestration.
- **Integration (vitest + `fake-camera.mjs`):**
  - connect → capture → transfer → ack → reconnect → reconcile against the real fake camera
    over HTTP/WS;
  - an in-memory fake of `installFile`/`writeTextAtomic` with crash points;
  - fake-camera switches for §7: new `bootId`, a `cameraId` change, `STORAGE_LOW`, a 404 `full`,
    a dropped capture response, pending forever.
- **Kotlin (`:core`):** recovery (each §4.6 row, quarantine), reclaim under low space, races with
  derived-file generation.
- **E2E on the emulator** (orchestrator): a CDP-driven script for the main flow against the fake
  camera, with pass/fail checks.
- **Hardware** (owner, Post-Completion): the §8 row 2 failure list on the tablet + phone.

## Progress Tracking
- Mark completed items `[x]` immediately; ➕ for new tasks, ⚠️ for blockers.
- Keep the plan in sync with the actual work.

## Solution Overview
- **Data lives on the tablet** under `filesDir/kopernikadr/` (ARCHITECTURE §5.4).
  - `ProjectStore` is the only writer of `index.json` and `project.json`.
  - Every change is a pure function applied inside one async mutation queue and written with
    `writeTextAtomic`.
  - UI state comes from the store through `useSyncExternalStore` (a small own store, no zustand;
    a deviation from §5.1 recorded in Task 23).
- **CameraClient** is a thin layer over remote-core `CameraConnection`, which already owns the
  one reconnect loop. It adds:
  - target selection: NSD, the remembered camera, manual `/info`;
  - `rememberedCamera` in `index.json`;
  - wrong-camera and `bootId` detection;
  - hooks after **every** new session: `resolveOutstanding()`, then `reconcile()`.
- **Capture → transfer → ack** follows §5.6:
  - the outstanding entry `{reqId, cameraId, sentAt}`, the camera binding and the geometry freeze
    are written in **one** mutation before the send;
  - downloads go one at a time into `tmp/`. `installFile` verifies `full` (size + sha256)
    natively; `play`/`thumb` are best-effort;
  - `state: local` is committed **before** any ack;
  - `reconcile()` covers frames the tablet missed.
- **Playback** uses a ring buffer of 8 `ImageBitmap`s from local `play`. If `play` is missing it
  falls back to `full` with `resizeWidth/Height` 1440×1080.
- **Export** reuses `lib/export/*`:
  - source `play`, with the same `full` fallback;
  - transfers pause while it runs, and shooting is blocked;
  - Cancel only in `encoding`.
- **Camera side:** recovery, plus reclaim of acked frames under low space only. The protocol wire
  stays v1; only PROTOCOL.md's "Today" notes change. A wire change is a ⚠️ blocker for the owner.

## Technical Details
- **Directories** (`filesDir/kopernikadr/`):
  - `index.json`, `projects/{id}/project.json`;
  - `projects/{id}/frames/{frameId}.{full|play|thumb}.jpg`;
  - `tmp/` (downloads), `exports/` (video writer), `probe/` (diagnostics).
- **Schemas:**
  - `index.json` = `{version: 1, clientId, rememberedCamera: {cameraId, host, port} | null,
    projects: [{id, name, createdAt}], deletedProjects: [id], pendingProjectDeletes: [{id,
    deadline}]}`;
  - `project.json` as in §5.4, plus `version: 1`. Each frame entry may carry
    `unavailable: {reason, since}`, a UI/store flag that is never acked.
  - Unknown future `version` → read-only + a parent warning. Corrupt JSON → keep the file renamed
    to `*.corrupt-<ts>`, rebuild from the directory listing and warn the parent.
- **Constants:**

  | Constant | Value |
  |---|---|
  | ping | every 2 s |
  | offline after | 5 s without a reply |
  | reconnect backoff | 0.5 → 5 s |
  | preview watchdog | 3 s |
  | capture send timeout | 10 s → `resolveOutstanding` for that reqId |
  | `resolveOutstanding` poll | 1 s |
  | `pending` give-up | 30 s continuous, or `pending` after a `bootId` change |
  | outstanding limit | 1 (the camera answers `CAPTURE_IN_PROGRESS` anyway) |
  | download retries | 3 per frame with backoff, then `unavailable` (retried by the next reconcile) |
  | Undo window | 5 s |
  | download reserve | 300 MB + the frame's `full` + 1 MB |
  | export reserve | 300 MB (native) |
  | phone reclaim | acked frames only, under low space only (spool reserve 500 MB), oldest `ackedAt` first |
  | fps | default 8, per project, choices 5/8/12 |

- **Ack eligibility:** `state == local` ∨ `frameId ∈ deletedFrameIds` ∨ project ∈
  `deletedProjects`. A project in `pendingProjectDeletes` (inside the Undo window) is **not**
  eligible. Nothing else is ever acked.
- **Spool recovery file rule:** only names matching
  `^[0-9A-Z]{26}\.(full|play|thumb)\.jpg(\.tmp)?$` are touched.
  - `*.tmp` are deleted.
  - `play`/`thumb` with no row are deleted.
  - A `full` with no row is **moved to `spool/quarantine/`**, never deleted.
  - `spool.db*` and unknown names are never touched.
- **Startup sequence:**
  1. the native export sweep (at plugin load);
  2. ProjectStore load + startup sweep (§5.8);
  3. UI;
  4. connect;
  5. on every session: `resolveOutstanding`, then `reconcile`.

## What Goes Where
- **Implementation Steps:** code, tests, docs and emulator runs in this repo.
- **Post-Completion:** the tablet + phone session with the owner (failure list, the kid's first
  real use, Family Link).

## Implementation Steps

Order: 1 → 2 → … → 23, one agent at a time.
- Tasks 1–3 (camera + fake camera) come first.
- Task 12 wires the app together early, so every later UI task runs inside the real boot
  sequence.
- Tasks 21 and 22 need the owner and hardware.

### Task 1: Camera: spool recovery at process start (TDD)

**Files:**
- Modify: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/spool/{Spool.kt,SpoolFrameStore.kt}`, the process-start wiring in `:app` (before the server opens), `protocol/PROTOCOL.md` ("Today" notes in §4, §6 `getOperation`/`getStatus`, §9)
- Create/Modify: tests in `camera-android/core/src/test/kotlin/.../spool/`, a contract fixture for `getOperation` → `failed(INTERRUPTED)`

- [x] tests first, then `Spool.recover()` per ARCHITECTURE §4.6, run once per process before the
      server accepts commands:
  - `pending` + valid `full` (SOI/EOI, decodable) → sha256 → `committed`;
  - `pending` without a valid file → delete its tmp leftovers → `failed(INTERRUPTED)`;
  - `committed`, unacked, file missing → `lost`;
  - `reclaimedAt` set but files exist → delete the files;
  - stray files: the file rule from Technical Details (pattern only, quarantine a `full` with no
    row, never touch `spool.db*` or unknown names)
- [x] the wire for recovered rows, with no new codes:
  - `getOperation` answers `done` or `failed(INTERRUPTED)`, never a stale `pending`;
  - a `lost` frame answers `failed` with the existing integrity code (or `INTERNAL`); document
    the choice in PROTOCOL.md
- [x] `getStatus`:
  - real `integrityErrors` (lost + quarantined);
  - real `orphanCount`: unacked frames of other clientIds, which today are remote-lite's movies.
    The doc wording says "frames of other remotes"
- [x] tests:
  - each table row;
  - a crash between the rename and the commit;
  - an idempotent double run;
  - a `full` with no row is quarantined, not deleted;
  - `spool.db*` and unknown names are untouched;
  - other clients' (remote-lite's) frames are untouched;
  - a committed frame's files are never deleted
- [x] update PROTOCOL.md "Today" notes and add a changelog line (wire unchanged)
- [x] run the camera + remote-lite tests — must pass before Task 2

### Task 2: Camera: reclaim acked frames under low space (TDD)

**Files:**
- Modify: `Spool.kt`, `SpoolFrameStore.kt`, `SpoolCaptureService.kt` (admission), `protocol/PROTOCOL.md` (§6 `STORAGE_LOW`, §9 "Today")
- Create/Modify: spool tests

- [x] tests first, then admission step 2:
  - when `free − 500 MB < 2 × expected full`, reclaim **acked** frames, oldest `ackedAt` first;
  - write `reclaimedAt` → commit → delete the files, until enough space is free;
  - else `STORAGE_LOW`
- [x] no timer and no 7-day expiry (deferred to stage 3)
- [x] lock ordering with `SpoolFrameStore` derived-file generation and prefetch: a reclaim never
      races a `play`/`thumb` generation of the same frame. A request for a reclaimed frame's file
      answers 404 per PROTOCOL
- [x] tests:
  - only acked frames are reclaimed, never unacked or other clients' frames;
  - `reclaimedAt` comes before the delete;
  - the crash in between is finished by `recover()`;
  - the race with a derived-file generation;
  - `STORAGE_LOW` when nothing acked is left
- [x] update PROTOCOL.md "Today" notes
- [x] run the camera + remote-lite tests — must pass before Task 3

- ➕ Tasks 1–2 notes (agent, accepted):
  - tmp files are really named `….jpg.<uuid>.tmp` (DurableFiles); the name rule accepts that too;
  - a pending row with a bad `full` is quarantined as well;
  - `orphanCount` is relative to the session's client (0 without a session);
  - quarantined files count in `integrityErrors` until removed by hand;
  - recovered `capturedAt` = file mtime;
  - admission sizes the next `full` as the max of the last 8 (5 MB default);
  - `DerivedFiles` uses per-frame striped locks against reclaim

### Task 3: Fake camera: failure switches for §7

**Files:**
- Modify: `protocol/tools/probe-client/fake-camera.mjs` + its tests

- [x] switches (HTTP `/fake/...` or options):
  - restart with a new `bootId`;
  - change `cameraId`;
  - `STORAGE_LOW` on the next capture;
  - 404 for a given frame's `full`;
  - a corrupted `full` (sha mismatch);
  - `pending` forever for the next capture;
  - reclaim (acked frame files → 404)
- [x] keep `/fake/kick` and `/fake/drop-capture` and the existing behaviour (the probes and the
      remote-lite tests use it)
- [x] write tests for each switch
- [x] run the probe-client + remote tests — must pass before Task 4

### Task 4: Remote app shell: views, store hook, i18n, layout

**Files:**
- Create: `remote/lib/state/{store.ts,useStore.ts}`, `remote/components/{AppShell.tsx,ProjectsView.tsx,ConnectView.tsx,CaptureView.tsx,PlayView.tsx}` (stubs)
- Modify: `remote/app/page.tsx`, `remote/components/Home.tsx`, `remote/lib/i18n/{pl,ru}.ts`, `remote/app/globals.css`

- [x] hash views `#/projects` (default), `#/connect`, `#/capture/<id>`, `#/play/<id>`,
      `#/diagnostics`; the Android back button through `@capacitor/app`
- [x] a tiny observable store + `useSyncExternalStore` hook (no new dependency)
- [x] the kid-facing layout baseline:
  - landscape 1920×1200;
  - touch targets of at least 64 px;
  - icons over text;
  - pl/ru strings;
  - parent-only things behind a long-press
- [x] write tests: router parsing, store subscribe/notify, i18n key parity
- [x] run tests — must pass before Task 5

### Task 5: ProjectStore: model + pure reducers (TDD)

**Files:**
- Create: `remote/lib/projects/{model.ts,reducers.ts,eligibility.ts}` + tests

- [x] tests first, then the types for `index.json`/`project.json` (version 1) and validation
- [x] reducers, all pure:
  - create/rename project;
  - **`beginCapture`**: in one state change, add outstanding `{reqId, cameraId, sentAt}`, bind
    `cameraId` if null and freeze geometry/rotation;
  - remove outstanding;
  - merge frame (monotonic, tombstone-aware, keyed by `frameId`, ordered by `seq`; refused when
    the frame's camera ≠ `project.cameraId`);
  - set local;
  - mark/clear `unavailable`;
  - hide/unhide/expire project;
  - recovered project from `FrameInfo`
- [x] `ackEligible(frame, project, index)` per Technical Details, including "pendingProjectDeletes
      → not eligible" and "result for a deleted project → eligible, not merged"
- [x] write tests:
  - the monotonic-merge table (§5.5);
  - tombstones;
  - duplicate results via capture + reconcile;
  - a geometry freeze at `beginCapture` (the first capture is lost, the rotation changes in the
    UI, then the result arrives → the original rotation holds);
  - a wrong-camera merge is refused;
  - the eligibility table
- [x] run tests — must pass before Task 6

- ➕ Task 5 decisions (agent): a project in `pendingProjectDeletes` makes none of its frames eligible; geometry counts as frozen when the project has outstanding entries, frames or tombstones; `mergeFrame` refuses an unbound project; results for a project inside its Undo window are still merged

### Task 6: ProjectStore: persistence + mutation queue (TDD)

**Files:**
- Create: `remote/lib/projects/{store.ts,files.ts}` + tests, `remote/lib/projects/fakeFs.testutil.ts`

- [x] tests first, then one async mutation queue:
  - load → reducer → `writeTextAtomic`;
  - the reducer result is applied in memory only after the write succeeds;
  - the mutation's promise resolves after the write;
  - mutations are strictly serialized
- [x] file access through an injected adapter: `KopernikadrNative` + `Filesystem` (listing,
      `getUri`, delete, mkdir) in the app, an in-memory fake with crash points in tests
- [x] creating a project writes the index entry and creates `projects/{id}/` in the same flow
      (the sweep handles a crash in between)
- [x] write tests:
  - a failed write (`NO_SPACE`) keeps memory and disk consistent;
  - a failed merge after a capture result keeps the outstanding entry, so it is retried later;
  - serialization under concurrent callers
- [x] run tests — must pass before Task 7

### Task 7: ProjectStore: startup sweep + corruption recovery (TDD)

**Files:**
- Create: `remote/lib/projects/sweep.ts` + tests

- [x] tests first, then the startup sweep (§5.8):
  - promote matching `pending` installs;
  - empty `tmp/`;
  - delete unreferenced files under `frames/`;
  - remove tombstoned dirs;
  - re-add missing project dirs;
  - expire past `pendingProjectDeletes` deadlines
- [x] corrupt or unknown-version JSON per Technical Details
- [x] write tests for the crash points: a kill after `installFile` before `local`; a kill between
      the tombstone commit and the unlink; a corrupt `project.json`; a missing index entry
- [x] run tests — must pass before Task 8

- ➕ Task 7 decisions (agent, accepted):
  - an unreferenced `full` that is not tombstoned is **kept** with a warning (a corrupt `project.json` rebuilds the project empty, and deleting would destroy the only copy); caches are deleted;
  - the corrupt-index rebuild is done by the sweep re-adding project dirs (not via `onIndexCorrupt`, which would deadlock the queue). `rememberedCamera` and project tombstones are lost with a corrupt index;
  - hidden-frame expiry also runs in the sweep

### Task 8: CameraClient: target selection over `CameraConnection` (TDD)

**Files:**
- Create: `remote/lib/camera/{client.ts,discover.ts}` + tests
- Modify (only if a gap is found, additive): `packages/remote-core/src/connection.js` + its tests

- [x] tests first, then target selection:
  - a project bound to a `cameraId` looks for that one;
  - otherwise the remembered camera, else the single one found;
  - else the connect screen.

  Manual `host:port` is checked with `GET /info`; `rememberedCamera` is saved through the store.
- [x] reuse `CameraConnection`'s loop. Never open a second one. App resume uses `reconnectNow()`
- [x] status: `searching | connecting | online | offline | busy | replaced | wrong-camera`
- [x] the `hello` cameraId ≠ the project's → `wrong-camera`; a `bootId` change is surfaced
- [x] hooks run on **every** new session, a reconnect with the same `bootId` included:
      `resolveOutstanding()` then `reconcile()`, in that order
- [x] write tests: target selection, wrong camera, hook order, hooks on every session, resume. Add
      core tests only for gaps (e.g. 4002 on a superseded socket) and then run the remote-lite
      tests
- [x] run tests — must pass before Task 9

### Task 9: Capture flow: outstanding, timeouts, resolveOutstanding (TDD)

**Files:**
- Create: `remote/lib/capture/{capture.ts,outstanding.ts}`, `remote/lib/transfer/types.ts` (the `Transfer.enqueue(frameId)` interface) + tests

- [x] tests first, then capture:
  1. `beginCapture` mutation (awaited);
  2. send `capture{projectId, rotation}` with a new reqId per press;
  3. on the result, a mutation removes outstanding and merges the frame. If the project was
     deleted, nothing is merged and the frame is handed to the ack pass;
  4. `Transfer.enqueue(frameId)` (a stub interface; the fake in tests)
- [x] a 10 s send timeout → `resolveOutstanding` for that reqId; outstanding limit 1
- [x] `resolveOutstanding()`:
  - only entries whose `cameraId` = the connected camera;
  - `getOperation` → `done` → result;
  - `pending` → poll every 1 s, give up after 30 s or after a `bootId` change: drop the entry
    with "sprawdzimy tę klatkę później"; reconcile still recovers a committed frame;
  - `failed`/`unknown` → drop with "nie wyszło, spróbuj jeszcze raz"
- [x] kid-level messages for `CAPTURE_IN_PROGRESS`, `CAMERA_NOT_READY`, `STORAGE_LOW`,
      `GEOMETRY_MISMATCH`; no auto-retake
- [x] a project bound to another camera → shooting blocked with "new movie needed"; watch/export
      still work
- [x] write tests:
  - a lost response on a live connection (fake `/fake/drop-capture`);
  - pending forever (Task 3 switch);
  - a `bootId` change while pending;
  - a duplicate result via reconcile;
  - capture while offline;
  - entries of another camera are left alone
- [x] run tests — must pass before Task 10

- ➕ Task 9 decisions (agent, accepted): press refuses while offline or reconciling; limit 1 is per connected camera and checked inside the `beginCapture` mutation; camera error answers (no frame) drop the entry without `getOperation`; local failures (timeout, socket, LEASE_LOST, INTERNAL) resolve via `getOperation`; only a freshly inserted frame is enqueued

### Task 10: Transfer A: download, install, ack (TDD)

**Files:**
- Create: `remote/lib/transfer/{queue.ts,download.ts,ack.ts}` + tests

- [x] tests first, then a one-at-a-time queue (ids, not bytes), the newest frame first:
  - `full` → `tmp/` via `@capacitor/file-transfer`;
  - `installFile({tmp, dest, bytes, sha256})` verifies natively. `CHECKSUM_MISMATCH` → retry;
    **no JS-side sha256 pass**;
  - `play`/`thumb`: best-effort (Content-Length + decode), never blocking
- [x] install mutation:
  - re-check tombstones (a tombstoned frame or project → delete the tmp file);
  - set `state: local`, committed;
  - **then** a batched ack
- [x] retries: 3 per frame with backoff for 404/mismatch/network errors, then mark
      `unavailable` (never acked; retried by the next reconcile)
- [x] admission:
  - `freeBytes` ≥ 300 MB + `full` + 1 MB, else pause with "Tablet storage full";
  - ENOSPC → pause + delete the tmp file;
  - paused during an export
- [x] the ack pass runs right after any commit that makes frames eligible: install, a project
      tombstone, a result for a deleted project. It does not wait for a reconcile
- [x] a project delete drops its queued jobs and their tmp files
- [x] write tests:
  - the eligibility path (pendingProjectDeletes never acked);
  - a mismatch → retry → `unavailable`;
  - a 404 `full`;
  - kill points (after download, after install, before ack);
  - a Wi-Fi drop mid-download;
  - storage full;
  - a delete during a download
- [x] run tests — must pass before Task 11

- ➕ Task 10 decisions (agent, accepted): 3 retries after the first attempt (4 downloads) then `unavailable`; Wi-Fi loss and storage-full don't consume retries; `ackNow(frameIds, projectOf?)`; only `ack.ts` sends `ack`, re-checking `ackEligible` per id at send time; the want-set is in memory (after a restart, acks come from the sweep promotion diff and reconcile); `kick()` must run on every session (Task 11 / boot wiring)

### Task 11: Transfer B: reconcile + integration (TDD)

**Files:**
- Create: `remote/lib/transfer/reconcile.ts` + test, `remote/lib/transfer/integration.test.ts`

- [x] tests first, then `reconcile()` over `listFrames` (our clientId, unacked, paged):
  - ack-eligible → ack;
  - pending → resume;
  - unknown in a live project → merge only if `project.cameraId` is null or equals the current
    camera, then download;
  - unknown `projectId` that is not tombstoned → an "Odzyskany <date>" project bound to the
    current camera;
  - a camera mismatch → recovered project;
  - a local `pending` frame that vanished from `listFrames` → `unavailable` with "lost on the
    phone", surfaced to the parent
- [x] integration test against `fake-camera.mjs`:
  - capture → transfer → ack → reconnect → reconcile;
  - plus the Task 3 switches: new `bootId`, `cameraId` change, 404 `full`, reclaim
- [x] run tests — must pass before Task 12

- ➕ Safety review on the Claude reviewer (2026-10-27, Codex out of credits): no path acks a frame that isn't durably `local`. Fixed:
  - the sweep quarantines instead of deleting on a verify mismatch, and HTTP errors in verify keep the file;
  - acks and downloads only for the connected camera's projects; `unknown` ack ids are not marked acked; `kick()` clears the acked set;
  - reconcile binds an empty unbound project (rotation from the first FrameInfo); lenient fps/name parsing;
  - `getOperation` protocol errors drop an outstanding entry after 3; a persisted `geometryFrozen` flag;
  - `setLocal` clears `unavailable`; `client-id.txt` backup; the `pause()` promise fix;
  - camera: a complete `full` tmp is finished instead of deleted, other `full` tmps are quarantined; the reclaimer counts only real deletes.
- ➕ Backlog: `quarantine/` folders (tablet and phone) are never cleaned up; they need a parent "show/clear" action later

### Task 12: Boot wiring + connect view

**Files:**
- Create: `remote/lib/app/boot.ts` + test, `remote/components/ConnectView.tsx`
- Modify: `remote/components/AppShell.tsx`

- [x] boot: the native sweep (already at plugin load) → ProjectStore load + sweep → UI →
      CameraClient → hooks (`resolveOutstanding` → `reconcile`) on every session
- [x] the connect view:
  - found cameras and their status;
  - a manual address field;
  - "Przejmij" after `4001`;
  - plain messages for BUSY and wrong-camera
- [x] from here on, the app runs the real flow end to end (no shooting UI yet)
- [x] write tests: the boot order with fakes; the connect view's states
- [x] the orchestrator runs it on the emulator against the fake camera: connects, reconciles
- [x] run tests — must pass before Task 13

- ➕ Task 12: emulator check 2026-10-27 — manual connect to the fake camera at `10.0.2.2:8765` → online, back to projects with the badge. Transfer and reconcile are stubs in `remote/lib/app/app.ts` until Tasks 10/11

### Task 13: Preview with watchdog + onion skin

**Files:**
- Create: `remote/components/{Preview.tsx,OnionSkin.tsx}`, `remote/lib/camera/previewController.ts` + test

- [x] `previewController` over remote-core `PreviewLoop`:
  - the 3 s watchdog;
  - restart on resume / new `bootId` / new session;
  - closes the previous bitmap;
  - the preview quality is a parent setting
- [x] onion skin:
  - the last local frame's `play`, else `thumb`, else nothing ("no frames yet" state);
  - opacity and toggle (as in remote-lite);
  - the 3×3 grid is a parent toggle
- [x] write tests: the watchdog fires, restart on a new bootId, no double loops, the "no frames
      yet" state
- [x] run tests — must pass before Task 14

### Task 14: Capture view (kid UI)

**Files:**
- Modify: `remote/components/CaptureView.tsx`
- Create: `remote/components/{ShutterButton.tsx,ConnectionBadge.tsx}` + component tests

- [x] preview + onion skin
- [x] a big shutter with sound and flash feedback (from remote-lite's `sound.js`)
- [x] the frame counter and pending-capture placeholders
- [x] a connection badge and error toasts
- [x] "play" and "back to movies" buttons
- [x] keep-awake while the view is open
- [x] write tests: the shutter is disabled while offline, at the outstanding limit, or during an
      export; toasts per error code
- [x] run tests — must pass before Task 15

- ➕ Integration (orchestrator): `AppShell` owns the parent settings (preview quality, grid) in localStorage and hosts `CaptureDrawer` (long-press wrench → `ParentDrawer`); the capture view is a two-column grid (preview full height on the left, controls on the right). Emulator 2026-10-27 against the fake camera: new film → 3 shutter presses → counter 3

### Task 15: Parent drawer

**Files:**
- Create: `remote/components/ParentDrawer.tsx` + test

- [x] long-press opens it. It holds:
  - exposure/WB/focus lock with `confirmed`/`settling`; "lock failed" via `isLockFailed`, only
    once `settling` is false;
  - exposure compensation, only when not frozen;
  - rotation 0/180 for empty projects only (no frames and no outstanding);
  - preview quality, fps, the grid toggle;
  - camera info, the transfer queue status, `unavailable` frames, storage
- [x] write tests: rotation locked after the first capture begins; compensation hidden when
      frozen; no "failed" while `settling`
- [x] run tests — must pass before Task 16

### Task 16: Projects view: create, rename, delete + Undo

**Files:**
- Modify: `remote/components/ProjectsView.tsx`
- Create: `remote/lib/projects/deletion.ts` + test

- [x] the movies list:
  - big cards with a cover (the first local frame's `thumb`), name, frame count;
  - "Odzyskany" projects as ordinary cards;
  - a "new movie" card;
  - tap → capture or play
- [x] rename via a parent long-press or a simple dialog
- [x] delete:
  - `pendingProjectDeletes` with a 5 s Undo (not ack-eligible in the window);
  - expiry → tombstone → commit → remove the dir → the immediate ack pass (Task 10)
- [x] write tests: Undo inside the window, expiry at startup, the ack pass after delete, nothing
      acked inside the window
- [x] run tests — must pass before Task 17

### Task 17: Playback view

**Files:**
- Modify: `remote/components/PlayView.tsx`
- Create: `remote/lib/play/{player.ts,ring.ts,frameSource.ts}` + tests

- [x] `frameSource`: local `play`, else `full` with `createImageBitmap(..., {resizeWidth: 1440,
      resizeHeight: 1080})`; shared with export
- [x] the canvas player:
  - a ring buffer of 8 bitmaps, closed on eviction;
  - rAF timing at the project's fps;
  - play/pause, loop
- [x] non-local and `unavailable` frames are skipped, with a "N klatek jeszcze się pobiera" note
- [x] the ring buffer is released before an export and when leaving the view
- [x] write tests: the scheduler with a fake clock, eviction closes bitmaps, the `full` fallback,
      skipping
- [x] run tests — must pass before Task 18

- ➕ Task 17: `PlayView` takes `project`/`frameUrl` props; `AppShell` wiring comes with Task 14/16 (UI wiring)

### Task 18: Export from the app

**Files:**
- Create: `remote/lib/export/projectExport.ts` + test, `remote/components/ExportDialog.tsx`
- Modify: `remote/components/PlayView.tsx`

- [x] `projectExport`:
  - waits while frames are still downloading. `unavailable` frames are skipped after a parent
    confirmation that names their count; they never deadlock the export;
  - pauses transfers and blocks shooting;
  - `frameSource` → `pickCodec` → `exportVideo` → the native writer → publish;
  - resumes transfers afterwards
- [x] the file name `kopernikadr-<name>-<date>.mp4`, sanitized (Polish/Cyrillic letters
      transliterated or kept per the native normalizer, slashes and controls removed)
- [x] the dialog:
  - progress;
  - Cancel only in `encoding`;
  - "Zapisano w galerii";
  - a plain error with a retry
- [x] write tests: the state machine (cancel only in encoding, publish/abort exclusive, cancel at
      each state), pause/resume of transfers, the `unavailable` confirmation, name sanitizing
- [x] run tests — must pass before Task 19

- ➕ Emulator 2026-10-27: Film 1 (9 frames from the fake camera) → export → `kopernikadr-Film_1-2026-10-27.mp4` in the gallery; ffprobe h264 Main, 9 frames, 8 fps, decodes clean (640×480 because the fake camera's `play` is 640×480; the export takes the size of the first frame)

### Task 19: Lifecycle refinements

**Files:**
- Create: `remote/lib/app/lifecycle.ts` + test
- Modify: `remote/lib/app/boot.ts`

- [x] pause/resume:
  - preview stops on pause;
  - `reconnectNow()` on resume;
  - transfers only in the foreground;
  - keep-awake only in the capture view and during an export
- [x] background/foreground while a capture is writing: the outstanding entry resolves after
      resume (a §7 crash point)
- [x] the Diagnostics view stays reachable for the parent; probes keep working
- [x] write tests for resume during a capture, during a download, during an export
- [x] run tests — must pass before Task 20

### Task 20: Emulator E2E script

**Files:**
- Create: `remote/e2e/flow.cdp.mjs`, `docs/diagnostics/<date>-stage1-2-emulator.md`
- Modify: `remote/android/app/build.gradle` (`versionCode`/`versionName` bump)

- [x] a CDP-driven script against `fake-camera.mjs`. Each step passes or fails:
  1. create a movie;
  2. connect;
  3. shoot 10 frames → 10 local;
  4. kill the app mid-transfer → relaunch → all 10 local, all acked;
  5. a dropped capture response → resolved;
  6. play;
  7. export → in the gallery (ffprobe: frames = local count);
  8. delete + Undo → still there;
  9. delete → the frames are acked on the fake camera
- [x] fix what's found (➕ tasks if larger)
- [x] run the full suite — must pass before Task 21

### Task 21: Tablet + phone install and smoke (orchestrator + owner)

- [ ] **back up the kid's spool before the first camera upgrade on the g05.** The release/probe
      build is not debuggable, so use the HTTP API read-only:
  1. take remote-lite's `clientId` from the tablet browser (localStorage) or the camera
     diagnostics;
  2. list its frames with probe-client;
  3. download every `full` to the Mac;
  4. verify the sha256 values;
  5. **no ack**
- [ ] list the spool counts before/after the upgrade via `getStatus` and compare
- [ ] install the camera build (`install -r`) and the remote debug build on the tablet
- [ ] smoke: a short movie end to end; remote-lite still works on the same phone
- [ ] record the results in `docs/diagnostics/<date>-stage1-2-tablet.md`

### Task 22: Verify acceptance criteria
- [ ] every Overview bullet works on the emulator and the tablet
- [ ] the safety rules hold:
  - no ack outside eligibility (grep + tests);
  - remote-lite tests green;
  - the camera never deletes unacked frames or an unaccounted `full`
- [ ] full suite:
  - `npm test --workspaces`;
  - `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - the remote-lite node tests;
  - `scripts/test/run.sh`
- [ ] a Codex review of the batch; fix the material findings

### Task 23: [Final] Update documentation
- [ ] `docs/ARCHITECTURE.md`:
  - §5 matches what was built: own store, hash views, export from `play` with a `full` fallback,
    no JS sha pass, no local cache regeneration, no deep link;
  - §4.6 reclaim under low space only;
  - §9 decision 2 (export source);
  - §8 stages 1–2 done;
  - line 40 `src/schema.ts` removed
- [ ] `README.md`:
  - how the kid uses the tablet app;
  - the parent drawer;
  - where movies are;
  - "uninstalling the remote deletes movies";
  - remote-lite as the fallback;
  - "frames of other remotes" on the phone
- [ ] `docs/ROADMAP.md`:
  - stages 1+2 done;
  - next = stage 3 (strip + editing, the 7-day reclaim, `ScreenPolicy`) and the effects layer
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
