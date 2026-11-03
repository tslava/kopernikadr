# Google Play release

## Overview
Publish both apps (tablet remote `pl.slava.kopernikadr.remote`, phone camera `pl.slava.kopernikadr.camera`)
on Google Play. Owner decisions (2026-11-03):
- new **personal** developer account (owner creates it): closed test with 12 testers for 14 days before
  production;
- target audience **children 6–12 and older** → Play Families policy;
- privacy policy on a separate **public** repo `tslava/kopernikadr-site` (GitHub Pages);
- store listing and app UI in **Polish, Russian, English**; English is the fallback for other locales;
- the kid's films in the debug build (`…remote.debug`) are **not migrated**: the debug app stays for old
  films, the Play app starts empty.

Already fine: targetSdk 36; release signing reads `~/.kopernikadr/keystore.properties` (owner);
the only native lib, `libmediapipe_tasks_jni.so`, is 16 KB aligned (LOAD align 2^14, `zipalign -c -P 16` OK);
OpenMoji CC BY-SA attribution is in parent mode (`about.openmoji`).

## Constraints
- Never create the release keystore and never commit keystores or passwords. A throwaway key for local
  release smoke tests lives in the scratchpad only, and such builds go to the emulator, never to the kid's
  tablet or phone (a signature mismatch would block the later Play install).
- Kid's devices: `install -r` only, never uninstall or `pm clear`; never touch "Film 2".
- Nothing is pushed to a public repo or uploaded to Play without the owner's explicit OK.

## Implementation Steps

### Task 1: English UI in the remote, English fallback
**Files:** Create `remote/lib/i18n/en.ts`; Modify `remote/lib/i18n/index.ts`, `remote/lib/i18n/i18n.test.ts`,
`remote/android/app/src/main/res/values*/strings.xml`
- [x] `en.ts` with every key of `pl` (plural entries per Intl rules); `LANGS = ['en','pl','ru']`, `FALLBACK = 'en'`
- [x] native strings: `values/` English, add `values-pl/`, keep `values-ru/`
- [x] tests: key parity en/pl/ru, `de-DE` → en, `pl-PL` → pl, `ru` → ru
- [x] `npm test` and lint pass

### Task 2: English in the camera app
**Files:** `camera-android/app/src/main/res/values*/strings.xml`
- [x] `values/` English, `values-pl/` Polish (current text), `values-ru/` kept; same keys in all three
- [x] unit tests / lint (`MissingTranslation`) pass

### Task 3: Drop MediaPipe telemetry
**Files:** `remote/android/app/build.gradle` or `AndroidManifest.xml`, `remote/VERSIONS.md`, `docs/ARCHITECTURE.md` §5.4a
- [x] remove `TransportBackendDiscovery` with `tools:node="remove"` (MediaPipe calls datatransport directly, so excluding the library would crash)
- [x] merged release manifest: no transport services/receivers, no `AD_ID`, list the final permissions
- [ ] segmenter still runs (debug build on the tablet, one cut)
- [x] close backlog `kopernikadr-mediapipe-telemetry`

### Task 4: Release builds
**Files:** both `build.gradle(.kts)`, `scripts/build-release.sh`, `docs/RELEASE.md`
- [x] versionCode/versionName scheme for both apps (Play needs a growing versionCode)
- [x] `scripts/build-release.sh`: `bundleRelease` for both apps, fails without keystore.properties, checks
      16 KB alignment and prints AAB sizes
- [x] release smoke on the emulator with a throwaway scratchpad key (2026-11-03, kopernikadr-tab, fake camera at 10.0.2.2:8765): start, connect by address, capture 3 frames + onion skin, MP4 export to the gallery, sticker cut (MediaPipe GPU, no crash with the backend discovery removed) and save; camera release starts. Not covered: NSD discovery of a real camera (needs two devices).
- [x] `docs/RELEASE.md`: keystore generation command for the owner, Play App Signing, upload order

### Task 5: Privacy policy site
**Files:** Create `store/site/` (index + privacy in pl/en/ru)
- [ ] policy: no account, no ads, no analytics, no data leaves the home network; camera and photos stay on the
      devices; on-device MediaPipe; contact email (owner provides)
- [ ] after owner OK: create public repo `tslava/kopernikadr-site`, enable Pages, record the URL

### Task 6: Store listing and Play Console answers
**Files:** Create `store/listing/{pl,en,ru}.md` per app, `store/console-answers.md`
- [ ] title (≤30), short (≤80), full (≤4000) description per language and app
- [ ] Data safety, content rating (IARC), target audience / Families, ads (none), app access (no login)

### Task 7: Graphics
**Files:** `store/graphics/`
- [ ] 512×512 icon per app, 1024×500 feature graphic per app
- [ ] screenshots: tablet (remote) and phone (camera), Test movies only

### Task 8: Owner checklist and docs
- [ ] `docs/RELEASE.md` owner checklist: account + identity check, keystore, internal → closed test (12×14),
      production, Family Link "Always allowed" for the Play apps
- [ ] ROADMAP, ARCHITECTURE updated; plan moved to `docs/plans/completed/`
