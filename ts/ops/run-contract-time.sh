#!/usr/bin/env bash
# launchd wrapper: the hourly Contract Time 48h / 24h court check (TS, scheduler#137).
#
# DRY until Ron presses the approval card for the two owner emails: without --live AND
# state/contract-time-approved.json the job only lists what it WOULD email or release.
# To go live, add --live below (and create the approval file) — nothing else changes.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
npx tsx src/cli.ts contract-time; rc=$?
# Heartbeat (daemon D-0052 §4) ONLY on a clean run; a failed read, release or send exits non-zero
# and stays silent so the fleet watchdog raises it.
HB="${WMPC_DAEMON_DIR:-$HOME/data/web/wmpc/projects/daemon}/infrastructure/heartbeat/heartbeat.sh"
[ "$rc" -eq 0 ] && [ -f "$HB" ] && bash "$HB" scheduler-contract-time "contract time checks ran" 2>/dev/null
exit "$rc"
