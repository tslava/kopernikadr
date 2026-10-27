# Stages 1+2 — emulator E2E, 2026-10-27

Emulator `kopernikadr-tab` (API 31, Chromium 158 WebView), debug build of the remote, fake camera
`protocol/tools/probe-client/fake-camera.mjs` on the Mac (`10.0.2.2:8765` from the emulator).
Script: `remote/e2e/flow.cdp.mjs` (see `remote/e2e/README.md`). Two runs (before and after the
Task 19 lifecycle merge), both 9/9 PASS:

| Step | Result |
|---|---|
| 1 create a movie | PASS |
| 2 connect | PASS (online; manual address on the first run) |
| 3 shoot 10 frames | PASS, counter 10 |
| 4 kill the app mid-transfer, relaunch | PASS: 4/10 acked before the kill, 10/10 local + acked after |
| 5 dropped capture response | PASS: resolved via `getOperation`, counter 11 |
| 6 play view | PASS |
| 7 export | PASS: `kopernikadr-Film_2-2026-10-27.mp4`; ffprobe h264 1440×1080, 8 fps, 11 frames, decodes clean |
| 8 delete + Undo | PASS: still listed after the window |
| 9 delete past the window | PASS: gone, 11/11 frames acked on the camera |

Also checked by hand on the emulator: the capture view layout (preview left, controls right), the
onion skin over the live preview, the parent drawer (long-press wrench).
