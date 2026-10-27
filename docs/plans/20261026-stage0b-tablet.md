# Stage 0b — tablet remote skeleton, native plugin, probes, release tooling, protocol v1

Status: rev 2 (after the plan review; all critical and important findings applied).

## Overview
- **Goal:** answer the remaining stage-0 questions on the **tablet** and put the foundations under
  the native remote, without building the full remote app yet (that is stages 1–3). The
  questions:
  - Does a Capacitor 8 app on the Tab M10 (Android 12, WebView 155) have a secure context?
  - Can it talk ws:// and http:// to the camera?
  - Can it **discover the camera via NSD**?
  - Can it download originals natively and turn them into `VideoFrame`s?
  - Can it encode H.264 1440×1080 with WebCodecs, and how fast is that from 8 MP originals on
    the T610, at what peak memory?
  - Does the MP4 land in the gallery and play/seek there?
  - Does it reconnect after a phone screen lock or a camera restart?
  - How do install, upgrade and Family Link behave on the child account?
- **Plus:**
  - the camera-side NSD advertiser (an 0a leftover, needed for the NSD question);
  - an in-app native plugin `KopernikadrNative` (atomic files, free space, positional MP4
    writer, MediaStore publish);
  - a small shared JS package `@kopernikadr/remote-core` used by both `remote-lite` and the new
    app;
  - release signing + `scripts/*`;
  - a README with the Family Link parent checklist;
  - **PROTOCOL.md frozen as v1**.
- **Not in 0b:** the real capture UI in the native app, projects/ack/transfer logic, the effects
  layer, AI (see `docs/ROADMAP.md`). `remote-lite` stays the kid's remote and **must not break**.
- **0a leftovers:** the NSD advertiser is pulled into 0b (Task 2). The 0a probes `streams`,
  `locks`, `focus` and `grid`, the `/diag` routes and the full 0a run (0a Tasks 6, 9, 14
  partially, 15–17) stay in the 0a plan. They are not prerequisites for 0b. Task 12 here records
  only facts measured in 0a/0b.

## Context (from discovery)
- **Repo:**
  - `camera-android/` (`:core` + `:app`, AGP 9.4.1 with built-in Kotlin, the `gradlew-jbr`
    wrapper);
  - `remote-lite` in `core/src/main/resources/remote-lite/` (`app.js` + `lib/*.js`), its pure
    tests in `core/src/test/remote-lite/`;
  - `protocol/` (PROTOCOL.md rev 3.1, fixtures, the Node `probe-client` + `fake-camera.mjs`,
    whose `--serve` points at the remote-lite source dir).
- **The camera server:**
  - `/info` and `/frames` answer CORS only for exactly `http://localhost`;
  - incoming WS limit 64 KiB;
  - derived frames 503 + `Retry-After`;
  - HEAD supported;
  - **no NSD advertiser exists yet**.
- **The phone** runs the `.probe` package (debug key) with the kid's spool; remote-lite projects
  live in the tablet browser's localStorage.
- **Devices:**
  - tablet TB328FU: Android 12 (API 31), Unisoc T610, 4 GB, 1920×1200, WebView 155;
  - phone moto g05 at 192.168.1.34:8765;
  - Mac M1 Pro 16 GB at 192.168.1.93;
  - installed emulator image: API 35 arm64 (the `ocash-pixel7` AVD belongs to another project).
- **Toolchain:** Node 22.21; Android SDK 36/36.1, build-tools 35/36; no system JDK (Android
  Studio JBR).
- **Owner decisions:**
  - 0b = probes + skeleton;
  - shared pure ESM package copied into remote-lite at build time;
  - dependencies ≥14 days old (cutoff 2026-10-12), pinned with lockfile;
  - the tablet is available for one session at the end;
  - remote-lite must not break;
  - testing mixed.

## Development Approach
- **testing approach**: mixed.
  - **TDD** for pure logic: remote-core modules (incl. new `nsd.js`), the camera `TxtRecord`,
    probe runners with injected adapters, the export pipeline order, the Kotlin file helpers
    behind `KopernikadrNative` (JVM unit tests), the scripts' device mapping (fake `adb`).
  - **Code first + device check** for Capacitor/WebView glue, MediaStore, NSD
    registration/discovery, UI.
- Complete each task fully before moving to the next. Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task:
  - write unit tests for new functions/methods;
  - write unit tests for modified functions/methods;
  - add new test cases for new code paths;
  - update existing test cases if behaviour changes;
  - tests cover both success and error scenarios.
