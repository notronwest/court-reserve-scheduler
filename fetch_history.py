"""
Fetches the 3-month historical reservations report and saves it locally.
Designed to run weekly via cron / launchd.

Usage:
    python fetch_history.py                  # last 90 days → today
    python fetch_history.py --months 3       # explicit window
"""

import argparse
import json
import os
from datetime import date, timedelta
from pathlib import Path

from cr_client import browser_session, fetch_schedule

HISTORY_DIR = Path(__file__).parent / "history"


def fetch_history(months: int = 3):
    HISTORY_DIR.mkdir(exist_ok=True)

    end_date   = date.today()
    start_date = end_date - timedelta(days=months * 30)

    start_str = start_date.strftime("%-m/%-d/%Y")
    end_str   = end_date.strftime("%-m/%-d/%Y")

    print(f"Fetching history: {start_str} → {end_str} ({months} months)...")

    with browser_session() as page:
        items = fetch_schedule(start_str, end_str, page=page)

    print(f"  {len(items)} records fetched.")

    # Save with datestamp so we keep a rolling archive
    filename = HISTORY_DIR / f"history_{end_date.strftime('%Y-%m-%d')}.json"
    with open(filename, "w") as f:
        json.dump(items, f, indent=2)
    print(f"  Saved: {filename}")

    # Also overwrite the canonical "latest" file for easy access
    latest = HISTORY_DIR / "history_latest.json"
    with open(latest, "w") as f:
        json.dump(items, f, indent=2)
    print(f"  Updated: {latest}")

    # Prune files older than 60 days
    cutoff = date.today() - timedelta(days=60)
    for old in HISTORY_DIR.glob("history_*.json"):
        if old.name == "history_latest.json":
            continue
        try:
            file_date = date.fromisoformat(old.stem.replace("history_", ""))
            if file_date < cutoff:
                old.unlink()
                print(f"  Pruned old file: {old.name}")
        except ValueError:
            pass

    return items


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--months", type=int, default=3)
    args = parser.parse_args()
    fetch_history(args.months)
