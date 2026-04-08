#!/bin/bash
# Wrapper for launchd — runs the daily scheduling job.
# Logs to ~/Library/Logs/court_reserve/

set -e

LOG_DIR="$HOME/Library/Logs/court_reserve"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/scheduler_$(date +%Y-%m-%d).log"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Court Reserve Scheduler $(date) ===" >> "$LOG" 2>&1

source "$SCRIPT_DIR/venv/bin/activate"

# Run with --book so it posts to Discord and waits for approval
python "$SCRIPT_DIR/run.py" --book >> "$LOG" 2>&1

echo "=== Done $(date) ===" >> "$LOG" 2>&1
