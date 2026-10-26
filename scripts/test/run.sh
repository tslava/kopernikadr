#!/usr/bin/env bash
# Tests for scripts/*.sh against a fake adb (scripts/test/fake-adb) on PATH. Plain bash.
#   scripts/test/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(cd "$HERE/.." && pwd)"
ORIG_PATH="$PATH"
PASS=0
FAIL=0
FAILED=()
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kopernikadr-scripts-test.XXXXXX")"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd)" # no '//' from a TMPDIR with a trailing slash
trap 'rm -rf "$TMP_ROOT"' EXIT

# ---- harness ------------------------------------------------------------------------------

T=""
OUT=""
RC=0
setup() {
  T="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  mkdir -p "$T/state" "$T/bin" "$T/dist"
  cp "$HERE/fake-adb" "$T/bin/adb"
  chmod +x "$T/bin/adb"
  : > "$T/state/calls.log"
  : > "$T/state/violations.log"
  export FAKE_ADB_STATE="$T/state"
  export PATH="$T/bin:$ORIG_PATH"
  export KOPERNIKADR_DIST_DIR="$T/dist"
  export KOPERNIKADR_KEYSTORE_PROPERTIES="$T/no-such-keystore.properties"
  export NO_COLOR=1
  unset ADB ANDROID_SERIAL
  local app variant
  for app in camera remote; do
    for variant in release debug probe; do
      [[ "$app" == remote && "$variant" == probe ]] && continue
      echo "apk $app $variant" > "$T/dist/kopernikadr-$app-$variant.apk"
    done
  done
}

device() { echo "$1|${2:-device}|${3:-}|${4:-}|${5:-}" >> "$T/state/devices"; } # serial state model qemu avd
run() { OUT="$("$@" 2>&1)" && RC=0 || RC=$?; }

CASE=""
case_ok=1
begin() {
  CASE="$1"
  case_ok=1
  setup
}
check() { # <description> <command...>
  local d="$1"
  shift
  if ! "$@"; then
    case_ok=0
    printf '    FAIL: %s\n' "$d"
  fi
}
end() {
  # Global invariants for every case: no uninstall / pm clear, no device command without -s.
  if [[ -s "$T/state/violations.log" ]]; then
    case_ok=0
    printf '    FAIL: adb violations:\n'
    sed 's/^/      /' "$T/state/violations.log"
  fi
  if [[ "$case_ok" == 1 ]]; then
    PASS=$((PASS + 1))
    printf 'ok   %s\n' "$CASE"
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$CASE")
    printf 'FAIL %s\n' "$CASE"
    printf '%s\n' "$OUT" | sed 's/^/      | /'
  fi
}

rc_is() { [[ "$RC" == "$1" ]]; }
rc_nonzero() { [[ "$RC" != 0 ]]; }
out_has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
called() { grep -qF -- "$1" "$T/state/calls.log"; }
not_called() { ! grep -qF -- "$1" "$T/state/calls.log"; }
no_install() { ! grep -q ' install ' "$T/state/calls.log"; }
not_out_has_gradle() { ! printf '%s' "$OUT" | grep -q 'gradle :app'; }

PHONE=ZY22FAKE01
TAB=HA1FAKE001

# ---- install.sh ---------------------------------------------------------------------------

begin "install: maps devices by model substring (g05 → camera, TB328 → remote)"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
run "$SCRIPTS/install.sh"
check "exit 0" rc_is 0
check "camera on the phone" called "-s $PHONE install -r $T/dist/kopernikadr-camera-release.apk"
check "remote on the tablet" called "-s $TAB install -r $T/dist/kopernikadr-remote-release.apk"
check "no remote on the phone" not_called "-s $PHONE install -r $T/dist/kopernikadr-remote"
end

begin "install: substring match is case-insensitive and needs no vendor prefix"
device "$PHONE" device "Moto G05"
device "$TAB" device "TB328FU"
run "$SCRIPTS/install.sh"
check "exit 0" rc_is 0
check "camera" called "-s $PHONE install -r"
check "remote" called "-s $TAB install -r"
end

begin "install: unknown model connected → fail, nothing installed"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
device PIXEL7 device "Pixel 7"
run "$SCRIPTS/install.sh"
check "non-zero" rc_nonzero
check "names the unknown device" out_has 'PIXEL7("Pixel 7")'
check "nothing installed" no_install
end

