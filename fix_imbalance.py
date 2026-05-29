#!/usr/bin/env python3
"""
fix_imbalance.py — Fix the AI / Intermediate imbalance for the next 14 days.

Rules applied:
  - Max 1 Advanced Intermediate per day
  - Target 2 Intermediate sessions per day (add if missing)
  - Never cancel an occurrence that has registered members
  - Vary AI start times across days (for pattern discovery)

Usage:
    venv/bin/python fix_imbalance.py             # dry run (shows what would change)
    venv/bin/python fix_imbalance.py --execute   # actually make the changes

    make fix-imbalance          # dry run
    make fix-imbalance-execute  # execute
"""

import argparse
import json
import logging
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

from cr_client import browser_session, fetch_schedule
from policy_loader import load_policy
from book_event import book_event, cancel_occurrence

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

POLICY        = load_policy()
APPROVED      = POLICY["approved_events"]          # str(id) -> {name, level}
COURTS        = POLICY["courts"]                   # str(id) -> {number, label}

# Approved event IDs by level
_BY_LEVEL = {info["level"]: eid for eid, info in APPROVED.items()}
AI_EVENT_ID   = int(_BY_LEVEL["Advanced Intermediate"])
INT_EVENT_ID  = int(_BY_LEVEL["Intermediate"])

# Court IDs in preference order (Court 4 preferred, then 1, 2, 3)
_COURT_IDS    = sorted(COURTS.keys(), key=lambda c: (COURTS[c]["number"] != 4, COURTS[c]["number"]))
PRIMARY_COURT_ID = int(_COURT_IDS[0])

# AI start-time rotation — vary across days to build pattern data
# Format: hour (24h). We rotate through these so each day gets a different slot.
AI_TIME_ROTATION = [9, 11, 13, 15, 17]   # 9am, 11am, 1pm, 3pm, 5pm

# Intermediate target and preferred times
INT_TARGET  = 2   # sessions per day
INT_TIMES   = [9, 11, 13, 15]  # candidate start hours


def _get_level(item: dict) -> str | None:
    eid = str(item.get("EventId", ""))
    return APPROVED[eid]["level"] if eid in APPROVED else None


def _court_free_at(items: list[dict], court_id: int, start: datetime, end: datetime) -> bool:
    """Return True if this court has no overlapping event."""
    for item in items:
        if str(item.get("CourtId") or "") != str(court_id):
            # Also check Courts field if CourtId not present
            courts_str = item.get("Courts", "")
            if str(court_id) not in courts_str:
                continue
        try:
            s = datetime.fromisoformat(item["StartDateTime"])
            e = datetime.fromisoformat(item["EndDateTime"])
        except Exception:
            continue
        if s < end and e > start:
            return False
    return True


def _find_free_court(items: list[dict], start: datetime, end: datetime) -> int | None:
    """Return first available court ID at this time, respecting the 3-court max."""
    occupied = set()
    for item in items:
        try:
            s = datetime.fromisoformat(item["StartDateTime"])
            e = datetime.fromisoformat(item["EndDateTime"])
        except Exception:
            continue
        if s < end and e > start:
            courts_str = str(item.get("Courts", ""))
            for cid in COURTS:
                if str(COURTS[cid]["number"]) in courts_str or cid in courts_str:
                    occupied.add(int(cid))

    # max 3 courts occupied at any time (hard constraint)
    if len(occupied) >= 3:
        return None

    for cid in _COURT_IDS:
        if int(cid) not in occupied:
            return int(cid)
    return None


