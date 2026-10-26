# Pinned versions

Rule: stable releases only, published on or before **2026-10-12** (≥14 days before 2026-10-26).
Dates are the `Last-Modified` of the `.pom` on Maven Central / Google Maven / the Gradle Plugin
Portal (Gradle: `buildTime` from services.gradle.org). Versions live in
`gradle/libs.versions.toml`.

| Component | Version | Published | Newest qualifying? |
|---|---|---|---|
| Gradle wrapper | 9.8.1 | 2026-10-07 | yes (9.8.2 is 2026-10-19) |
| AGP `com.android.application` | 9.4.1 | 2026-09-18 | yes |
| Kotlin (`kotlin.jvm`, `plugin.compose`, `plugin.serialization`, stdlib) | 2.4.21 | 2026-10-08 | yes |
| kotlinx-serialization-json | 1.11.0 | 2026-04-09 | yes (1.12.0 is 2026-10-19) |
| kotlinx-coroutines-core / -android / -test | 1.11.0 | 2026-05-07 | yes |
| Compose BOM | 2026.06.01 | 2026-07-01 | **no**, see below |
| ↳ compose ui / ui-tooling(-preview) | 1.11.4 | 2026-07-01 | via BOM |
| ↳ material3 | 1.4.0 | 2025-09-24 | via BOM |
| activity-compose | 1.13.0 | 2026-03-11 | yes |
| lifecycle-runtime-ktx / -runtime-compose | 2.10.0 | 2025-11-19 | **no**, see below |
| CameraX camera-core / -camera2 / -lifecycle / -view | 1.6.2 | 2026-08-26 | yes |
| Ktor server core / cio / websockets / cors / content-negotiation, serialization-kotlinx-json, server-test-host, client-websockets / -content-negotiation | 3.6.0 | 2026-09-16 | yes |
| slf4j-nop (app runtime), slf4j-simple (`:core` tests) | 2.0.20 | 2026-09-22 | yes |
| androidx.sqlite `sqlite` / `sqlite-bundled` | 2.7.1 | 2026-09-09 | yes |
| JUnit | 4.13.2 | 2021-02-13 | yes |

Held back:
- **Compose BOM 2026.08.00+ (Compose 1.12) and lifecycle 2.11.0** set `minCompileSdk = 37`.
  This app compiles against android-36 (compileSdk = targetSdk = 36), so the newest Compose
  that fits is BOM 2026.06.01 (Compose 1.11.4) and lifecycle 2.10.0.
- **slf4j-android** was not used: its last release (1.7.36, 2022) is an slf4j 1.x binding and
  is ignored by the slf4j 2.x API that Ktor 3 needs. Android gets `slf4j-nop` instead.

Kotlin on Android: AGP 9 compiles Kotlin itself ("built-in Kotlin"), so
`org.jetbrains.kotlin.android` is not applied. AGP 9.4.1 declares a runtime dependency on
KGP 2.2.10; declaring the Kotlin plugins in the root build lifts it to 2.4.21 (check with
`./gradlew-jbr buildEnvironment`).