begin "install: --serial on an unknown model → fail"
device PIXEL7 device "Pixel 7"
run "$SCRIPTS/install.sh" --serial PIXEL7
check "non-zero" rc_nonzero
check "message" out_has 'unknown model "Pixel 7"'
check "nothing installed" no_install
end

begin "install: --serial picks the device and the matching app; others are not queried"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
device PIXEL7 device "Pixel 7"
run "$SCRIPTS/install.sh" --serial "$TAB"
check "exit 0" rc_is 0
check "remote on the tablet" called "-s $TAB install -r $T/dist/kopernikadr-remote-release.apk"
check "phone untouched" not_called "-s $PHONE"
end

begin "install: --serial with the wrong --*-only → fail"
device "$TAB" device "Lenovo TB328FU"
run "$SCRIPTS/install.sh" --serial "$TAB" --camera-only
check "non-zero" rc_nonzero
check "nothing installed" no_install
end

begin "install: emulator without --allow-emulator → not a tablet"
device emulator-5582 device "sdk_gphone64_arm64" 1 kopernikadr-tab
run "$SCRIPTS/install.sh" --remote-only
check "non-zero" rc_nonzero
check "says no tablet" out_has "no tablet connected"
check "mentions --allow-emulator" out_has "--allow-emulator"
check "nothing installed" no_install
end

begin "install: emulator with --allow-emulator → remote"
device emulator-5582 device "sdk_gphone64_arm64" 1 kopernikadr-tab
run "$SCRIPTS/install.sh" --remote-only --allow-emulator
check "exit 0" rc_is 0
check "remote on the emulator" called "-s emulator-5582 install -r $T/dist/kopernikadr-remote-release.apk"
end

begin "install: --serial emulator without --allow-emulator → fail"
device emulator-5582 device "sdk_gphone64_arm64" 1 kopernikadr-tab
run "$SCRIPTS/install.sh" --serial emulator-5582
check "non-zero" rc_nonzero
check "message" out_has "Pass --allow-emulator"
check "nothing installed" no_install
end

begin "install: an AVD with a custom model is recognised by its AVD name"
device emulator-5582 device "Lenovo TB328FU" 1 kopernikadr-tab
run "$SCRIPTS/install.sh" --remote-only
check "not taken as the real tablet" rc_nonzero
run "$SCRIPTS/install.sh" --remote-only --allow-emulator
check "ok with --allow-emulator" rc_is 0
end

begin "install: --remote-only skips the camera"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
run "$SCRIPTS/install.sh" --remote-only
check "exit 0" rc_is 0
check "remote installed" called "-s $TAB install -r"
check "camera not installed" not_called "-s $PHONE install"
end

begin "install: both apps but only the tablet connected → fail before installing anything"
device "$TAB" device "Lenovo TB328FU"
run "$SCRIPTS/install.sh"
check "non-zero" rc_nonzero
check "says no camera" out_has "no camera phone connected"
check "nothing installed" no_install
end

begin "install: INSTALL_FAILED_UPDATE_INCOMPATIBLE → non-zero, loud, never uninstalls"
device "$TAB" device "Lenovo TB328FU"
printf '%s\n' "Performing Streamed Install" \
  "adb: failed to install kopernikadr-remote-release.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package pl.slava.kopernikadr.remote signatures do not match newer version; ignoring!]" \
  > "$T/state/install.$TAB"
run "$SCRIPTS/install.sh" --remote-only
check "non-zero" rc_nonzero
check "reason shown" out_has "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE"
check "signature text" out_has "signature differs — NOT uninstalling; uninstalling would delete the app's data (frames/projects)"
check "no uninstall call" not_called "uninstall"
check "no pm clear call" not_called "pm clear"
end

begin "install: INSTALL_FAILED_VERSION_DOWNGRADE → non-zero"
device "$PHONE" device "moto g05"
echo "adb: failed to install x.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 1 is older than current 2]" \
  > "$T/state/install.$PHONE"
run "$SCRIPTS/install.sh" --camera-only --variant probe
check "non-zero" rc_nonzero
check "reason shown" out_has "INSTALL_FAILED_VERSION_DOWNGRADE"
check "downgrade text" out_has "NEWER versionCode"
check "no uninstall call" not_called "uninstall"
end

