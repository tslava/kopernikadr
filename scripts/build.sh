#!/usr/bin/env bash
# Builds the camera app and/or the tablet remote into dist/:
#   dist/kopernikadr-camera-<variant>.apk, dist/kopernikadr-remote-<variant>.apk
#
#   scripts/build.sh [--camera-only|--remote-only] [--variant release|probe|debug]
#
# Default variant: release. Release needs the keystore (~/.kopernikadr/keystore.properties, or
# KOPERNIKADR_KEYSTORE_PROPERTIES); without it this script refuses to build, because an unsigned
# release APK can't be installed. The remote has no probe build type.
# Remote: `npm run build` (Next static export) → `npx cap sync android` → Gradle.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

apps=(camera remote)
variant=release
while [[ $# -gt 0 ]]; do
  case "$1" in
    --camera-only) apps=(camera) ;;
    --remote-only) apps=(remote) ;;
    --variant)
      [[ $# -ge 2 ]] || die "--variant needs a value (release|probe|debug)"
      variant="$2"
      shift
      ;;
    --variant=*) variant="${1#--variant=}" ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

for app in "${apps[@]}"; do validate_variant "$app" "$variant"; done
if [[ "$variant" == release ]]; then
  require_keystore
  info "release signing: $KOPERNIKADR_KEYSTORE_PROPERTIES"
fi

task="assemble$(capitalize "$variant")"
mkdir -p "$DIST_DIR"

# Prints the signer certificate digest (if apksigner is around) so a key mix-up is visible.
print_signer() {
  local apk="$1" sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}" apksigner
  apksigner="$(find "$sdk/build-tools" -maxdepth 2 -name apksigner -type f 2> /dev/null | sort | tail -n 1)"
  [[ -n "$apksigner" ]] || return 0
  JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}" \
    "$apksigner" verify --print-certs "$apk" 2> /dev/null | grep -E 'certificate (DN|SHA-256)' | sed 's/^/     /' >&2 || true
}

# copy_apk <app> <outputs dir>
copy_apk() {
  local app="$1" outputs="$2" src dst
  src="$outputs/$variant/app-$variant.apk"
  dst="$(apk_path "$app" "$variant")"
  if [[ ! -f "$src" ]]; then
    if [[ -f "$outputs/$variant/app-$variant-unsigned.apk" ]]; then
      die "$app: Gradle produced an UNSIGNED $variant APK ($outputs/$variant/app-$variant-unsigned.apk)." \
        "Check $KEYSTORE_PROPERTIES and the signingConfig in the app's build.gradle."
    fi
    die "$app: expected APK not found: $src"
  fi
  cp "$src" "$dst"
  ok "$app $variant → ${dst#"$REPO_ROOT"/}"
  print_signer "$dst"
}

for app in "${apps[@]}"; do
  case "$app" in
    camera)
      info "camera: gradle :app:$task"
      "$REPO_ROOT/camera-android/gradlew-jbr" ":app:$task"
      copy_apk camera "$REPO_ROOT/camera-android/app/build/outputs/apk"
      ;;
    remote)
      info "remote: web build (next build)"
      (cd "$REPO_ROOT/remote" && npm run build)
      info "remote: npx cap sync android"
      (cd "$REPO_ROOT/remote" && npx cap sync android)
      info "remote: gradle :app:$task"
      "$REPO_ROOT/remote/android/gradlew-jbr" ":app:$task"
      copy_apk remote "$REPO_ROOT/remote/android/app/build/outputs/apk"
      ;;
  esac
done