def analyse_day(date_str: str, items: list[dict]) -> dict:
    """Return analysis of AI and Intermediate events for one day."""
    dt = datetime.strptime(date_str, "%m/%d/%Y")
    ai_events  = []
    int_events = []

    for item in items:
        level = _get_level(item)
        start = datetime.fromisoformat(item["StartDateTime"])
        if start.date() != dt.date():
            continue
        members = int(item.get("MembersCount") or 0)
        record = {
            "event_name":    item.get("EventName", ""),
            "start":         start,
            "end":           datetime.fromisoformat(item["EndDateTime"]),
            "courts":        item.get("Courts", ""),
            "members":       members,
            "occurrence_id": item.get("Id"),
            "event_id":      item.get("EventId"),
        }
        if level == "Advanced Intermediate":
            ai_events.append(record)
        elif level == "Intermediate":
            int_events.append(record)

    return {
        "date_str":   date_str,
        "dow":        dt.strftime("%A"),
        "ai_events":  sorted(ai_events,  key=lambda x: x["start"]),
        "int_events": sorted(int_events, key=lambda x: x["start"]),
        "all_items":  items,
    }


def plan_changes(analyses: list[dict]) -> list[dict]:
    """
    Given per-day analyses, produce a list of changes to make.
    Each change: {action: 'cancel'|'book', date_str, ...}
    """
    changes = []

    for i, day in enumerate(analyses):
        date_str  = day["date_str"]
        dow       = day["dow"]
        ai_events = day["ai_events"]
        int_events = day["int_events"]

        # ── AI: keep at most 1 ───────────────────────────────────────────────
        if len(ai_events) > 1:
            # Keep the one with members (or first if none), cancel rest
            with_members = [e for e in ai_events if e["members"] > 0]
            keep = with_members[0] if with_members else ai_events[0]
            for ev in ai_events:
                if ev is keep:
                    continue
                if ev["members"] > 0:
                    log.warning(
                        "  %s  AI at %s has %d members — SKIPPING cancel",
                        date_str, ev["start"].strftime("%-I:%M%p"), ev["members"],
                    )
                    continue
                changes.append({
                    "action":       "cancel",
                    "date_str":     date_str,
                    "dow":          dow,
                    "event_id":     int(ev["event_id"]),
                    "occurrence_id": int(ev["occurrence_id"]),
                    "description":  f"Cancel extra AI at {ev['start'].strftime('%-I:%M%p')} ({ev['courts']})",
                })

        # ── Intermediate: add up to target ───────────────────────────────────
        needed = INT_TARGET - len(int_events)
        if needed > 0:
            items_for_day = day["all_items"]
            # Try candidate start hours
            for hour in INT_TIMES:
                if needed <= 0:
                    break
                start_dt = datetime.strptime(date_str, "%m/%d/%Y").replace(hour=hour)
                end_dt   = start_dt.replace(hour=hour + 2)

                # Check operating window
                win = POLICY["operating_windows"]
                window = win["weekday"] if dow not in ("Saturday", "Sunday") else win["weekend"]
                win_start_h = int(window["start"].split(":")[0])
                win_end_h   = int(window["end"].split(":")[0])
                if hour < win_start_h or hour + 2 > win_end_h:
                    continue

                # Skip if this time already has an Intermediate session
                already = any(
                    abs((e["start"].hour * 60 + e["start"].minute) - hour * 60) < 120
                    for e in int_events
                )
                if already:
                    continue

                # Find a free court (respecting 3-court max)
                court_id = _find_free_court(items_for_day, start_dt, end_dt)
                if court_id is None:
                    continue

                changes.append({
                    "action":      "book",
                    "date_str":    date_str,
                    "dow":         dow,
                    "event_id":    INT_EVENT_ID,
                    "start_time":  start_dt.strftime("%-I:%M %p"),
                    "end_time":    end_dt.strftime("%-I:%M %p"),
                    "court_id":    court_id,
                    "court_num":   COURTS[str(court_id)]["number"],
                    "description": (
                        f"Book Intermediate {start_dt.strftime('%-I:%M%p')}–"
                        f"{end_dt.strftime('%-I:%M%p')} Court #{COURTS[str(court_id)]['number']}"
                    ),
                })
                # Add to items_for_day so subsequent slots respect this booking
                items_for_day.append({
                    "EventId":       str(INT_EVENT_ID),
                    "StartDateTime": start_dt.isoformat(),
                    "EndDateTime":   end_dt.isoformat(),
                    "Courts":        f"#{COURTS[str(court_id)]['number']}",
                    "CourtId":       str(court_id),
                    "MembersCount":  0,
                })
                needed -= 1

    return changes


