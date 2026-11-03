# shellcheck shell=bash
# Shared helpers for scripts/*.sh. Source it; don't run it. Written for macOS /bin/bash 3.2
# (no associative arrays, no mapfile, guarded empty-array expansions).
#
# Safety rule for every script here: never `adb uninstall`, never `pm clear`. Uninstalling or
# clearing an app deletes its data (the camera's frames, the remote's projects).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${KOPERNIKADR_DIST_DIR:-$REPO_ROOT/dist}"
DIAG_ROOT="$REPO_ROOT/diagnostics"
KEYSTORE_PROPERTIES="${KOPERNIKADR_KEYSTORE_PROPERTIES:-$HOME/.kopernikadr/keystore.properties}"

CAMERA_PACKAGE="pl.slava.kopernikadr.camera"
REMOTE_PACKAGE="pl.slava.kopernikadr.remote"

# ---- output -------------------------------------------------------------------------------

if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\033[1;31m'
  C_YEL=$'\033[1;33m'
  C_GRN=$'\033[1;32m'
  C_BLD=$'\033[1m'
  C_OFF=$'\033[0m'
else
  C_RED="" C_YEL="" C_GRN="" C_BLD="" C_OFF=""
fi

info() { printf '%s==>%s %s\n' "$C_BLD" "$C_OFF" "$*" >&2; }
ok() { printf '%sOK:%s %s\n' "$C_GRN" "$C_OFF" "$*" >&2; }
warn() { printf '%sWARNING:%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die() {
  printf '%sERROR:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2
  shift
  local line
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}

# A loud multi-line block (first argument is the headline).
banner() {
  local bar="!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  printf '\n%s%s\n!!! %s\n' "$C_RED" "$bar" "$1" >&2
  shift
  local line
  for line in "$@"; do printf '!!! %s\n' "$line" >&2; done
  printf '%s%s\n\n' "$bar" "$C_OFF" >&2
}

# ---- naming -------------------------------------------------------------------------------

# package_for <camera|remote> <release|probe|debug>
package_for() {
  local base
  case "$1" in
    camera) base="$CAMERA_PACKAGE" ;;
    remote) base="$REMOTE_PACKAGE" ;;
    *) die "package_for: unknown app '$1'" ;;
  esac
  case "$2" in
    release) echo "$base" ;;
    probe | debug) echo "$base.$2" ;;
    *) die "package_for: unknown variant '$2'" ;;
  esac
}

# apk_path <camera|remote> <variant> — the file build.sh writes and install.sh reads.
apk_path() { echo "$DIST_DIR/kopernikadr-$1-$2.apk"; }

capitalize() { printf '%s%s' "$(printf '%s' "${1:0:1}" | tr '[:lower:]' '[:upper:]')" "${1:1}"; }

# Keeps a string safe for a directory name.
sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

# validate_variant <app> <variant>
validate_variant() {
  case "$2" in
    release | debug) ;;
    probe) [[ "$1" == camera ]] || die "the remote has no 'probe' build type (only release|debug)." \
      "Use --camera-only with --variant probe." ;;
    *) die "unknown --variant '$2' (release|probe|debug)" ;;
  esac
}

# ---- keystore -----------------------------------------------------------------------------

# prop_value <file> <key> — a plain `key=value` line (no Java escapes, which we don't use).
prop_value() {
  sed -n "s/^[[:space:]]*$2[[:space:]]*[=:][[:space:]]*//p" "$1" | tail -n 1 | tr -d '\r'
}

keystore_help() {
  cat >&2 <<EOF

Release builds must be signed with the one Kopernikadr release key. Create it once
(see README → "Release keystore"), then BACK IT UP:

  mkdir -p ~/.kopernikadr && chmod 700 ~/.kopernikadr
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" -genkeypair -v \\
    -keystore ~/.kopernikadr/upload.jks -alias upload \\
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Kopernikadr"
  # then ~/.kopernikadr/keystore.properties:
  storeFile=upload.jks
  storePassword=...
  keyAlias=upload
  keyPassword=...

Expected properties file: $KEYSTORE_PROPERTIES
(override with KOPERNIKADR_KEYSTORE_PROPERTIES=/path/to/keystore.properties)
EOF
}

