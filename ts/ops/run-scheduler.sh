#!/usr/bin/env bash
# launchd wrapper: the daily 8 AM scheduler (TS). Generates recommendations for
# the 14-day-out date, posts them to Discord, and writes pending_approval.json
# for the listener to book on approval — replacing the Python run.py flow.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
# BSD date: zero-padded M/D is fine — cli.ts parses MM/DD/YYYY.
DATE="$(date -v+14d '+%m/%d/%Y')"
exec npx tsx src/cli.ts schedule "$DATE"
