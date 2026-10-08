#!/usr/bin/env bash
# launchd wrapper: the daily 8 AM scheduler (TS). Generates recommendations for
# the 14-day-out date and books them directly (auto-book), posting a Discord
# confirmation. The 8:30 catch-up (run-catch-up.sh) re-books anything this
# run misses.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
# BSD date: zero-padded M/D is fine — cli.ts parses MM/DD/YYYY.
DATE="$(date -v+14d '+%m/%d/%Y')"
npx tsx src/cli.ts schedule "$DATE"; rc=$?
# Heartbeat (daemon D-0052 §4) ONLY on a run that booked. A dead fetch or a
# zero-booked run exits non-zero and must stay silent — that silence is what
# the fleet watchdog turns into an alarm.
HB="${WMPC_DAEMON_DIR:-$HOME/data/web/wmpc/projects/daemon}/infrastructure/heartbeat/heartbeat.sh"
[ "$rc" -eq 0 ] && [ -f "$HB" ] && bash "$HB" scheduler-daily "booked $DATE" 2>/dev/null
exit "$rc"
