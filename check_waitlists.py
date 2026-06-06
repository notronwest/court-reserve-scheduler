#!/usr/bin/env python3
"""
check_waitlists.py — Detect upcoming events with waitlists and propose court expansions.

For each approved event, scans the next N days for occurrences that are:
  - Fully booked (MaxPeople reached)
  - Have players on the waitlist
  - Have a free court available at the same time (within the 3-court max)

For each such occurrence a Discord embed is posted showing the proposal and the
risk (how many spots may go unfilled if only waitlisted players join).

The expansion details are saved to logs/pending_waitlist.json.  Reply
`!expand <res_id>` in Discord to approve; the listener executes it.

Usage:
    venv/bin/python check_waitlists.py             # scan and post alerts
    venv/bin/python check_waitlists.py --days 14   # look 14 days ahead (default 7)
    venv/bin/python check_waitlists.py --dry-run   # print proposals without posting

    make check-waitlists
"""

import argparse
import json
import logging
import os
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

from cr_client import browser_session, fetch_schedule
from book_event import _page_ready
from policy_loader import load_policy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

POLICY   = load_policy()
APPROVED = POLICY["approved_events"]   # str(id) -> {name, level}
COURTS   = POLICY["courts"]            # str(id) -> {number, label}

WEBHOOK_URL      = os.getenv("DISCORD_WEBHOOK_URL", "")
OCCURRENCES_URL  = "https://app.courtreserve.com/Events/Edit/{event_id}?page=occurrences"
PENDING_FILE     = Path(__file__).parent / "logs" / "pending_waitlist.json"

# Court IDs in preference order (Court 4 first, then 1, 2, 3)
_COURT_IDS = sorted(COURTS.keys(), key=lambda c: (COURTS[c]["number"] != 4, COURTS[c]["number"]))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_cr_date(text: str) -> date | None:
    """Parse 'Thu, Jun 12th' or 'Fri, Dec 5th 2025' → date."""
    clean = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", text.strip().split("\n")[0])
    today = date.today()
    try:
        return datetime.strptime(clean, "%a, %b %d %Y").date()
    except ValueError:
        pass
    try:
        return datetime.strptime(f"{clean} {today.year}", "%a, %b %d %Y").date()
    except ValueError:
        pass
    return None


def _parse_max_people(text: str) -> tuple[int, int, int]:
    """
    Parse the MaxPeople cell text.  Returns (registered, max_people, waitlist).

    Formats seen:
      "4 / 5"                → (4, 5, 0)
      "FULL (5)    WL (0)"   → (5, 5, 0)
      "FULL (5)    WL (2)"   → (5, 5, 2)
    """
    t = " ".join(text.split())   # collapse whitespace
    full_m = re.match(r"FULL\s*\((\d+)\)", t)
    wl_m   = re.search(r"WL\s*\((\d+)\)", t)
    if full_m:
        mx = int(full_m.group(1))
        wl = int(wl_m.group(1)) if wl_m else 0
        return (mx, mx, wl)
    xy_m = re.match(r"(\d+)\s*/\s*(\d+)", t)
    if xy_m:
        return (int(xy_m.group(1)), int(xy_m.group(2)), 0)
    return (0, 0, 0)


def _parse_court_numbers(courts_text: str) -> list[int]:
    """'Court #2' → [2],  '#1, #2' → [1, 2]"""
    return [int(n) for n in re.findall(r"#(\d+)", courts_text)]


def _court_id_for_number(num: int) -> int | None:
    for cid, info in COURTS.items():
        if info["number"] == num:
            return int(cid)
    return None


def _parse_time_range(time_text: str, date_val: date) -> tuple:
    """'9:00 AM-11:00 AM' → (start_dt, end_dt)"""
    parts = time_text.replace("–", "-").split("-", 1)
    if len(parts) < 2:
        return None, None
    try:
        d = date_val.strftime("%Y-%m-%d")
        start = datetime.strptime(f"{d} {parts[0].strip()}", "%Y-%m-%d %I:%M %p")
        end   = datetime.strptime(f"{d} {parts[1].strip()}", "%Y-%m-%d %I:%M %p")
        return start, end
    except Exception:
        return None, None


# ── Scanning ──────────────────────────────────────────────────────────────────

