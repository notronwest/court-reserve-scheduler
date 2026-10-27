#!/usr/bin/env bash
# launchd wrapper: the 8:30 AM catch-up (TS). Walks today..today+14 and
# re-books any date the 8:00 daily run left empty or never finished (#50).
# Thin days are reported to Discord, never refilled.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
# Fleet recorder (D-0154): "started" / "finished", never in the booking's way.
# shellcheck source=fleet-run.sh
. "$(dirname "$0")/fleet-run.sh"
fleet_run_start scheduler-catch-up "horizon scan and re-book"
${WMPC_CATCHUP_CMD:-npx tsx src/cli.ts catch-up --book}; rc=$?
# The CLI exits non-zero on an unreadable day or a failed re-book.
if [ "$rc" -eq 0 ]; then fleet_run_end scheduler-catch-up ok "horizon scanned"
else fleet_run_end scheduler-catch-up failed "exit $rc"; fi
# Heartbeat (daemon D-0052 §4) ONLY on a completed run — a fetch that stayed
# dead or a failed re-book exits non-zero and stays silent, so the fleet
# watchdog alarms instead of trusting Discord to be read.
HB="${WMPC_DAEMON_DIR:-$HOME/data/web/wmpc/projects/daemon}/infrastructure/heartbeat/heartbeat.sh"
[ "$rc" -eq 0 ] && [ -f "$HB" ] && bash "$HB" scheduler-catch-up "horizon scanned" 2>/dev/null
exit "$rc"
