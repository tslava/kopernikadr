# probe-client

A Mac-side CLI for poking the camera server (`protocol/PROTOCOL.md`). It needs Node ≥ 22 and has
no dependencies; it uses the global `fetch` and `WebSocket`.

```sh
cd protocol/tools/probe-client
node --test                                   # unit + fake-camera tests
node client.mjs <command> <host[:port]> ...   # default port 8765
```

`clientId` and a default `projectId` are kept in `~/.config/kopernikadr/probe-client.json`
(created on first use). `--clientId <uuid>` overrides it for one call. `--json` prints the raw
result on stdout and sends progress to stderr. `--verbose` also prints control-socket events.

## Usage

```sh
# GET /info
node client.mjs info 192.168.1.42

# hello on /ws/control, print the session, close; a second clientId must get BUSY
node client.mjs hello 192.168.1.42
node client.mjs hello 192.168.1.42 --clientId 0b0e7a3c-1f0e-4f43-9a54-6b7c8d9e0f12

# capture (rotation defaults to the camera's current one); --repeat re-sends the same reqId
# and prints PASS if both answers carry the same frameId
node client.mjs capture 192.168.1.42 --repeat
node client.mjs capture 192.168.1.42 --rotation 180 --projectId <uuid> --reqId <uuid>

# preview pull loop: fps, next→frame latency, JPEG sizes, w×h; a 3 s stall triggers re-hello + reopen.
# --quality goes through POST /diag/controls (debug/probe builds only; a 404 is a warning)
node client.mjs preview 192.168.1.42 --seconds 20 --quality high

# download a frame variant, check Content-Length and (optionally) sha256, save it
node client.mjs download 192.168.1.42 01JC... --sha256 <hex> --out /tmp/f.jpg
node client.mjs download 192.168.1.42 01JC... --variant thumb

# run a /diag probe; prompts are answered with Enter here (or Continue on the phone);
# the report and its files land in <repo>/diagnostics/<YYYY-MM-DD>/<runId>/
node client.mjs probe 192.168.1.42 caps
node client.mjs probe 192.168.1.42 locks --args '{"manualRestart":true}'

# read-only backup of one client's unacked frames (remote-lite's clientId is in the tablet
# browser's localStorage, key kopernikadr.remoteLite.clientId): every full is downloaded, checked
# against its sha256 and saved next to a manifest.json. It never acks; a re-run skips saved frames.
# The camera holds a session for 10 s after a client leaves: a BUSY answer means "wait and retry".
node client.mjs backup 192.168.1.42 --clientId <uuid> --out ~/kopernikadr-backup/<date>
```

During `probe`, the server may vanish while the phone screen is locked; the client keeps polling
with backoff for up to 5 minutes. The `/diag` JSON shapes it assumes are documented at the top of
`diag.mjs`, the only place to change if the server differs.

## Fake camera (dev server for remote-lite and the remote app)

`fake-camera.mjs` is a test-only stand-in for the camera server; it also serves remote-lite for
manual runs. Serve the **merged build output**: remote-lite's `lib/` is assembled from
`packages/remote-core` at build time, so `camera-android/core/src/main/resources/remote-lite` no
longer contains every module.

```sh
(cd ../../../camera-android && ./gradlew-jbr :core:processResources)
node fake-camera.mjs --serve ../../../camera-android/core/build/resources/main/remote-lite --port 8765
# open http://localhost:8765/   (--host 0.0.0.0 to reach it from another device)
```

Re-run `:core:processResources` after changing remote-lite or `packages/remote-core`.

CORS: `/info` and `/frames/...` echo the request `Origin` in `Access-Control-Allow-Origin` (with
`Vary: Origin`) when it is `http://localhost`, `http://127.0.0.1` or `http://10.0.2.2` (the
Android emulator's host), with or without a port. That covers a remote dev build on another port
or in the emulator. Other origins get no CORS header. The failure knobs (`/fake/kick`,
`/fake/slow-play`, `/fake/fail-play`, ...) are listed at the top of `fake-camera.mjs`.

### Failure switches

Plain GETs on the fake camera (full list and details in the header comment of `fake-camera.mjs`):
`/fake/restart[?cameraId=]` (new `bootId`, sockets dropped), `/fake/camera-id?id=`,
`/fake/storage-low` (next capture), `/fake/missing-full?frame=` (404), `/fake/corrupt-full?frame=`
(sha mismatch), `/fake/pending-forever` (next capture), `/fake/reclaim` (acked frames' files → 404),
plus `/fake/kick`, `/fake/drop-capture`, `/fake/fail-lock`, `/fake/slow-play`, `/fake/fail-play`.