- **CRITICAL: all tests must pass before starting the next task.** No exceptions.
- **CRITICAL: update this plan file when scope changes during implementation.**
- **Test commands:**
  - `npm test --workspaces` (root);
  - `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - `node --test` in `protocol/tools/probe-client`.
- **Dependency graph** (the orchestrator serializes every `package-lock.json` change):
  - parallel group A: **Task 1** (remote-core), **Task 2** (camera NSD advertiser),
    **Task 3** (fake-camera CORS + dev workflow), **Task 9** (README draft);
  - then **Task 4** (remote skeleton) → **Task 5** (native plugin: file helpers) →
    **Task 6** (native plugin: MediaStore + bridge);
  - **Task 7** (NSD discovery) after 2 + 4;
  - **Task 8** (signing + scripts) after 4;
  - **Task 10** (probes: runner/env/report) after 5;
  - **Task 11** (probes: camera/download/VideoFrame) after 6 + 7 + 10;
  - **Task 12** (export probe) after 11;
  - **Task 13** (emulator E2E) after 8 + 12;
  - **Task 14** (tablet session) after 13;
  - **Task 15** (protocol v1) after 14;
  - then Tasks 16 and 17.

## Testing Strategy
- **Unit (JS):**
  - `packages/remote-core` with `node --test`;
  - a **module rule test**: remote-core files use only relative `./x.js` imports — no bare
    specifiers, no `node:` — because browsers load them unbundled;
  - `remote/` with vitest for probe runners, report building, the export pipeline order and
    discovery parsing.
- **Contract:** remote-core tests drive its `ControlClient` with the `protocol/fixtures` (`*.res`
  resolve the pending requests; `*.req` key sets equal the requests it builds;
  `parsePreviewFrame` parses a frame built from `preview.header.json`). Kotlin keeps its fixture
  coverage test.
- **Unit (Kotlin/JVM):** `:core` `TxtRecord`; the `KopernikadrNative` helpers in
  `remote/android/app/src/test` (pure Kotlin, file ops in temp dirs, seams for StatFs).
- **remote-lite regression gates (deterministic, on the Mac):**
  - a node test resolves every relative import of `app.js` and `lib/*.js` against the merged
    output dir `camera-android/core/build/resources/main/remote-lite`;
  - the fake camera serves that merged dir and a scripted Chrome run passes (preview, capture,
    playback, export);
  - the APK contains `remote-lite/lib/protocol.js` (`unzip -l`).
- **E2E (Mac):** the remote web build in Chrome and the debug APK on the emulator, against the
  fake camera (with CORS) and the real phone.
- **On the tablet:** the diagnostics report JSON + the `docs/ACCEPTANCE.md` 0b section.

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with the ➕ prefix.
- Document issues and blockers with the ⚠️ prefix.
- Update the plan if implementation deviates from the original scope, and keep it in sync with
  the actual work.

## Solution Overview
- **Root npm workspaces:** `packages/remote-core`, `remote`, `protocol/tools/probe-client`
  (dependency-free, unchanged).
- **`@kopernikadr/remote-core`** holds only what both apps use in 0b:
  - `protocol.js`, `connection.js`, `backoff.js`, `preview.js`, `preview-frame.js`;
  - the new `nsd.js`;
  - the i18n helpers `pickLang` / `makeTranslator` (plural rules) — each app keeps its own
    STRINGS.

  Plain ESM with JSDoc; the remote consumes it with `allowJs` + `checkJs` (no hand-written
  `.d.ts`). `store.js`, `captures.js`, `video.js`, `frame-loader.js`, `export-core.js` and the
  strings stay in remote-lite. They may move in stages 1–3 when the native app really reuses them.
- **Gradle copy** (fails loudly; a dedicated root so it doesn't overlap compile outputs):
  ```kotlin
  val syncRemoteCore by tasks.registering(Sync::class) {
      val src = rootDir.resolve("../packages/remote-core/src")
      from(src) { include("*.js"); into("remote-lite/lib") }
      into(layout.buildDirectory.dir("generated/remote-core-res"))
      doFirst { check(src.resolve("protocol.js").isFile) { "remote-core not found at $src" } }
  }
  sourceSets.main { resources.srcDir(syncRemoteCore) }
  ```
  remote-lite keeps its relative `./lib/x.js` imports. The classpath merges `remote-lite/lib/`
  from both roots.
- **`remote/` app:**
  - Next.js 16 `output:'export'`, `trailingSlash:true`, `images.unoptimized`,
    `turbopack.root` = repo root;
  - client components only, with Capacitor/probe code in `useEffect` or dynamic import (pages are
    still prerendered at build);
  - **one route `/`** with in-page views (home / diagnostics), because the Capacitor local server
    serves the root `index.html` for extensionless paths and a reload on `/diagnostics/` would
    break;
  - Capacitor 8 Android in `remote/android/`: `androidScheme:'http'`, `hostname:'localhost'`,
    `network_security_config` (cleartext) referenced from the manifest, landscape, minSdk 31 /
    targetSdk 36, a debug `applicationIdSuffix ".debug"`, wrapper sha256 pinned, `gradlew-jbr`;
  - plugins: `@capacitor/filesystem`, `@capacitor/file-transfer`, `@capacitor/app`,
    `@capacitor-community/keep-awake`, NSD per Task 7.
- **`KopernikadrNative`** is an **in-app plugin** (Capacitor's "custom native code" pattern):
  - Kotlin classes in `remote/android/app/src/main/java/pl/slava/kopernikadr/remote/native/`,
    registered with `registerPlugin(KopernikadrNativePlugin::class.java)` in `MainActivity`;
  - TS facade `remote/lib/native.ts` (`registerPlugin<KopernikadrNative>('KopernikadrNative')`);
  - the Capacitor Android template is AGP 8.x/Groovy, so apply `org.jetbrains.kotlin.android`
    there (unlike camera-android's AGP 9 built-in Kotlin);
  - all paths are relative to `filesDir/kopernikadr/` (ARCHITECTURE §5.4): `tmp/`, `exports/`,
    `probe/`.
- **Probes:** pure runners with injected adapters, plus the app adapters.
  - The report is written atomically to `filesDir/kopernikadr/probe/` and copied with
    `Filesystem.writeFile({directory: External})` so `adb pull` works.
  - Keep-awake is held for the whole probe run.
  - Peak memory is sampled from the Mac (`scripts/meminfo-sampler.sh`: `adb shell dumpsys
    meminfo` for the app and its WebView sandboxed process, 1 s).
- **Export probe:**
  - codec selection via `VideoEncoder.isConfigSupported` over `avc1.640028` → `avc1.4d0028` →
    `avc1.42e028` (1440×1080, framerate, bitrate), falling back to `vp09.00.40.08` (VP9-in-MP4)
    so the emulator, which has no hardware AVC encoder, still exercises the writer path;
  - Mediabunny output `Mp4OutputFormat({fastStart:false})` with
    `new StreamTarget(new WritableStream({write: c => native.videoWriteAt({handle, position:
    c.position, data: b64(c.data)})}), {chunked: true, chunkSize: 1 << 20})` — the awaited write
    is the backpressure;
  - frames decoded from `full` with `createImageBitmap(blob, {resizeWidth:1440,
    resizeHeight:1080})`;
  - a linear pipeline: encode → finalize → close → publish; on error, abort and clean up (the
    full cancel state machine is stage 3).
- **Frames for the export probe:** download ~20 originals once, captured by the probe itself with
  its own `clientId` (remote-lite closed during the session), and cycle them to 100 encoded
  frames. **Ack** the probe's frames after verification, so the phone doesn't keep them forever.
- **Release & scripts:**
  - one keystore `~/.kopernikadr/release.jks` + `keystore.properties` (outside the repo, with a
    backup step — losing it means uninstall → lost projects);
  - `build.sh` fails if the keystore is missing (an unsigned release can't be installed);
  - `install.sh`: device by model **substring** (`g05` → camera, `TB328` → remote), `adb -s
    <serial>`, unknown model → fail, `--camera-only` / `--remote-only`, `--variant
    release|probe|debug`, `adb install -r`, **fails loudly** on any `Failure [` (incl.
    `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, `INSTALL_FAILED_VERSION_DOWNGRADE`), never uninstalls;
  - `collect-diagnostics.sh`.

## Technical Details
- **Root `package.json`:**
  - `private`;
  - `workspaces: ["packages/remote-core", "remote", "protocol/tools/probe-client"]`;
  - `engines.node >=22`;
  - scripts `test`, `lint`.

  `.npmrc` sets `save-exact=true`. The lockfile is committed.
- **remote-core `nsd.js`:** `parseService({name, host, port, txt})` →
  `{cameraId, name, protocolVersions:{min,max}, host, port}`. It normalizes a trailing dot and
  rejects a missing `id` or a `pv` without version 1.
- **Camera `TxtRecord`** (`:core`): `{id: cameraId, pv: "1-1", name}` with value-size limits
  (≤255 bytes each). The `Advertiser` (`:app`) registers in onStart and unregisters in onStop.
- **File-transfer:**
  - `const {uri} = await Filesystem.getUri({directory: Directory.Data, path:
    'kopernikadr/tmp/<id>.jpg'})` after `Filesystem.mkdir({directory: Data, path:
    'kopernikadr/tmp', recursive: true})`;
  - then `FileTransfer.downloadFile({url, path: uri})`;
  - then `KopernikadrNative.installFile`.
- **MediaStore:**
  - insert into `MediaStore.Video.Media.getContentUri(VOLUME_EXTERNAL_PRIMARY)` with
    `RELATIVE_PATH="Movies/Kopernikadr/"`, `MIME_TYPE="video/mp4"`, `IS_PENDING=1`;
  - copy, then `IS_PENDING=0`;
  - check free space (file size + 300 MB reserve) before the copy;
  - cleanup queries with `Bundle{QUERY_ARG_MATCH_PENDING: MATCH_INCLUDE}` and deletes only our
    own pending rows (`OWNER_PACKAGE_NAME` + display-name prefix `kopernikadr-`).

  No storage permissions are needed on API 31.
- **CORS for E2E:**
  - the fake camera answers `Access-Control-Allow-Origin` with the request `Origin` for
    `localhost`/`127.0.0.1`/`10.0.2.2` (any port);
  - the real camera allows `http://localhost` (the Capacitor origin) and additionally
    `http://localhost:*` **only in debug/probe builds** (for the Chrome dev run of the web
    build).
- **Diagnostics report** (`remote-diag-<ts>.json`):
  - `env`: UA/WebView version, `isSecureContext`, `crypto.subtle`, `VideoEncoder`/`VideoFrame`,
    cores, memory, screen;
  - `nsd`: services found, latency;
  - `camera`:
    - manual `/info`, hello/session, ping during a capture;
    - preview fps/latency at low/normal/high;
    - capture round-trip;
    - reconnect after a phone screen lock and after a camera restart, with time-to-reconnect;
  - `download`: MB/s, sha256 ok, installFile ok;
  - `videoFrame`: ok + size;
  - `export`: codec string, per-frame decode/encode ms, total, bytes, URI, publish ok, frames;
  - `storage`: freeBytes;
  - plus the Mac-side meminfo series stored next to the report.

## What Goes Where
- **Implementation Steps** (`[ ]`): code, tests, docs, emulator runs, and the tablet session
  (Task 14).
- **Post-Completion**: multi-day Family Link observations, and the decision on a native
  MediaCodec fallback.

## Implementation Steps

### Task 1: `@kopernikadr/remote-core` (minimal) + Gradle copy + remote-lite gates

**Files:**
- Create: `package.json`, `.npmrc`, `package-lock.json` (root), `packages/remote-core/{package.json,README.md}`, `packages/remote-core/src/{protocol,connection,backoff,preview,preview-frame,i18n-core}.js`, `packages/remote-core/test/*.test.mjs`, `camera-android/core/src/test/remote-lite/imports.test.mjs`
- Modify: `camera-android/core/build.gradle.kts`, `camera-android/core/src/main/resources/remote-lite/lib/i18n.js` (uses `i18n-core.js`), `.gitignore`
- Delete (git mv): `camera-android/core/src/main/resources/remote-lite/lib/{protocol,connection,backoff,preview,preview-frame}.js` and their tests → remote-core

- [x] root workspaces + `@kopernikadr/remote-core` (`"type":"module"`, `"exports"`)
- [x] `git mv` the five modules + their tests unchanged; extract `pickLang`/`makeTranslator`
      into `i18n-core.js` (STRINGS stay in remote-lite `lib/i18n.js`)
- [x] the `syncRemoteCore` Sync task (dedicated root, fails if the source is missing) wired with
      `resources.srcDir(syncRemoteCore)`
- [x] write the module rule test (only relative `./x.js` imports in remote-core)
- [x] write the contract tests against `protocol/fixtures` (ControlClient resolves `*.res`,
      `*.req` key sets, preview frame from `preview.header.json`)
- [x] write `imports.test.mjs`: every relative import of `app.js` and `lib/*.js` resolves in
      `build/resources/main/remote-lite`
- [x] gates:
  - [x] `:core:test` (StaticRoutes tests green + classpath has `remote-lite/lib/protocol.js`);
  - [x] `:app:assembleProbe` + `unzip -l` shows `remote-lite/lib/protocol.js`;
  - [x] the fake camera `--serve camera-android/core/build/resources/main/remote-lite`;
  - [x] a Chrome run (preview, capture, playback, export) via DevTools MCP
- [x] run tests — must pass before Task 4

### Task 2: Camera NSD advertiser (`TxtRecord` TDD + `Advertiser`)

**Files:**
- Create: `camera-android/core/src/main/kotlin/pl/slava/kopernikadr/camera/net/TxtRecord.kt` + test
- Create: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/net/Advertiser.kt`
- Modify: `camera-android/app/src/main/kotlin/pl/slava/kopernikadr/camera/host/ServerHost.kt` (register after the server binds, unregister on stop)

- [x] tests first, then `TxtRecord` (keys, value limits, `pv` format)
- [x] `Advertiser`: `NsdManager.registerService` `_kopernikadr._tcp` with the bound port and the
      TXT; unregister on stop; the instance name is "Kopernikadr Kamera (xxxx)"; failures logged,
      never fatal
- [x] write tests for the ServerHost wiring order with a fake advertiser
- [ ] ⚠️ on the phone: upgrade installed (firstInstallTime kept), but Family Link downtime (22:11) suspended all apps — dns-sd/`/info` check pending. Verified on an Android 15 emulator instead. Install as an upgrade of the **same `.probe` package** (`install -r`; the
      spool survives); `dns-sd -B _kopernikadr._tcp` and `dns-sd -L` on the Mac show the service
      + TXT
- [x] run tests — must pass before Task 7

### Task 3: Fake camera CORS + remote-lite dev workflow

**Files:**
- Modify: `protocol/tools/probe-client/fake-camera.mjs`, `protocol/tools/probe-client/commands.test.mjs` (or a new test), `protocol/tools/probe-client/README.md`

- [x] CORS echo for `localhost`/`127.0.0.1`/`10.0.2.2` origins on `/info` and `/frames`
- [x] `--serve` docs/comment point at `camera-android/core/build/resources/main/remote-lite`
      (built by `./gradlew-jbr :core:processResources`)
- [x] write tests: CORS header present for allowed origins and absent for others
- [x] run tests — must pass before Task 11

### Task 4: `remote/` skeleton — Next 16 + Capacitor 8 Android

**Files:**
- Create: `remote/{package.json,next.config.mjs,tsconfig.json,capacitor.config.ts,VERSIONS.md,vitest.config.ts}`, `remote/app/{layout.tsx,page.tsx}`, `remote/components/{Home.tsx,Diagnostics.tsx}`, `remote/lib/i18n/{pl.ts,ru.ts,index.ts}` + test, `remote/android/**` (from `npx cap add android`, then edited), `remote/android/gradlew-jbr`
- Modify: `.gitignore` (`remote/.next`, `remote/out`, `dist/`)

- [x] pin versions ≥14 days (Next, React, Capacitor core/cli/android, filesystem, file-transfer,
      app, keep-awake, vitest, TypeScript); record them in `remote/VERSIONS.md`
- [x] Next: `output:'export'`, `trailingSlash`, `images.unoptimized`, `turbopack.root`; one route
      with in-page views; `allowJs`/`checkJs` importing remote-core
- [x] Capacitor Android:
  - [x] appId `pl.slava.kopernikadr.remote`, label "Kopernikadr";
  - [x] androidScheme http; cleartext config referenced in the manifest;
  - [x] landscape; min/target 31/36;
  - [x] debug suffix; wrapper sha256 pinned; `gradlew-jbr`;
  - [x] the Kotlin Android plugin applied (for Task 5)
- [x] i18n with remote-core `i18n-core`; write a pl/ru key-parity test
- [x] create AVD `kopernikadr-tab` (install the **API 31** arm64 image via sdkmanager; tablet
      1920×1200 landscape); record the emulator's WebView version (stock 91 can't run Next 16 output → replaced with a Chromium 158 snapshot WebView in the AVD; the tablet has 155)
- [x] **1-minute smoke** on the emulator: the app launches, `isSecureContext === true`, a
      `ws://10.0.2.2:8765/ws/control` hello against the fake camera succeeds; reload stays on
      the same view
- [x] run tests — must pass before Task 5

### Task 5: `KopernikadrNative` — file helpers (JVM TDD)

**Files:**
- Create: `remote/android/app/src/main/java/pl/slava/kopernikadr/remote/native/{AtomicFiles.kt,VideoWriter.kt,PathGuard.kt,DiskSpace.kt}`
- Create: `remote/android/app/src/test/java/pl/slava/kopernikadr/remote/native/{AtomicFilesTest.kt,VideoWriterTest.kt,PathGuardTest.kt}`

- [x] tests first, then `PathGuard`: relative to `filesDir/kopernikadr/`; rejects `..`,
      absolute paths and symlink escapes
- [x] tests first, then `AtomicFiles`:
  - [x] `writeTextAtomic`: tmp → fsync → rename over the target → dir fsync; never deletes the
        target first;
  - [x] `installFile`, idempotent: same size+sha → OK + tmp removed; differing dest → replaced;
        missing tmp + valid dest → OK;
  - [x] `freeBytes` via the `DiskSpace` seam
- [x] tests first, then `VideoWriter`:
  - [x] `open` → `exports/export-<id>.mp4`;
  - [x] `writeAt` handles out-of-order/overlapping positions;
  - [x] `close` fsyncs;
  - [x] `abort` is idempotent;
  - [x] a write after close → error;
  - [x] `cleanupAbandoned` deletes `exports/*`
- [x] write tests for errors: simulated ENOSPC, a bad handle
- [x] run tests — must pass before Task 6
- [x] ➕ note for stage 2 ProjectStore: `writeTextAtomic` can leave `.<name>.<uuid>.tmp` next to a target after a crash; the startup sweep must delete `.*.tmp` everywhere under `kopernikadr/`, not only `tmp/`

### Task 6: `KopernikadrNative` — MediaStore publish + Capacitor bridge

**Files:**
- Create: `remote/android/app/src/main/java/pl/slava/kopernikadr/remote/native/{GalleryPublisher.kt,KopernikadrNativePlugin.kt}`, `remote/lib/native.ts`
- Modify: `remote/android/app/src/main/java/.../MainActivity.java|kt` (`registerPlugin`)

- [x] `GalleryPublisher`:
  - [x] free-space check;
  - [x] insert pending → copy → `IS_PENDING=0` → delete the temp → URI;
  - [x] on failure, delete our pending row;
  - [x] cleanup queries pending rows with `QUERY_ARG_MATCH_PENDING`, our own only
- [x] thin `@PluginMethod`s for every API in `native.ts`; base64 decode for `videoWriteAt`
- [x] write tests: `GalleryPublisher` decision logic behind a `MediaStoreGateway` seam (order of
      calls, cleanup filter)
- [x] on the emulator:
  - [x] publish a small MP4 → visible in the gallery;
  - [x] pending-row cleanup: insert pending, kill the app, run cleanup, and the row is gone
        (2026-10-27: `deletedRows: 1`, the published row stayed)
- [x] run tests — must pass before Task 10

### Task 7: NSD discovery (plugin or own bridge) + parsing (TDD)

**Files:**
- Create: `packages/remote-core/src/nsd.js` + test, `remote/lib/discovery.ts` + test
- Modify: `remote/package.json` (if the plugin is chosen) or add `NsdBridge.kt` to KopernikadrNative

- [x] tests first, then `parseService` (TXT, trailing dot, `pv`, missing `id`)
- [x] evaluate `@mhaberler/capacitor-zeroconf-nsd` (≥14 days, peer Capacitor 8, Android
      NsdManager). Use it if OK, else write `NsdBridge` (discover + resolve + events). Record the
      choice → own `KopernikadrNsd` plugin (`remote/.../nsd/`): `registerServiceInfoCallback` on API 34+, serial `resolveService` below
- [x] `discovery.ts` (probe scope only): discover for N s, list results, report latency
- [x] write tests with a fake plugin (found, none, two cameras, bad TXT)
- [x] emulator: try discovery of the phone. ⚠️ mDNS doesn't cross the emulator NAT (confirmed);
      discovery is verified on the tablet (Task 14)
- [x] run tests — must pass before Task 11

### Task 8: Release signing + scripts

**Files:**
- Create: `scripts/{build.sh,install.sh,collect-diagnostics.sh,meminfo-sampler.sh,lib.sh}`, `scripts/test/run.sh` (+ fake `adb`)
- Modify: `camera-android/app/build.gradle.kts`, `remote/android/app/build.gradle` (release signingConfig from `~/.kopernikadr/keystore.properties`)

- [x] release signing in both apps; README steps to create the keystore with the JBR `keytool`
      **and back it up**
- [x] `build.sh`: camera release + remote release (web build → cap sync → gradle) into `dist/`;
      **fails** without the keystore
- [x] `install.sh`:
  - [x] model substring mapping, `-s <serial>`, unknown model → fail;
  - [x] `--camera-only` / `--remote-only`, `--variant`;
  - [x] `install -r`;
  - [x] any `Failure [` → fail loudly; never uninstalls
- [x] `collect-diagnostics.sh` (both apps' reports) and `meminfo-sampler.sh` (app + WebView
      sandboxed process, 1 s CSV)
- [x] write tests (`scripts/test/run.sh` with a fake `adb`): mapping by substring, unknown
      model, INCOMPATIBLE and DOWNGRADE failures, no devices, `--remote-only`
- [x] dry run on the emulator with a **throwaway** keystore: the upgrade is refused on a
      signature change and nothing is uninstalled
- [x] run tests — must pass before Task 13

### Task 9: README + parent checklist (draft)

**Files:**
- Create: `README.md`, `docs/ACCEPTANCE.md` (0b section; 0a items carried over)

- [x] README sections:
  - [x] what this is; layout;
  - [x] build (`gradlew-jbr`, npm workspaces);
  - [x] install (scripts);
  - [x] remote-lite usage (URL/QR on the phone screen);
  - [x] the remote-lite dev workflow (fake camera `--serve` of the merged dir);
  - [x] diagnostics; known limitations
- [x] **parent checklist (Family Link)** with the actual paths:
  - [x] developer mode: Informacje o telefonie → Numer kompilacji ×7;
  - [x] Family Link → Ustawienia urządzenia → Opcje programisty, Aplikacje z nieznanych źródeł;
        USB debugging;
  - [x] what to turn off after;
  - [x] a DHCP reservation for the phone;
  - [x] "uninstalling the remote deletes projects"; keystore backup;
  - [x] lighting tips: lock after the light is set, constant light, 50 Hz;
  - [ ] limits/downtime behaviour (placeholder, filled in Task 14)
- [x] `docs/ACCEPTANCE.md` 0b checklist (to fill in Tasks 13–14)

### Task 10: Probes — runner, env, report, diagnostics view

**Files:**
- Create: `remote/lib/probes/{runner.ts,env.ts,report.ts}` + tests
- Modify: `remote/components/Diagnostics.tsx`

- [x] tests first, then `runner`: sequential with injected adapters; each result is
      `{name, ok, ms, data, error?}`; one failure doesn't stop the others; keep-awake held for
      the whole run (adapter)
- [x] `env` probe
- [x] `report`: write via `writeTextAtomic` to `kopernikadr/probe/` and a copy via
      `Filesystem.writeFile({directory: External})`; an on-screen pass/fail summary
- [x] write tests for the runner, env (fake globals) and report (path, content)
- [x] run tests — must pass before Task 11
- [x] ➕ result extras: `skipped?: <reason>` (`native-only`, `cancelled`, `user`, `no-input`) is
      neither a pass nor a failure; `ProbeFailure` keeps partial data; a Stop button aborts the
      run (remaining probes → `cancelled`); interactive steps go through a `prompt` adapter
- [x] ➕ `storage` probe (`freeBytes`) lives in `env.ts`; the report is
      `probe/remote-diag-<YYYYMMDDTHHMMSSZ>.json` in both places (`collect-diagnostics.sh` pulls
      the external copy); in a browser nothing is written and the JSON is shown on screen
- [x] ➕ wiring in `remote/lib/probes/app.ts` (dynamic import on "run", nothing at prerender),
      `shared.ts` (`PROBE_ORDER`, the state probes hand on, localStorage helpers); keep-awake via
      the existing `@capacitor-community/keep-awake` dependency
- [x] ➕ a browser smoke of the web build (`out/` in Chrome) against `fake-camera.mjs`: env ✓,
      camera ✓, reconnect ✓ (sockets kicked + camera restarted), native probes `native-only`
- ⚠️ i18n follows the existing tables, **pl + ru** (there is no English table)

### Task 11: Probes — NSD, camera, reconnect, download, VideoFrame

**Files:**
- Create: `remote/lib/probes/{nsd.ts,camera.ts,download.ts,videoFrame.ts}` + tests

- [x] `nsd`: via `discovery.ts` (Task 7)
- [x] `camera`:
  - [x] manual `/info`;
  - [x] remote-core `ControlClient`: hello → session, ping during a capture;
  - [x] preview 10 s at low/normal/high (fps, latency p50/p95);
  - [x] capture round-trip
- [x] `reconnect` (interactive): prompts "lock the phone screen, then unlock" and "close the
      camera app and start it again"; measures time-to-reconnect and checks a new `bootId`
- [x] `download`: `getUri` + `mkdir`, file-transfer of `full`, sha256 via
      `fetch(convertFileSrc)` + `crypto.subtle`, `installFile`, MB/s; **ack** the probe's frames
      after verification
- [x] `videoFrame`: `convertFileSrc` → `createImageBitmap` → `new VideoFrame` → close
- [x] write tests for each with fake adapters (success and failure paths)
- [x] emulator against the fake camera (`10.0.2.2`), 2026-10-27: env, storage, camera, download,
      videoFrame, export OK; nsd fails ("no camera found", mDNS doesn't cross the emulator NAT, as
      expected); reconnect skipped. Report pulled from `Android/data/…/files/probe/`
- [ ] emulator against the real phone — ⚠️ pending: phone not connected (Task 13)
- [x] run tests — must pass before Task 12
- [x] ➕ camera address: the first NSD camera, else the manual field on Diagnostics (persisted in
      localStorage); no address → the camera probes fail with "no camera address"
- [x] ➕ one persistent probe `clientId` + `projectId` (localStorage `kopernikadr.probe.*`), so
      `listFrames`/`ack` only ever see the probe's own frames (the kid's are never listed or
      acked; tested). `download` downloads every listed probe frame (≤25 per run, captures one if
      none), acks only those verified by size + sha256 (+ `installFile` natively); a frame that
      fails verification stays on the camera
- [x] ➕ `download` in a browser: skipped as `native-only`, but it still fetches + verifies +
      acks the probe frames so a Chrome run leaves nothing on the phone
- [x] ➕ `camera` also times JPEG decode (`createImageBitmap`) per preview frame and restores the
      original `previewQuality`; `videoFrame` also decodes at 1440×1080 (the export resize)
- [x] ➕ `reconnect` uses remote-core `CameraConnection` (the real loop: 2 s ping, backoff);
      the drop is looked for from the moment the first prompt is shown; it runs **last**
      (interactive). Task 12 adds `export` to `PROBE_ORDER` and `buildProbes` before `reconnect`
- [x] ➕ JSDoc types added to remote-core `protocol.js`, `preview-frame.js`, `connection.js`
      (`Object.assign(this, …)` → explicit fields), `backoff.js`, so the remote's `checkJs`
      accepts them; no behaviour change (remote-core tests green)
- [x] ➕ `fake-camera.mjs` `close()` also destroys open WebSocket sockets (like a camera app
      stopping); otherwise `server.close()` hangs while a client keeps reconnecting
- ⚠️ the camera allows one session: remote-lite (another clientId) must be closed during the
      run (the probes report `camera busy … close remote-lite`), and right after a run the kid's
      remote gets `BUSY` until the probe session's 10 s TTL runs out
- ⚠️ `nsd` fails with "no camera found" on the emulator (mDNS doesn't cross the NAT, Task 7);
      the manual `10.0.2.2:<port>` is used there

### Task 12: Export probe — Mediabunny → KopernikadrNative → gallery

**Files:**
- Create: `remote/lib/export/{codecPick.ts,mediabunnyExport.ts}` + tests, `remote/lib/probes/export.ts`
- ➕ Create: `remote/lib/export/nativeWriter.ts` (the `ExportWriter` over `KopernikadrNative`,
  1 MiB base64 calls) and `remote/lib/export/benchmark.ts` (`runExportBenchmark`, the probe's
  entry point) + tests
- Modify: `remote/package.json` (mediabunny pinned ≥14 days; verify the encoding-config field
  for a full codec string in that version), `remote/VERSIONS.md`

- [x] mediabunny **1.61.4** (2026-10-12; 1.61.5 is 2026-10-15) pinned exactly, in the root lock
      and `remote/VERSIONS.md`. The full codec string goes in
      `VideoEncodingConfig.fullCodecString`, next to a matching `codec` (`'avc'`/`'vp9'`)
- [x] tests first, then `codecPick`: the `isConfigSupported` ladder avc High → Main → Baseline
      → VP9-in-MP4; the result records the codec string (and which ones failed, with errors)
  - ⚠️ deviation: VP9 is `vp09.00.40.08` (level 4.0), not `vp09.00.10.08`: the MP4 muxer copies
    the codec string's level into `vpcC`, so level 1.0 would mislabel a 1440×1080 stream.
    Mediabunny itself derives `vp09.00.40.08` / `avc1.640028` for 1440×1080
  - the checked config mirrors the one Mediabunny configures (`bitrateMode: 'variable'`,
    `alpha: 'discard'`, `avc: {format: 'avc'}`, `framerate`)
- [x] tests first, then the `mediabunnyExport` order with a fake encoder/target: chunked
      `StreamTarget` writes carry `position`; finalize → close → publish; abort + cleanup on error
  - mirrors remote-lite `export-core.js`: optional `prepare` pass over every frame before the
    file is opened; per-frame load retries (default 1) then `FRAME_LOAD_FAILED` with `index`;
    load-ahead 1; every image closed on every path; cancel honoured only until `finalizing`
  - ➕ an integration test runs the **real** Mediabunny muxer + `StreamTarget` in Node (a
    registered `CustomVideoEncoder` emitting fake VP9 packets) and demuxes the output with
    Mediabunny's `Input`: valid MP4, `vp09.00.40.08`, 20 packets, duration 20/fps, writes
    ≤ `chunkSize` with a backwards (`mdat` patch) position; write failure and cancel abort
- [x] ➕ `nativeWriter.ts`: `videoOpen` → `videoWriteAt` (≤1 MiB per call, sequential, base64
      via `toBase64`) → `videoClose` → `videoPublish`; `abort` is a no-op before `open`
- [x] ➕ `runExportBenchmark({frames, repeatTo, writer, fps?, width?, height?, bitrate?,
      displayName?, signal?, onProgress?})` in `remote/lib/export/benchmark.ts`: codec pick →
      `fetch(url)` + `createImageBitmap(resize 1440×1080)` of `frames[i % frames.length]` →
      export → `{uri, codec, bytes, writes, frames, ms, perFrame, pick, summary{decodeMs,
      waitMs, encodeMs: {mean,p50,p95,max}, msPerFrame, speed}}`; `NoEncoderError` (`NO_ENCODER`,
      with `pick`) before anything is written
- [x] export probe (`remote/lib/probes/export.ts`, on the Task 10 runner):
  - [x] captures ~20 frames with the probe's own clientId, downloads their `full`, and cycles
        them to N (20 and 100);
  - [x] measures per-frame decode/encode ms, total, bytes, URI, codec (the report keeps the
        summary, not the per-frame array);
  - [x] acks the probe frames at the end
- [x] emulator: an export lands in the gallery and plays. ⚠️ The emulator picked **avc1.4d0028**
      (Main; High unsupported), not VP9 — its software encoder handles AVC. ffprobe on the 100-frame
      file: h264 Main 1440×1080, 8 fps, 100 frames, decodes clean. 14 ms/frame on the Mac emulator;
      the real AVC numbers come from the tablet
- [ ] ➕ conditional (after Task 14): if AVC fails or is too slow on the T610, add a native
      MediaCodec+MediaMuxer `exportNative` task
- [ ] run tests — must pass before Task 13 (the export lib part passes: remote vitest 148 tests,
      typecheck, build; remaining: the emulator VP9 run)

### Task 13: Emulator end-to-end + Chrome dev run

**Files:**
- Modify: `camera-android/core/src/main/kotlin/.../server/CameraServer.kt` (CORS `localhost:*`
  in debug/probe builds only, via config) + test; `docs/ACCEPTANCE.md`

- [x] debug/probe-only CORS for `http://localhost:*` (a config flag from `:app` build type);
      write a test
- [ ] emulator (debug + release): all probes against the fake camera and the real phone; reports
      pulled with `collect-diagnostics.sh`
- [ ] the remote web build in Chrome against the real phone (non-native probes); native probes
      report "native only"
- [ ] remote-lite regression on the phone (browser): capture, export
- [ ] fix what's found (➕ tasks if larger)
- [ ] run the full suite — must pass before Task 14

- [x] ➕ Codex review of the 0b batch (2026-10-27), two medium findings fixed:
  - the plugin runs `videoCleanupAbandoned` at load (startup sweep), so an export killed
    mid-encode/publish leaves no file or pending row (verified on the emulator:
    `deletedFiles=1, deletedRows=1` after a kill);
  - the download probe's frame fetch takes the probe signal + a 30 s deadline (headers and
    body); a cancelled native download's tmp file is removed after it settles

### Task 14: Tablet session (owner connects the tablet) + Family Link

**Files:**
- Create: `docs/diagnostics/<date>-tablet.md`
- Modify: `docs/ACCEPTANCE.md`, `README.md`

- [ ] prep:
  - [ ] close remote-lite on every device;
  - [ ] phone on the rig, camera app running;
  - [ ] `meminfo-sampler.sh` running
- [ ] **manual APK install** via the Files app (unknown sources), then **an upgrade** over it
      with `install.sh --remote-only` (bumped `versionCode`); record the Family Link prompts
- [ ] run all probes:
  - [ ] env, NSD, manual address, camera (low/normal/high), reconnect (screen lock + camera
        restart), download, VideoFrame;
  - [ ] **export of 20 and 100 frames** (per-frame ms on the T610, total, peak memory from the
        sampler, gallery playback + seek)
- [ ] Family Link on **both** devices:
  - [ ] daily limit, app limit, downtime, the parent's manual lock, ordinary screen lock;
  - [ ] what "Always allowed" covers;
  - [ ] the observed behaviour for each case
- [ ] summary with numbers; decide the export path and the NSD approach; fill
      `docs/ACCEPTANCE.md` and the README's Family Link section
- [ ] run the full suite — must pass before Task 15

### Task 15: PROTOCOL v1 + fixtures

**Files:**
- Modify: `protocol/PROTOCOL.md`, `protocol/fixtures/*` (new: setControl req/res/err, listFrames req/res, ack req/res, getStatus), Kotlin fixture-coverage test, remote-core contract tests

- [ ] PROTOCOL.md:
  - [ ] header + §2: fixtures + Kotlin models + remote-core (no `src/schema.ts`);
  - [ ] 503 + `Retry-After`; HEAD; incoming 64 KiB → close 1009;
  - [ ] **decide the focus `failed` mode** (add `failed` to focus modes, or keep locked +
        confirmed:false) and align Kotlin + JS + fixtures;
  - [ ] flat `setControl`; `listFrames`/`ack`/`getStatus` shapes;
  - [ ] `getOperation` behaviours; retention today;
  - [ ] NSD TXT; CORS rules (Capacitor origin + debug-only `localhost:*`)
- [ ] mark it **"v1 (frozen <date>)"**
- [ ] new fixtures + coverage tests on both sides
- [ ] run tests — must pass before Task 16

### Task 16: Verify acceptance criteria
- [ ] every Overview question has a measured answer in `docs/diagnostics/<date>-tablet.md`
- [ ] remote-lite: merged-dir Chrome run + phone browser smoke pass; its tests green
- [ ] full suite:
  - [ ] `npm test --workspaces`;
  - [ ] `cd camera-android && ./gradlew-jbr :core:test :app:testDebugUnitTest`;
  - [ ] `cd remote/android && ./gradlew-jbr :app:testDebugUnitTest`;
  - [ ] `node --test` in probe-client;
  - [ ] `scripts/test/run.sh`

### Task 17: [Final] Update documentation
- [ ] `docs/ARCHITECTURE.md`:
  - [ ] `:core`/`:app` + the `probe` build type;
  - [ ] `ROTATION_90` + 0/180 geometry;
  - [ ] the freeze mechanics (fence via the future, ISO tolerance);
  - [ ] remote-lite as the interim remote + remote-core sharing;
  - [ ] the in-app native plugin;
  - [ ] the corrected §5.7 Mediabunny API (WritableStream `StreamTarget`, codec ladder);
    - ➕ (from Task 12, checked in mediabunny 1.61.4) `StreamTarget` has no `onData(chunk,
      position)`: it is `new StreamTarget(writable: WritableStream<{type: 'write', data,
      position}>, {chunked: true, chunkSize})` (chunk default 16 MiB, min 1024; we use 1 MiB);
      positions are not monotonic with `fastStart: false` (the `mdat` header is patched at
      finalize). Mediabunny does not await each `write()`: backpressure is `writer.ready` (the
      stream's queue), a failed write surfaces on the next flush or in `finalize()`, and
      `finalize()` resolves only after every queued write
    - ➕ the ladder is `VideoEncoder.isConfigSupported` with Mediabunny's own config, not
      `canEncodeVideo('avc', …)`; codec strings are `avc1.640028` → `avc1.4d0028` →
      `avc1.42e028` → `vp09.00.40.08`, passed as `VideoEncodingConfig.fullCodecString` with
      `codec: 'avc' | 'vp9'`; bitrate as `quality: new Quality({bitrate})` (`bitrate` is
      deprecated); frame rate via `addVideoTrack(source, {frameRate})`
    - ➕ `output.cancel()` closes the stream (waits for queued writes) rather than aborting it;
      the export then calls `videoAbort`. Cancel is honoured only in `encoding` (as §5.7 says)
    - ➕ the writer side is `remote/lib/export/nativeWriter.ts`; each `videoWriteAt` carries
      ≤1 MiB as base64
  - [ ] measured 0a/0b facts replacing [S0]; §9 decisions
- [ ] README final; `docs/ROADMAP.md`: 0b done, next = stage 1 or the effects layer per the
      owner
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Manual verification**
- A real downtime schedule over a day, with both apps' behaviour checked.
- The parent decides whether to keep "Opcje programisty" / USB debugging enabled.

**Decisions after the tablet session**
- Native export fallback (MediaCodec) only if WebCodecs/AVC fails or is too slow on the T610.
- When to move the kid from remote-lite to the native remote (after stages 1–3).
- Switching the phone from the `.probe` package to the release camera app without losing the
  spool (export the remote-lite movies first, or keep `.probe` until the native remote ships).
