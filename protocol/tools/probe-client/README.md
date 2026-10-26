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
```

During `probe`, the server may vanish while the phone screen is locked; the client keeps polling
with backoff for up to 5 minutes. The `/diag` JSON shapes it assumes are documented at the top of
`diag.mjs`, the only place to change if the server differs.