def print_summary(analyses: list[dict], changes: list[dict]):
    """Print a human-readable summary."""
    print("\n" + "═" * 70)
    print("  CURRENT SCHEDULE — Advanced Intermediate & Intermediate")
    print("═" * 70)
    for day in analyses:
        ai  = day["ai_events"]
        i   = day["int_events"]
        if not ai and not i:
            continue
        def _ai_label(e):
            tag = "🔒" if e["members"] > 0 else str(e["members"])
            return f"{e['start'].strftime('%-I%p')}({tag})"
        ai_str = ", ".join(_ai_label(e) for e in ai) or "—"
        i_str = ", ".join(
            f"{e['start'].strftime('%-I%p')}({e['members']})"
            for e in i
        ) or "—"
        flag = "  ⚠" if len(ai) > 1 or len(i) < INT_TARGET else ""
        print(f"  {day['dow'][:3]} {day['date_str']}  AI:[{ai_str}]  I:[{i_str}]{flag}")

    print("\n" + "═" * 70)
    print(f"  PLANNED CHANGES  ({len(changes)} total)")
    print("═" * 70)
    if not changes:
        print("  No changes needed.")
    for c in changes:
        icon = "❌ CANCEL" if c["action"] == "cancel" else "✅ BOOK"
        print(f"  {icon}  {c['dow'][:3]} {c['date_str']}  {c['description']}")
    print()


def execute_changes(changes: list[dict], dry_run: bool):
    """Execute the planned changes against Court Reserve."""
    if not changes:
        log.info("Nothing to do.")
        return

    cancels = [c for c in changes if c["action"] == "cancel"]
    bookings = [c for c in changes if c["action"] == "book"]

    with browser_session(headless=False) as page:
        # ── Cancellations first ──────────────────────────────────────────────
        for c in cancels:
            log.info("Cancelling %s occ=%s on %s", c["description"], c["occurrence_id"], c["date_str"])
            result = cancel_occurrence(
                page          = page,
                event_id      = c["event_id"],
                occurrence_id = c["occurrence_id"],
                date          = c["date_str"],
                dry_run       = dry_run,
            )
            status = "✅ OK" if result["success"] else f"❌ FAILED: {result.get('error')}"
            print(f"  {status}  {c['description']}")

        # ── New bookings ─────────────────────────────────────────────────────
        for c in bookings:
            log.info("Booking %s on %s", c["description"], c["date_str"])
            result = book_event(
                page       = page,
                event_id   = c["event_id"],
                date       = c["date_str"],
                start_time = c["start_time"],
                end_time   = c["end_time"],
                court_id   = c["court_id"],
                dry_run    = dry_run,
            )
            status = "✅ OK" if result["success"] else f"❌ FAILED: {result.get('error')}"
            print(f"  {status}  {c['description']}")


def main():
    parser = argparse.ArgumentParser(description="Fix AI/Intermediate imbalance for the next 14 days")
    parser.add_argument("--execute", action="store_true",
                        help="Actually make the changes (default: dry run, show plan only)")
    parser.add_argument("--days", type=int, default=14,
                        help="Number of days ahead to check (default: 14)")
    args = parser.parse_args()

    dry_run = not args.execute
    today   = date.today()
    dates   = [(today + timedelta(d)).strftime("%-m/%-d/%Y") for d in range(1, args.days + 1)]

    print(f"\nFetching schedule for {dates[0]} → {dates[-1]}...")
    analyses = []
    with browser_session(headless=True) as page:
        for d in dates:
            items = fetch_schedule(d, d, page=page)
            analyses.append(analyse_day(d, items))

    changes = plan_changes(analyses)
    print_summary(analyses, changes)

    if dry_run:
        print("  Dry run — no changes made.")
        print("  Run with --execute to apply changes.\n")
    else:
        print(f"  Executing {len(changes)} change(s)...")
        execute_changes(changes, dry_run=False)
        print("\n  Done.\n")


if __name__ == "__main__":
    main()
