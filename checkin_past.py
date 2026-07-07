#!/usr/bin/env python3
"""
checkin_past.py — Mark all registered members as Checked-In for past events.

For every approved event, looks back N days (default 90), finds occurrences
with registered members who have NOT been checked in, and clicks the Check-In
button for each.

Usage:
    venv/bin/python checkin_past.py             # dry run (shows who would be checked in)
    venv/bin/python checkin_past.py --execute   # actually check people in
    venv/bin/python checkin_past.py --days 30   # look back 30 days instead of 90
    venv/bin/python checkin_past.py --event 1717131  # one specific event only

    make checkin-past          # dry run
    make checkin-past-execute  # execute
"""

import argparse
import json
import logging
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

from courtreserve_api import browser_session
from courtreserve_api import _page_ready
from policy_loader import load_policy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

POLICY   = load_policy()
APPROVED = POLICY["approved_events"]   # str(id) -> {name, level}

OCCURRENCES_URL = (
    "https://app.courtreserve.com/Events/Edit/{event_id}?page=occurrences"
)


# ── Date parsing ──────────────────────────────────────────────────────────────

def _parse_cr_date(text: str) -> date | None:
    """
    Parse Court Reserve date strings like:
      'Sun, Jun 7th'          → uses current year
      'Fri, Dec 5th 2025'     → uses explicit year
    Returns a date or None if parsing fails.
    """
    # Strip ordinal suffixes (1st → 1, 2nd → 2, etc.)
    clean = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", text.strip())
    today = date.today()
    # Try with year already present in the string (e.g. "Fri, Dec 5th 2025")
    try:
        return datetime.strptime(clean, "%a, %b %d %Y").date()
    except ValueError:
        pass
    # No year in string — append current year (e.g. "Sun, Jun 7th" → "Sun, Jun 7 2026")
    try:
        return datetime.strptime(f"{clean} {today.year}", "%a, %b %d %Y").date()
    except ValueError:
        pass
    return None


# ── Core logic ────────────────────────────────────────────────────────────────

def collect_past_occurrences(
    page,
    event_id: int,
    since: date,
) -> list[dict]:
    """
    Navigate to the event's occurrences grid, enable past dates, and return
    a list of {res_id, date_text, parsed_date} for occurrences that:
      - have registrants (expand button visible)
      - are in the past (before today)
      - are on or after `since` (within the lookback window)
    """
    url = OCCURRENCES_URL.format(event_id=event_id)
    log.info("Loading occurrences grid: %s", url)
    page.goto(url)
    _page_ready(page)
    page.wait_for_timeout(2000)

    # Enable "Show Past Event Date(s)"
    checked = page.evaluate("""
        (function() {
            var cb = document.getElementById('ShowPastDates');
            if (!cb) return 'not_found';
            if (!cb.checked) { cb.click(); return 'clicked'; }
            return 'already_checked';
        })()
    """)
    log.info("ShowPastDates checkbox: %s", checked)
    if checked == "clicked":
        page.wait_for_timeout(3000)

    # Scrape all master rows
    raw_rows = page.evaluate("""
        (function() {
            var result = [];
            var rows = Array.from(document.querySelectorAll('tr.k-master-row'));
            rows.forEach(function(row) {
                // The expand button is hidden (display:none) when registrations = 0
                var btn = row.querySelector('.k-hierarchy-cell a.k-i-expand');
                var has_registrants = btn && btn.style.display !== 'none';

                // Reservation ID from revertReservationToSeries onclick
                var resId = null;
                var links = Array.from(row.querySelectorAll('a[onclick]'));
                for (var l of links) {
                    var m = l.getAttribute('onclick').match(
                        /revertReservationToSeries\\(([0-9]+)/
                    );
                    if (m) { resId = m[1]; break; }
                }

                var dateCell = row.querySelector("td[data-testid='Date']");
                var dateText = dateCell
                    ? dateCell.textContent.replace(/\\s+/g, ' ').trim()
                    : '';
                // Strip any trailing link text after the date (e.g. "Jun 7th ↗")
                dateText = dateText.split('\\n')[0].trim();

                // Registrations count from the MaxPeople column ("4 / 5" format)
                var regCell = row.querySelector("td[data-testid='MaxPeople']");
                var regText = regCell ? regCell.textContent.trim() : '';

                if (resId) {
                    result.push({
                        res_id:          resId,
                        date_text:       dateText,
                        has_registrants: has_registrants,
                        registrations:   regText,   // e.g. "4/5" or ""
                    });
                }
            });
            return result;
        })()
    """)

    today = date.today()
    occurrences = []
    for row in raw_rows:
        # Skip rows with 0 registrations — expand button is hidden when count=0,
        # and the MaxPeople cell reads "0 / N". Both checks guard against edge cases.
        if not row["has_registrants"]:
            continue
        reg_text = row.get("registrations", "")
        if reg_text:
            registered = reg_text.split("/")[0].strip()
            if registered == "0":
                continue
        parsed = _parse_cr_date(row["date_text"])
        if parsed is None:
            log.warning("Could not parse date: %r", row["date_text"])
            continue
        if parsed >= today:
            continue          # future date — skip
        if parsed < since:
            continue          # older than our lookback window — skip
        occurrences.append({
            "res_id":       row["res_id"],
            "date_text":    row["date_text"],
            "date":         parsed,
            "registrations": row.get("registrations", ""),
        })

    occurrences.sort(key=lambda r: r["date"], reverse=True)  # most recent first
    return occurrences


