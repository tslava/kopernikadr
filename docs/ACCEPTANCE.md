# On-device acceptance

One checklist per stage. Every item gets a result (pass/fail + the number or note) and a link to
the run summary in `docs/diagnostics/`. Unchecked = not run yet.

## Stage 0a — camera (moto g05)

Plan: [plans/20261026-stage0-camera.md](plans/20261026-stage0-camera.md). The fast track
(a working rig with remote-lite) ran first; the items below were left for later.

Done so far:
- [x] Viewfinder in landscape 4:3 with the full field of view (Task 4).
- [x] Resolved sizes logged: the strict variant A bind fails, the fallback gives preview 960×720,
      analysis 960×720, still 3264×2448 (Task 4).

Pending on the phone (0a Task 4):
- [ ] Screen lock/unlock → the camera rebinds and the locks are re-applied. Result:
- [ ] Camera permission denied → the "Poproś rodzica o zgodę na aparat" screen, no crash
      (screenshot). Result:
- [ ] Variant B (analysis + capture, no preview) strict bind. Result:
- [ ] `capture-test` on the probe build (non-debuggable): orientation, geometry, paired result.
      Result:
- [ ] Preview fps in normal room light. Result:

Deferred probes and checks (0a Tasks 6, 9, 14, 15–16):
- [ ] `streams`: variants A/B, strict + fallback bind, preview/analysis fps, 20 captures with the
      capture-to-commit breakdown (p50/p95), heap, YUV vs RGBA cost. Result:
- [ ] `locks`: freeze vs AE/AWB lock, segments S1–S4 with the card and a camera restart, incl.
      `--manual-restart` across a real screen lock. Verdict:
- [ ] `focus`: sharp at the mount distance; freeze-focus confirmation time. Result:
- [ ] `grid`: preview path vs still at rotation 0 and 180 (shift, scale, score, overlay).
      Result:
- [ ] `/diag` routes + probe-client `info` / `hello` / `capture` / `preview` / `download` against
      the phone; a second `clientId` gets BUSY. Result:
- [ ] `preview --quality high` (1280 px) fps. Result:
- [ ] Wi-Fi off/on → a new hello and preview work. Result:
- [ ] Release APK contains no app-side diagnostics classes. Result:

(The NSD advertiser moved from 0a Task 14 to plan 0b Task 2; it is checked in the 0b section.)

## Stage 0b — tablet (Tab M10 TB328FU) + phone

Plan: [plans/20261026-stage0b-tablet.md](plans/20261026-stage0b-tablet.md). Filled in Tasks 13
(emulator) and 14 (tablet session). Run summary: `docs/diagnostics/<date>-tablet.md`.

Secure context and transport (release build on the tablet):
- [ ] The Capacitor 8 app has a secure context (`isSecureContext`, `crypto.subtle`) on the
      Tab M10, Android 12, WebView 155. Result:
- [ ] `ws://` control (hello, session, ping during a capture) and `http://` (`/info`, frames)
      to the camera work. Result:
- [ ] Preview fps / latency (p50/p95) at low / normal / high. Result:

Discovery:
- [ ] The phone advertises `_kopernikadr._tcp` with the TXT record (`dns-sd -B` / `-L` on the
      Mac). Result:
- [ ] The tablet app discovers the camera via NSD (services found, latency). Result:
- [ ] Manual address entry works. Result:

Download and VideoFrame:
- [ ] Originals download natively to disk (MB/s, sha256 ok, `installFile` ok). Result:
- [ ] A downloaded original → `convertFileSrc` → `createImageBitmap` → `VideoFrame`. Result:

Export:
- [ ] Codec picked by `isConfigSupported` (H.264 1440×1080 profile string). Result:
- [ ] Export of 20 frames: per-frame decode/encode ms, total, bytes. Result:
- [ ] Export of 100 frames from 8 MP originals on the T610: per-frame ms, total, peak memory
      (meminfo sampler). Result:
- [ ] The MP4 lands in the gallery (Movies/Kopernikadr) and plays and seeks there. Result:

Reconnect:
- [ ] After a phone screen lock and unlock (time to reconnect). Result:
- [ ] After a camera app restart (new `bootId`, time to reconnect). Result:

Install and Family Link (child account):
- [ ] Manual APK install via the Files app (unknown sources); the prompts seen. Result:
- [ ] Upgrade over it with `install.sh --remote-only` (bumped `versionCode`). Result:
- [ ] Daily limit — behaviour of both apps. Result:
- [ ] App limit. Result:
- [ ] Downtime. Result:
- [ ] The parent's manual lock. Result:
- [ ] Ordinary screen lock. Result:
- [ ] What "Always allowed" covers. Result:

remote-lite must not break:
- [ ] Merged-dir Chrome run against the fake camera (preview, capture, playback, export).
      Result:
- [ ] On the phone from a browser: capture and export. Result:

Decisions recorded after the session:
- [ ] Export path (WebCodecs + Mediabunny, or the native MediaCodec fallback). Decision:
- [ ] NSD approach (plugin or own bridge). Decision:
