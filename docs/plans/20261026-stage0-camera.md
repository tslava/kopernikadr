# Stage 0a — camera-android: probes first, minimal server

## Overview
- Build the first version of `camera-android` on the moto g05 and **answer the stage-0 phone
  questions with measurements**:
  1. Does **freeze** keep exposure/colour across a series **and across a camera restart while
     the scene changed**, better than AE/AWB lock?
  2. Is 3264×2448 a JPEG size? What do capture-to-commit (broken down by step) and peak heap
     look like?
  3. Do Preview + ImageAnalysis + ImageCapture really bind together at the requested sizes, at
     what resolved sizes and fps, and how does that compare with the variant without Preview?
  4. Is focus sharp at the mount distance?
  5. Do the tablet-preview path and the still line up at rotation 0 and 180 (shift, scale, flip)?
- **Probes come first**, built on pure core logic; the production-shaped camera code grows
  under them. After the probes, a **minimal real server**: `/info`, `hello` + session, `ping`,
  a simple `capture`, pull `/ws/preview`, `/frames`. That lets plan 0b's tablet probes talk to
  a real camera.
- **Deferred to stage 1** (as in ARCHITECTURE §8):
  - full Spool recovery, reqId idempotency/replay and `getOperation`;
  - `ScreenPolicy` dimming;
  - QR;
  - the full status UI.
- **Deferred to plan 0b**:
  - the tablet (`remote`, Capacitor, `KopernikadrNative`, export probe);
  - release signing and the `scripts/*`;
  - the README parent checklist;
  - Family Link limit tests;
  - freezing PROTOCOL v1.

## Context (from discovery)
- Repo: only `docs/PROMPT.md`, `docs/ARCHITECTURE.md` (rev 3 + hardware facts, §8 stages,
  §9 approved decisions) and `protocol/PROTOCOL.md` (v0 rev 3). No code; nothing committed.
- Mac toolchain:
  - Android SDK at `~/Library/Android/sdk`: platforms 36/36.1, build-tools 35/36;
    `platform-tools/adb` is not on PATH;
  - **no system JDK**. Android Studio's JBR is at
    `/Applications/Android Studio.app/Contents/jbr/Contents/Home`;
  - no system Gradle;
  - Node 22.21.
- Phone:
  - moto g05, Android 15 (API 35), 720×1604, lens-down over the table;
  - Camera2 FULL with MANUAL_SENSOR, MANUAL_POST_PROCESSING, READ_SENSOR_SETTINGS;
  - AE/AWB lock, compensation [-4,4] × ½ EV, manual focus + AF macro;
  - 4:3 stream sizes 3264×2448 … 640×480;
  - USB debugging is being enabled under Family Link.
- Approved decisions:
  - Lock = freeze of the metered values;
  - rotation 0/180 only;
  - `full` 3264×2448;
  - targetSdk 36 / minSdk 31;
  - no battery exemption;
  - pull WS preview;
  - no auto-retake.
- Decisions from this plan's review, approved by the owner:
  - **a separate JVM module `:core`** for all pure logic;
  - **probes first, minimal server**.
- Constraints:
  - Mac + phone only;
  - no system JDK install;
  - dependencies stable and ≥14 days old (cutoff 2026-10-12);
  - the phone is available, so every camera task has an on-device check.

## Development Approach
- **testing approach**: mixed.
  - **TDD** for everything in `:core` (no `android.*` there, enforced by the module type):
    `Ulid`, geometry/`FrameTransform`, size selection, capability mapping, `ConfirmationMachine`,
    `Metrics`, `StillPipeline` logic via the `ImageCodec` seam, `Spool` (pending/commit/fail),
    `SessionManager`, protocol models + fixtures, server routes (Ktor `testApplication`), the NSD
    TXT builder.
  - **Code first + on-device check** for the `:app` adapters: CameraX binding, Camera2Interop,
    PreviewView, NSD registration, UI, probe runners.
- Complete each task fully before moving to the next. Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task:
  - write unit tests for new functions/methods;
  - write unit tests for modified functions/methods;
  - add new test cases for new code paths;
  - update existing test cases if behaviour changes;
  - tests cover both success and error scenarios.
