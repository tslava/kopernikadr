# @kopernikadr/remote-core

Plain browser ESM (with JSDoc) shared by the two remotes:

- **remote-lite** (`camera-android/core/src/main/resources/remote-lite/`), the browser remote served
  by the camera app. Gradle's `:core:syncRemoteCore` copies `src/*.js` into
  `remote-lite/lib/` at build time, next to remote-lite's own `lib/*.js`; remote-lite imports them
  as `./lib/x.js` (and `lib/i18n.js` imports `./i18n-core.js`).
- **remote** (the native app, stage 0b+), as the npm workspace package
  `@kopernikadr/remote-core/<module>` (e.g. `@kopernikadr/remote-core/protocol`).

| Module | What |
|---|---|
| `protocol.js` | control-socket envelope, `ControlClient` (reqId correlation, events), `ProtocolError`, `uuid()` |
| `connection.js` | `CameraConnection`: hello, ping/offline detection, reconnect with backoff, BUSY / 4001 handling |
| `backoff.js` | reconnect delays 0.5 → 5 s |
| `preview.js` | `PreviewLoop`: the `{"t":"next"}` pull loop with a watchdog |
| `preview-frame.js` | binary preview frame parser |
| `i18n-core.js` | `pickLang` / `makeTranslator` (Intl plural rules) over an app's own STRINGS |

## Rules

- Modules import only each other, by a relative `./x.js` path: no bare specifiers, no `node:`,
  no subdirectories (browsers load remote-lite unbundled). `test/module-rule.test.mjs` enforces it.
- No file name may also exist in remote-lite's `lib/` (the Gradle merge fails on duplicates).
- Wire shapes are checked against `protocol/fixtures/` in `test/contract.test.mjs`.

## Tests

```sh
npm test -w @kopernikadr/remote-core     # from the repo root (or: npm test --workspaces)
```
