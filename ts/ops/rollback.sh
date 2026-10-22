#!/usr/bin/env bash
# Restore the Python launchd jobs from the backup cutover.sh made. Use this to
# revert the TS cutover in ~30 seconds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# D-0202: the Python recommender knows only weekly patterns. Rolling back while any
# active standing row runs every other week would book it EVERY week, so refuse.
# Reads the last-good fixed-events cache the TS scheduler writes every run, plus the
# policy.json seed; a row whose `until` is on or before today is retired and ignored.
if ! python3 - "$ROOT" <<'PY'
import json, os, sys, datetime
root = sys.argv[1]
today = datetime.date.today().isoformat()
state = os.environ.get("CR_STATE_DIR", os.path.join(root, "state"))
rows = []
for path, pick in (
    (os.path.join(state, "fixed-events.json"), lambda d: d.get("events", [])),
    (os.path.join(root, "policy.json"), lambda d: (d.get("fixed_events") or {}).get("events", [])),
):
    try:
        with open(path) as f:
            rows += pick(json.load(f))
    except (OSError, ValueError):
        pass
bad = [r for r in rows
       if str(r.get("every_weeks") or 1) != "1"
       and not (r.get("until") and str(r["until"])[:10] <= today)]
if bad:
    print("Refusing to roll back: the Python scheduler would book these every-other-week")
    print("standing sessions EVERY week:")
    for r in bad:
        print("  - %s (%s %s)" % (r.get("name"), r.get("day_of_week"), r.get("start_time")))
    print("Retire them (set `until`) or switch them to weekly first, then re-run.")
    sys.exit(1)
PY
then
  exit 1
fi

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