- **CRITICAL: all tests must pass before starting the next task.** No exceptions.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Commands (always via the wrapper):
  - `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - build/install: `./gradlew-jbr :app:installProbe` (timing runs) or `:app:installDebug`.

## Testing Strategy
- **`:core` unit tests** (JVM): SQLite via `androidx.sqlite` `BundledSQLiteDriver`, which
  resolves its JVM variant in a `kotlin("jvm")` module (spike in Task 1). Images go through the
  `ImageCodec` seam, implemented with `javax.imageio` in tests. Time, disk space and directory
  fsync go through the `Clock` / `DiskSpace` / `DirSync` seams.
- **Server tests**: Ktor `testApplication` in `:core` with a fake `CameraPort`. They cover:
  - `/info` + CORS;
  - hello / BUSY / replace (4001 on the old control **and** preview socket) / LEASE_LOST /
    `UNSUPPORTED_VERSION` / non-hello first message;
  - ping while capture runs;
  - capture single-flight;
  - the preview 409 before upgrade, the pull loop, coalescing, and a pending `next` surviving a
    camera rebind;
  - `/frames` + Content-Length;
  - port-busy fallback (bind a `ServerSocket` first).
- **Contract**: each `protocol/fixtures/*.json` in the 0a subset round-trips through the Kotlin
  models (`encodeDefaults=true`, `explicitNulls=false`) to equal JSON.
- **`:app` unit tests**: only thin mapping helpers (e.g. Camera2 result → `ResultSummary`) with
  plain value inputs. No Robolectric.
- **Mac client** `protocol/tools/probe-client`: `node:test` for the preview frame parser.
- **On device**: each camera task ends with a phone check. The probes produce the answers. The
  `docs/ACCEPTANCE.md` 0a section records pass/fail.

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with the ➕ prefix.
- Document issues and blockers with the ⚠️ prefix.
- Update the plan if implementation deviates from the original scope, and keep it in sync with
  the actual work.

## Solution Overview
- **Gradle project** `camera-android/`:
  - `:core`: `kotlin("jvm")`, no Android; holds the domain logic, protocol models, Ktor routes and
    the Spool;
  - `:app`: Android application; holds the CameraX/Camera2 adapters, UI, NSD, the probe runners
    and the codec/disk adapters.

  This deviates from ARCHITECTURE §2 ("single :app module"); Task 16 updates the doc.
- **Build types**:
  - `debug` (`.debug` suffix);
  - `probe`: `initWith(release)`, `isDebuggable=false`, debug signing, `.probe` suffix, own
    source set `src/probe` with all diagnostics code;
  - `release`: no diagnostics code at all; `installDiag(...)` is a no-op there.

  Timing probes run on `probe`, and every report records `debuggable`.
- **Geometry** (fixes the review's portrait-crop issue):
  - the activity is locked to `landscape`;
  - all three use cases and the `ViewPort` use one fixed target rotation `ROTATION_90`, so a
    4:3 ViewPort equals the sensor-native landscape (no FOV loss) and every buffer's
    `rotationDegrees` is 0 or 180;
  - project rotation 0 is defined relative to the sensor's native landscape;
  - `FrameTransform` applies `rotationDegrees + projectRotation` (mod 360, only 0/180) plus the
    `cropRect`. It never rotates by 90°, so the 8 MP still needs one bitmap plus at most one
    rotated copy.
- **Reports**: probes write to `getExternalFilesDir("diag")/<runId>/`. `adb pull` reads them on a
  non-debuggable build too, and so does HTTP once `/diag` exists. Probe captures use their **own**
  `Spool` instance in the run dir, never the production spool. Probes and remote captures are
  mutually exclusive: a probe holds the camera lock, and a remote `capture` meanwhile gets
  `CAMERA_NOT_READY`.
- **ProbeRunner** is Application-scoped, so it survives screen lock and activity recreation. A
  probe step that needs the camera waits for the next bind. Interactive steps (put the card in,
  take it out, lock the screen) show a full-screen prompt with a large **Continue** button on the
  phone; the screen faces up. From the Mac they are answered with `POST /diag/continue` once the
  routes exist.

## Technical Details
- **Toolchain**:
  - the Gradle 9.8.1 wrapper (published 2026-10-07) is generated once by running the downloaded
    9.8.1 distribution with the JBR; `distributionSha256Sum` is pinned;
  - `gradlew-jbr` exports `JAVA_HOME` (JBR) and `ANDROID_HOME`, writes `local.properties` if it
    is missing, and execs `./gradlew`;
  - AGP 9 has built-in Kotlin, so `kotlin.android` is not applied. The Compose compiler and
    serialization plugins are applied;
  - no `jvmToolchain()` (it would auto-provision a JDK); `jvmTarget`/`compileOptions` are set
    explicitly.
- **Dependencies** (Task 1 pins exact versions ≥14 days old in `libs.versions.toml`, with dates
  in `VERSIONS.md`):
  - AGP 9.x, Kotlin 2.4.x, Compose BOM, activity-compose;
  - camera-core / camera2 / lifecycle / view (`PreviewView`);
  - Ktor server core / cio / websockets / cors + `ktor-server-test-host`, slf4j-android (or
    `slf4j-nop`);
  - kotlinx-serialization-json, kotlinx-coroutines (+ test);
  - androidx.sqlite + sqlite-bundled;
  - JUnit 4.13.2.
- **Size selection**:
  - `full` = the largest 4:3 JPEG ≤ 3264×2448;
  - analysis 1280×960 YUV, **falling back to 960×720**;
  - Preview: 4:3 matched by the ViewPort.

  Bind once with `FALLBACK_RULE_NONE` to detect real failure, then with fallback. The resolved
  sizes (`resolutionInfo`, `ImageProxy` w/h) are always recorded next to the requested ones.
- **`:core` seams**: `ImageCodec` (decode/encode/transform on own `Pixels`), `DiskSpace`,
  `DirSync`, `KeyValueStore`, `Clock`, `CameraPort`.
- **`:app` adapters**:
  - `ImageCodec` → `BitmapFactory`/`Bitmap.compress`/`Matrix`;
  - `DirSync` → `Os.open(dir, O_RDONLY)` + `Os.fsync` (primary), with the path that worked
    logged;
  - `KeyValueStore` → `SharedPreferences.commit()`.
- **Spool 0a** (`:core`):
  - schema as in ARCHITECTURE §4.5, plus `capturedAt`, `exposureJson`, `errorMessage`;
  - WAL + `synchronous=FULL`;
  - API: `lookup(clientId, reqId)`, `insertPending(...)`, `commit(frameId, meta)`,
    `fail(frameId, code, msg)`;
  - `recover()` is **not** in 0a. A leftover `pending` row from a crash is simply left; stage 1
    adds recovery.
  - Durable write: tmp → `fd.sync()` → atomic move → `DirSync`.
- **Controls** (fixes the review's CameraX mechanics):
  - a **full option set per generation** via `Camera2CameraControl.setCaptureRequestOptions`;
    `CONTROL_MODE=AUTO` with per-control modes; `SENSOR_FRAME_DURATION` set with manual exposure;
  - the generation **fence** is the future returned by `setCaptureRequestOptions`, plus the frame
    number at completion. Only results after the fence count (no request tags — CameraX owns
    them);
  - freeze waits for `aeState` CONVERGED (or FLASH_REQUIRED) / `awbState` CONVERGED, with a 3 s
    timeout → `failed`, then reads ISO / exposure time / frame duration / gains / transform from
    the next result;
  - AF: `CameraControl.startFocusAndMetering` with auto-cancel disabled, then freeze
    `LENS_FOCUS_DISTANCE` with `afMode=OFF`;
  - lock **intent** and frozen values are persisted with `commit()`.
- **ConfirmationMachine** (`:core`) consumes
  `ResultSummary(frameNumber, aeMode, aeState, iso, timeNs, awbMode, awbState, ccMode, gains,
  transform, afMode, afState, lensState, distance)`:
  - freeze-exposure: `aeMode==OFF`, ISO equal, time within 1%;
  - freeze-WB: `awbMode==OFF`, `ccMode==TRANSFORM_MATRIX`, gains/transform within rounding;
  - freeze-focus: `afMode==OFF`, `STATIONARY`, distance within 0.05 dpt;
  - fallbacks use the lock states;
  - 3 s → `failed`.
- **Per-still metadata**: every `ImageCapture` result is paired with its `TotalCaptureResult` via
  `Camera2Interop.Extender(imageCaptureBuilder).setSessionCaptureCallback` (EXIF ISO/time as a
  cross-check). Preview fps comes from counting results through the same callback on the
  Preview builder.
- **Metrics** (`:core`):
  - mean luma and R/G/B over the centre 50%;
  - per-segment mean/stddev, the step between segments in units of the within-segment stddev;
  - Laplacian variance on a 512-px grayscale centre crop;
  - **alignment**: downscale both images to 320×240 grayscale, search shift ±16 px × scale
    0.95–1.05 (0.01 steps) by normalized cross-correlation, report the best score and the score
    of the 180°-rotated candidate, and write a 50% overlay PNG.
- **Probes** (run on the `probe` build):
  - `caps`:
    - hardware level, capabilities;
    - AE/AWB/AF modes, AE antibanding modes;
    - compensation range/step, ISO/exposure/frame-duration ranges;
    - JPEG and stream sizes, `SENSOR_INFO_ACTIVE_ARRAY_SIZE`, sensor orientation;
    - min focus distance + `LENS_INFO_FOCUS_DISTANCE_CALIBRATION`.
  - `streams`, for variant A (Preview + Analysis + Capture) and variant B (Analysis + Capture):
    - strict bind with `FALLBACK_RULE_NONE` (ok/fail), then fallback bind with the resolved
      sizes;
    - preview fps and analysis fps over 10 s;
    - 20 captures at `full` with a capture-to-commit breakdown (takePicture / decode /
      transform / encode / fsync / DB) as p50 and p95;
    - native + Java heap sampled every 50 ms during the captures;
    - then 10 s analysis cost: YUV + on-demand JPEG vs RGBA + output rotation (CPU ms per
      frame).
  - `locks`, for each method (freeze, ae_awb_lock), N=10 per segment:
    - S1 auto, 2 s;
    - lock + confirm;
    - S2 N captures;
    - (fallback only) compensation +2 steps → S3 N captures;
    - prompt "put the card into the frame" → camera restart (unbind/rebind; with
      `--manual-restart`: prompt to lock and unlock the phone screen) → re-apply the lock as
      after a real restart → prompt "remove the card";
    - S4 N captures.

    The report contains per-still ISO/time/gains, per-segment metrics, and the S2→S4 step in
    stddev units. This is the "freeze vs AE lock" answer.
  - `focus`: AF trigger at the mount, `LENS_FOCUS_DISTANCE`, sharpness at d, d±0.25, d±0.5 dpt
    (only if calibrated), and the freeze-focus confirmation time.
  - `grid`: an asymmetric printed target (`docs/diagnostics/grid-target.svg`, 4 distinct corner
    fiducials + an arrow). At rotation 0 and 180: capture `full` and the next frame from the
    **PreviewEncoder path** (analysis → FrameTransform → JPEG, the tablet's view), then run the
    alignment metrics and save the overlay PNG.

## What Goes Where
- **Implementation Steps** (`[ ]`): code, tests, docs, and on-device checks on the phone.
- **Post-Completion**: things needing the child account in real conditions, or the tablet.

## Implementation Steps

### Task 1: Gradle skeleton (:core + :app), toolchain, pinned versions, build types

**Files:**
- Create: `.gitignore`, `camera-android/settings.gradle.kts`, `camera-android/build.gradle.kts`,
  `camera-android/gradle/libs.versions.toml`, `camera-android/gradle/wrapper/*`, `camera-android/gradlew*`,
  `camera-android/gradlew-jbr`, `camera-android/VERSIONS.md`
- Create: `camera-android/core/build.gradle.kts`, `camera-android/core/src/test/kotlin/.../SqliteSpikeTest.kt`
- Create: `camera-android/app/build.gradle.kts`, `camera-android/app/src/main/AndroidManifest.xml`,
  `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/{App,MainActivity}.kt`,
  `camera-android/app/src/main/kotlin/.../diag/InstallDiag.kt` (no-op), `camera-android/app/src/probe/...`,
  `camera-android/app/src/debug/...` (diag hook stubs)

- [ ] check publish dates; pin every dependency ≥14 days old in `libs.versions.toml`; record
      versions + dates in `VERSIONS.md`
- [ ] produce the Gradle 9.8.1 wrapper with the downloaded distribution + JBR; pin
      `distributionSha256Sum`. `gradlew-jbr` exports `JAVA_HOME`/`ANDROID_HOME`, creates
      `local.properties`, and fails clearly if the JBR is missing
- [ ] `:app`:
  - [ ] `applicationId pl.slava.kopernikadr.camera`, compile/target/min 36/36/31;
  - [ ] build types debug / probe (non-debuggable, debug signing, `src/probe`) / release;
  - [ ] activity locked to landscape, `FLAG_KEEP_SCREEN_ON`, edge-to-edge;
  - [ ] permissions CAMERA, INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE,
        CHANGE_WIFI_MULTICAST_STATE;
  - [ ] cleartext network security config;
  - [ ] label "Kopernikadr Kamera"; `values/` Polish, `values-ru/`
- [ ] **spike**: `SqliteSpikeTest` opens a `BundledSQLiteDriver` DB in `:core` tests on macOS
      and sets WAL + `synchronous=FULL`. If it fails, switch to `sqlite-jdbc` in tests behind a
      `SqlDriver` seam and record it with ⚠️
- [ ] `./gradlew-jbr :core:test :app:assembleDebug :app:assembleProbe :app:assembleRelease` green
- [ ] on the phone: `adb install -r` of the debug build; it launches in landscape
- [ ] run tests — must pass before task 2

### Task 2: Pure core — Ulid, geometry, size selection, capability mapping (TDD)

**Files:**
- Create: `core/src/main/kotlin/.../core/{Ulid,Geometry,FrameTransform,SizeSelection,CapabilityMapper,CharacteristicsSnapshot}.kt`
- Create: matching tests in `core/src/test/...`

- [ ] tests first, then `Ulid`: monotonic within a ms, 26-char Crockford, sortable
- [ ] tests first, then `IntRect`/`Affine` + `FrameTransform`: `rotationDegrees` ∈ {0,180} ×
      project rotation {0,180} → output w>h, exactly 4:3 after crop, no 90° rotation; rejects
      90/270 inputs; odd crop rects
- [ ] tests first, then `SizeSelection`: g05 JPEG list → 3264×2448; fallback to a lower 4:3;
      analysis 1280×960 → 960×720 fallback; non-4:3 rejected
- [ ] tests first, then `CapabilityMapper`: `CharacteristicsSnapshot` (own data class) → PROTOCOL
      `Capabilities` (freeze/ae_lock/null methods, compensation num/den, rotations [0,180], focus
      modes, fixed lens)
- [ ] write tests for edge cases: empty size lists, no manual capabilities → fallback methods,
      uncalibrated focus distance
- [ ] run tests — must pass before task 3

### Task 3: `caps` probe, ProbeRunner, bare diagnostics screen (on device)

**Files:**
- Create: `core/src/main/kotlin/.../diag/{ProbeReport,ProbeRunnerCore}.kt` + tests
- Create: `app/src/probe/kotlin/.../diag/{ProbeRunner,CapsProbe,DiagnosticsScreen}.kt`,
  `app/src/main/kotlin/.../camera/CharacteristicsReader.kt`
- Create: `core/src/test/resources/g05-caps.json` (after the run)

- [ ] `ProbeRunnerCore` (`:core`, TDD): one probe at a time, run dir + `report.json`, a failure is
      captured in the report, steps can wait on "camera bound" and on user "Continue"
- [ ] `ProbeRunner` (Application-scoped) + `CharacteristicsReader` → `CharacteristicsSnapshot`
      (all `caps` fields from Technical Details)
- [ ] diagnostics screen: probe buttons, progress, full-screen prompt with Continue, last report
      summary
- [ ] on the phone (probe build): run `caps`; `adb pull` the report; save it as `g05-caps.json`
- [ ] write tests: `CapabilityMapper` and `SizeSelection` against the **real** `g05-caps.json`
      (fixes the fakes if reality differs)
- [ ] run tests — must pass before task 4

### Task 4: CameraController — binding, viewfinder, resolved sizes (on device)

**Files:**
- Create: `core/src/main/kotlin/.../camera/CameraPort.kt`
- Create: `app/src/main/kotlin/.../camera/{CameraController,ResultSummaryMapper}.kt`,
  `app/src/main/kotlin/.../ui/StatusScreen.kt` (with `PreviewView`)
- Create: `app/src/test/kotlin/.../camera/ResultSummaryMapperTest.kt`

- [ ] `CameraController`:
  - [ ] Preview (`PreviewView` on the status screen) + ImageAnalysis (KEEP_ONLY_LATEST) +
        ImageCapture (in-memory) in one `UseCaseGroup`, `ViewPort(4:3, ROTATION_90)`, all
        target rotations `ROTATION_90`;
  - [ ] variant B without Preview;
  - [ ] strict bind (`FALLBACK_RULE_NONE`), then fallback bind;
  - [ ] expose the resolved sizes
- [ ] session capture callbacks on the Preview and ImageCapture builders → `ResultSummary` stream
      with frame numbers
- [ ] `CameraPort` adapter (`takePicture` → JPEG bytes + paired `ResultSummary`; analysis frames
      on demand)
- [ ] write tests: `ResultSummaryMapper` from plain values (null keys, units)
- [ ] on the phone: the viewfinder shows landscape 4:3 with the full FOV; resolved sizes are
      logged; the camera releases on screen lock and rebinds on unlock
- [ ] run tests — must pass before task 5

### Task 5: Still pipeline, durable files, Spool 0a (TDD + on device)

**Files:**
- Create: `core/src/main/kotlin/.../image/{ImageCodec,StillPipeline,PreviewEncoder}.kt`,
  `core/src/main/kotlin/.../spool/{DurableFiles,Spool,SpoolSchema}.kt` + tests
  (`core/src/test/.../image/ImageIoCodec.kt` test codec)
- Create: `app/src/main/kotlin/.../image/AndroidImageCodec.kt`, `app/src/main/kotlin/.../spool/AndroidDirSync.kt`

- [ ] tests first, then `DurableFiles.writeAtomic` (tmp → sync → atomic move → `DirSync`) +
      sha256; I/O failure leaves no target file
- [ ] tests first, then `Spool` 0a: `lookup` / `insertPending` / `commit` / `fail`; `UNIQUE(clientId,
      reqId)`; `seq` strictly increasing across reopen; stores `capturedAt`/`exposureJson`/error
- [ ] tests first, then `StillPipeline`: JPEG → decode → `FrameTransform` → `full` q92 → durable
      write → commit, with timings per step. Caches `play` 1440×1080 / `thumb` 256×192 after
      commit (best-effort)
- [ ] tests first, then `PreviewEncoder`: encode only when a request is pending, sizes 640/960/1280,
      same `FrameTransform`
- [ ] `:app` adapters: `AndroidImageCodec`, `AndroidDirSync` (`Os.open` + `Os.fsync`, log the path
      used)
- [ ] on the phone: one capture → file in a scratch spool, correct orientation, timings logged
- [ ] run tests — must pass before task 6

### Task 6: `streams` probe (on device)

**Files:**
- Create: `app/src/probe/kotlin/.../diag/StreamsProbe.kt`
- Create: `core/src/main/kotlin/.../diag/Stats.kt` + test (p50/p95, heap series summary)

- [ ] tests first, then `Stats` (percentiles, min/max, series summary)
- [ ] `streams` per Technical Details: variants A/B, strict + fallback bind, resolved sizes,
      preview/analysis fps, 20 captures with breakdown, heap sampling, YUV vs RGBA cost; probe
      Spool in the run dir
- [ ] on the phone (probe build): run `streams`; pull the report
- [ ] ➕ if the strict A bind fails or fps is poor, record it and propose the ARCH §4.3 fallback
      in Task 16
- [ ] run tests — must pass before task 7

### Task 7: Controls — freeze/fallback, generation fence, confirmation (TDD + on device)

**Files:**
- Create: `core/src/main/kotlin/.../camera/{ConfirmationMachine,ControlsPlan,KeyValueStore}.kt` + tests
- Create: `app/src/main/kotlin/.../camera/{Controls,PrefsKeyValueStore}.kt`

- [ ] tests first, then `ConfirmationMachine`:
  - per control and per method;
  - only results after the fence frame number count;
  - convergence wait;
  - 3 s → `failed`;
  - stale results ignored
- [ ] tests first, then `ControlsPlan` (pure): intent + frozen values → the complete option set per
      generation (`CONTROL_MODE=AUTO`, per-control modes, `SENSOR_FRAME_DURATION`); compensation
      only for auto/ae_lock; persistence of intent + values
- [ ] `Controls` adapter:
  - [ ] `setCaptureRequestOptions` future as the fence;
  - [ ] AF via `startFocusAndMetering` (no auto-cancel);
  - [ ] re-apply on bind (`exact`);
  - [ ] `commit()` persistence
- [ ] on the phone: lock with freeze → `confirmed` within a few frames; lock the screen and unlock
      → re-applied with `exact:true`; fallback lock → confirmed by lock states
- [ ] run tests — must pass before task 8

### Task 8: Metrics and the printable target (TDD)

**Files:**
- Create: `core/src/main/kotlin/.../diag/Metrics.kt` + `MetricsTest.kt`
- Create: `docs/diagnostics/grid-target.svg`

- [ ] tests first, then the luma/RGB centre means, segment stats and step-in-stddev
- [ ] tests first, then Laplacian variance (sharp vs blurred synthetic)
- [ ] tests first, then alignment: shift ±16 × scale 0.95–1.05 NCC on synthetic images with a
      known shift/scale; 180° candidate detected; periodic pattern doesn't fool it thanks to
      fiducials; overlay image produced
- [ ] `grid-target.svg`: A4, 4 distinct corner fiducials + an arrow + a fine grid
- [ ] run tests — must pass before task 9

### Task 9: `locks`, `focus`, `grid` probes (on device)

**Files:**
- Create: `app/src/probe/kotlin/.../diag/{LocksProbe,FocusProbe,GridProbe}.kt`

- [ ] `locks` with segments S1–S4, card prompts, the restart step and `--manual-restart`, per
      Technical Details; per-still ISO/time/gains from the paired results
- [ ] `focus` per Technical Details (±dpt only if calibrated)
- [ ] `grid` at 0 and 180 through the `PreviewEncoder` path; overlay PNG
- [ ] write tests: segment bookkeeping in `ProbeRunnerCore` (prompt/continue/wait-for-bind
      transitions, a run resumed after a rebind)
- [ ] on the phone: run all three, including `locks --manual-restart` across a real screen
      lock/unlock; pull the reports
- [ ] run tests — must pass before task 10

### Task 10: Protocol fixtures, models, SessionManager (TDD)

**Files:**
- Create: `protocol/fixtures/*.json` (info, hello req/res/busy/unsupported, ping, capture
  req/res/err, preview header, status)
- Create: `core/src/main/kotlin/.../protocol/Messages.kt`,
  `core/src/main/kotlin/.../server/SessionManager.kt` + tests

- [ ] fixtures per PROTOCOL §3–7 for the 0a subset
- [ ] tests first, then the models: `args` decoded as `JsonElement` and then per `op` (unknown op →
      `UNKNOWN_OP`, bad args → `INVALID_ARGS`); round-trip equality; unknown fields ignored
- [ ] tests first, then `SessionManager`:
  - grant / replace (returns the old session to close) / BUSY with `retryAfterMs`;
  - `validate` → LEASE_LOST;
  - injected monotonic `Clock`, TTL 10 s;
  - expiry exactly at TTL
- [ ] run tests — must pass before task 11

### Task 11: Server — `/info`, `/frames`, identity, status (TDD)

**Files:**
- Create: `core/src/main/kotlin/.../server/{Server,InfoRoutes,FrameRoutes,Identity,StatusProvider}.kt` + tests
- Create: `app/src/main/kotlin/.../server/AndroidStatusSource.kt`

- [ ] `Identity`: persisted `cameraId` (durable write), new `bootId` per server start
- [ ] `StatusProvider`: battery/charging, free space, spool bytes / unacked count, thermal, behind
      seams
- [ ] tests first, then the Ktor CIO server on 8765 (ephemeral fallback when busy), `/info` with
      CORS for `http://localhost`, `/frames/{id}/{full|play|thumb}.jpg` with Content-Length,
      on-demand caches, 404 rules
- [ ] write tests: CORS header, port-busy fallback (pre-bound `ServerSocket`), 404 vs on-demand
      cache
- [ ] `:app`: start/stop with the activity (stop off the main thread)
- [ ] run tests — must pass before task 12

### Task 12: Server — `/ws/control` (hello, session, ping, capture) (TDD)

**Files:**
- Create: `core/src/main/kotlin/.../server/ControlSocket.kt`, `core/src/main/kotlin/.../capture/SimpleCapture.kt` + tests

- [ ] tests first, then `hello`:
  - must be the first message, otherwise an error + close;
  - version negotiation → `UNSUPPORTED_VERSION`;
  - session grant / BUSY + close / replace → 4001 on the old control socket;
  - stale socket → `LEASE_LOST` + 4002
- [ ] tests first, then `ping` (answered while a capture runs)
- [ ] tests first, then `SimpleCapture` (0a): lookup → checks → `insertPending` → camera →
      `StillPipeline` → commit:
  - one in flight → `CAPTURE_IN_PROGRESS`;
  - rotation mismatch → `GEOMETRY_MISMATCH`;
  - probe owns the camera → `CAMERA_NOT_READY`;
  - free space → `STORAGE_LOW`;
  - a committed reqId returns its stored `FrameInfo` (cheap, since `lookup` exists)
- [ ] other ops → `UNKNOWN_OP` (`getOperation`/`listFrames`/`ack`/`setControl` come in stage 1)
- [ ] run tests — must pass before task 13

### Task 13: Server — `/ws/preview` pull loop (TDD)

**Files:**
- Create: `core/src/main/kotlin/.../server/PreviewSocket.kt` + tests

- [ ] tests first, then a route-scoped session check **before** the upgrade (409)
- [ ] tests first, then the pull loop: one pending `next`, duplicates coalesced, binary
      `uint32 BE headerLen + JSON + JPEG`, quality low/normal/high, a pending `next` survives a
      camera rebind, closed with 4001 on session replace
- [ ] run tests — must pass before task 14

### Task 14: NSD, `/diag` routes, probe-client (on device)

**Files:**
- Create: `core/src/main/kotlin/.../net/TxtRecord.kt` + test,
  `app/src/main/kotlin/.../net/Advertiser.kt`
- Create: `app/src/probe/kotlin/.../diag/DiagRoutes.kt`, `app/src/debug/kotlin/.../diag/DiagRoutes.kt`
- Create: `protocol/tools/probe-client/{package.json,client.mjs,preview-frame.mjs,preview-frame.test.mjs}`

- [ ] `TxtRecord` (TDD) + `Advertiser` register/unregister `_kopernikadr._tcp` in onStart/onStop
- [ ] `/diag`:
  - `POST /diag/probe/{name}`;
  - `POST /diag/continue`;
  - `GET /diag/runs`;
  - `GET /diag/report/{runId}`;
  - `GET /diag/files/{runId}/{name}` (strict regex on both segments);
  - `POST /diag/controls` (lock method, compensation, rotation, previewQuality)

  Installed via `installDiag` only in debug/probe.
- [ ] probe-client (Node global `WebSocket`, no deps), persistent `clientId` file. Commands:
  - `info`;
  - `hello [--clientId]`;
  - `capture` (+ same-reqId repeat);
  - `preview --seconds --quality` (fps, latency, sizes; a watchdog re-hellos after a stall);
  - `download` (sha256);
  - `probe <name>` (start, continue prompts, fetch the report + files into `diagnostics/<date>/`)
- [ ] write `node:test` tests for the preview frame parser (good, short header, bad JSON)
- [ ] on the phone: `dns-sd -B _kopernikadr._tcp` sees it; `probe-client info/hello/capture/preview
      /download` work; a second clientId gets BUSY
- [ ] run tests — must pass before task 15

### Task 15: Full on-device run, results, acceptance

**Files:**
- Create: `docs/diagnostics/<run-date>-phone.md` (raw reports under `diagnostics/`, git-ignored)
- Create: `docs/ACCEPTANCE.md` (stage 0a section)

- [ ] phone mounted at the real height over the printed target, under the child account, probe
      build
- [ ] run `caps`, `streams`, `focus`, `grid`, `locks`, `locks --manual-restart` via probe-client;
      `preview --quality high` for the 1280 px fps; Wi-Fi off/on → a new hello + preview works
- [ ] summary with numbers:
  - lock method verdict (S2→S4 steps for both methods);
  - 8 MP availability;
  - capture-to-commit breakdown and heap;
  - A vs B binding and fps;
  - focus;
  - alignment (shift/scale/score, 0 and 180)
- [ ] `docs/ACCEPTANCE.md` 0a checklist with pass/fail
- [ ] run the full test suite — must pass before task 16

### Task 16: Verify acceptance criteria
- [ ] every Overview question has a measured answer in the run summary
- [ ] edge cases: permission denied text, port busy (test), Wi-Fi drop, second client BUSY, screen
      lock during a probe
- [ ] full suite: `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
      `cd protocol/tools/probe-client && node --test`
- [ ] `assembleRelease` contains no `diag` classes (class-list check)

### Task 17: [Final] Update documentation
- [ ] `docs/ARCHITECTURE.md`:
  - [ ] `:core`/`:app` modules, the `probe` build type;
  - [ ] locked landscape + `ROTATION_90` geometry;
  - [ ] the controls fence mechanism;
  - [ ] measured facts replacing the answered [S0] items; tablet [S0] items marked pending 0b;
  - [ ] the 0↔180 no-rebind simplification if the run confirms it
- [ ] `protocol/PROTOCOL.md`: corrections found while implementing (stays v0 until 0b)
- [ ] `README.md`: build/install via `gradlew-jbr`, the adb path, how to run the probes and
      probe-client
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Manual verification**
- The parent decides whether to keep "Opcje programisty" / USB debugging enabled on the phone
  after 0a.
- Re-run `locks` in the evening, under the actual room light the movie will be shot in.

**Plan 0b (next)**
- Tablet:
  - Next + Capacitor skeleton;
  - `KopernikadrNative` (atomic write, free space, MP4 writer + MediaStore);
  - remote probes: secure context, WS to the real camera, NSD plugin, native download,
    `convertFileSrc` → `VideoFrame`, T610 export speed from 8 MP originals.
- Release signing; `scripts/build.sh` / `install.sh` / `collect-diagnostics.sh`; the README
  parent checklist.
- Family Link behaviour under daily limit / app limit / downtime / manual lock.
- Freeze PROTOCOL.md v1.

**Stage 1 (moved from 0a)**
- Spool `recover()` + reqId replay/attach + `getOperation`.
- `ScreenPolicy` dimming, QR, the full status UI, the localized permission screen.
