# Releasing to Google Play

Two apps, two Android App Bundles (AAB): `pl.slava.kopernikadr.camera` (phone) and
`pl.slava.kopernikadr.remote` (tablet).

## 1. Upload key (once)

Play App Signing: Google holds the real app signing key and re-signs what Play delivers. We only keep
an **upload key** that proves the AAB comes from us. One key is used for both apps.

```sh
mkdir -p ~/.kopernikadr && chmod 700 ~/.kopernikadr
"/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" -genkeypair -v \
  -keystore ~/.kopernikadr/upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Kopernikadr"
```

keytool asks for the passwords; use a long random one and put it in a password manager.

`~/.kopernikadr/keystore.properties` (never commit; `chmod 600`):

```properties
storeFile=upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

`storeFile` is absolute or relative to the properties file.

**Back up** `upload.jks` and the passwords (password manager plus an offline copy). If the upload key
is lost, Play can reset it through support, but it takes days. Never put either file in the repo.

Another key file: `KOPERNIKADR_KEYSTORE_PROPERTIES=/path/to/keystore.properties`.

## 2. Versions

One place per app, `gradle.properties` in the Android dir:

| App | File |
|---|---|
| remote | `remote/android/gradle.properties` |
| camera | `camera-android/gradle.properties` |

```properties
APP_VERSION_CODE=1      # integer, must grow with EVERY upload to Play (even to internal testing)
APP_VERSION_NAME=1.0.0  # shown to users
```

Bump `APP_VERSION_CODE` by 1 for each new upload; bump the name as you like (semver). The two apps
version independently. The AAB file name carries both: `kopernikadr-<app>-<name>-<code>.aab`.

## 3. Build

```sh
scripts/build-release.sh                 # both apps
scripts/build-release.sh --camera-only   # or --remote-only
```

It stops at once if `keystore.properties` is missing. For the remote it also fetches the MediaPipe
model, runs the web build and `cap sync`. After Gradle it checks, per AAB: the signature
(`jarsigner -verify`), that every native `.so` has 16 KB ELF alignment (Play requirement), and prints
size. Output in `dist/` (git-ignored):

- `dist/kopernikadr-camera-<name>-<code>.aab`
- `dist/kopernikadr-remote-<name>-<code>.aab`

## 4. Upload

1. Play Console, create the app (first time), accept Play App Signing when asked.
2. **Internal testing** first: Testing, Internal testing, Create release, upload the AAB. Install via the
   opt-in link on the real devices (phone: camera; tablet: remote) and check the basics.
3. Then closed testing (see the plan for the 12 testers x 14 days rule), then production.
4. Upload order: camera and remote are independent, but release both to the same track together so the
   pair stays compatible.
