#!/bin/bash
# Wrapper for launchd — runs the persistent Discord listener.
# KeepAlive=true in the plist ensures launchd restarts it if it exits.

set -e

LOG_DIR="$HOME/Library/Logs/court_reserve"
mkdir -p "$LOG_DIR"

# Project root is parent of scripts/
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

source "$SCRIPT_DIR/venv/bin/activate"

exec python "$SCRIPT_DIR/discord_listener.py"
