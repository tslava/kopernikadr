# Kopernikadr — architecture plan

Status: **rev 4 (2026-10-27)**: stages 0, 0b, 1 and 2 are built (§8). The requirements are in
[PROMPT.md](PROMPT.md) and the wire contract is in
[../protocol/PROTOCOL.md](../protocol/PROTOCOL.md) (v1, frozen 2026-10-27). Items marked
**[S0]** were hypotheses for the stage 0 probes; where a probe has answered, the text states the
measured fact and what was built (the measurements are in `docs/diagnostics/`).

## 1. Overview

```
 ┌──────────── phone (moto g05) ────────────┐        ┌──────────── tablet (Tab M10) ─────────────┐
 │ camera-android (Kotlin, Compose)         │  Wi-Fi │ remote (Next.js static → Capacitor 8)     │
 │                                          │        │                                           │
 │ CameraX ─► FrameTransform ─► Spool       │◄──ctl──│ CameraClient   (WS /ws/control, session)  │
 │   │  (crop+rotate)          (SQLite+files)│──prev─►│ PreviewView    (WS /ws/preview, pull)     │
 │   └─► preview JPEG (on demand)           │──GET──►│ Transfer       (@capacitor/file-transfer) │
 │ Ktor CIO server ◄─ SessionManager        │        │ ProjectStore   (serialized, native atomic)│
 │ NsdManager: _kopernikadr._tcp            │──mDNS─►│ Discovery      (NSD plugin)               │
 └──────────────────────────────────────────┘        │ Exporter       (WebCodecs + Mediabunny)   │
                                                     │ KopernikadrNative (local plugin: atomic   │
                                                     │   files, free space, MP4 writer, gallery) │
                                                     └───────────────────────────────────────────┘
```

The tablet owns projects. The phone is a durable capture spool with no knowledge of order
or deletions. Three invariants hold:

1. **Nothing is reported before it is on disk.** The phone answers `capture` only after the
   frame is committed. The tablet acks only after the frame is committed locally, or after
   its deletion is permanent.
2. **Nothing is deleted while another copy depends on it.** The phone never deletes an
   unacked frame. The tablet never acks a frame that Undo may still need.
3. **Every multi-step change has a recovery rule.** A crash at any step leaves a state that
   startup recovery resolves (§4.6, §5.8).

## 2. Repository layout

```
kopernikadr/
  docs/            PROMPT.md, ARCHITECTURE.md, ACCEPTANCE.md (per-stage on-device checklists)
  protocol/        PROTOCOL.md, fixtures/*.json, tools/probe-client/ (a Mac CLI and the Node
                   fake camera, `fake-camera.mjs`)
  packages/        remote-core/: shared plain JS (protocol client, `CameraConnection`, preview
                   loop, backoff, NSD helpers, i18n core), used by remote-lite and the remote
  camera-android/  Gradle project: `:core` (plain JVM: pure logic, server routes, spool,
                   remote-lite web files) and `:app` (Android: camera adapters, UI, probes)
  remote/          Next.js app + android/ (Capacitor; the local native plugin lives in
                   android/app/.../remote/native and .../nsd) + e2e/ (CDP emulator script)
  scripts/         build.sh, install.sh, collect-diagnostics.sh, meminfo-sampler.sh
  README.md        build/install, parent guide, Family Link checklist, known limitations
```

npm workspaces at the root (`packages/remote-core`, `remote`, `protocol/tools/probe-client`).
Gradle stays separate. There is no codegen and no `src/schema.ts`. The contract is enforced by
**shared fixtures**: `protocol/fixtures/*.json` are valid example messages. The remote-core
contract tests replay them, and a Kotlin unit test parses every fixture with the
kotlinx.serialization models and round-trips it (`FixtureServerTest` also sends the fixture
requests through the real server).

**Build types.** The camera app has `debug`, `probe` and `release`. `probe` is release-like
(non-debuggable, debug key, package suffix `.probe`) and carries the diagnostics code from
`src/probe`; `debug` has the same diagnostics; `release` has none. The three are separate apps
with separate data. The kid's phone runs the `.probe` build until the native remote ships. The
remote has `debug` and `release`.

**remote-lite as the interim remote.** The phone serves a browser remote, remote-lite
(`camera-android/core/src/main/resources/remote-lite/`), on `/`. It is the kid's remote until the
native app takes over, and it **keeps working unchanged** as a fallback. It shares code with the
native remote through `packages/remote-core`: Gradle copies `remote-core/src/*.js` into the
`remote-lite/lib/` resource root at build time (so the APK serves them), and the native remote
imports the same package as an npm workspace. A change in remote-core therefore needs the
remote-lite tests too. remote-lite never acks and keeps its own `clientId`, so to the camera all
its movies are unacked frames of another client (§4.6 Orphans).

## 3. Toolchain and versions

All versions are pinned in stage 0 (exact versions, lockfiles committed); pre-release versions
are not used. Starting point as of 2026-10: Capacitor 8.5.x, @capacitor/filesystem 8.x,
@capacitor/file-transfer 2.x, @capacitor-community/keep-awake 8.x, Next.js 16.x,
Mediabunny 1.x, CameraX 1.6 stable, Ktor 3.x, current stable Kotlin and AGP.