begin "install: any other Failure [ → non-zero and the reason"
device "$TAB" device "Lenovo TB328FU"
echo "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]" > "$T/state/install.$TAB"
run "$SCRIPTS/install.sh" --remote-only
check "non-zero" rc_nonzero
check "reason shown" out_has "INSTALL_FAILED_INSUFFICIENT_STORAGE"
end

begin "install: the first failure stops before the next device"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
echo "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: x]" > "$T/state/install.$PHONE"
run "$SCRIPTS/install.sh"
check "non-zero" rc_nonzero
check "tablet not attempted" not_called "-s $TAB install"
end

begin "install: no devices → fail"
run "$SCRIPTS/install.sh"
check "non-zero" rc_nonzero
check "message" out_has "no usable devices"
end

begin "install: an unauthorized device only → fail with a hint"
device "$TAB" unauthorized ""
run "$SCRIPTS/install.sh" --remote-only
check "non-zero" rc_nonzero
check "hint" out_has "accept the USB debugging prompt"
end

begin "install: several tablets → asks for --serial"
device "$TAB" device "Lenovo TB328FU"
device HA2FAKE002 device "Lenovo TB328FU"
run "$SCRIPTS/install.sh" --remote-only
check "non-zero" rc_nonzero
check "message" out_has "--serial"
check "nothing installed" no_install
end

begin "install: --variant probe applies to the camera only"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
run "$SCRIPTS/install.sh" --variant probe
check "fails without --camera-only" rc_nonzero
check "says why" out_has "the remote has no 'probe' build type"
check "nothing installed" no_install
run "$SCRIPTS/install.sh" --variant probe --camera-only
check "ok with --camera-only" rc_is 0
check "probe apk" called "-s $PHONE install -r $T/dist/kopernikadr-camera-probe.apk"
end

begin "install: a missing APK → fail with the build command"
device "$TAB" device "Lenovo TB328FU"
rm "$T/dist/kopernikadr-remote-release.apk"
run "$SCRIPTS/install.sh" --remote-only
check "non-zero" rc_nonzero
check "build hint" out_has "scripts/build.sh --remote-only --variant release"
check "nothing installed" no_install
end

begin "install: camera release next to the kid's probe build → warns, still installs"
device "$PHONE" device "moto g05"
echo "package:pl.slava.kopernikadr.camera.probe" > "$T/state/packages.$PHONE"
run "$SCRIPTS/install.sh" --camera-only
check "exit 0" rc_is 0
check "warning" out_has "also has pl.slava.kopernikadr.camera.probe"
end

# ---- build.sh (argument / keystore checks only; no Gradle runs here) ----------------------

begin "build: release without the keystore → fail with instructions, before Gradle"
run "$SCRIPTS/build.sh" --remote-only
check "non-zero" rc_nonzero
check "says what's missing" out_has "no release keystore properties at $T/no-such-keystore.properties"
check "keytool command" out_has "keytool\" -genkeypair"
check "backup advice" out_has "BACK IT UP"
check "no gradle" not_out_has_gradle
end

begin "build: keystore properties without keys → fail"
printf 'storeFile=release.jks\n' > "$T/ks.properties"
export KOPERNIKADR_KEYSTORE_PROPERTIES="$T/ks.properties"
run "$SCRIPTS/build.sh" --camera-only
check "non-zero" rc_nonzero
check "lists the missing keys" out_has "missing: storePassword keyAlias keyPassword"
end

begin "build: keystore file missing → fail"
printf 'storeFile=release.jks\nstorePassword=a\nkeyAlias=b\nkeyPassword=c\n' > "$T/ks.properties"
export KOPERNIKADR_KEYSTORE_PROPERTIES="$T/ks.properties"
run "$SCRIPTS/build.sh" --camera-only
check "non-zero" rc_nonzero
check "message" out_has "storeFile not found: $T/release.jks"
end

begin "build: remote has no probe variant"
run "$SCRIPTS/build.sh" --variant probe
check "non-zero" rc_nonzero
check "message" out_has "the remote has no 'probe' build type"
end

begin "build: unknown variant / argument"
run "$SCRIPTS/build.sh" --variant beta
check "non-zero (variant)" rc_nonzero
run "$SCRIPTS/build.sh" --bogus
check "non-zero (arg)" rc_nonzero
end

# ---- collect-diagnostics.sh ---------------------------------------------------------------

begin "collect: pulls both apps' reports into diagnostics/<date>/<device>/"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
device PIXEL7 device "Pixel 7"
mkdir -p "$T/state/fs/$PHONE/sdcard/Android/data/pl.slava.kopernikadr.camera.probe/files/diag"
echo '{"caps":1}' > "$T/state/fs/$PHONE/sdcard/Android/data/pl.slava.kopernikadr.camera.probe/files/diag/caps-1.json"
mkdir -p "$T/state/fs/$TAB/sdcard/Android/data/pl.slava.kopernikadr.remote/files"
echo '{"r":1}' > "$T/state/fs/$TAB/sdcard/Android/data/pl.slava.kopernikadr.remote/files/remote-diag-1.json"
run "$SCRIPTS/collect-diagnostics.sh" --out "$T/diag"
day="$(date +%Y-%m-%d)"
check "exit 0" rc_is 0
check "camera probe report" test -f "$T/diag/$day/camera-moto_g05-$PHONE/pl.slava.kopernikadr.camera.probe/diag/caps-1.json"
check "remote report" test -f "$T/diag/$day/remote-Lenovo_TB328FU-$TAB/pl.slava.kopernikadr.remote/files/remote-diag-1.json"
check "asked for the camera debug dir too" called "-s $PHONE pull /sdcard/Android/data/pl.slava.kopernikadr.camera.debug/files/diag/"
check "asked for the remote debug dir too" called "-s $TAB pull /sdcard/Android/data/pl.slava.kopernikadr.remote.debug/files/"
check "no empty dir for a missing report" test ! -e "$T/diag/$day/camera-moto_g05-$PHONE/pl.slava.kopernikadr.camera.debug"
check "unknown device skipped" out_has "skipping PIXEL7"
check "unknown device not pulled" not_called "-s PIXEL7 pull"
end

begin "collect: --serial limits to one device; unknown --serial → fail"
device "$PHONE" device "moto g05"
device "$TAB" device "Lenovo TB328FU"
device PIXEL7 device "Pixel 7"
run "$SCRIPTS/collect-diagnostics.sh" --serial "$TAB" --out "$T/diag"
check "exit 0" rc_is 0
check "tablet pulled" called "-s $TAB pull"
check "phone not pulled" not_called "-s $PHONE pull"
run "$SCRIPTS/collect-diagnostics.sh" --serial PIXEL7 --out "$T/diag"
check "unknown serial fails" rc_nonzero
end

begin "collect: no devices → fail"
run "$SCRIPTS/collect-diagnostics.sh" --out "$T/diag"
check "non-zero" rc_nonzero
end

# ---- meminfo-sampler.sh -------------------------------------------------------------------

meminfo_fixture() { # <serial> <pkg-or-pid> <pss>
  cat > "$T/state/meminfo.$1.$2" <<EOF
Applications Memory Usage (in Kilobytes):
Uptime: 1 Realtime: 1

** MEMINFO in pid 4242 [$2] **
                   Pss  Private  Private  SwapPss      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap     1000      900        0        0     2000     4000     3000     1000
        TOTAL     $3     5000     1000        0    90000     4000     3000     1000

 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                         ------
           Java Heap:      100                            200

           TOTAL PSS:     $3            TOTAL RSS:    90000       TOTAL SWAP PSS:        0
EOF
}

sampler_setup() {
  device "$TAB" device "Lenovo TB328FU"
  meminfo_fixture "$TAB" pl.slava.kopernikadr.remote 150000
  meminfo_fixture "$TAB" 5001 60000
  meminfo_fixture "$TAB" 5002 1000
  cat > "$T/state/services.$TAB.pl.slava.kopernikadr.remote" <<'EOF'
ACTIVITY MANAGER SERVICES (dumpsys activity services)
  User 0 active services:
  * ServiceRecord{1a2b u0 pl.slava.kopernikadr.remote/org.chromium.content.app.SandboxedProcessService0:0}
    intent={cmp=com.google.android.webview/org.chromium.content.app.SandboxedProcessService0:0}
    packageName=com.google.android.webview
    app=ProcessRecord{3c4d 5001:com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0/u0ai1}
EOF
  # 5002 is another app's renderer: must not be counted when the services correlation works.
  printf '%s\n' " 4242 pl.slava.kopernikadr.remote" \
    " 5001 com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0" \
    " 5002 com.android.chrome:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:1" \
    > "$T/state/ps.$TAB"
}