def scan_event_waitlists(
    page,
    event_id: int,
    event_name: str,
    days_ahead: int,
) -> list[dict]:
    """
    Navigate to the occurrences grid (future dates only) and return one dict
    per occurrence that is full AND has waitlisted players.
    """
    url = OCCURRENCES_URL.format(event_id=event_id)
    page.goto(url)
    _page_ready(page)
    page.wait_for_timeout(2000)

    today  = date.today()
    cutoff = today + timedelta(days=days_ahead)

    raw = page.evaluate("""
        (function() {
            function cell(row, testid) {
                var el = row.querySelector("td[data-testid='" + testid + "']");
                return el ? el.textContent.trim() : '';
            }
            return Array.from(document.querySelectorAll('tr.k-master-row')).map(function(row) {
                var resId = null;
                for (var a of row.querySelectorAll('a[onclick]')) {
                    var m = a.getAttribute('onclick').match(
                        /revertReservationToSeries\\(([0-9]+)/
                    );
                    if (m) { resId = m[1]; break; }
                }
                return {
                    res_id:          resId,
                    date_text:       cell(row, 'Date'),
                    time_text:       cell(row, 'StartTime'),
                    courts_text:     cell(row, 'CourtsDisplay'),
                    max_people_text: cell(row, 'MaxPeople'),
                    status:          cell(row, 'Status.Name'),
                };
            });
        })()
    """)

    alerts = []
    for row in raw:
        if not row["res_id"]:
            continue
        if "cancel" in row["status"].lower():
            continue

        parsed = _parse_cr_date(row["date_text"])
        if not parsed or parsed <= today or parsed > cutoff:
            continue

        registered, max_people, waitlist = _parse_max_people(row["max_people_text"])
        if waitlist <= 0:
            continue

        alerts.append({
            "res_id":      row["res_id"],
            "event_id":    event_id,
            "event_name":  event_name,
            "date":        parsed.isoformat(),
            "date_text":   row["date_text"].split("\n")[0].strip(),
            "time_text":   row["time_text"],
            "courts_text": row["courts_text"],
            "registered":  registered,
            "max_people":  max_people,
            "waitlist":    waitlist,
        })

    return alerts


# ── Proposal building ─────────────────────────────────────────────────────────

def build_proposal(alert: dict, page) -> dict | None:
    """
    Check whether a free court is available at this occurrence's time.
    Returns a proposal dict or None if expansion is impossible.
    """
    date_val = date.fromisoformat(alert["date"])
    date_str = date_val.strftime("%-m/%-d/%Y")

    start_dt, end_dt = _parse_time_range(alert["time_text"], date_val)
    if not start_dt or not end_dt:
        log.warning("Could not parse time for res_id=%s: %r", alert["res_id"], alert["time_text"])
        return None

    current_nums = _parse_court_numbers(alert["courts_text"])
    current_ids  = [_court_id_for_number(n) for n in current_nums]
    current_ids  = [c for c in current_ids if c]
    num_courts   = len(current_ids) if current_ids else 1

    if num_courts >= 3:
        log.info("  res_id=%s already at 3 courts — cannot expand", alert["res_id"])
        return None

    # Fetch the full day schedule to check court availability
    schedule = fetch_schedule(date_str, date_str, page=page)

    # Courts occupied by ANY event during this occurrence's window
    occupied = set()
    for item in schedule:
        try:
            s = datetime.fromisoformat(item["StartDateTime"])
            e = datetime.fromisoformat(item["EndDateTime"])
        except Exception:
            continue
        if s < end_dt and e > start_dt:
            c_str = str(item.get("Courts", ""))
            for cid in COURTS:
                num_str = f"#{COURTS[cid]['number']}"
                if num_str in c_str or cid in c_str:
                    occupied.add(int(cid))

    if len(occupied) >= 3:
        log.info("  res_id=%s: 3 courts already in use — cannot add another", alert["res_id"])
        return None

    # Find first preferred free court not already hosting this occurrence
    new_court_id = None
    for cid in _COURT_IDS:
        cid_int = int(cid)
        if cid_int in current_ids:
            continue
        if cid_int not in occupied:
            new_court_id = cid_int
            break

    if not new_court_id:
        log.info("  res_id=%s: no free court available", alert["res_id"])
        return None

    per_court  = alert["max_people"] // max(num_courts, 1) or 4
    new_max    = per_court * (num_courts + 1)
    new_num    = COURTS[str(new_court_id)]["number"]
    all_ids    = sorted(current_ids + [new_court_id])
    all_nums   = sorted(current_nums + [new_num])

    return {
        "new_court_id":       new_court_id,
        "new_court_num":      new_num,
        "all_court_ids":      all_ids,
        "all_court_nums":     all_nums,
        "per_court":          per_court,
        "new_max":            new_max,
        "num_courts_before":  num_courts,
        "num_courts_after":   num_courts + 1,
    }


# ── Discord notification ──────────────────────────────────────────────────────

