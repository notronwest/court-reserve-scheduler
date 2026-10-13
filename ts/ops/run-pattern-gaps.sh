#!/usr/bin/env bash
# launchd wrapper: the 8:45 AM standing-session check (TS). Asks, per SESSION rather
# than per day, whether every standing pattern actually has its occurrence in the next
# 14 days — the question catch-up cannot answer, because it measures a day's court-hours
# and a healthy-looking day can be missing one session (Ron, 2026-10-13).
#
# Runs AFTER the 8:00 daily booker and the 8:30 catch-up, so it only ever sees what those
# two left behind. --fix books what it can; what it cannot (no event attached, every court
# busy, a booking that failed) goes to Discord as an alarm.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
npx tsx src/cli.ts pattern-gaps --fix; rc=$?
# Heartbeat (daemon D-0052 §4) ONLY on a clean run. A run that left something open exits
# non-zero and stays SILENT here on purpose: the fleet watchdog turns that silence into an
# alarm, so a missing session is caught even if nobody reads Discord.
HB="${WMPC_DAEMON_DIR:-$HOME/data/web/wmpc/projects/daemon}/infrastructure/heartbeat/heartbeat.sh"
[ "$rc" -eq 0 ] && [ -f "$HB" ] && bash "$HB" scheduler-pattern-gaps "horizon has every standing session" 2>/dev/null
exit "$rc"
