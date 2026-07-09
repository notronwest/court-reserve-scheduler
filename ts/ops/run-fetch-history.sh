#!/usr/bin/env bash
# launchd wrapper: the Monday 7 AM attendance-history fetch (TS). Defaults to 3
# months, writing history/history_latest.json.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
exec npx tsx src/jobs/fetchHistory.ts