def load_registrants(page, res_id: str) -> list[dict]:
    """
    Expand the row for this reservation and load the registrant AJAX tab.
    Returns a list of {first, last, onclick} for members who need checking in
    (i.e. whose button text is 'Check-In', not already 'Checked-In').
    """
    # Click the expand button for the matching row
    page.evaluate(f"""
        (function() {{
            var rows = Array.from(document.querySelectorAll('tr.k-master-row'));
            for (var row of rows) {{
                if (row.innerHTML.indexOf('{res_id}') === -1) continue;
                var btn = row.querySelector('.k-hierarchy-cell a.k-i-expand');
                if (btn) {{ btn.click(); }}
                break;
            }}
        }})()
    """)
    page.wait_for_timeout(1500)

    # Trigger the AJAX load via the bound JS function
    page.evaluate(f"""
        (function() {{
            if (typeof rebindEventSignUpMembersTab{res_id} === 'function') {{
                rebindEventSignUpMembersTab{res_id}();
            }}
        }})()
    """)
    page.wait_for_timeout(3500)

    # Find Check-In buttons (text exactly "Check-In" → not yet checked in)
    registrants = page.evaluate(f"""
        (function() {{
            var container = document.getElementById(
                'event-sign-up-members-container_{res_id}'
            );
            if (!container) return [];
            var btns = Array.from(container.querySelectorAll('button'));
            return btns
                .filter(function(b) {{
                    return b.innerText.trim() === 'Check-In';
                }})
                .map(function(b) {{
                    var oc = b.getAttribute('onclick') || '';
                    var m = oc.match(
                        /setCheckedInOutUserInReservation\\([^,]+,\\s*[^,]+,\\s*'([^']*)',\\s*'([^']*)'/
                    );
                    return {{
                        first:   m ? m[1] : '?',
                        last:    m ? m[2] : '?',
                        onclick: oc,
                    }};
                }});
        }})()
    """)
    return registrants


def do_checkin(page, res_id: str, registrant: dict) -> bool:
    """
    Click the Check-In button for one registrant.
    Handles any SweetAlert confirmation that may appear.
    Returns True on success.
    """
    onclick_escaped = registrant["onclick"].replace("'", "\\'")

    clicked = page.evaluate(f"""
        (function() {{
            var container = document.getElementById(
                'event-sign-up-members-container_{res_id}'
            );
            if (!container) return false;
            var btns = Array.from(container.querySelectorAll('button'));
            for (var btn of btns) {{
                if (btn.innerText.trim() === 'Check-In'
                    && btn.getAttribute('onclick') === '{onclick_escaped}') {{
                    btn.click();
                    return true;
                }}
            }}
            // Fallback: click ANY Check-In button (if only one left)
            for (var btn of btns) {{
                if (btn.innerText.trim() === 'Check-In') {{
                    btn.click();
                    return true;
                }}
            }}
            return false;
        }})()
    """)

    if not clicked:
        return False

    page.wait_for_timeout(1200)

    # Dismiss any SweetAlert / confirmation modal that appears
    try:
        confirm = page.query_selector(".swal2-confirm")
        if confirm and confirm.is_visible():
            confirm.click()
            page.wait_for_timeout(1200)
    except Exception:
        pass

    return True


