#!/bin/bash
# Run scheduler sequentially for a range of dates
# Each run waits for Discord approval before moving to the next day

cd /Users/notronwest/data/court_reserve_scheduling
source venv/bin/activate

DATES=(
  "4/13/2026"
  "4/14/2026"
  "4/15/2026"
  "4/16/2026"
  "4/17/2026"
  "4/18/2026"
  "4/19/2026"
  "4/20/2026"
  "4/21/2026"
  "4/22/2026"
)

for DATE in "${DATES[@]}"; do
  echo ""
  echo "════════════════════════════════════════════════════"
  echo "  Starting: $DATE"
  echo "════════════════════════════════════════════════════"
  python run.py "$DATE" --book
  echo ""
  echo "  ✓ Completed: $DATE"
  sleep 3
done

echo ""
echo "All dates complete."
