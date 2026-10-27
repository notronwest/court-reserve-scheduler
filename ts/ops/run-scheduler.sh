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
# Fleet recorder (D-0154): "started" / "finished", never in the booking's way. The 8:00
# run's self-heal window runs through the 8:30 catch-up (heal=30 in the daemon's JOBS),
# so a partial 8:00 is degraded, not a cut-off.
# shellcheck source=fleet-run.sh
. "$(dirname "$0")/fleet-run.sh"
fleet_run_start scheduler-daily "booking $DATE; self-heal through 8:30 catch-up"
LOG_OUT="$(mktemp)"
${WMPC_SCHEDULER_CMD:-npx tsx src/cli.ts schedule} "$DATE" 2>&1 | tee "$LOG_OUT"; rc=${PIPESTATUS[0]}
# Outcome: all booked -> ok; some booked, some left for the catch-up -> degraded;
# nothing booked because of an error -> failed.
BOOKED="$(sed -n 's/.*Done: booked \([0-9]*\), failed \([0-9]*\).*/\1/p' "$LOG_OUT" | tail -1)"
FAILED="$(sed -n 's/.*Done: booked \([0-9]*\), failed \([0-9]*\).*/\2/p' "$LOG_OUT" | tail -1)"
rm -f "$LOG_OUT"
if [ "$rc" -eq 0 ] && [ "${FAILED:-0}" -eq 0 ]; then OUTCOME=ok
elif [ "${BOOKED:-0}" -gt 0 ]; then OUTCOME=degraded
else OUTCOME=failed; fi
fleet_run_end scheduler-daily "$OUTCOME" "booked ${BOOKED:-0}, failed ${FAILED:-0} for $DATE"
# Heartbeat (daemon D-0052 §4) ONLY on a run that booked. A dead fetch or a
# zero-booked run exits non-zero and must stay silent — that silence is what
# the fleet watchdog turns into an alarm.
HB="${WMPC_DAEMON_DIR:-$HOME/data/web/wmpc/projects/daemon}/infrastructure/heartbeat/heartbeat.sh"
[ "$rc" -eq 0 ] && [ -f "$HB" ] && bash "$HB" scheduler-daily "booked $DATE" 2>/dev/null
exit "$rc"
