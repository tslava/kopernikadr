#!/usr/bin/env bash
# Builds the signed release AABs for Google Play into dist/:
#   dist/kopernikadr-camera-<versionName>-<versionCode>.aab, dist/kopernikadr-remote-<...>.aab
#
#   scripts/build-release.sh [--camera-only|--remote-only]
#
# Needs the upload key: ~/.kopernikadr/keystore.properties, or KOPERNIKADR_KEYSTORE_PROPERTIES=<file>
# (the same override the Gradle files read). Without it the script stops before building.
# Remote: fetch the segmenter model -> `npm run build` -> `npx cap sync android` -> Gradle bundleRelease.
# Then per AAB: jarsigner -verify, 16 KB ELF alignment of every .so, size. See docs/RELEASE.md.
# Env: KOPERNIKADR_ALLOW_UNSIGNED=1 builds without a key and skips the signature check (tests only).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

apps=(camera remote)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --camera-only) apps=(camera) ;;
    --remote-only) apps=(remote) ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

JBR="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
JARSIGNER="$JBR/bin/jarsigner"
unsigned_ok="${KOPERNIKADR_ALLOW_UNSIGNED:-0}"

if [[ "$unsigned_ok" == 1 ]]; then
  warn "KOPERNIKADR_ALLOW_UNSIGNED=1: building without a key, the AABs can NOT be uploaded."
else
  [[ -x "$JARSIGNER" ]] || die "jarsigner not found at $JARSIGNER (set JAVA_HOME to Android Studio's JBR)"
  require_keystore
  info "upload key: $KOPERNIKADR_KEYSTORE_PROPERTIES"
fi

# llvm-objdump: PATH, Android SDK NDK, or Xcode's toolchain.
find_objdump() {
  local c
  if c="$(command -v llvm-objdump 2> /dev/null)"; then echo "$c"; return; fi
  if c="$(xcrun -f llvm-objdump 2> /dev/null)"; then echo "$c"; return; fi
  c="$(find "${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk" -name llvm-objdump -type f 2> /dev/null | sort | tail -n 1)"
  [[ -n "$c" ]] && echo "$c"
}
OBJDUMP="$(find_objdump || true)"
[[ -n "$OBJDUMP" ]] || die "llvm-objdump not found (needed for the 16 KB alignment check)." \
  "Install Xcode command line tools or an Android NDK."

# check_alignment <aab>: every LOAD segment of every .so must have p_align >= 2**14.
check_alignment() {
  local aab="$1" tmp so bad=0 n=0 line exp
  tmp="$(mktemp -d)"
  unzip -q -o "$aab" '*.so' -d "$tmp" 2> /dev/null || true
  while IFS= read -r so; do
    n=$((n + 1))
    while IFS= read -r line; do
      exp="${line##*2\*\*}"
      if [[ "$exp" -lt 14 ]]; then
        warn "${so#"$tmp"/}: LOAD align 2**$exp (< 2**14)"
        bad=1
      fi
    done < <("$OBJDUMP" -p "$so" | awk '$1 == "LOAD" { for (i = 1; i <= NF; i++) if ($i == "align") print $(i + 1) }')
  done < <(find "$tmp" -name '*.so' -type f | sort)
  rm -rf "$tmp"
  if [[ "$n" -eq 0 ]]; then
    warn "$(basename "$aab"): no native libs found"
  elif [[ "$bad" -ne 0 ]]; then
    die "$(basename "$aab"): not 16 KB aligned (Play requires it for targetSdk 35+)."
  else
    ok "$(basename "$aab"): $n native libs, all LOAD segments aligned to >= 16 KB"
  fi
}

# verify_signature <aab>
verify_signature() {
  local aab="$1"
  if [[ "$unsigned_ok" == 1 ]]; then warn "$(basename "$aab"): signature check skipped"; return; fi
  "$JARSIGNER" -verify "$aab" > /dev/null 2>&1 || die "$(basename "$aab"): jarsigner -verify failed (unsigned or broken)." \
    "Check $KOPERNIKADR_KEYSTORE_PROPERTIES; run: jarsigner -verify -verbose $aab"
  ok "$(basename "$aab"): signature verified ($("$JARSIGNER" -verify -verbose:summary -certs "$aab" 2> /dev/null | grep -m1 -o 'CN=[^,)]*' || echo "cert"))"
}

# gradle_prop <gradle.properties> <key>
gradle_prop() { sed -n "s/^$2=//p" "$1" | tail -n 1 | tr -d '\r'; }

# finish <app> <android dir>
finish() {
  local app="$1" dir="$2" src dst code name
  src="$dir/app/build/outputs/bundle/release/app-release.aab"
  [[ -f "$src" ]] || die "$app: expected AAB not found: $src"
  name="$(gradle_prop "$dir/gradle.properties" APP_VERSION_NAME)"
  code="$(gradle_prop "$dir/gradle.properties" APP_VERSION_CODE)"
  mkdir -p "$DIST_DIR"
  dst="$DIST_DIR/kopernikadr-$app-$name-$code.aab"
  cp "$src" "$dst"
  verify_signature "$dst"
  check_alignment "$dst"
  OUTPUTS+=("$dst")
}

OUTPUTS=()
for app in "${apps[@]}"; do
  case "$app" in
    camera)
      info "camera: gradle :app:bundleRelease"
      "$REPO_ROOT/camera-android/gradlew-jbr" :app:bundleRelease
      finish camera "$REPO_ROOT/camera-android"
      ;;
    remote)
      info "remote: segmenter model (cached in ~/.kopernikadr/models)"
      (cd "$REPO_ROOT/remote" && node scripts/fetch-models.mjs)
      info "remote: web build (next build)"
      (cd "$REPO_ROOT/remote" && npm run build)
      info "remote: npx cap sync android"
      (cd "$REPO_ROOT/remote" && npx cap sync android)
      info "remote: gradle :app:bundleRelease"
      "$REPO_ROOT/remote/android/gradlew-jbr" :app:bundleRelease
      finish remote "$REPO_ROOT/remote/android"
      ;;
  esac
done

printf '\nRelease bundles:\n' >&2
for f in "${OUTPUTS[@]}"; do
  printf '  %s  (%s)\n' "$f" "$(du -h "$f" | cut -f1)" >&2
done
