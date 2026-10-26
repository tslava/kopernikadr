#!/usr/bin/env bash
# Pulls the probe/diagnostics reports from the connected devices (read-only, nothing is changed
# on the device) into diagnostics/<YYYY-MM-DD>/<kind>-<model>-<serial>/<package>/ (git-ignored):
#   camera phone: /sdcard/Android/data/pl.slava.kopernikadr.camera{.probe,.debug}/files/diag/
#   tablet:       /sdcard/Android/data/pl.slava.kopernikadr.remote{,.debug}/files/
#
#   scripts/collect-diagnostics.sh [--serial S] [--allow-emulator] [--out DIR]
#
# Without --serial: every known device (unknown models are skipped with a warning).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

serial=""
allow_emulator=0
out_root="$DIAG_ROOT"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial)
      [[ $# -ge 2 ]] || die "--serial needs a value"
      serial="$2"
      shift
      ;;
    --serial=*) serial="${1#--serial=}" ;;
    --allow-emulator) allow_emulator=1 ;;
    --out)
      [[ $# -ge 2 ]] || die "--out needs a directory"
      out_root="$2"
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

resolve_adb
scan_devices "$serial"
[[ "$(device_count)" -gt 0 ]] || die "no usable devices connected."

day="$(date +%Y-%m-%d)"
collected=0

# pull_dir <serial> <remote dir> <local dir> — returns 1 if the dir isn't on the device.
pull_dir() {
  local serial="$1" src="$2" dst="$3" out
  mkdir -p "$dst"
  if out="$(adb_s "$serial" pull "$src" "$dst" 2>&1)"; then
    printf '%s\n' "$out" | tail -n 1 | sed 's/^/     /' >&2
    return 0
  fi
  rmdir "$dst" 2> /dev/null || true
  return 1
}

for ((i = 0; i < ${#DEV_SERIALS[@]}; i++)); do
  s="${DEV_SERIALS[$i]}"
  model="${DEV_MODELS[$i]}"
  if [[ -n "$serial" ]]; then
    kind="$(app_kind_of_index "$i" "$allow_emulator")" || exit 1
  else
    case "${DEV_KINDS[$i]}" in
      camera | remote) kind="${DEV_KINDS[$i]}" ;;
      emulator)
        if [[ "$allow_emulator" == 1 ]]; then kind=remote; else
          warn "skipping emulator $s (pass --allow-emulator)"
          continue
        fi
        ;;
      *)
        warn "skipping $s: unknown model \"$model\""
        continue
        ;;
    esac
  fi
  dest="$out_root/$day/$kind-$(sanitize "$model")-$(sanitize "$s")"
  info "$kind $s (\"$model\") → $dest"
  case "$kind" in
    camera) pkgs=("$CAMERA_PACKAGE.probe" "$CAMERA_PACKAGE.debug") ;;
    remote) pkgs=("$REMOTE_PACKAGE" "$REMOTE_PACKAGE.debug") ;;
  esac
  for pkg in "${pkgs[@]}"; do
    if [[ "$kind" == camera ]]; then
      src="/sdcard/Android/data/$pkg/files/diag/"
    else
      src="/sdcard/Android/data/$pkg/files/"
    fi
    if pull_dir "$s" "$src" "$dest/$pkg"; then
      collected=$((collected + 1))
      ok "$pkg: $src"
    else
      info "$pkg: nothing at $src"
    fi
  done
  rmdir "$dest" 2> /dev/null || true
done

if [[ "$collected" == 0 ]]; then
  warn "no reports found on any device."
else
  ok "collected $collected report dir(s) under ${out_root%/}/$day/"
fi