csv_shape_ok() { # <csv> <expected app> <expected renderer>
  local f="$1" header rows bad
  header="$(head -n 1 "$f")"
  [[ "$header" == "ts,app_pss_kb,renderer_pss_kb,total_kb" ]] || return 1
  rows="$(tail -n +2 "$f" | wc -l | tr -d ' ')"
  [[ "$rows" -ge 1 ]] || return 1
  bad="$(tail -n +2 "$f" | grep -cvE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2},[0-9]+,[0-9]+,[0-9]+$')"
  [[ "$bad" == 0 ]] || return 1
  tail -n +2 "$f" | awk -F, -v a="$2" -v r="$3" '$2 != a || $3 != r || $4 != a + r { bad = 1 } END { exit bad }'
}

begin "sampler: CSV shape, renderer correlated via the app's services, summary with peaks"
sampler_setup
run "$SCRIPTS/meminfo-sampler.sh" --serial "$TAB" --package pl.slava.kopernikadr.remote \
  --seconds 1 --interval 0.2 --out "$T/mem.csv"
check "exit 0" rc_is 0
check "csv shape + values" csv_shape_ok "$T/mem.csv" 150000 60000
check "summary file" test -f "$T/mem.summary.txt"
check "peak total" grep -q "peak_total_kb=210000" "$T/mem.summary.txt"
check "peak renderer" grep -q "peak_renderer_pss_kb=60000" "$T/mem.summary.txt"
end

begin "sampler: falls back to every sandboxed_process when the services show none"
sampler_setup
rm "$T/state/services.$TAB.pl.slava.kopernikadr.remote"
run "$SCRIPTS/meminfo-sampler.sh" --serial "$TAB" --package pl.slava.kopernikadr.remote \
  --seconds 1 --interval 0.2 --out "$T/mem.csv"
check "exit 0" rc_is 0
check "csv values (5001 + 5002)" csv_shape_ok "$T/mem.csv" 150000 61000
check "fallback warned" out_has "summing every sandboxed_process"
end

begin "sampler: app not running → zeros, still a valid CSV"
device "$TAB" device "Lenovo TB328FU"
run "$SCRIPTS/meminfo-sampler.sh" --serial "$TAB" --package pl.slava.kopernikadr.remote \
  --seconds 1 --interval 0.2 --out "$T/mem.csv"
check "exit 0" rc_is 0
check "csv zeros" csv_shape_ok "$T/mem.csv" 0 0
end

begin "sampler: stop signal writes the summary"
sampler_setup
"$SCRIPTS/meminfo-sampler.sh" --serial "$TAB" --package pl.slava.kopernikadr.remote \
  --interval 0.2 --out "$T/mem.csv" > "$T/sampler.log" 2>&1 &
pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$T/mem.csv" && "$(wc -l < "$T/mem.csv")" -ge 3 ]] && break
  sleep 0.3
done
kill -TERM "$pid" 2> /dev/null
wait "$pid"
RC=$?
OUT="$(cat "$T/sampler.log")"
check "exit 0 after the signal" rc_is 0
check "summary written" grep -q "peak_total_kb=210000" "$T/mem.summary.txt"
check "csv shape" csv_shape_ok "$T/mem.csv" 150000 60000
end

begin "sampler: --serial and --package are required"
run "$SCRIPTS/meminfo-sampler.sh" --package x
check "non-zero" rc_nonzero
end

# ---- static checks ------------------------------------------------------------------------

begin "static: no script runs adb uninstall or pm clear"
# Command lines only: drop comments and quoted message text, then look for the verbs.
hits="$(cat "$SCRIPTS"/*.sh | sed -e 's/#.*$//' -e 's/"[^"]*"//g' -e "s/'[^']*'//g" | grep -nE '\buninstall\b|pm[[:space:]]+clear' || true)"
OUT="$hits"
check "no hits" test -z "$hits"
end

if command -v shellcheck > /dev/null 2>&1; then
  begin "static: shellcheck"
  run shellcheck -x "$SCRIPTS"/*.sh "$HERE/run.sh" "$HERE/fake-adb"
  check "clean" rc_is 0
  end
else
  echo "skip shellcheck (not installed)"
fi

echo
echo "passed: $PASS, failed: $FAIL"
if [[ "$FAIL" != 0 ]]; then
  for c in "${FAILED[@]}"; do echo "  - $c"; done
  exit 1
fi