# ── Main ──────────────────────────────────────────────────────────────────────

def process_event(
    page,
    event_id: int,
    event_name: str,
    since: date,
    dry_run: bool,
) -> dict:
    """
    Process all past occurrences for one event.
    Returns {event_id, event_name, checked_in, already_in, skipped, errors}
    """
    result = {
        "event_id":   event_id,
        "event_name": event_name,
        "checked_in": 0,
        "already_in": 0,
        "skipped":    0,
        "errors":     [],
    }

    occurrences = collect_past_occurrences(page, event_id, since)
    log.info("  %d past occurrence(s) with registrations in window", len(occurrences))

    for occ in occurrences:
        res_id    = occ["res_id"]
        date_str  = occ["date_text"]
        regs = occ.get("registrations", "")
        log.info("  → %s  [%s]  (resId=%s)", date_str, regs or "?/?", res_id)

        try:
            registrants = load_registrants(page, res_id)
        except Exception as e:
            log.error("    Failed to load registrants: %s", e)
            result["errors"].append(f"{date_str}: {e}")
            continue

        if not registrants:
            log.info("    All checked in (or no registrants)")
            result["already_in"] += 1
            continue

        log.info("    %d member(s) need checking in:", len(registrants))
        for reg in registrants:
            name = f"{reg['first']} {reg['last']}"
            if dry_run:
                print(f"    [DRY RUN] Would check in: {name}  ({date_str})")
                result["checked_in"] += 1
            else:
                ok = do_checkin(page, res_id, reg)
                if ok:
                    log.info("    ✅  Checked in: %s", name)
                    result["checked_in"] += 1
                else:
                    log.warning("    ❌  Could not find button for: %s", name)
                    result["errors"].append(f"{date_str}: button not found for {name}")
                    result["skipped"] += 1

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Check in all registered members for past events"
    )
    parser.add_argument(
        "--execute", action="store_true",
        help="Actually check people in (default: dry run)",
    )
    parser.add_argument(
        "--days", type=int, default=90,
        help="How many days back to look (default: 90)",
    )
    parser.add_argument(
        "--event", type=int, default=None,
        help="Process only this event_id (default: all approved events)",
    )
    args = parser.parse_args()

    dry_run  = not args.execute
    since    = date.today() - timedelta(days=args.days)
    today    = date.today()

    if args.event:
        event_ids = {str(args.event): APPROVED.get(str(args.event), {"name": "?", "level": "?"})}
    else:
        event_ids = APPROVED

    print(f"\n{'DRY RUN — ' if dry_run else ''}Checking in past registrants "
          f"from {since} → {today}  ({args.days} days)\n")

    totals = {"checked_in": 0, "already_in": 0, "skipped": 0, "errors": []}

    with browser_session(headless=False) as page:
        for eid, info in event_ids.items():
            name = info.get("name", f"Event {eid}")
            print(f"{'─'*60}")
            print(f"  {name}  (event {eid})")
            result = process_event(page, int(eid), name, since, dry_run)
            totals["checked_in"] += result["checked_in"]
            totals["already_in"] += result["already_in"]
            totals["skipped"]    += result["skipped"]
            totals["errors"]     += result["errors"]
            print(f"  ✅ {result['checked_in']} checked in   "
                  f"⏭  {result['already_in']} already done   "
                  f"❌ {result['skipped']} skipped")

    print(f"\n{'═'*60}")
    print(f"  TOTAL: {totals['checked_in']} checked in  |  "
          f"{totals['already_in']} already done  |  "
          f"{totals['skipped']} skipped")
    if totals["errors"]:
        print(f"\n  ERRORS ({len(totals['errors'])}):")
        for e in totals["errors"]:
            print(f"    {e}")
    if dry_run:
        print("\n  Dry run — no changes made.")
        print("  Run with --execute to apply.\n")
    else:
        print("\n  Done.\n")


if __name__ == "__main__":
    main()
