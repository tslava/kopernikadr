#!/usr/bin/env bash
# Installs the APKs from dist/ (scripts/build.sh) on the right devices, upgrading in place.
#
#   scripts/install.sh [--camera-only|--remote-only] [--variant release|probe|debug]
#                      [--serial S] [--allow-emulator]
#
# Device by ro.product.model substring: 'g05' → camera phone, 'TB328' → tablet (remote). Any
# unknown model connected → fail (pick a device with --serial). With --serial and no
# --*-only flag, installs the app that matches that device. Emulators (AVD kopernikadr-tab,
# model sdk_gphone*) count as the tablet only with --allow-emulator (testing).
#
# Always `adb -s <serial> install -r`. Any "Failure [" stops the script with a non-zero exit.
# It NEVER uninstalls and never clears app data: that would delete frames / projects.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

only=""
variant=release
serial=""
allow_emulator=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --camera-only) only=camera ;;
    --remote-only) only=remote ;;
    --variant)
      [[ $# -ge 2 ]] || die "--variant needs a value (release|probe|debug)"
      variant="$2"
      shift
      ;;
    --variant=*) variant="${1#--variant=}" ;;
    --serial)
      [[ $# -ge 2 ]] || die "--serial needs a value"
      serial="$2"
      shift
      ;;
    --serial=*) serial="${1#--serial=}" ;;
    --allow-emulator) allow_emulator=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

resolve_adb

# Resolve every target first; install nothing unless all of them are there.
targets_app=()
targets_serial=()
targets_model=()

if [[ -n "$serial" ]]; then
  scan_devices "$serial"
  [[ "$(device_count)" == 1 ]] || die "device $serial is not usable (see the warning above)."
  kind="$(app_kind_of_index 0 "$allow_emulator")" || exit 1
  if [[ -n "$only" && "$only" != "$kind" ]]; then
    die "--$only-only, but $serial (model \"${DEV_MODELS[0]}\") is the $kind device."
  fi
  targets_app=("$kind")
  targets_serial=("$serial")
  targets_model=("${DEV_MODELS[0]}")
else
  if [[ -n "$only" ]]; then wanted=("$only"); else wanted=(camera remote); fi
  for app in "${wanted[@]}"; do validate_variant "$app" "$variant"; done
  scan_devices
  for app in "${wanted[@]}"; do
    find_device "$app" "$allow_emulator"
    targets_app+=("$app")
    targets_serial+=("$FOUND_SERIAL")
    targets_model+=("$FOUND_MODEL")
  done
fi

for app in "${targets_app[@]}"; do
  validate_variant "$app" "$variant"
  apk="$(apk_path "$app" "$variant")"
  [[ -f "$apk" ]] || die "missing $apk" "Build it first: scripts/build.sh --$app-only --variant $variant"
done

# install_one <app> <serial> <model>
install_one() {
  local app="$1" serial="$2" model="$3" apk pkg out rc=0 reason
  apk="$(apk_path "$app" "$variant")"
  pkg="$(package_for "$app" "$variant")"
  if [[ "$app" == camera && "$variant" != probe ]] &&
    adb_shell "$serial" pm list packages "$CAMERA_PACKAGE.probe" | grep -qx "package:$CAMERA_PACKAGE.probe"; then
    warn "$serial also has $CAMERA_PACKAGE.probe: a separate app with its own frames." \
      "$pkg won't see them. Don't uninstall the probe build."
  fi
  info "$app: installing $pkg on $serial (\"$model\") — adb -s $serial install -r $(basename "$apk")"
  out="$(adb_s "$serial" install -r "$apk" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/     /' >&2
  if printf '%s' "$out" | grep -q 'Failure \['; then
    reason="$(printf '%s\n' "$out" | grep -o 'Failure \[[^]]*\]*' | head -n 1)"
    case "$reason" in
      *INSTALL_FAILED_UPDATE_INCOMPATIBLE*)
        banner "INSTALL FAILED on $serial (\"$model\"): $pkg" \
          "$reason" \
          "" \
          "The APK's signature differs — NOT uninstalling; uninstalling would delete the app's data (frames/projects)." \
          "Rebuild with the key the installed app was signed with (your ~/.kopernikadr backup)," \
          "then run this script again. If that key is truly lost, stop and decide by hand."
        ;;
      *INSTALL_FAILED_VERSION_DOWNGRADE*)
        banner "INSTALL FAILED on $serial (\"$model\"): $pkg" \
          "$reason" \
          "" \
          "The device has a NEWER versionCode than this APK (a downgrade)." \
          "Build the current version (or bump versionCode) and install again." \
          "NOT uninstalling and NOT forcing a downgrade (-d): both risk the app's data."
        ;;
      *)
        banner "INSTALL FAILED on $serial (\"$model\"): $pkg" \
          "$reason" \
          "" \
          "Nothing was uninstalled. Fix the cause above and run this script again."
        ;;
    esac
    exit 1
  fi
  if [[ "$rc" != 0 ]] || ! printf '%s' "$out" | grep -q 'Success'; then
    banner "INSTALL FAILED on $serial (\"$model\"): $pkg" "adb exited with $rc; output above." \
      "Nothing was uninstalled."
    exit 1
  fi
  ok "$pkg on $serial"
}

for ((i = 0; i < ${#targets_app[@]}; i++)); do
  install_one "${targets_app[$i]}" "${targets_serial[$i]}" "${targets_model[$i]}"
done