def post_discord_alert(alert: dict, proposal: dict):
    """Post a waitlist expansion proposal embed to Discord."""
    import requests

    confirmed    = alert["registered"] + alert["waitlist"]
    empty        = proposal["new_max"] - confirmed
    courts_before = alert["courts_text"]
    courts_after  = "Courts #" + ", #".join(str(n) for n in proposal["all_court_nums"])

    risk = (
        f"\n⚠️  Only ~{confirmed} confirmed players on "
        f"{proposal['num_courts_after']} courts "
        f"({empty} spot{'s' if empty != 1 else ''} may go unfilled if no one else signs up)"
        if empty > 0 else ""
    )

    desc = (
        f"**{alert['event_name']}**\n"
        f"📅  {alert['date_text']}  ·  {alert['time_text']}\n"
        f"🎾  {courts_before} → **{courts_after}** after expansion\n"
        f"👥  {alert['registered']}/{alert['max_people']} registered  "
        f"+  **{alert['waitlist']} on waitlist**\n"
        f"📈  New max: **{proposal['new_max']}** "
        f"({proposal['num_courts_after']} courts × {proposal['per_court']} per court)"
        f"{risk}\n\n"
        f"Reply `!expand {alert['res_id']}` to approve"
    )

    payload = {"embeds": [{
        "title": "⚡  Waitlist — Court Expansion Needed",
        "color": 0xFF8C00,   # orange
        "description": desc,
        "footer": {"text": "White Mountain Pickleball • Court Reserve Scheduler"},
    }]}

    try:
        r = requests.post(WEBHOOK_URL, json=payload, timeout=10)
        r.raise_for_status()
        log.info("  Posted Discord alert for %s res_id=%s", alert["event_name"], alert["res_id"])
    except Exception as e:
        log.warning("  Discord post failed: %s", e)


# ── Pending state ─────────────────────────────────────────────────────────────

def load_pending_waitlist() -> dict:
    if PENDING_FILE.exists():
        try:
            return json.loads(PENDING_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_pending_waitlist(pending: dict):
    PENDING_FILE.parent.mkdir(exist_ok=True)
    PENDING_FILE.write_text(json.dumps(pending, indent=2, default=str))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Check upcoming events for waitlists and post Discord expansion proposals"
    )
    parser.add_argument("--days", type=int, default=7,
                        help="Days ahead to scan (default: 7)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print proposals without posting to Discord")
    args = parser.parse_args()

    today = date.today()
    print(f"\n{'DRY RUN — ' if args.dry_run else ''}Scanning for waitlists: "
          f"{today} → {today + timedelta(days=args.days)}\n")

    proposals = []

    with browser_session(headless=False) as page:
        for eid, info in APPROVED.items():
            name = info.get("name", f"Event {eid}")
            log.info("Scanning %s (event %s)", name, eid)
            alerts = scan_event_waitlists(page, int(eid), name, args.days)

            if not alerts:
                log.info("  No waitlists found")
                continue

            for alert in alerts:
                log.info("  Waitlist: %s res_id=%s  %d registered + %d waiting",
                         alert["date_text"], alert["res_id"],
                         alert["registered"], alert["waitlist"])
                prop = build_proposal(alert, page)
                if prop:
                    proposals.append({"alert": alert, "proposal": prop})
                    log.info("  → Expansion possible: +Court #%d, new max %d",
                             prop["new_court_num"], prop["new_max"])
                else:
                    log.info("  → No expansion possible (no free court or already at 3)")

    if not proposals:
        print("\nNo waitlist expansions needed or available.\n")
        return

    print(f"\n{len(proposals)} expansion proposal(s):\n")
    pending = load_pending_waitlist()

    for p in proposals:
        alert = p["alert"]
        prop  = p["proposal"]
        confirmed = alert["registered"] + alert["waitlist"]
        empty     = prop["new_max"] - confirmed

        print(f"  {alert['event_name']}")
        print(f"  {alert['date_text']} · {alert['time_text']}")
        print(f"  {alert['courts_text']} → Courts #{', #'.join(str(n) for n in prop['all_court_nums'])}")
        print(f"  {alert['registered']}/{alert['max_people']} full + {alert['waitlist']} waitlisted")
        print(f"  New max: {prop['new_max']}  (risk: {empty} spots may go unfilled)")
        print(f"  !expand {alert['res_id']}")
        print()

        if args.dry_run:
            continue

        # Post to Discord
        post_discord_alert(alert, prop)

        # Save to pending file
        pending[alert["res_id"]] = {
            "event_id":    alert["event_id"],
            "event_name":  alert["event_name"],
            "date":        alert["date"],
            "date_text":   alert["date_text"],
            "time_text":   alert["time_text"],
            "courts_text": alert["courts_text"],
            "registered":  alert["registered"],
            "max_people":  alert["max_people"],
            "waitlist":    alert["waitlist"],
            "all_court_ids":  prop["all_court_ids"],
            "all_court_nums": prop["all_court_nums"],
            "new_max":     prop["new_max"],
            "posted_at":   datetime.now().isoformat(),
        }

    if not args.dry_run:
        save_pending_waitlist(pending)
        log.info("Saved %d pending proposal(s) → %s", len(proposals), PENDING_FILE)

    if args.dry_run:
        print("  Dry run — nothing posted.\n")


if __name__ == "__main__":
    main()
