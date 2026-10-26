# Project: Kopernikadr — home stop-motion rig (phone as camera + tablet as remote)

## Context
A kid makes stop-motion animations from wooden blocks and figures
on a table. A phone is mounted above the table, lens down, and acts as the camera.
The kid controls shooting from a tablet: live preview, onion skin, frame strip,
playback preview, MP4 export. No store publishing — install via adb / APK.
An iOS version of the camera and/or remote may come later, so the protocol is a
separate, platform-neutral contract.

## Name
The app is called **Kopernikadr** (Kopernik + "kadr" = frame in Polish/Russian;
inspired by a stop-motion station at Centrum Nauki Kopernik, Warsaw).
- Repo: `kopernikadr`
- applicationId: `pl.slava.kopernikadr.camera` / `pl.slava.kopernikadr.remote`
  (adjust the prefix if I give you a domain)
- Launcher labels: "Kopernikadr Kamera" / "Kopernikadr" (remote is the main app)
- NSD service type: `_kopernikadr._tcp`
- Simple original icon: a planet/orbit motif combined with a film frame.
  No Centrum Nauki Kopernik branding.

## Devices
- Camera: Motorola moto g05 (Android)
- Remote: Lenovo Tab M10 (3rd Gen) TB328FU, 10.1", 4 GB RAM, landscape
Same home Wi-Fi. Do NOT assume Android versions, Camera2 capabilities, codec
support or WebView version — we verify them on the hardware in stage 0.
Both devices are supervised child devices (Google Family Link) — see Risks.

## Architecture (monorepo)
- `/protocol` — protocol spec (PROTOCOL.md) + TypeScript message types.
  Single source of truth; a camera on any platform implements it.
- `/camera-android` — native Kotlin app: CameraX (+ Camera2Interop where needed),
  embedded server (Ktor CIO or equivalent), durable frame spool. Minimal UI.
- `/remote` — Next.js (static export) + Capacitor. Android now, iOS later.
  Native code only where unavoidable, and each such piece is named explicitly:
  - NSD discovery — an existing Capacitor plugin verified against the chosen
    Capacitor major version, or a small own NsdManager bridge;
  - keep-awake;
  - saving the video to the gallery (MediaStore);
  - native MP4 encoding — only if the WebCodecs path fails in stage 0.
- Pin all toolchain and library versions in stage 0.

## Data ownership (the core of the protocol)
- **The tablet owns projects**: project metadata, frame list and order, deletions.
- **The phone is a durable capture spool**: it never deletes an unacked frame.
  Acked frames are kept too and cleaned up after 7 days, or by a button in
  parent mode (a 100-frame movie is ~300–400 MB, which is fine for the phone).
  So `ack` only drives re-download: a lost ack costs one extra transfer,
  never a frame. The phone knows nothing about frame order or deletions.
- Frames must never be lost because of Wi-Fi drops, the phone locking/sleeping,
  either app being killed, or a lost network response.

## Protocol (draft — PROTOCOL.md v0 is provisional; freeze as v1 after stage 0)
- **Discovery:** NSD/mDNS `_kopernikadr._tcp`. Fallback: the phone shows IP:port
  and a QR code; the remote allows manual entry. The NSD instance name is for
  display only — identity is a persistent `cameraId` returned in `hello`.
  Normalize trailing-dot differences in discovered names.
- **Threat model:** trusted home LAN, no authentication or encryption in v1.
  Keep an optional `token` field in `hello` for later.
- **Single controller:** only one remote controls the camera at a time
  (lease, renewed by heartbeat). Another client gets `BUSY`. The same remote
  (same persistent `clientId`) reconnecting gets its lease back.
- **Identifiers:** persistent `cameraId`, persistent `clientId`, per-process
  `bootId`, globally unique `frameId` (UUID/ULID — never a counter that restarts).