# Validates the keystore properties (the same rules as the Gradle loaders) and exports
# KOPERNIKADR_KEYSTORE_PROPERTIES with an absolute path, so Gradle reads the same file.
require_keystore() {
  local f="$KEYSTORE_PROPERTIES" key store missing=""
  if [[ ! -f "$f" ]]; then
    printf '%sERROR:%s no release keystore properties at %s\n' "$C_RED" "$C_OFF" "$f" >&2
    keystore_help
    exit 1
  fi
  for key in storeFile storePassword keyAlias keyPassword; do
    [[ -n "$(prop_value "$f" "$key")" ]] || missing="$missing $key"
  done
  [[ -z "$missing" ]] || die "$f: missing:$missing"
  store="$(prop_value "$f" storeFile)"
  [[ "$store" == /* ]] || store="$(cd "$(dirname "$f")" && pwd)/$store"
  [[ -f "$store" ]] || die "$f: storeFile not found: $store"
  KOPERNIKADR_KEYSTORE_PROPERTIES="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
  export KOPERNIKADR_KEYSTORE_PROPERTIES
}

# ---- adb ----------------------------------------------------------------------------------

# $ADB, else `adb` on PATH, else the SDK's platform-tools.
resolve_adb() {
  if [[ -n "${ADB:-}" ]]; then
    [[ -x "$ADB" ]] || die "ADB=$ADB is not executable"
  elif command -v adb > /dev/null 2>&1; then
    ADB="$(command -v adb)"
  elif [[ -x "${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb" ]]; then
    ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
  else
    die "adb not found (looked at \$ADB, PATH and ~/Library/Android/sdk/platform-tools/adb)"
  fi
}

# Every device command goes through here: always `adb -s <serial>`.
adb_s() {
  local serial="$1"
  shift
  "$ADB" -s "$serial" "$@"
}

# adb shell output without the CR some adb versions add.
adb_shell() {
  local serial="$1"
  shift
  adb_s "$serial" shell "$@" | tr -d '\r'
}

# ---- devices ------------------------------------------------------------------------------
#
# scan_devices fills parallel arrays DEV_SERIALS / DEV_MODELS / DEV_KINDS with the usable
# (state "device") devices. Kind by ro.product.model substring, case-insensitive:
#   *g05*   → camera   (moto g05, the kid's phone)
#   *TB328* → remote   (Lenovo Tab M10 3rd gen, TB328FU)
#   an emulator whose AVD is kopernikadr-tab or whose model is sdk_gphone* → emulator
#     (counts as a remote only with --allow-emulator; for testing)
#   anything else → unknown (never installed to)

DEV_SERIALS=()
DEV_MODELS=()
DEV_KINDS=()

kind_for() { # <model> <is_emulator 0|1> <avd>
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  if [[ "$2" == 1 ]]; then
    if [[ "$3" == kopernikadr-tab || "$lower" == sdk_gphone* ]]; then echo emulator; else echo unknown; fi
    return
  fi
  case "$lower" in
    *g05*) echo camera ;;
    *tb328*) echo remote ;;
    *) echo unknown ;;
  esac
}

# scan_devices [only_serial]
scan_devices() {
  local only="${1:-}" out line serial state model qemu avd emu kind seen=0
  DEV_SERIALS=()
  DEV_MODELS=()
  DEV_KINDS=()
  out="$("$ADB" devices -l)" || die "'adb devices -l' failed"
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in "" | "List of devices"* | "* "*) continue ;; esac
    serial="${line%%[[:space:]]*}"
    state="$(printf '%s\n' "$line" | awk '{print $2}')"
    [[ -z "$only" || "$serial" == "$only" ]] || continue
    seen=1
    if [[ "$state" != device ]]; then
      case "$state" in
        unauthorized) warn "$serial is unauthorized: unlock it and accept the USB debugging prompt." ;;
        *) warn "$serial is '$state', skipping." ;;
      esac
      continue
    fi
    model="$(adb_shell "$serial" getprop ro.product.model)"
    qemu="$(adb_shell "$serial" getprop ro.boot.qemu)"
    emu=0
    if [[ "$serial" == emulator-* || "$qemu" == 1 ]]; then emu=1; fi
    avd=""
    if [[ "$emu" == 1 ]]; then avd="$(adb_shell "$serial" getprop ro.boot.qemu.avd_name)"; fi
    kind="$(kind_for "$model" "$emu" "$avd")"
    DEV_SERIALS+=("$serial")
    DEV_MODELS+=("$model")
    DEV_KINDS+=("$kind")
  done <<< "$out"
  if [[ -n "$only" && "$seen" == 0 ]]; then
    die "device $only is not connected (see 'adb devices -l')."
  fi
}

device_count() { echo "${#DEV_SERIALS[@]}"; }

describe_devices() {
  local i
  for ((i = 0; i < ${#DEV_SERIALS[@]}; i++)); do
    printf '  %s  model="%s"  kind=%s\n' "${DEV_SERIALS[$i]}" "${DEV_MODELS[$i]}" "${DEV_KINDS[$i]}" >&2
  done
}

# app_kind_of_index <i> <allow_emulator 0|1> → camera|remote, or dies (unknown, or an emulator
# without --allow-emulator).
app_kind_of_index() {
  local i="$1" allow="$2"
  case "${DEV_KINDS[$i]}" in
    camera | remote) echo "${DEV_KINDS[$i]}" ;;
    emulator)
      [[ "$allow" == 1 ]] || die "${DEV_SERIALS[$i]} is an emulator (model \"${DEV_MODELS[$i]}\")." \
        "Pass --allow-emulator to treat it as the tablet (testing only)."
      echo remote
      ;;
    *) die "${DEV_SERIALS[$i]}: unknown model \"${DEV_MODELS[$i]}\"." \
      "Known: model containing 'g05' (camera phone) or 'TB328' (tablet)." ;;
  esac
}

# find_device <camera|remote> <allow_emulator 0|1> — after scan_devices. Sets FOUND_SERIAL and
# FOUND_MODEL, or dies: no such device, several of them, or any unknown device connected (we
# don't guess with a stranger plugged in; use --serial).
FOUND_SERIAL=""
FOUND_MODEL=""
find_device() {
  local want="$1" allow="$2" i hits=0 unknown="" skipped=""
  FOUND_SERIAL=""
  FOUND_MODEL=""
  [[ "${#DEV_SERIALS[@]}" -gt 0 ]] || die "no usable devices connected (adb devices -l shows none in state 'device')."
  for ((i = 0; i < ${#DEV_SERIALS[@]}; i++)); do
    case "${DEV_KINDS[$i]}" in
      unknown) unknown="$unknown ${DEV_SERIALS[$i]}(\"${DEV_MODELS[$i]}\")" ;;
      emulator)
        if [[ "$allow" == 1 && "$want" == remote ]]; then
          hits=$((hits + 1))
          FOUND_SERIAL="${DEV_SERIALS[$i]}"
          FOUND_MODEL="${DEV_MODELS[$i]}"
        elif [[ "$allow" != 1 ]]; then
          skipped="$skipped ${DEV_SERIALS[$i]}"
        fi
        ;;
      "$want")
        hits=$((hits + 1))
        FOUND_SERIAL="${DEV_SERIALS[$i]}"
        FOUND_MODEL="${DEV_MODELS[$i]}"
        ;;
    esac
  done
  [[ -z "$unknown" ]] || die "unknown device(s) connected:$unknown." \
    "Known: model containing 'g05' (camera phone) or 'TB328' (tablet)." \
    "Disconnect the others, or pick a device with --serial <serial>."
  [[ -z "$skipped" ]] || warn "ignoring emulator(s)$skipped (pass --allow-emulator to use one as the tablet)."
  if [[ "$hits" == 0 ]]; then
    case "$want" in
      camera) die "no camera phone connected (a model containing 'g05')." "Connected:" "$(describe_devices 2>&1)" ;;
      remote) die "no tablet connected (a model containing 'TB328')." "Connected:" "$(describe_devices 2>&1)" ;;
    esac
  fi
  [[ "$hits" == 1 ]] || die "several $want devices connected; pick one with --serial <serial>." \
    "$(describe_devices 2>&1)"
}
