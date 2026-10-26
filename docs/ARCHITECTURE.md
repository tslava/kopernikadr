# Kopernikadr — architecture plan

Status: **draft for review (rev 3)**. The requirements are in [PROMPT.md](PROMPT.md) and the
wire contract is in [../protocol/PROTOCOL.md](../protocol/PROTOCOL.md) (v0, provisional).
Items marked **[S0]** are hypotheses that the stage 0 probes either confirm or replace.

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
  protocol/        PROTOCOL.md, src/schema.ts (zod → TS types), fixtures/*.json,
                   tools/fake-camera/ (Node implementation of the camera side, stage 1)
  camera-android/  Gradle project, single :app module
  remote/          Next.js app + android/ (Capacitor) + plugins/native/ (local Capacitor plugin)
  scripts/         build.sh, install.sh, collect-diagnostics.sh
  README.md        build/install, parent checklist (Family Link), known limitations
```

npm workspaces at the root (`protocol`, `remote`). Gradle stays separate. There is no codegen.
The contract is enforced by **shared fixtures**: `protocol/fixtures/*.json` are valid example
messages. The TS side validates them with the zod schemas. A Kotlin unit test parses every
fixture with the kotlinx.serialization models and round-trips it.

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
  0.5–1 s per frame, i.e. 4–8 min for 500 frames. **[S0]** measures it. If it is too slow, the
  fallback (with your OK) is exporting from `play`, which has the same 1440×1080 output size.

## 4. camera-android

### 4.1 Components

| Component | Responsibility |
|---|---|
| `MainActivity` (Compose) | Status UI, IP:port + QR, permission screen, parent diagnostics screen (long-press). Owns lifecycle. |
| `CameraController` | Binds CameraX use cases in one `UseCaseGroup` with a `ViewPort`; applies controls via Camera2Interop; confirms control states from `CaptureResult` (§4.4). |
| `FrameTransform` | Pure function: (`cropRect`, `rotationDegrees` of the buffer, project rotation) → matrix + output size. Unit-tested for all rotations. |
| `CaptureService` | Single-threaded capture executor (§4.5). |
| `Spool` | SQLite (WAL, `synchronous=FULL`) + `filesDir/spool/`: operation/frame records, ack state, retention, recovery. |
| `Server` | Ktor CIO: `/info`, `/ws/control`, `/ws/preview`, `/frames/...`. Heartbeats are handled on the socket coroutine; captures run on `CaptureService`, so a long capture never delays a ping. |
| `SessionManager` | Single controller: one live session (`sessionId`, `clientId`, last-seen on the monotonic clock); replacement, expiry, per-request validation (PROTOCOL §4). |
| `Advertiser` | NsdManager registration of `_kopernikadr._tcp` with TXT `id`, `pv`, `name`. |
| `ScreenPolicy` | `FLAG_KEEP_SCREEN_ON` while started. After 2 min without remote commands or touches it sets window brightness to ~5%; any activity restores it. |

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
  Both use the full 4:3 sensor area. The phone is mounted with its long side along the table's
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
  `full` is the durable unit and the **only source of truth for pixels**: export encodes from
  `full`.
- **Display caches.** `play` (1440×1080) and `thumb` (256×192) are display accelerators only:
  onion skin, strip, playback. The phone generates them right after the commit, or on demand,
  so the tablet gets the onion skin quickly without decoding 12 MP during shooting. If they are
  missing or broken, the tablet regenerates them from `full`. They are never used for export.
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

`Spool.recover()` runs once per process, before the server opens (§4.2):

| Found | Action |
|---|---|
| `pending` row + valid `full` file (JPEG SOI/EOI, decodable) | Compute sha256 → `committed` (the photo survives a crash after step 4). |
| `pending` row without a valid file | Delete leftovers → `failed(INTERRUPTED)`. Never re-executed automatically. |
| `committed`, unacked, file missing | **Integrity error.** The row is kept, marked `lost`, and reported in status and diagnostics. |
| `reclaimedAt` set but files still exist | Delete files (a crash during reclaim). |
| `*.tmp`, or files with no row | Delete. |
| `committed`, missing `play`/`thumb` | Regenerated lazily. |

**Retention.**
- Unacked frames are never deleted.
- Acked frames are reclaimed after 7 days, on `clearAcked`, or under low space (oldest first).
- Reclaim writes `reclaimedAt` **first**, then deletes files.
- Rows are kept forever. They are tiny, and they keep reqId dedup, results and `seq` valid.

**Orphans.** Unacked frames of another `clientId` (e.g. the remote was reinstalled) are never
listed to a different client and **never deleted by the app**. The phone's diagnostics screen
only shows their count and size. The only way to remove them is the OS-level "Clear storage"
for the camera app, and README describes it.

## 5. remote

### 5.1 App shell

- Next.js `output: 'export'`, App Router, client components only. Routes: `/` (projects),
  `/connect`, `/capture?p=<id>`, `/play?p=<id>`, `/diagnostics` (parent, stage 0).
- Capacitor: `server.androidScheme: 'http'`, `hostname: 'localhost'`. Network security config has
  `base-config cleartextTrafficPermitted="true"`: Android has no subnet selector, and the phone's
  IP is DHCP-assigned. `android.allowMixedContent` stays false. **[S0]** proves on a release build:
  `isSecureContext`, ws:// control + preview, cross-origin `GET /info` with CORS, native download,
  and `convertFileSrc` → `VideoFrame`.
- State: zustand. i18n: own tiny `t()` with `ru.json`/`pl.json`, fallback `pl`, locale from
  `navigator.language`. A unit test checks key parity.
- Plugins:
  - `@capacitor/filesystem`, used for directory listing and `getUri` only;
  - `@capacitor/file-transfer`;
  - `@capacitor/app` (back button, deep link);
  - `@capacitor-community/keep-awake`;
  - NSD: `@mhaberler/capacitor-zeroconf-nsd` if **[S0]** confirms it with Capacitor 8,
    otherwise an `NsdManager` bridge in our plugin.
- **`KopernikadrNative`** (local plugin, Kotlin), small and unit-tested:
  - `writeTextAtomic(path, text)`: write tmp → fsync → `rename(2)` over the target →
    fsync dir. It never deletes the target first, unlike `Filesystem.rename`, which deletes
    before moving.
  - `installFile(tmp, dest, bytes, sha256)`, idempotent:
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
- The QR on the phone encodes `kopernikadr://connect?host=…&port=…&id=…`. The remote registers the
  deep link, so the tablet's system scanner can open it without a camera permission in our app.
  It is optional: manual entry always works.
- Control WS: `hello` → session. Pings every 2 s. The connection counts as offline after 5 s
  without a reply. Reconnect uses backoff 0.5 s → 5 s.
  After every (re)connect: `resolveOutstanding()`, then `Transfer.reconcile()`. Merges are
  monotonic (§5.5), so the order is not load-bearing.
- **One reconnect loop.** Each socket carries the local connection generation that opened it.
  Callbacks from a superseded socket are ignored. Close code `4001 replaced` ends that socket's
  loop without reconnecting. After `4002 lease lost`, a reconnect starts only if that socket
  still owns the current generation. App resume and timeouts reuse the same loop and never open
  a second one.
- Persistent `clientId` (UUID, stored with the project index).

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
  index.json                         {clientId, projects:[{id,name,createdAt}], deletedProjects:[id],
                                      pendingProjectDeletes:[{id, deadline}]}
  projects/{id}/project.json         see below
  projects/{id}/frames/{frameId}.{full|play|thumb}.jpg
  tmp/                               downloads and exports in progress; swept on start
```

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
  `cameraId`.
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

### 5.6 Capture, transfer, ack

- **Capture.**
  1. Mutation: add `outstanding{reqId}`.
  2. Send `capture{projectId, rotation}`.
  3. On the result, mutation: remove `outstanding`, and merge the frame (monotonic, §5.5). The
     counter and a placeholder appear immediately; `thumb` → `play` → `full` are downloaded next.
- **Timeout / restart.** `resolveOutstanding()` calls `getOperation(reqId)` for each outstanding
  entry:
  - `done` → treat as a result;
  - `pending` → poll every 1 s;
  - `failed` / `unknown` → drop the entry and show "didn't work, try again".

  **No auto-retake** — the child may already be moving the figures.
- **Download** (one at a time; the queue holds ids, not bytes): `full` to `tmp/`, then verify size
  and sha256 (`fetch(convertFileSrc)` + `crypto.subtle.digest`). `play`/`thumb` are caches: they
  are checked for Content-Length and JPEG decode only, and regenerated locally from `full` if
  unavailable.
- **Install and ack.** Mutation: re-check state inside the queue.
  - Frame or project tombstoned → delete the tmp files.
  - Otherwise `installFile` the `full` into `frames/` (fsynced, idempotent) and set
    `state: local`. Caches are installed best-effort and never block this.

  After that mutation commits, the frame is **ack-eligible**.
- **Interrupted install.** The app was killed after `installFile` but before `state: local`. On
  startup, a `pending` frame whose `frames/{id}.full.jpg` matches the stored `bytes` and `sha256`
  is promoted to `local`. If it doesn't match, the file is deleted and the frame stays `pending`.
- **Ack eligibility** (the only cases where `ack` is sent):
  - `state == local`;
  - or `frameId ∈ deletedFrameIds`;
  - or the project is in `deletedProjects`.

  A `pending` frame is never acked: it resumes downloading. A hidden frame (Undo window) is
  downloaded and acked like any other, since its files exist.
- **`reconcile()`** after (re)connect, over `listFrames(unacked)` (scoped to our `clientId`):
  - ack-eligible → ack;
  - pending in a live project → resume;
  - unknown frame in a live project → merge at its `seq`, then download;
  - unknown `projectId` that is not tombstoned → create a project "Recovered <date>" with that id
    (tablet metadata loss), bound to the current camera, with rotation from `FrameInfo`, and import.
- **Storage: one bulk writer at a time.** Transfers pause while an export runs.
  - **Download admission**: `freeBytes` ≥ reserve (300 MB) + this frame's `full` bytes + 1 MB
    for caches.
  - If admission fails, transfers pause and the parent sees "Tablet storage full". The phone
    keeps the frames.
  - ENOSPC during a write is handled the same way, and the tmp file is deleted.

### 5.7 Playback and export

- **Playback.** A canvas plus a ring buffer of 8 `ImageBitmap`s, decoded from `play` at
  1440×1080 (~6.2 MB each, ~50 MB total; the 1920×1200 screen shows it at ~1.1×), with
  requestAnimationFrame timing at the project
  fps. Memory does not depend on project length. The ring buffer is released before export starts.
- **Export state machine** (one export at a time; transfers paused):
  `encoding → finalizing → publishing → done`, or `→ cancelled/failed`.
  1. `videoOpen()` creates `exports/export-<id>.mp4` (seekable, app-private).
     `videoWriteAt` checks `freeBytes` ≥ reserve before each write; if it fails, the export
     fails cleanly.
  2. Mediabunny: `Output{format: Mp4OutputFormat({fastStart: false}), target: StreamTarget}`.
     `onData(chunk, position)` → `await videoWriteAt(handle, position, chunk)` (≤1 MB chunks, so
     backpressure reaches the encoder). `canEncodeVideo('avc', 1440×1080, fps)` tries High →
     Main → Baseline first.
  3. **encoding**: frames are processed sequentially from **`full`**: `fetch(convertFileSrc)` →
     `createImageBitmap(blob, {resizeWidth:1440, resizeHeight:1080})` → `VideoSample` with
     timestamp `i/fps` and duration `1/fps` → `await add()` → `close()` both. **[S0]** measures
     per-frame time; we expect ~0.3 s per 12 MP frame, so a few minutes for 500 frames.
  4. **finalizing**: `await output.finalize()` → `videoClose` (fsync).
  5. **publishing**: `videoPublish` copies into MediaStore `Movies/Kopernikadr` with
     `IS_PENDING=1`, first checking free space for the actual file size + reserve. It then sets
     `IS_PENDING=0`, deletes the temp file and returns the URI. Only then is "Done, video saved to
     gallery" shown.
  6. **Cancel** is offered **only in `encoding`**: stop feeding → `output.cancel()` →
     `videoAbort` (idempotent). From `finalizing` on, the Cancel button is hidden and the export
     runs to `done` or `failed`. That makes publish and abort mutually exclusive.
  7. **Startup**: `videoCleanupAbandoned()` deletes every file in `exports/` and our own pending
     MediaStore rows (matched by owner package + display-name prefix).
- **Fallback [S0].** If WebCodecs/AVC fails, `KopernikadrNative.exportNative(projectDir,
  frameIds, fps)` uses MediaCodec + MediaMuxer, writing to the same temp → publish path. The UI
  stays the same.

### 5.8 Deletion, Undo, recovery

- **Delete frame.** Mutation sets `hiddenUntil = now + 5 s`, and the frame disappears from UI.
  Undo is a mutation that clears it, so position and transfer state stay as they were.
- **Expiry** (timer, or app start for past deadlines): mutation moves the id to `deletedFrameIds`
  and removes the frame entry → commit → **then** unlink its files. Unlinking is idempotent.
- **Projects**: the same pattern at index level (`pendingProjectDeletes` → `deletedProjects` →
  remove the directory).
- **Startup sweep**:
  - `pending` frames with a matching installed `full` are promoted to `local` (§5.6);
  - `tmp/` is emptied; `exports/` is cleaned by `videoCleanupAbandoned`;
  - files under `frames/` with no live frame entry are deleted;
  - project dirs that are tombstoned are removed;
  - project dirs missing from the index and not tombstoned are re-added to the index (recovery).
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
- **Fake camera** (`protocol/tools/fake-camera`, Node, stage 1): implements the protocol with
  sample JPEGs, plus switches to drop responses, close sockets, delay, return `BUSY`/`STORAGE_LOW`,
  restart with a new `bootId`, and change `cameraId`.
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
| **0** | Repo skeleton, pinned versions, build/install/diagnostics scripts, PROTOCOL.md v0, `KopernikadrNative` with atomic write + free space + MP4 writer.<br>**Camera probes**: capabilities dump; three use cases bound at real sizes (fps, capture-to-commit time, peak heap); YUV-vs-RGBA analysis cost; 20 AE/AWB-locked captures with per-frame brightness/colour stats and compensation moved mid-series; focus at mount distance; grid test at 0 and 180; **freeze** vs AE/AWB-lock comparison: lock, lock the phone screen, unlock, check that brightness/colour match frame-to-frame.<br>**Minimal real server**: `/info` (CORS), `/ws/control` with `hello`/session/`ping`/`capture`, `/ws/preview`, `/frames`.<br>**Remote probes**: WebView version, `isSecureContext`, manual address via `/info`, NSD discovery, session + heartbeat during a capture, preview pull loop, native download + sha256, `convertFileSrc`→`VideoFrame`, reconnect after phone lock and after camera restart, export of the probe frames at the chosen profile → temp → MediaStore → plays and seeks in the gallery.<br>**Supervision**: install/upgrade under the child account, camera permission, behaviour under daily limit / app limit / downtime / manual lock. | Run everything under the child account and send the reports. Then we confirm the control mechanism, check the full-res size and the export speed, choose the export path and the NSD plugin, and **freeze PROTOCOL.md v1**. |
| **1** | Protocol v1 on both sides + fake camera. Connection screen, sessions/BUSY, preview with watchdog, capture with the durable spool (operation rows, recovery, idempotency, `getOperation`), outstanding captures on the tablet, onion skin, parent drawer (controls with `confirmed`/`settling`, rotation for empty projects). Phone status UI, keep-on/dim, permission-denied screen. | Shooting works; locks hold across phone lock/unlock; preview and onion skin line up in the grid test. |
| **2** | Transfer with verification and ack eligibility, reconcile (incl. recovered projects), serialized ProjectStore, projects screen (create/rename/delete + Undo), phone retention + orphans, storage reserves on both sides. | The failure list: Wi-Fi off mid-transfer, phone locked, either app killed around capture/install/ack, lost capture response, low storage on each side. |
| **3** | Frame strip, view/delete + Undo, playback, export with progress/cancel/cleanup. | 500-frame project → playback → export; memory stays flat; cancel and app kill during export leave no junk. |
| **4** | UX polish from your notes. | With the kid. |

## 9. Decisions (approved by the owner on 2026-10-26)

1. Battery-optimization exemption dropped (§4.2).
2. The phone produces `play`/`thumb` display caches, so the onion skin is fast. Export is from
   `full`, as the prompt says (§4.3, §5.7).
3. Pull-based WS preview instead of MJPEG (§5.3).
4. targetSdk 36 (§3).
5. QR as a deep link opened by the tablet's own scanner, optional (§5.2).
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
