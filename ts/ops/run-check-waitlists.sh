#!/usr/bin/env bash
# launchd wrapper: the waitlist scan (TS), fired at 9/11/13/15/17 daily.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
exec npx tsx src/jobs/checkWaitlists.ts