- **WebSocket `/ws` (control):** JSON messages with `reqId` and `protocolVersion`;
  typed errors; heartbeat; reconnect with backoff.
  - `hello` / capabilities: every control is reported separately, with
    supported modes and ranges (see "Exposure stability").
  - `capture{projectId}` → `captured{frameId, projectId, w, h, bytes, sha256}`.
    The phone sends `captured` **only after** the JPEG and its manifest entry are
    durably written (fsync).
  - **Idempotency:** the phone keeps a persisted journal of
    `(clientId, reqId) → result`. A retried `capture` with the same `reqId`
    returns the original result and never takes a second photo.
    On timeout the remote queries the operation status by `reqId` and does
    not send a new capture.
  - `ack{frameId}` — sent by the tablet **only after** it has downloaded the
    full-res file, verified size + sha256, written it to disk, and written the
    project entry. Repeated acks are harmless.
  - `listFrames` — the phone's unacked frames; on every (re)connect the remote
    downloads and acks everything it is missing. A frameId the project already
    has, or one the user has deleted (the tablet keeps the ids of deleted
    frames), is just acked again and never re-added.
  - `setExposure` / `setWhiteBalance` / `setFocus` / `setExposureCompensation`
    (only what capabilities report), `status` (battery, free storage,
    thermal state if available).
- **Preview:** JPEG frames ~640px, 10–15 fps, on a channel separate from control
  (e.g. a second WS endpoint or MJPEG — pick one and justify). Preview is
  disposable: at most one frame in flight, stale frames dropped, never queued.
  Preview may pause briefly during a still capture. Capture responses must
  never wait behind preview traffic.
- **HTTP `GET /frames/{frameId}.jpg`** — full-resolution frame. The remote
  downloads it natively (see "Tablet storage"); add CORS headers only for
  endpoints the web layer fetches directly.

## Image geometry
- One canonical geometry for the project: 4:3 landscape (or whatever the camera
  actually supports — decided in stage 0).
- Preview and stills use the same sensor crop (CameraX ViewPort / UseCaseGroup),
  so the onion skin lines up with the live preview.
- The phone is lens-down, so "up" is arbitrary: parent mode has a rotation
  setting (0/90/180/270). The phone applies it to both preview and stills and
  writes upright pixels (no reliance on EXIF orientation anywhere).
- Onion skin uses the last **captured still** (a cached display-size copy),
  not a preview frame.
- Export keeps the aspect ratio: 4:3 → 1440×1080. No stretching.
- Verify alignment with a printed grid on the table.

## Technical risks — verify, don't take my word for it
- **Capacitor transport.** Capacitor on Android serves the app from
  https://localhost by default → ws:// and http:// to LAN addresses are mixed
  content. Likely fix: androidScheme "http" + cleartext allowed in the Network
  Security Config (it has no LAN/subnet selector — document what you actually
  allow). Mixed content, Android cleartext policy and CORS are separate layers.
  Required proof, on an installed **release** build: secure context is true;
  WS control, preview and full-res download work; a downloaded frame, loaded
  via `convertFileSrc`, can be turned into a `VideoFrame`.
  `isSecureContext` alone or a debug-only config is not proof.
- **iOS (future):** ATS NSAllowsLocalNetworking, Local Network permission,
  Bonjour services in Info.plist — account for it in the protocol, don't implement now.
- **Tablet storage and memory (4 GB RAM).** Frames are files, not IndexedDB.
  Capacitor Filesystem's binary `readFile`/`writeFile` go through base64, so
  bytes must not cross the bridge:
  - download originals straight to disk natively. `Filesystem.downloadFile` is
    deprecated since 7.1.0 in favour of `@capacitor/file-transfer` — check the
    current versions and use what is recommended;
  - for display, playback and export: `convertFileSrc` → `fetch` →
    `createImageBitmap`. The image is then same-origin with the app, so
    `VideoFrame` works without CORS.
  Keep small derivatives for thumbnails and
  playback. Every pipeline (download, decode, playback, encode) uses a bounded
  queue independent of project length. Release `ImageBitmap`/`VideoFrame`
  promptly. Target: a 500-frame project plays and exports without running out of memory.
- **MP4 export.** WebCodecs `VideoEncoder` + **Mediabunny** (mp4-muxer is
  deprecated). An available `VideoEncoder` is not enough: check the exact AVC
  config with `isConfigSupported` (1440×1080, chosen FPS). Decode originals
  one at a time, apply encoder backpressure, and timestamp frames from index ÷
  project FPS (not capture time). Stream the output to a file, not into memory.
  Fallback: native MediaCodec + MediaMuxer plugin — chosen in stage 0, not
  discovered in stage 3.
- **Saving to the gallery.** Use MediaStore (Movies/Kopernikadr, `video/mp4`,
  `IS_PENDING` while writing; on failure/cancel the pending entry is removed). Show
  "saved to gallery" only after the entry is published. No broad storage
  permissions.