- **targetSdk 36 on both apps.** Android 17 blocks local-network access for apps targeting SDK
  37+ unless they hold `ACCESS_LOCAL_NETWORK`
  ([docs](https://developer.android.com/privacy-and-security/local-network-permission)).
  We sideload and don't need 37. README records this as a known future step.
- **minSdk 31 on both apps** (the tablet runs Android 12). Phone-only APIs above 31 are
  guarded by version checks.

### Known hardware facts (2026-10-26, from settings screens)

| | Phone | Tablet |
|---|---|---|
| Model | motorola moto g05 | Lenovo Tab M10 (3rd Gen) TB328FU |
| Android / API | 15 / 35 | 12 / 31, build TB328FU_S200155_241104_ROW |
| SoC / RAM / storage | — | Unisoc T610 / 4 GB / 64 GB |
| Screen | 720×1604, 280 dpi, 6.6" | 1920×1200, 10.1" |
| WebView | — | 155.0.8059.43 (from Play) |
| Family Link | "Opcje programisty" and "Aplikacje z nieznanych źródeł" toggles exist, currently off | same toggles (owner confirmed) |

**Phone back camera (id 0), from a Camera2 info app:**
- Hardware level **FULL**.
- Capabilities: BACKWARD_COMPATIBLE, **MANUAL_SENSOR**, **MANUAL_POST_PROCESSING**,
  READ_SENSOR_SETTINGS, BURST_CAPTURE, CONSTRAINED_HIGH_SPEED_VIDEO. No RAW.
- Exposure: AE modes incl. manual, **AE lock** ✓, compensation **[-4, 4] × 1/2 EV** (±2 EV,
  9 positions). FPS ranges include fixed [10,10], [15,15], [20,20], [30,30].
- White balance: AWB off/auto + presets, **AWB lock** ✓.
- Focus: **manual focus** ✓, AF auto/continuous/macro. No OIS (irrelevant on a rig).
- 4:3 preview-stream sizes: 3264×2448, 2560×1920, 1920×1440, **1440×1080**, 1280×960, 960×720,
  640×480. The largest size overall is 4080×2296 (16:9), so the sensor is probably 4080×3072.
  JPEG sizes are not on the screenshots.

Still unknown: the JPEG output sizes, `LENS_INFO_MINIMUM_FOCUS_DISTANCE`, sensor orientation
(all three come from our own diagnostics in S0).

Consequences:
- **Android 15 on the phone** (targetSdk 36): edge-to-edge is enforced, so the Compose UI
  handles insets. We have no foreground service, so the Android 14+/15 FGS restrictions don't
  apply.
- **Tablet 1920×1200.** The preview area is about 1600×1200, so 960 px preview is upscaled
  ~1.7×. A `high` preview quality (1280 px) is added and **[S0]** checks its fps.
- **Unisoc T610** is modest. Export decodes 12 MP originals sequentially, which we estimate at
  0.5–1 s per frame, i.e. 4–8 min for 500 frames. **Measured (0b):** 118 ms per 8 MP `full`, so
  about 1 min for 500 frames; the export now reads `play` anyway (§5.7, decision 2).

## 4. camera-android

### 4.1 Components

| Component | Responsibility |
|---|---|
| `MainActivity` (Compose) | Status UI, IP:port + QR, permission screen, parent screen (3 s hold on the title: quarantine show/clear, diagnostics in debug/probe). Owns lifecycle. |
| `CameraController` | Binds CameraX use cases in one `UseCaseGroup` with a `ViewPort`; applies controls via Camera2Interop; confirms control states from `CaptureResult` (§4.4). |
| `FrameTransform` | Pure function: (`cropRect`, `rotationDegrees` of the buffer, project rotation) → matrix + output size. Unit-tested for all rotations. |
| `CaptureService` | Single-threaded capture executor (§4.5). |
| `Spool` | SQLite (WAL, `synchronous=FULL`) + `filesDir/spool/`: operation/frame records, ack state, retention, recovery. |
| `Server` | Ktor CIO: `/info`, `/ws/control`, `/ws/preview`, `/frames/...`. Heartbeats are handled on the socket coroutine; captures run on `CaptureService`, so a long capture never delays a ping. |
| `SessionManager` | Single controller: one live session (`sessionId`, `clientId`, last-seen on the monotonic clock); replacement, expiry, per-request validation (PROTOCOL §4). |
| `Advertiser` | NsdManager registration of `_kopernikadr._tcp` with TXT `id`, `pv`, `name`. |
| `ScreenPolicy` | `FLAG_KEEP_SCREEN_ON` while started. After 2 min without remote commands (capture, controls, session open; the preview stream does not count) or touches it sets window brightness to ~5%; any activity restores it, and an Activity pause/resume resets it. It never dims while the waiting card with the QR (or diagnostics) is shown. The keep-screen-on flag stays, so the server and NSD keep running. |

### 4.2 Lifecycle

Camera, server and NSD run while `MainActivity` is **started**. There is no Android Service
and no background camera.

- **Process start** (`Application.onCreate`): `Spool.recover()` runs **once**, before any
  server can accept commands. It never runs again in the same process, so it can't race a live
  capture.
- `onStart`: open camera → start server → register NSD.
- `onStop` (screen lock, downtime, home): unregister NSD → stop server → CameraX releases the
  camera through the lifecycle binding. A capture that is still running finishes or fails on its
  own worker and records a terminal state: `committed`, or `failed(INTERRUPTED)` if the camera
  closed under it. Committed frames are already on disk.
- **No battery-optimization exemption.** While the activity is started the screen is on, so
  Doze does not apply. While it is stopped we do not need to run, so the exemption buys nothing.
  *(This deviates from the prompt and needs your OK.)*

### 4.3 Camera pipeline and geometry

Use cases: `Preview` (on-phone viewfinder), `ImageAnalysis` (`STRATEGY_KEEP_ONLY_LATEST`) and
`ImageCapture` (in-memory JPEG). LEGACY guarantees PRIV + YUV + max-size JPEG. **[S0]**
confirms the combination at the real sizes. If it fails or is too slow, we drop `Preview` and
show the analysis frame on the phone instead.

- **Project geometry.** The output is always **4:3 landscape** (**[S0]**: confirm the sensor
  supports it). Rotation (**0 or 180 only**) is a **project property** owned by the tablet. It is
  sent with every `capture` and set on the camera when a project opens. Rotation is **frozen**
  once the project has a frame **or an outstanding capture**. A recovered project takes its
  rotation from the imported `FrameInfo`. On the phone, `setControl(rotation)` is rejected while
  a capture is in flight, and each capture snapshots the transform it was admitted with.
  Both use the full 4:3 sensor area. **As built:** every use case is bound with target rotation
  `ROTATION_90`, so the 4:3 `ViewPort` equals the sensor-native landscape and a buffer's
  `rotationDegrees` is only 0 or 180; `FrameTransform` rejects anything else, and the total
  rotation `(buffer + project) mod 360` is 0 or 180. The phone is mounted with its long side along the table's
  long side; README shows how. 90/270 are not offered, because they would crop ~44% of the
  field of view.
- **One transform.** The `ViewPort` crop is recomputed whenever rotation changes, and use cases are
  rebound. Each buffer's `cropRect` and `rotationDegrees` feed `FrameTransform`:
  - in-memory `ImageCapture` reports the sensor rotation, which must be applied;
  - `ImageAnalysis` with output rotation enabled reports 0.

  Output JPEGs are upright pixels with EXIF orientation normal. **[S0]** grid test: preview and still
  overlay exactly at 0 and 180.
- **Still.** Decode → crop + rotate → encode `full` (q≈92). **Proposed size: 3264×2448 (8 MP)**,
  if S0 confirms it among the JPEG sizes, rather than the probable 4080×3072 maximum. It gives
  plenty of headroom over the 1440×1080 export and decodes ~35% faster on both the phone and the
  T610. Each file is ~2–2.5 MB, so about 250 MB per 100 frames on the phone. Peak heap is two
  8 MP ARGB bitmaps (~64 MB). **[S0]** measures heap and capture-to-commit time.
  `full` is the durable unit and the **source of truth for pixels**. Export encodes from `play`
  (1440×1080, the export size anyway) with a `full` fallback: see §5.7 and decision 2 in §9.
- **Display caches.** `play` (1440×1080) and `thumb` (256×192) are display accelerators only:
  onion skin, strip, playback. The phone generates them right after the commit, or on demand,
  so the tablet gets the onion skin quickly without decoding 12 MP during shooting. The camera
  also generates a missing one when it is requested. The tablet **does not regenerate** a missing
  or broken cache: playback and export fall back to `full` resized to 1440×1080, and the next
  reconcile retries the download.
- **Preview.** It is encoded only when a preview client has a pending `next` (PROTOCOL §7).
  Otherwise the `ImageProxy` is closed at once.
  - Output: frame → same transform → 640 px (`low`), 960 px (`normal`) or 1280 px (`high`) →
    JPEG q≈70.
  - **[S0]** benchmarks YUV + on-demand conversion against CameraX RGBA + output rotation, and
    picks the cheaper one.
  - The analyzer never blocks on the network.
- **Thermal.** `PowerManager.getCurrentThermalStatus()` goes into status. At `severe` or worse,
  the preview is limited to `low` at 5 fps.

### 4.4 Controls

The protocol exposes intent (`auto`/`locked`, compensation). The camera picks one mechanism per
control. g05 is FULL with MANUAL_SENSOR + MANUAL_POST_PROCESSING + manual focus, so every
"freeze" method is available.

**Proposal: "Lock" = meter automatically, then freeze the measured values.** *(Needs your OK.)*
- **Why.** The phone will often restart the camera mid-movie: screen lock, downtime, the app being
  killed. With AE/AWB lock, a restart re-meters **the scene as it is now**. Hands in the frame, or
  figures moved, give a different exposure, and the movie flickers at that frame.
- **Freeze** stores the exact ISO, exposure time, WB gains, transform and focus distance. It
  restores them after any restart (`exact:true`), so frame N+1 matches frame N.
- **Parent flow.** In `auto`, the exposure-compensation slider (±2 EV) adjusts brightness, using
  AE compensation. Pressing "Lock" freezes what is on screen. To change brightness afterwards:
  Unlock → slider → Lock.
- The AE/AWB-lock methods stay as a fallback, if S0 shows that frozen values don't stick on this
  device.

| Control | `locked` via (default first) | Confirmed when (in `CaptureResult` of the current settings generation) |
|---|---|---|
| Exposure: **freeze** | AE converges (with the current compensation) → read ISO + exposure time + frame duration → `aeMode=OFF` with those values | `aeMode == OFF` and ISO/time equal the frozen values within device precision |
| Exposure: fallback | `CONTROL_AE_LOCK=true` | `aeState == LOCKED` |
| White balance: **freeze** | AWB converges → read gains + transform → `awbMode=OFF` + `COLOR_CORRECTION_MODE=TRANSFORM_MATRIX` with those values | mode, gains and transform equal the frozen values within device rounding |
| White balance: fallback | `CONTROL_AWB_LOCK=true` | `awbState == LOCKED` |
| Focus: **freeze** | one AF trigger → read `LENS_FOCUS_DISTANCE` → `afMode=OFF` with that distance | `afMode == OFF`, `lensState == STATIONARY`, distance equal |
| Focus: fallback | AF trigger, then hold | `afState ∈ {FOCUSED_LOCKED, NOT_FOCUSED_LOCKED}` (the latter reported as `focusOk:false`) |

- **Freeze mechanics (as built, `ConfirmationMachine`).** "Lock" runs in two steps. First the
  control meters with its auto options. The first result at or after the generation's **fence**
  with 3A converged (AE converged or flash-required, AWB converged, AF focused-locked or
  not-focused-locked) is read and frozen; no convergence within 3 s fails the lock. Then the
  frozen values are applied under a new generation, and a result at or after the new fence that
  matches them confirms it. The fence is the frame number of the result that completes the
  `setCaptureRequestOptions` future: results before it (or with no fence yet) are ignored, so a
  stale frame can never confirm. The comparison has tolerances: ISO 1 %, exposure time 1 %,
  colour gains and transform 1e-3, focus 0.05 diopters. Unconfirmed 3 s after the fence → `failed`,
  with the values left applied (a late match still confirms).
- **Compensation** is enabled only while exposure is `auto` (or AE-locked, in the fallback). It
  is disabled and rejected while frozen. There is no emulation.
- Every control change or rebind increments the **settings generation**. `confirmed` resets and
  only results tagged with the new generation can confirm it. Settings are applied to the
  repeating request **and** the still request. While any locked control is unconfirmed, the
  controls report `settling:true` and `capture` returns `CAMERA_NOT_READY` (retryable).
- **Confirmation timeout.** If a lock is not confirmed within 3 s, that control reports
  `mode:"failed"` and settling ends. The parent drawer shows a red "Lock failed", and capture
  is allowed again. Capture is never stuck forever.
- **Locks across restarts.** Lock intent is persisted. After a restart, AE/AWB lock re-meters
  and re-locks (`exact:false`); frozen manual values are restored exactly (`exact:true`).

### 4.5 Capture path

**Admission** (steps 1–3) runs synchronously in the request handler, under one mutex shared
with `setControl`. When it returns, the request is either rejected or durably `pending`, so
`getOperation` sees every accepted request. Steps 4–6 then run on the capture worker. No capture
command ever waits unregistered in a queue.

1. Check the request's session is current. Look up `(clientId, reqId)` in the DB:
   - `committed` → return the stored result;
   - `pending` (this process) → attach to the in-flight work;
   - `failed` → return the stored failure;
   - same reqId with a different args hash → `REQ_ID_REUSED`.

   If another capture is in flight → `CAPTURE_IN_PROGRESS`. If the rotation in args ≠ the current
   rotation → `GEOMETRY_MISMATCH`. If controls are settling → `CAMERA_NOT_READY`.
2. Free-space check: free − reserve (500 MB) must cover 2 × the expected `full` size. Acked
   frames may be reclaimed (oldest first) to get there. Otherwise → `STORAGE_LOW`.
3. **Insert an operation row** `{frameId (ULID), seq (next), clientId, reqId, argsHash,
   projectId, rotation, state: pending}` and commit. The intent is now durable before the
   camera does anything.
4. `takePicture` → decode → transform → write `{frameId}.full.jpg.tmp` → `fsync` → rename →
   `fsync(dir)`.
5. Update the row: `state: committed`, size, sha256, w/h, `committedAt`. Commit.
6. Respond with `FrameInfo`. Then generate `play` and `thumb` (tmp + rename, no fsync needed —
   they are caches).

If steps 4–5 fail (camera error, I/O error, camera closed), the worker records `failed(code)`
durably before answering. Recovery (§4.6) is only for a dead process.

### 4.6 Spool recovery and retention

`Spool.recover()` runs once per process, before the server opens (§4.2). **As built**, only names
matching `^[0-9A-Z]{26}\.(full|play|thumb)\.jpg` plus an optional `.tmp` or `.<uuid>.tmp` suffix
are touched; `spool.db*` and unknown names never are:

| Found | Action |
|---|---|
| `pending` row + valid `full` file (JPEG SOI/EOI, decodable) | Compute sha256 → `committed` (the photo survives a crash after step 4). |
| `pending` row without a valid file | Delete tmp leftovers → `failed(INTERRUPTED)`. Never re-executed automatically. A bad `full` of such a row is moved to `quarantine/`, not deleted. A complete `full` tmp is finished (renamed and committed) instead of deleted; any other `full` tmp is quarantined. |
| `committed`, unacked, file missing | **Integrity error.** The row is kept, marked `lost`, and counted in `getStatus.integrityErrors`; `getOperation` answers `failed` for it. |
| `reclaimedAt` set but files still exist | Delete files (a crash during reclaim). |
| `*.tmp`, or `play`/`thumb` with no row | Delete. |
| `full` with no row | **Moved to `spool/quarantine/`, never deleted** (it may be the only copy of a photo). |
| `committed`, missing `play`/`thumb` | Regenerated lazily. |

A recovered frame's `capturedAt` is the file's mtime. Quarantined files count in
`integrityErrors` until someone removes them by hand; **nothing cleans `quarantine/` yet** (a
stage 3 UI, same on the tablet).

**Retention.**
- Unacked frames are never deleted.
- Acked frames are reclaimed oldest `ackedAt` first, on two triggers; `clearAcked` is not built.
  - **Low space.** Capture admission step 2 asks `SpoolReclaimer` to free space when
    `free − 500 MB` is below 2 × the expected `full` size (the maximum of the last 8 `full`
    sizes, 5 MB with no history); with nothing acked left it answers `STORAGE_LOW`.
  - **Age (7 days).** `ServerHost` starts a pass once `recover()` has run (on every server
    start), then hourly, and cancels it in `stop()`. It reclaims every acked frame, of any
    `clientId`, whose `ackedAt` is at or before now − 7 days, and logs the count
    (`age reclaim: N frame(s)`). A clock earlier than `ackedAt` reclaims nothing.
  - Both go through one reclaimer-level lock, because `Spool.failedDeletes` is shared state.
  - **First launch after the upgrade:** the first age pass reclaims every frame acked more than
    7 days ago in one go, including frames acked by an earlier install. Back up the spool
    first (README, Known limitations).
- Reclaim writes `reclaimedAt` **first**, then deletes files under the frame's exclusive lock
  (`DerivedFiles`, striped per frame), so it never races a `play`/`thumb` generation of the same
  frame. A crash in between is finished by `recover()`. A reclaimed frame's files answer 404.
- Rows are kept forever. They are tiny, and they keep reqId dedup, results and `seq` valid.

**Orphans.** Unacked frames of another `clientId` (a reinstalled remote, or remote-lite, which
never acks and has its own `clientId`) are never listed to a different client and **never deleted
by the app**. `getStatus.orphanCount` reports them as "frames of other remotes", relative to the
current session's client (0 without a session). The phone's screen does not show the count. The only way to remove them is the OS-level "Clear storage"
for the camera app, and README describes it.

## 5. remote

### 5.1 App shell

- Next.js `output: 'export'`, App Router, client components only, **one page**. The views are
  **hash routes** parsed by `lib/router.ts`: `#/projects` (default; anything unknown falls back to
  it), `#/connect`, `#/capture/<id>`, `#/play/<id>`, `#/diagnostics` (parent). The Android back
  button goes through `@capacitor/app`.
- Capacitor: `server.androidScheme: 'http'`, `hostname: 'localhost'`. Network security config has
  `base-config cleartextTrafficPermitted="true"`: Android has no subnet selector, and the phone's
  IP is DHCP-assigned. `android.allowMixedContent` stays false. **[S0]** proves on a release build:
  `isSecureContext`, ws:// control + preview, cross-origin `GET /info` with CORS, native download,
  and `convertFileSrc` → `VideoFrame`.
- State: **no zustand** (a deviation from the first draft). A tiny own observable store
  (`lib/state/store.ts`: `get/set/update/subscribe`, listeners fire only on a change) is read
  through `useSyncExternalStore`, so there is no new dependency. Persistent state lives in
  ProjectStore (§5.5); the store holds UI state derived from it. i18n: own tiny `t()` with
  `ru.ts`/`pl.ts`, fallback `pl`, locale from `navigator.language`. A unit test checks key parity.
- The kid-facing layout: landscape 1920×1200, touch targets of at least 64 px, icons over text,
  pl/ru strings. Parent-only things sit behind a long-press (1.5 s): the wrench on the capture
  view opens the parent drawer (controls, rotation for empty projects, preview quality, fps, grid
  toggle, transfer queue, `unavailable` frames, storage). `AppShell` keeps the parent settings
  (preview quality, grid) in `localStorage`.
- **Lifecycle (`lib/app/lifecycle.ts`).** On pause the preview stops; on resume the connection
  calls `reconnectNow()`; transfers run only in the foreground. **Keep-awake is ref-counted**
  (`KeepAwakeManager`): the capture view holds a `view` reference while it is open and an export
  holds an `export` reference; the screen is held when an export holds it, or a view holds it
  while the app is in the foreground. Several holders never release each other's lock.
- Plugins:
  - `@capacitor/filesystem`, used for directory listing and `getUri` only;
  - `@capacitor/file-transfer`;
  - `@capacitor/app` (back button);
  - `@capacitor-community/keep-awake`;
  - NSD: our own **`KopernikadrNsd`** plugin (`NsdManager` with a serial `resolveService`, which
    Android 12 on the tablet needs) and `lib/discovery.ts`. **[S0]:** it found the camera in
    438 ms.
- **`KopernikadrNative`** (local plugin, Kotlin, in the app module
  `remote/android/app/.../remote/native`, not a separate package), small and unit-tested:
  - `writeTextAtomic(path, text)`: write tmp → fsync → `rename(2)` over the target →
    fsync dir. It never deletes the target first, unlike `Filesystem.rename`, which deletes
    before moving.
  - `installFile(tmp, dest, bytes, sha256)`, idempotent. It **verifies size and sha256
    natively** (`CHECKSUM_MISMATCH` otherwise), so JS never hashes a file:
    - if `dest` already exists with the same size and hash → delete `tmp`, OK;
    - if `dest` exists but differs → replace it;
    - otherwise fsync `tmp`, `rename(2)` it, fsync the dir.

    A repeated call after a crash always succeeds.
  - `freeBytes(path)`: `StatFs`.
  - MP4 writer: `videoOpen() → handle`, `videoWriteAt(handle, position, base64)`,
    `videoClose(handle)`, `videoPublish(handle, displayName) → contentUri`, `videoAbort(handle)`,
    `videoCleanupAbandoned()` (§5.7). The writer owns `Data/kopernikadr/exports/` and never
    touches project metadata. Cleanup is derived from that directory's contents.
  - The native plugin **never writes `index.json` or `project.json`**; ProjectStore is their
    only writer.

### 5.2 Connection (`CameraClient`)

- Discovery lists NSD services.
  - A project already bound to a camera looks for that `cameraId`.
  - Otherwise the remembered camera is auto-connected, or the single one found.
  - Manual `host:port` is checked with `GET /info` (CORS allows `http://localhost`).
- **There is no QR deep link** (decision 5 was dropped, §9): NSD works on the tablet and manual
  `host:port` entry stays. The QR on the phone is for remote-lite's browser.
- **`CameraClient` (`lib/camera/client.ts`) is a thin layer over remote-core's
  `CameraConnection`**, which owns hello/session/ping and the one reconnect loop. The client adds
  target selection, `rememberedCamera` in `index.json`, wrong-camera and `bootId` detection and
  the hooks below. Its status is `searching | connecting | online | offline | busy | replaced |
  wrong-camera`; a `hello` `cameraId` different from the project's is `wrong-camera`.
- Control WS: `hello` → session. Pings every 2 s. The connection counts as offline after 5 s
  without a reply. Reconnect uses backoff 0.5 s → 5 s (`BUSY` uses `retryAfterMs`).
  After **every** new session, a reconnect with the same `bootId` included: `resolveOutstanding()`,
  then `reconcile()`, in that order. Merges are monotonic (§5.5), so the order is not
  load-bearing.
- **One reconnect loop.** Each socket carries the local connection generation that opened it.
  Callbacks from a superseded socket are ignored. Close code `4001 replaced` ends that socket's
  loop without reconnecting. After `4002 lease lost`, a reconnect starts only if that socket
  still owns the current generation. App resume and timeouts reuse the same loop and never open
  a second one.
- Persistent `clientId` (UUID, stored with the project index, and backed up in `client-id.txt`).

### 5.3 Preview

`/ws/preview?session=<sessionId>` is pull-based. The client sends `next`, draws the frame it
receives, and only then sends `next` again. At most one frame is in flight, stale frames are
dropped at the source, and slow Wi-Fi lowers fps instead of adding latency. Drawing goes to
`<canvas>` via `createImageBitmap`, and the previous bitmap is closed.

A **watchdog** runs independently of the control heartbeat. If no frame arrives within 3 s of a
`next`, or a decode fails, the preview socket is dropped and reopened. Without a valid session it
waits for one. The loop is also restarted on app resume and on a new `bootId`/`sessionId`.

**Why WS rather than MJPEG.** MJPEG in `<img>` has no flow control, so frames buffer on slow
links. It also cannot carry per-frame metadata (seq, lock states), and Android WebView MJPEG
handling varies.

### 5.4 Project model

```
Data/kopernikadr/
  index.json                         {version:1, clientId, rememberedCamera:{cameraId,host,port}|null,
                                      projects:[{id,name,createdAt}], deletedProjects:[id],
                                      pendingProjectDeletes:[{id, deadline}]}
  projects/{id}/project.json         see below (plus "version": 1)
  projects/{id}/frames/{frameId}.{full|play|thumb}.jpg
  tmp/                               downloads in progress; emptied on start
  exports/                           the MP4 writer's temp files (videoCleanupAbandoned)
  quarantine/                        install files that failed verification; never deleted
  probe/                             diagnostics reports
```

`Data/` is the app's `filesDir`. A frame entry may also carry `unavailable: {reason, since}`, a
UI/store flag that is never acked, and `project.json` carries a persisted `geometryFrozen` flag.
A file with an unknown future `version` is opened read-only with a parent warning; a corrupt one
is kept renamed to `*.corrupt-<ts>`, and the project is rebuilt from the directory listing (§5.8).

`project.json`:
```jsonc
{
  "id": "…", "name": "…", "createdAt": "…", "fps": 8,
  "geometry": {"aspect": "4:3", "rotation": 0},      // frozen after first frame/outstanding capture
  "cameraId": "<cameraId>" | null,                     // bound on first capture
  "frames": [{"frameId":"…", "seq":42, "bytes":3456789, "sha256":"…",
              "state":"pending"|"local", "hiddenUntil": null | "<deadline>"}],
  "deletedFrameIds": ["…"],                            // permanent tombstones
  "outstanding": [{"reqId":"…", "cameraId":"…", "sentAt":"…"}]
}
```

- **One camera per project.** A project is bound to the `cameraId` of its first capture, and its
  order is `seq` (comparable within one camera). If that camera identity disappears (camera app
  reinstalled or its data cleared), the project can still be watched and exported, but new shots
  need a new movie. The capture screen says so plainly. Upgrades with `adb install -r` keep the
  `cameraId`. The `cameraId` is bound, and the geometry frozen, in the **same mutation** that adds
  the outstanding entry (`beginCapture`), before the request is sent.
- Images never pass through `Filesystem.readFile/writeFile`, which base64 everything across the
  bridge. They are **downloaded** by `@capacitor/file-transfer` into `tmp/` and moved by
  `KopernikadrNative.move`. They are **read** by `convertFileSrc` → `fetch` → `createImageBitmap`:
  same origin, no bridge, safe for `VideoFrame`.

### 5.5 ProjectStore: serialized mutations

All reads-modify-writes of `index.json` and every `project.json` go through **one async mutation
queue**. Each mutation loads the current state, applies a pure function, and writes it with
`writeTextAtomic`. Mutations are upserts keyed by `frameId`/`projectId`, so a frame seen through
both a capture result and reconcile ends up once.

**Merges are monotonic.** A discovered frame is inserted as `pending` only if absent and not
tombstoned. An existing entry keeps its state (`local` never goes back to `pending`), its
`hiddenUntil` and its position. Resolving an outstanding request only removes that request. A step that needs a commit **before** a side
effect (an ack, a network send, unlinking a file) awaits that mutation's completion. UI state is
derived from the store.

**As built** (`lib/projects/`): `model.ts` (types, validation), `reducers.ts` (pure),
`eligibility.ts`, `store.ts` (the queue), `files.ts` (an injected adapter over `KopernikadrNative`
and `Filesystem`; tests use an in-memory fake with crash points). A reducer's result is applied
in memory only after `writeTextAtomic` succeeded, and the mutation's promise resolves after the
write, so a failed write (`NO_SPACE`) leaves memory and disk consistent. A merge is refused when
the frame's camera differs from `project.cameraId` and when the project is unbound.

### 5.6 Capture, transfer, ack

- **Capture.**
  1. One mutation (`beginCapture`): add `outstanding{reqId, cameraId, sentAt}`, bind `cameraId` if
     null and freeze the geometry.
  2. Send `capture{projectId, rotation}` with **a new `reqId` per press** (a `failed` reqId
     replays its error). Send timeout 10 s, then `resolveOutstanding` for that reqId; one
     outstanding entry at a time per connected camera. A press is refused while offline or
     reconciling.
  3. On the result, mutation: remove `outstanding`, and merge the frame (monotonic, §5.5). The
     counter and a placeholder appear immediately; `thumb` → `play` → `full` are downloaded next.
- **Timeout / restart.** `resolveOutstanding()` calls `getOperation(reqId)` for each outstanding
  entry:
  - `done` → treat as a result;
  - `pending` → poll every 1 s, give up after 30 s or after a `bootId` change: drop the entry
    with "we will check this frame later" (reconcile still recovers a committed frame);
  - `failed` / `unknown` → drop the entry and show "didn't work, try again";
  - only entries whose `cameraId` is the connected camera are resolved; after 3 protocol errors
    from `getOperation` an entry is dropped.

  **No auto-retake** — the child may already be moving the figures.
- **Download** (one at a time, newest frame first; the queue holds ids, not bytes): `full` to
  `tmp/` through `@capacitor/file-transfer`, then `installFile` verifies size and sha256
  **natively**. There is **no JS-side sha256 pass**. `play`/`thumb` are caches: best-effort
  (Content-Length and decode), never blocking, and **not regenerated locally** when unavailable.
  Retries: 3 after the first attempt, with backoff, for a 404, a mismatch or a network error;
  then the frame is marked `unavailable` (never acked; the next reconcile retries it). Wi-Fi loss
  and a full tablet do not consume retries.
- **Install and ack.** Mutation: re-check state inside the queue.
  - Frame or project tombstoned → delete the tmp files.
  - Otherwise `installFile` the `full` into `frames/` (fsynced, idempotent) and set
    `state: local`. Caches are installed best-effort and never block this.

  After that mutation commits, the frame is **ack-eligible**.
- **Interrupted install.** The app was killed after `installFile` but before `state: local`. On
  startup, a `pending` frame whose `frames/{id}.full.jpg` matches the stored `bytes` and `sha256`
  is promoted to `local`. If it doesn't match, the file is **moved to the tablet's `quarantine/`**
  (never deleted: it may be the only copy) and the frame stays `pending`; HTTP errors during that
  check keep the file.
- **Ack eligibility** (the only cases where `ack` is sent):
  - `state == local`;
  - or `frameId ∈ deletedFrameIds`;
  - or the project is in `deletedProjects`.

  A `pending` frame is never acked: it resumes downloading. **A project in
  `pendingProjectDeletes` (inside its 5 s Undo window) makes none of its frames eligible.** Only
  `ack.ts` sends `ack`; it re-checks eligibility per id at send time, and only for projects of the
  connected camera. The ack pass runs right after any commit that makes frames eligible (an
  install, a project tombstone, a result for a deleted project), without waiting for a
  reconcile.
- **`reconcile()`** after (re)connect, over `listFrames(unacked)` (scoped to our `clientId`):
  - ack-eligible → ack;
  - pending in a live project → resume;
  - unknown frame in a live project → merge at its `seq` (only if `project.cameraId` is null or the
    current camera), then download; an empty unbound project is bound first, with its rotation
    from the first `FrameInfo`;
  - unknown `projectId` that is not tombstoned, or a camera mismatch → create a project
    "Odzyskany <date>" ("Recovered") with that id (tablet metadata loss), bound to the current
    camera, with rotation from `FrameInfo`, and import;
  - a local `pending` frame that vanished from `listFrames` → `unavailable` ("lost on the
    phone"), shown to the parent.
- **Storage: one bulk writer at a time.** Transfers pause while an export runs.
  - **Download admission**: `freeBytes` ≥ reserve (300 MB) + this frame's `full` bytes + 1 MB
    for caches.
  - If admission fails, transfers pause and the parent sees "Tablet storage full". The phone
    keeps the frames.
  - ENOSPC during a write is handled the same way, and the tmp file is deleted.

### 5.7 Playback and export

- **Playback.** A canvas plus a ring buffer of 8 `ImageBitmap`s, decoded from the local `play` at
  1440×1080 (~6.2 MB each, ~50 MB total; the 1920×1200 screen shows it at ~1.1×), with
  requestAnimationFrame timing at the project fps (5, 8 or 12; default 8; per project) and loop.
  `lib/play/frameSource.ts` falls back to the local `full` with
  `createImageBitmap(…, {resizeWidth: 1440, resizeHeight: 1080})` when `play` is missing, and
  export shares it. Frames that are not `local`, and `unavailable` ones, are skipped with a
  "N frames are still downloading" note. Memory does not depend on project length. Bitmaps are
  closed on eviction; the ring is released before an export starts and when the view is left.
- **Export state machine** (one export at a time; transfers paused):
  `encoding → finalizing → publishing → done`, or `→ cancelled/failed`.
  1. `videoOpen()` creates `exports/export-<id>.mp4` (seekable, app-private).
     `videoWriteAt` checks `freeBytes` ≥ reserve before each write; if it fails, the export
     fails cleanly.
  2. Mediabunny (1.61.4), **the API as actually used**:
     `Output{format: new Mp4OutputFormat({fastStart: false}), target: new StreamTarget(writable,
     {chunked: true, chunkSize})}`, where `writable` is a **`WritableStream`** of
     `{type: 'write', data, position}` (there is no `onData(chunk, position)` callback). The chunk
     size defaults to 16 MiB (minimum 1024); we use 1 MiB. Each write goes to `videoWriteAt` in
     `lib/export/nativeWriter.ts`: at most 1 MiB per call, sequential, as base64. Positions are
     **not monotonic** with `fastStart: false` (the `mdat` header is patched at finalize).
     Mediabunny does not await each `write()`: backpressure is the stream's `writer.ready`, a
     failed write surfaces on the next flush or in `finalize()`, and `finalize()` resolves only
     after every queued write.
     The **codec ladder** is `VideoEncoder.isConfigSupported` with Mediabunny's own config (not
     `canEncodeVideo`): `avc1.640028` (High) → `avc1.4d0028` (Main) → `avc1.42e028` (Baseline) →
     `vp09.00.40.08`, passed as `VideoEncodingConfig.fullCodecString` with
     `codec: 'avc' | 'vp9'`. The bitrate is `quality: new Quality({bitrate})` (`bitrate` is
     deprecated) and the frame rate comes from `addVideoTrack(source, {frameRate})`.
     **[S0] result:** the T610 encodes AVC High in hardware.
  3. **encoding**: frames are processed sequentially from **`play`** (with the `full` fallback,
     via `frameSource`) → `VideoSample` with timestamp `i/fps` and duration `1/fps` →
     `await add()` → `close()` both. The video takes the size of the first frame (1440×1080 from
     a real camera). **[S0] measured:** from 8 MP `full`, 118 ms per frame (100 frames in 11.8 s),
     the JPEG decode (≈220 ms for 8 MP) being the bottleneck and the encode ≈ 1 ms; from
     1440×1080 pictures 45 ms per frame, about 3× faster. `unavailable` frames are skipped after
     a parent confirmation that names their count, so they never deadlock an export; transfers
     pause and shooting is blocked while it runs.
  4. **finalizing**: `await output.finalize()` → `videoClose` (fsync).
  5. **publishing**: `videoPublish` copies into MediaStore `Movies/Kopernikadr` with
     `IS_PENDING=1`, first checking free space for the actual file size + reserve. It then sets
     `IS_PENDING=0`, deletes the temp file and returns the URI. Only then is "Done, video saved to
     gallery" shown.
  6. **Cancel** is offered **only in `encoding`**: stop feeding → `output.cancel()` (it closes the
     stream and waits for the queued writes; it does not abort it) → `videoAbort` (idempotent). From `finalizing` on, the Cancel button is hidden and the export
     runs to `done` or `failed`. That makes publish and abort mutually exclusive.
  7. **Startup**: `videoCleanupAbandoned()` deletes every file in `exports/` and our own pending
     MediaStore rows (matched by owner package + display-name prefix).
- **Fallback [S0].** A native MediaCodec export would have been the fallback if WebCodecs/AVC
  failed on the T610. It did not, so it is **not built** and not needed.
- **File name and place.** `kopernikadr-<name>-<date>.mp4`, sanitized (slashes and control
  characters removed), in the tablet's gallery under `Movies/Kopernikadr` (MediaStore).

### 5.8 Deletion, Undo, recovery

- **Delete frame.** Mutation sets `hiddenUntil = now + 5 s`, and the frame disappears from UI.
  Undo is a mutation that clears it, so position and transfer state stay as they were.
- **Expiry** (timer, or app start for past deadlines): mutation moves the id to `deletedFrameIds`
  and removes the frame entry → commit → **then** unlink its files. Unlinking is idempotent.
- **Projects**: the same pattern at index level (`pendingProjectDeletes` → `deletedProjects` →
  remove the directory).
- **Startup sweep**:
  - `pending` frames with a matching installed `full` are promoted to `local` (§5.6); a mismatch
    **quarantines** the file instead of deleting it;
  - `tmp/` is emptied, and so is every `.<name>.<uuid>.tmp` that `writeTextAtomic` can leave
    after a crash, anywhere under `kopernikadr/`; `exports/` is cleaned by
    `videoCleanupAbandoned` (at plugin load, before the sweep);
  - cache files under `frames/` with no live frame entry are deleted. An unreferenced `full` that
    is not tombstoned is **kept** with a warning (a corrupt `project.json` rebuilds the project
    empty, and deleting would destroy the only copy);
  - project dirs that are tombstoned are removed;
  - project dirs missing from the index and not tombstoned are re-added to the index (recovery);
    this is also how a corrupt `index.json` is rebuilt, and `rememberedCamera` and the project
    tombstones are lost with it;
  - expired hidden frames and `pendingProjectDeletes` past their deadline are expired.
- **Boot order** (`lib/app/boot.ts`): the native export sweep (at plugin load) → ProjectStore
  load + sweep → UI → CameraClient → on every session `resolveOutstanding`, then `reconcile`.
- **`quarantine/`** folders (tablet and phone) are never cleaned up; a parent "show/clear" action
  comes in stage 3.
- Uninstalling the remote deletes all projects. README says so plainly; there is no backup in v1.

## 6. Build, signing, install

- Release keystore at `~/.kopernikadr/release.jks`, with `keystore.properties` next to it, both
  outside the repo. Debug builds use `applicationIdSuffix ".debug"`, so debug/release signatures
  never conflict and their data stays separate.
- `scripts/build.sh` → both release APKs in `dist/`.
- `scripts/install.sh` maps `adb devices` by `ro.product.model` (moto g05 → camera, TB328FU →
  remote) and runs `adb install -r`. On `INSTALL_FAILED_UPDATE_INCOMPATIBLE` it **fails loudly**
  and never uninstalls.
- `scripts/collect-diagnostics.sh` pulls both diagnostics reports (also logged with tag
  `KopernikadrDiag`) into `diagnostics/<date>/`.

## 7. Testing

- **Contract**: shared fixtures (§2) on both sides.
- **Kotlin unit**: `FrameTransform`, `Spool` (idempotency, every recovery row in §4.6, retention,
  reserve), `SessionManager` (replace, expire, stale-session rejection), control confirmation
  per generation.
- **Remote unit (vitest)**: store mutations as pure functions (capture result vs reconcile race,
  ack eligibility, Undo/expiry, recovered project), `reconcile()`, export state machine with a
  fake writer.
- **Native plugin unit**: `writeTextAtomic` never leaves the target missing (fault injection
  between steps), `videoWriteAt` with out-of-order positions.
- **Fake camera** (`protocol/tools/probe-client/fake-camera.mjs`, Node): implements the protocol
  with sample JPEGs, plus `/fake/...` switches to drop responses, kick sockets, delay, return
  `STORAGE_LOW`, restart with a new `bootId`, change `cameraId`, 404 or corrupt a `full`, stay
  `pending` for ever and reclaim a frame. Integration tests run capture → transfer → ack →
  reconnect → reconcile against it.
- **Emulator E2E** (`remote/e2e/flow.cdp.mjs`, driven over CDP against the fake camera): the main
  flow in 9 steps, 9/9 PASS on 2026-10-27 (`docs/diagnostics/20261027-stage1-2-emulator.md`).
- **On-device acceptance**: `docs/ACCEPTANCE.md`, one checklist per stage, including the failure
  list from PROMPT.md and these crash points:
  - kill after `installFile` but before `state: local`;
  - reconcile and `getOperation` returning the same frame;
  - background/foreground while a capture is writing;
  - rotation change while the first capture is unresolved;
  - cancel at each export state;
  - kill during export.

## 8. Stages

| Stage | Deliverables | You verify on hardware |
|---|---|---|
| **0 / 0b** (0: 2026-10-26; 0b: 2026-10-27, probes and PROTOCOL v1 done, the Family Link run still open) | Repo skeleton, pinned versions, build/install/diagnostics scripts, PROTOCOL.md v0, `KopernikadrNative` with atomic write + free space + MP4 writer.<br>**Camera probes**: capabilities dump; three use cases bound at real sizes (fps, capture-to-commit time, peak heap); YUV-vs-RGBA analysis cost; 20 AE/AWB-locked captures with per-frame brightness/colour stats and compensation moved mid-series; focus at mount distance; grid test at 0 and 180; **freeze** vs AE/AWB-lock comparison: lock, lock the phone screen, unlock, check that brightness/colour match frame-to-frame.<br>**Minimal real server**: `/info` (CORS), `/ws/control` with `hello`/session/`ping`/`capture`, `/ws/preview`, `/frames`.<br>**Remote probes**: WebView version, `isSecureContext`, manual address via `/info`, NSD discovery, session + heartbeat during a capture, preview pull loop, native download + sha256, `convertFileSrc`→`VideoFrame`, reconnect after phone lock and after camera restart, export of the probe frames at the chosen profile → temp → MediaStore → plays and seeks in the gallery.<br>**Supervision**: install/upgrade under the child account, camera permission, behaviour under daily limit / app limit / downtime / manual lock. | Run everything under the child account and send the reports. Then we confirm the control mechanism, check the full-res size and the export speed, choose the export path and the NSD plugin, and **freeze PROTOCOL.md v1**. |
| **1** (done 2026-10-27) | Protocol v1 on both sides + fake camera. Connection screen, sessions/BUSY, preview with watchdog, capture with the durable spool (operation rows, recovery, idempotency, `getOperation`), outstanding captures on the tablet, onion skin, parent drawer (controls with `confirmed`/`settling`, rotation for empty projects). Phone status UI, keep-on/dim, permission-denied screen. | Shooting works; locks hold across phone lock/unlock; preview and onion skin line up in the grid test. |
| **2** (done 2026-10-27) | Transfer with verification and ack eligibility, reconcile (incl. recovered projects), serialized ProjectStore, projects screen (create/rename/delete + Undo), phone retention + orphans, storage reserves on both sides. | The failure list: Wi-Fi off mid-transfer, phone locked, either app killed around capture/install/ack, lost capture response, low storage on each side. |
| **3** | Frame strip, view/delete + Undo, playback, export with progress/cancel/cleanup. **Minimal playback and export were pulled forward into stages 1+2** (owner decision, 2026-10-27). What remains for stage 3: the frame strip and editing, the 7-day reclaim, the phone dim (`ScreenPolicy`) and a cleanup UI for `quarantine/`. | 500-frame project → playback → export; memory stays flat; cancel and app kill during export leave no junk. |
| **4** | UX polish from your notes. | With the kid. |

## 9. Decisions (approved by the owner on 2026-10-26)

1. Battery-optimization exemption dropped (§4.2).
2. The phone produces `play`/`thumb` display caches, so the onion skin is fast. **Export is from
   `play` (1440×1080, the export size anyway), with a fallback to `full` resized to the same
   size** (revised 2026-10-27 after the tablet measurements: ≈3× faster, same output size; §4.3,
   §5.7).
3. Pull-based WS preview instead of MJPEG (§5.3).
4. targetSdk 36 (§3).
5. ~~QR as a deep link opened by the tablet's own scanner~~ **Dropped** (2026-10-27): NSD works
   on the tablet and manual entry stays (§5.2).
6. No auto-retake after a failed/unknown capture (§5.6).
7. Rotation is per project, **0/180 only**, and frozen once the project has frames (§4.3).
8. One camera per project. After a camera-app reinstall or data wipe, old movies can be watched
   and exported but not continued (§5.4).
9. Export Cancel is available only while encoding, not during finalize/publish (§5.7).
10. Orphaned frames (from a reinstalled remote) are never deleted by the app; only the OS
    "Clear storage" removes them (§4.6).
11. **"Lock" = freeze the measured values** (manual ISO/time, WB gains/transform, focus
    distance), not AE/AWB lock. This survives restarts exactly. Compensation is set before
    locking (§4.4).
12. `full` = 3264×2448 (8 MP) instead of the sensor maximum (§4.3).
13. **No zustand**: a small own store with `useSyncExternalStore` (§5.1).
14. **Quarantine instead of delete** for any `full` file that can't be accounted for, on the phone
    and on the tablet (§4.6, §5.6, §5.8). Nothing cleans it automatically.
15. The phone reclaims acked frames under low space and 7 days after the ack, hourly (§4.6).
    Unacked frames are never reclaimed.
16. Minimal playback and export are built in stages 1+2, not stage 3 (§8).
