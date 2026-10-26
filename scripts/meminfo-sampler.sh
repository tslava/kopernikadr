#!/usr/bin/env bash
# Samples an app's memory about once a second while you use it:
#   app_pss_kb      — `dumpsys meminfo <package>` TOTAL PSS of the app process
#   renderer_pss_kb — TOTAL PSS of the app's WebView sandboxed renderer process(es)
#   total_kb        — the sum
#
#   scripts/meminfo-sampler.sh --serial S --package P [--seconds N] [--out file.csv]
#                              [--interval SEC]
#
# CSV columns: ts,app_pss_kb,renderer_pss_kb,total_kb (ts = local ISO time). Stops after N
# seconds, or on Ctrl-C; either way prints and writes <out>.summary.txt with the peaks.
# Default out: diagnostics/<YYYY-MM-DD>/meminfo-<package>-<HHMMSS>.csv. A process that isn't
# running counts as 0. Read-only on the device.
#
# Renderer: the app's own ServiceRecords in `dumpsys activity services <package>` name the
# sandboxed process (WebView renderers run as the app's external isolated service). If none is
# found there, it falls back to every `*sandboxed_process*` in `ps -A` and says so once.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }

serial=""
package=""
seconds=0
out=""
interval=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial | --package | --seconds | --out | --interval)
      [[ $# -ge 2 ]] || die "$1 needs a value"
      case "$1" in
        --serial) serial="$2" ;;
        --package) package="$2" ;;
        --seconds) seconds="$2" ;;
        --out) out="$2" ;;
        --interval) interval="$2" ;;
      esac
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done
[[ -n "$serial" && -n "$package" ]] || { usage >&2; die "--serial and --package are required"; }
[[ "$seconds" =~ ^[0-9]+$ ]] || die "--seconds must be a whole number"

resolve_adb
scan_devices "$serial"
[[ "$(device_count)" == 1 ]] || die "device $serial is not usable."

if [[ -z "$out" ]]; then
  out="$DIAG_ROOT/$(date +%Y-%m-%d)/meminfo-$(sanitize "$package")-$(date +%H%M%S).csv"
fi
mkdir -p "$(dirname "$out")"
summary="${out%.csv}.summary.txt"

# total_pss <dumpsys meminfo output on stdin> → kB, or 0. Matches the table's "TOTAL <pss>"
# row or the App Summary's "TOTAL PSS: <n>", whichever comes first.
total_pss() {
  awk '
    /TOTAL PSS:/ { for (i = 1; i < NF; i++) if ($i == "PSS:") { print $(i + 1); found = 1; exit } }
    /^[[:space:]]*TOTAL[[:space:]]+[0-9]+/ { print $2; found = 1; exit }
    END { if (!found) print 0 }'
}

# renderer_pids → RENDERER_PIDS (whitespace-separated). A global rather than $(...), so the
# fallback note shows once.
fallback_noted=0
RENDERER_PIDS=""
renderer_pids() {
  RENDERER_PIDS="$(adb_shell "$serial" dumpsys activity services "$package" |
    grep -oE 'ProcessRecord\{[0-9a-f]+ [0-9]+:[^ /}]*sandboxed_process[^ /}]*' |
    sed -E 's/^ProcessRecord\{[0-9a-f]+ ([0-9]+):.*/\1/' | sort -u)" || true
  if [[ -z "$RENDERER_PIDS" ]]; then
    RENDERER_PIDS="$(adb_shell "$serial" ps -A -o PID,NAME |
      awk '$2 ~ /sandboxed_process/ { print $1 }' | sort -u)" || true
    if [[ -n "$RENDERER_PIDS" && "$fallback_noted" == 0 ]]; then
      warn "renderer not found in the app's services; summing every sandboxed_process (close other WebView/Chrome apps)."
      fallback_noted=1
    fi
  fi
}

stop=0
trap 'stop=1' INT TERM

samples=0
peak_app=0
peak_renderer=0
peak_total=0
peak_ts=""
start_ts="$(date +%Y-%m-%dT%H:%M:%S)"
start=$SECONDS

write_summary() {
  {
    echo "package=$package serial=$serial"
    echo "from=$start_ts to=$(date +%Y-%m-%dT%H:%M:%S) samples=$samples"
    echo "peak_app_pss_kb=$peak_app"
    echo "peak_renderer_pss_kb=$peak_renderer"
    echo "peak_total_kb=$peak_total at $peak_ts"
    echo "csv=$out"
  } > "$summary"
  info "summary ($summary):"
  sed 's/^/     /' "$summary" >&2
}

echo "ts,app_pss_kb,renderer_pss_kb,total_kb" > "$out"
info "sampling $package on $serial → $out (Ctrl-C to stop)"

while [[ "$stop" == 0 ]]; do
  ts="$(date +%Y-%m-%dT%H:%M:%S)"
  app="$(adb_shell "$serial" dumpsys meminfo "$package" | total_pss)" || app=0
  renderer=0
  renderer_pids
  for pid in $RENDERER_PIDS; do
    [[ "$stop" == 0 ]] || break
    kb="$(adb_shell "$serial" dumpsys meminfo "$pid" | total_pss)" || kb=0
    renderer=$((renderer + kb))
  done
  [[ "$stop" == 0 ]] || break # an interrupted sample is incomplete: drop it
  total=$((app + renderer))
  echo "$ts,$app,$renderer,$total" >> "$out"
  samples=$((samples + 1))
  if ((app > peak_app)); then peak_app=$app; fi
  if ((renderer > peak_renderer)); then peak_renderer=$renderer; fi
  if ((total > peak_total)); then
    peak_total=$total
    peak_ts=$ts
  fi
  if [[ "$seconds" -gt 0 && $((SECONDS - start)) -ge "$seconds" ]]; then break; fi
  sleep "$interval" || true
done

write_summary
