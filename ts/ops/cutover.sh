#!/usr/bin/env bash
# Cut the four launchd jobs over from the Python scheduler to the TS one.
# Backs up each existing (Python) plist to ~/Library/LaunchAgents/.python-plist-backup
# so rollback.sh can restore it. Idempotent — safe to re-run.
#
# PREREQUISITES (do these first):
#   - courtreserve-api service is running (curl localhost:8787/health)
#   - ts deps installed (npm install) and ts/.env populated
#   - if the TS listener is running in the FOREGROUND, Ctrl-C it first, or you'll
#     end up with two listeners on the live channel (double bookings).
set -euo pipefail

LA="$HOME/Library/LaunchAgents"
OPS="$(cd "$(dirname "$0")" && pwd)"          # ts/ops
BACKUP="$LA/.python-plist-backup"
mkdir -p "$BACKUP" "$HOME/Library/Logs/court_reserve"

LABELS=(listener scheduler fetch-history check-waitlists)
for name in "${LABELS[@]}"; do
  label="com.whitemountain.$name"
  installed="$LA/$label.plist"
  new="$OPS/$label.plist"
  echo "── $label ──"
  launchctl unload "$installed" 2>/dev/null || true
  if [ -f "$installed" ] && [ ! -f "$BACKUP/$label.plist" ]; then
    cp "$installed" "$BACKUP/$label.plist"
    echo "  backed up Python plist → $BACKUP/$label.plist"
  fi
  cp "$new" "$installed"
  launchctl load "$installed"
  echo "  installed + loaded TS plist"
done

echo
echo "Loaded whitemountain jobs (pid  status  label):"
launchctl list | grep whitemountain || true
echo
echo "Listener should show a live pid. Tail it with:"
echo "  tail -f ~/Library/Logs/court_reserve/launchd_listener.log"
