#!/usr/bin/env bash
# launchd wrapper: the always-on Discord listener (TS). launchd runs with a
# minimal PATH, so we add Homebrew's bin (node/npx live there) and cd into ts/.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."   # -> ts/
exec npx tsx src/discord/listener.ts
