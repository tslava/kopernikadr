# Pinned versions (remote)

Rule: stable releases only, published on or before **2026-10-12** (≥14 days before 2026-10-26).
npm dates are the registry `time` of the version (`npm view <pkg> time --json`). Exact versions
(`.npmrc` has `save-exact=true`); installed from the repo root with
`npm install --before=2026-10-12T23:59:59Z` so transitive deps follow the same rule (all 235
locked registry packages checked: none is newer than the cutoff).

## npm

| Package | Version | Published | Newest qualifying? |
|---|---|---|---|
| next | 16.4.3 | 2026-10-23 | **exception** (owner-approved 2026-10-26): security patch release in the same minor as 16.4.0, which has open advisories |
| react, react-dom | 19.3.0 | 2026-09-09 | yes (19.3.1 is 2026-10-14) |
| @capacitor/core, @capacitor/android, @capacitor/cli | 8.5.3 | 2026-10-07 | yes |
| @capacitor/filesystem | 8.1.4 | 2026-10-02 | yes (8.1.5 is 2026-10-15) |
| @capacitor/file-transfer | 2.0.6 | 2026-10-02 | yes |
| @capacitor/app | 8.1.2 | 2026-10-02 | yes |
| @capacitor-community/keep-awake | 8.0.1 | 2026-04-16 | yes |
| typescript | 7.0.2 | 2026-07-08 | yes |
| vitest | 5.0.4 | 2026-10-12 | yes (5.0.5 is 2026-10-15) |
| vite (vitest peer) | 8.3.4 | 2026-10-08 | yes (8.3.5 is 2026-10-21) |
| @types/react, @types/react-dom | 19.3.0 | 2026-09-09 | yes |
| @types/node | 22.20.5 | 2026-10-01 | newest 22.x (matches Node 22) |
| mediabunny | 1.61.4 | 2026-10-12 | yes (1.61.5 is 2026-10-15); deps `@types/dom-webcodecs` 0.1.13 (exact), `@types/dom-mediacapture-transform` 0.1.12 (2026-07-08) |

Notes:
- **TypeScript 7** (native compiler) has no classic JS API. Next 16.4 type-checks through the
  `tsc` CLI, and `@capacitor/cli` 8.5.3 loads `capacitor.config.ts` with Node's type stripping
  when `transpileModule` is missing (works on Node 22.21).
- **Next 16.4.3 is a deliberate exception to the 14-day rule.** 16.4.0 (the newest qualifying
  version) has open advisories (image optimizer SVG RCE, server-actions DoS, `use cache` typed arrays)
  and makes `next build` stop once under a coding agent. None of those features ship in a static
  export, but the owner chose the patched release over the cooldown.
- **mediabunny 1.61.4** (MPL-2.0) was added later (Task 12) with `npm install mediabunny@1.61.4
  --save-exact -w remote --before=2026-10-12T23:59:59Z`. A full codec string goes in
  `VideoEncodingConfig.fullCodecString` (next to a matching `codec`), not in `codec`; see
  `lib/export/mediabunnyExport.ts`.
- `npm audit` also flags `uuid` < 11.1.1 via `@capacitor/cli` → `xcode` (iOS tooling only, a
  dev dependency; not in the app).

## Android (`android/`)

Dates: `Last-Modified` of the `.pom` on Google Maven / Maven Central; Gradle: `buildTime` from
services.gradle.org.

| Component | Version | Published | Note |
|---|---|---|---|
| Gradle wrapper (`-all`) | 8.14.6 | 2026-10-08 | sha256 pinned in `gradle-wrapper.properties` |
| AGP `com.android.tools.build:gradle` | 8.13.2 | 2025-12-11 | template had 8.13.0; newest 8.13.x |
| Kotlin Gradle plugin (`org.jetbrains.kotlin.android`, stdlib) | 2.4.21 | 2026-10-08 | same as camera-android |

- Gradle 8.14.6 `-all` sha256:
  `24fc39aedd1b68c3de8e4d46a0277c9b42d9ccdb172231a634fad54a3693e50a`
  (from `https://services.gradle.org/distributions/gradle-8.14.6-all.zip.sha256`). The wrapper
  jar/scripts were regenerated with `./gradlew-jbr wrapper --gradle-version 8.14.6`; the jar's
  sha256 `ad16bca4…37e0` matches `gradle-8.14.6-wrapper.jar.sha256`.
- The Capacitor 8 template is AGP 8.x + Groovy (not AGP 9 built-in Kotlin like camera-android),
  so `:app` applies `org.jetbrains.kotlin.android`. `ext.kotlin_version` in the root
  `build.gradle` also lifts the Kotlin-based plugins (filesystem, file-transfer; default 2.2.20)
  to 2.4.21.
- AndroidX versions in `variables.gradle` are the Capacitor 8.5.3 template's (activity 1.11.0,
  appcompat 1.7.1, core 1.17.0, webkit 1.14.0, …), unchanged.
- SDK: compileSdk 36, targetSdk 36, minSdk 31. JDK: Android Studio's JBR 21 via `gradlew-jbr`.
