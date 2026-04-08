#!/bin/bash
# Wrapper for launchd — runs the weekly history fetch.
# Logs to ~/Library/Logs/court_reserve/

set -e

LOG_DIR="$HOME/Library/Logs/court_reserve"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/history_$(date +%Y-%m-%d).log"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== History Fetch $(date) ===" >> "$LOG" 2>&1

source "$SCRIPT_DIR/venv/bin/activate"

python "$SCRIPT_DIR/fetch_history.py" >> "$LOG" 2>&1

echo "=== Done $(date) ===" >> "$LOG" 2>&1
