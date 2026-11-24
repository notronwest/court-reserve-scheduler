#!/usr/bin/env bash
# launchd wrapper: the hourly Contract Time 48h / 24h court check (TS, scheduler#137).
#
# LIVE since Ron's approval of the two owner emails and the court release (2026-11-23,
# approval 57b10aa3-30dd-445a-974b-cb3edf91a782; state/contract-time-approved.json is on the mini).
# The job needs BOTH --live (below) AND that approval file; without either it only lists what it
# WOULD email or release.
set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
npx tsx src/cli.ts contract-time --live; rc=$?
# Heartbeat (daemon D-0052 §4) ONLY on a clean run; a failed read, release or send exits non-zero
# and stays silent so the fleet watchdog raises it.
HB="${WMPC_DAEMON_DIR:-$HOME/data/web/wmpc/projects/daemon}/infrastructure/heartbeat/heartbeat.sh"
[ "$rc" -eq 0 ] && [ -f "$HB" ] && bash "$HB" scheduler-contract-time "contract time checks ran" 2>/dev/null
exit "$rc"