- **Exposure stability is THE core camera requirement.** Negotiate each control
  independently from actual capabilities:
  - exposure: baseline is AE lock + an exposure-compensation slider
    (Camera2: compensation works while `aeMode != OFF` and "takes effect even
    when aeLock == true"). Manual ISO + shutter (MANUAL_SENSOR) only if stage 0
    shows the lock is not stable enough;
  - white balance: manual gains if MANUAL_POST_PROCESSING, else AWB lock;
  - focus: manual distance if the lens is adjustable, else AF once + AF lock /
    fixed focus.
  Show "Locked" only after CaptureResult confirms the state. Settings must
  apply to both the preview and the still requests and be re-applied after any
  camera rebind. Exposure compensation only while AE is on (it is disabled in
  manual exposure mode). If a control is
  unavailable, say so plainly in parent mode (no fake "Locked").
  Camera2Interop can fight CameraX's own 3A — verify the actual frames, not
  just the request keys.
- **Camera lifecycle (phone).** The camera works only while the camera app is
  in the foreground; no background camera / camera foreground service in v1.
  On screen lock, downtime or process death: shooting stops, nothing is lost
  (everything captured is already on disk); when the app is back in the
  foreground the camera and server resume and the remote reconnects
  automatically. During a session: keep the screen on; after 2 minutes of
  inactivity dim via window brightness (keep-screen-on stays). Battery
  optimization exemption: request it with an explanation, but the app must
  work if it is denied.
- **Storage limits.** Both apps keep a free-space reserve. When it is reached,
  capture/download/export are refused with a clear message before the disk
  fills up. Write failures are still handled. The phone never deletes unacked
  frames to free space (it may clean up acked ones early, oldest first).
  Partial/temporary files are cleaned up on startup.
  Thermal: show a warning in parent mode only.
- **Supervised devices (Google Family Link).**
  - It is unclear what "Always allowed" covers: limits only, Downtime too, the
    parent's manual lock? Don't argue it — test it in stage 0: daily limit,
    app limit, downtime, manual lock, ordinary screen lock, each separately,
    and record the actual settings. Never try to bypass supervision.
  - Camera permission denied → a clear screen "Ask a parent to allow the
    camera", not a crash.
  - Build: release signing (keystore outside the repo, stable forever),
    stable applicationIds. Install script: `adb install -r` to both devices
    (upgrade in place); on a signature mismatch it fails loudly and never
    uninstalls automatically (uninstall wipes projects). Plus an APK build
    for manual installation.
- In the README add a parent checklist with the actual menu paths found in
  stage 0: which Family Link toggles to enable for development (Developer
  options, Apps from unknown sources), which to disable afterwards, and how to
  keep both apps usable during limits and downtime. State clearly: uninstalling
  the remote app deletes all projects (no backup in v1).

## UI/UX
References: the capture-screen patterns of Stop Motion Studio (large preview,
previous-frame overlay, frame strip, side capture button) and an interactive
science-museum stop-motion station (minimal text, large preview, thumbnail
column, 2–3 big buttons). Do not copy other apps' graphics or branding —
use a simple original design.

General principles (the user is a 9-year-old):
- Tablet in landscape, touch targets ≥ 64dp, primary button ≥ 96dp.
- Icons + short labels; icons have accessible names. All strings in
  localization files; languages: ru, pl; fallback for other locales: pl.
- No dialogs with three choices. Destructive actions use Undo
  (5-second snackbar), not "Are you sure?".
- Instant feedback on every action.
- State is never shown by color alone (connection, locks): icon + color.
- Camera settings hidden behind a "parent mode" (long-press the gear for 2 s),
  so the kid can't accidentally wreck exposure mid-animation.
- Dark neutral theme on the capture screen (doesn't distract from the image),
  bright accents only on buttons.

### Remote: screens
1. **Projects.** Card grid: first-frame thumbnail, name (defaults to date),
   frame count. A big "+ New movie" card. Long-press — rename/delete (with Undo).
2. **Connection.** Shown only when no camera is found: "looking for camera…"
   animation, found cameras as big buttons, "enter address manually" at the bottom.
   If exactly one camera is found — connect automatically. If it answers
   `BUSY` — "The camera is used by another tablet".
3. **Capture (main screen).**
   - Center-left: preview as large as possible in the project's aspect ratio,
     with onion skin on top (last captured frame, 30% by default).
   - Right column: a huge round "Capture" button; below it "Delete last";
     below that "Watch" (go to playback).
   - Top bar: back to projects, frame counter, connection indicator
     and phone battery, onion-skin toggle + opacity slider, gear (parent mode).
   - Bottom: thumbnail strip; new frames appear on the right, strip auto-scrolls.
   - On capture: 100 ms white flash + shutter sound (can be muted), the thumbnail
     "flies" into the strip. The Capture button is disabled with a spinner until
     the camera confirms the frame. If no answer arrives in time, the remote
     asks the camera for the status of that `reqId` and never re-sends the capture.
   - Tap a thumbnail — the frame opens large with "Delete" and "Close".
     Deletion is the only editing operation in v1.
   - Deletion is local to the tablet: the frame is hidden at once; the file is
     removed only after the Undo window closes. Undo restores the same frame in
     the same position. Pending deletions survive an app restart.
   - Connection lost: preview dims, a large banner "Camera offline, reconnecting…",
     Capture disabled. Recovery is automatic, including fetching any frames
     captured but not yet received.
4. **Playback.** Full-screen looped playback of frames (swap images on a timer,
   not a video), using playback-size copies. Play/Pause, FPS slider 4–12 with
   turtle/hare icons; FPS is saved in the project. "Save video" button →
   progress bar (cancellable) → "Done, video saved to gallery".

### Parent mode (right-side drawer)
Exposure / white balance / focus — each with a clear status (Locked / Auto /
Not supported), exposure compensation (only when AE is on), image rotation,
shutter sound, preview quality, "clear transferred frames from the phone"
(acked only), camera info from diagnostics, thermal warning.

### Camera (phone)
Almost no UI: full-screen preview with large status on top
("Waiting for tablet" / "Connected to tablet"), IP:port and QR.
Screen stays on during a session; dims after 2 minutes of inactivity (see
Camera lifecycle).

## Out of scope for v1
Audio/music, titles, crop, filters, reordering/duplicating frames,
multiple simultaneous cameras or controllers, project backup/export of frames,
LAN authentication/encryption, iOS (only accounted for in the protocol),
cloud, accounts, analytics, ads.

## How we work
Stages; after each one — stop, I test on the hardware, you commit to git.
Don't add features beyond this list.

0. **Facts and feasibility probes**, all as installed release builds, run
   UNDER THE CHILD ACCOUNT:
   - PROTOCOL.md v0 (provisional) + monorepo skeleton with pinned versions.
   - camera-android diagnostics: Android version, cameras, hardware level,
     CAPABILITIES (MANUAL_SENSOR, MANUAL_POST_PROCESSING), AE/AWB/AF modes and
     lock support, ranges, minimum focus distance, supported output sizes.
   - Camera probe: preview + analysis (640px JPEG) + full-res still bound
     together at the real sizes; measured fps and capture time; 20 captures
     in a row with AE/AWB lock under the real lighting — brightness/color stay
     the same, also after moving the compensation slider while locked; sharp
     focus at the real mounting distance.
   - Remote probe: WebView version, secure context, WS + preview, native
     full-res download from the phone, `convertFileSrc` → `createImageBitmap`
     → `VideoFrame`, NSD discovery, manual address.
   - Export probe: encode ~30 real frames at 1440×1080 into an MP4, save it via
     MediaStore, play it in the gallery. Record which path works (WebCodecs or native).
   - Supervision probe: adb install, manual APK install, upgrade over an
     existing install, camera permission, and app behaviour under limits /
     downtime / manual lock, with the actual parent menu paths.
   I'll send you the output. Based on it we pick the exposure strategy, minSdk,
   transport details and export path, and freeze PROTOCOL.md v1.
1. Connection, preview, Capture (phone writes durably, with final identifiers
   and the reqId journal), onion skin, exposure/WB/focus controls, rotation.
2. Frame transfer with durable ack, projects, reconnection without loss.
3. Frame strip with delete + Undo, playback, MP4 export to gallery.
4. UX polish based on my notes after testing with the kid.

Acceptance for stages 1–3 includes failure tests, not just the happy path:
Wi-Fi off mid-transfer, phone locked mid-session, either app killed before and
after `captured` / `ack`, a lost capture response (retry must not duplicate),
delete during transfer, low storage, and a long session (≥ 300 frames →
playback → export).

Start with an architecture plan and PROTOCOL.md v0, then wait for my OK.
