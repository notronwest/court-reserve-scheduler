#!/usr/bin/env bash
# Restore the Python launchd jobs from the backup cutover.sh made. Use this to
# revert the TS cutover in ~30 seconds.
set -euo pipefail

LA="$HOME/Library/LaunchAgents"
BACKUP="$LA/.python-plist-backup"

if ! ls "$BACKUP"/com.whitemountain.*.plist >/dev/null 2>&1; then
  echo "No backup found at $BACKUP — nothing to roll back."
  exit 1
fi

for f in "$BACKUP"/com.whitemountain.*.plist; do
  label="$(basename "$f" .plist)"
  installed="$LA/$label.plist"
  echo "── restoring $label (Python) ──"
  launchctl unload "$installed" 2>/dev/null || true
  cp "$f" "$installed"
  launchctl load "$installed"
done

echo
echo "Restored whitemountain jobs:"
launchctl list | grep whitemountain || true
