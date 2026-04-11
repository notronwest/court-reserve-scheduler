"""
White Mountain Pickleball — Schedule Recommender & Booker
=========================================================
Usage:
    python run.py 4/16/2026           # recommend only
    python run.py 4/16/2026 --book    # recommend then book confirmed slots
    python run.py 4/16/2026 --dry-run # show form fills without submitting
"""

import sys
import json
import argparse
from datetime import datetime, date, timedelta
from pathlib import Path

from cr_client import browser_session, fetch_schedule
from recommender import recommend, APPROVED_EVENTS, COURTS, _overlaps, _parse_court_nums
from book_event import book_event, fix_event_court, edit_occurrence_multi_court
from discord_notify import (
    send_and_wait, maybe_send_fixed_events_reminder, WEBHOOK_URL,
    send_booking_results, wait_for_retry_reply, BOT_TOKEN, CHANNEL_ID,
)


POLICY_FILE = Path(__file__).parent / "policy.json"


def _check_conflict(rec, live_items):
    """
    Check if a recommendation conflicts with any live schedule item on the same court.
    Returns a description string if conflict found, None if clear.
    """
    for item in live_items:
        item_courts = _parse_court_nums(item.get("Courts", ""))
        if rec.court_num not in item_courts:
            continue
        item_start = datetime.fromisoformat(item["StartDateTime"])
        item_end   = datetime.fromisoformat(item["EndDateTime"])
        if _overlaps(rec.start, rec.end, item_start, item_end):
            name = (item.get("EventName") or item.get("ReservationType") or "Unknown").strip()
            return f"{name} {item_start.strftime('%-I:%M %p')}–{item_end.strftime('%-I:%M %p')} Court #{rec.court_num}"
    return None


def load_policy() -> dict:
    with open(POLICY_FILE) as f:
        return json.load(f)


def fmt_date(d: str) -> str:
    """'4/16/2026' → 'Thursday, April 16 2026'"""
    try:
        dt = datetime.strptime(d, "%m/%d/%Y")
    except ValueError:
        dt = datetime.strptime(d, "%-m/%-d/%Y")
    return dt.strftime("%A, %B %-d %Y")


def print_existing(items: list[dict], target_date: str):
    from recommender import _parse_date
    td = _parse_date(target_date)
    date_str = td.strftime("%Y-%m-%d")

    day_items = [
        i for i in items
        if datetime.fromisoformat(i["StartDateTime"]).strftime("%Y-%m-%d") == date_str
    ]
    day_items.sort(key=lambda i: i["StartDateTime"])

    print(f"\n{'─'*60}")
    print(f"  Existing schedule — {fmt_date(target_date)}")
    print(f"{'─'*60}")
    if not day_items:
        print("  (no events scheduled)")
    for item in day_items:
        s = datetime.fromisoformat(item["StartDateTime"]).strftime("%-I:%M %p")
        e = datetime.fromisoformat(item["EndDateTime"]).strftime("%-I:%M %p")
        courts = item.get("Courts", "") or "TBD"
        name   = (item.get("EventName") or item.get("ReservationType") or "").strip()
        print(f"  {s} – {e}  {courts:<22}  {name}")
    print()


def print_recommendations(recs, stats: dict):
    source = stats.get("rec_source", "rule_based")
    source_tag = {
        "llm":        " [Claude API]",
        "fallback":   " [rule-based — LLM failed]",
        "rule_based": "",
    }.get(source, "")
    print(f"{'─'*60}")
    print(f"  Recommendations{source_tag}")
    print(f"{'─'*60}")

    if not recs:
        print("  No recommendations — schedule may already meet target utilization.")
        return

    for i, r in enumerate(recs, 1):
        print(f"  {i:2}.  {r.display()}")

    print()
    print(f"  Utilization:")
    print(f"    Existing:     {stats['existing_court_hours']:5.1f} court-hrs")
    print(f"    + Recommended:{stats['recommended_court_hours']:5.1f} court-hrs")
    print(f"    = Achieved:   {stats['achieved_court_hours']:5.1f} / {stats['target_court_hours']:.1f} target  ({stats['achieved_pct']}% vs {stats['target_pct']}% goal)")
    if stats["gap_court_hours"] > 0:
        print(f"    Gap:          {stats['gap_court_hours']:.1f} court-hrs ({stats['gap_pct_points']} pct-pts)")

    print()
    if stats["levels_missing"]:
        print(f"  ⚠  Levels not covered: {', '.join(stats['levels_missing'])}")
    else:
        print(f"  ✓  All 5 skill levels covered")

    if not stats["min_recommendations_met"]:
        print(f"  ⚠  Below minimum recommendation count")
    print()


def prompt_selection(recs) -> list[int]:
    """Ask user which recommendations to book. Returns list of 0-based indices."""
    if not recs:
        return []

    print("  Which recommendations would you like to book?")
    print("  Enter: all | none | comma-separated numbers (e.g. 1,3,5)")
    print()

    while True:
        try:
            raw = input("  > ").strip().lower()
        except EOFError:
            print("\n  No terminal input available. Run this script directly in your terminal.")
            print("  Example: python run.py 4/16/2026 --dry-run")
            return []

        if raw == "all":
            return list(range(len(recs)))
        if raw in ("none", "n", ""):
            return []
        try:
            indices = [int(x.strip()) - 1 for x in raw.split(",")]
            if all(0 <= i < len(recs) for i in indices):
                return indices
            print(f"  Numbers must be between 1 and {len(recs)}. Try again.")
        except ValueError:
            print("  Invalid input. Try again.")


def cmd_fix(args):
    """
    Fix the court assignment for a specific event occurrence.

    Fetches the live schedule to find the occurrence by event name/ID + date + start time,
    then updates the court via the UpdateReservation form.

    Usage:
        python run.py fix 4/22/2026 "Advanced Open Play" --court 1
        python run.py fix 4/22/2026 --event-id 1633147 --start "1:00 PM" --court 1
    """
    from recommender import APPROVED_EVENTS, _parse_court_nums

    target_date = args.fix_date
    dry_run     = args.dry_run

    # Resolve court_id from court number
    policy = load_policy()
    court_map = {int(v["label"].split("#")[-1]): int(k)
                 for k, v in policy["courts"].items()}
    if args.court not in court_map:
        print(f"  Unknown court #{args.court}. Valid: {sorted(court_map)}")
        return
    court_id  = court_map[args.court]
    court_num = args.court

    print(f"\nFetching schedule for {fmt_date(target_date)}...")
    with browser_session() as page:
        items = fetch_schedule(target_date, target_date, page=page)
        print(f"  {len(items)} event(s) found.")

        # Find the target occurrence
        match = None
        for item in items:
            # Match by event_id if provided
            if args.event_id:
                if item.get("EventId") and int(item["EventId"]) == args.event_id:
                    if not args.start or item["StartDateTime"][11:16] == datetime.strptime(args.start, "%I:%M %p").strftime("%H:%M"):
                        match = item
                        break
            # Match by name fragment
            elif args.name:
                name = (item.get("EventName") or item.get("ReservationType") or "").lower()
                if args.name.lower() in name:
                    if not args.start or item["StartDateTime"][11:16] == datetime.strptime(args.start, "%I:%M %p").strftime("%H:%M"):
                        match = item
                        break

        if not match:
            print(f"  No matching event found. Use --event-id or a name fragment with --name.")
            print(f"\n  Events on {target_date}:")
            for item in items:
                s = datetime.fromisoformat(item["StartDateTime"]).strftime("%-I:%M %p")
                print(f"    EventId={item.get('EventId')}  Id={item.get('Id')}  {s}  "
                      f"{item.get('Courts') or '(no court)'}  "
                      f"{item.get('EventName') or item.get('ReservationType')}")
            return

        occurrence_id = match.get("Id")
        start_dt = datetime.fromisoformat(match["StartDateTime"])
        end_dt   = datetime.fromisoformat(match["EndDateTime"])
        current_courts = match.get("Courts") or "(none)"
        event_name = match.get("EventName") or match.get("ReservationType")

        print(f"\n  Found: {event_name}")
        print(f"    Date:           {target_date}")
        print(f"    Time:           {start_dt.strftime('%-I:%M %p')} – {end_dt.strftime('%-I:%M %p')}")
        print(f"    Current courts: {current_courts}")
        print(f"    Occurrence Id:  {occurrence_id}")
        print(f"    → Updating to Court #{court_num} (id={court_id})")
        if dry_run:
            print("  [DRY RUN] Would update court — skipping submit.")

        result = fix_event_court(
            page=page,
            event_id=int(match["EventId"]) if match.get("EventId") else 0,
            date=target_date,
            start_time=start_dt.strftime("%-I:%M %p"),
            end_time=end_dt.strftime("%-I:%M %p"),
            court_id=court_id,
            occurrence_id=occurrence_id,
            dry_run=dry_run,
        )

        if result.get("success"):
            print(f"\n  ✓ Fixed via {result.get('method')}  (screenshot: {result.get('screenshot')})")
        else:
            print(f"\n  ✗ Failed ({result.get('method')}): {result.get('error')}")
            print(f"    Screenshot: {result.get('screenshot')}")


def main():
    two_weeks_out = (date.today() + timedelta(days=14)).strftime("%-m/%-d/%Y")

    parser = argparse.ArgumentParser(description="Court Reserve scheduler")
    subparsers = parser.add_subparsers(dest="command")

    # ── fix subcommand ────────────────────────────────────────────────────────
    fix_parser = subparsers.add_parser("fix", help="Fix the court assignment for a specific event")
    fix_parser.add_argument("fix_date", help="Date of the event  M/D/YYYY")
    fix_parser.add_argument("--event-id", dest="event_id", type=int)
    fix_parser.add_argument("--name",     dest="name")
    fix_parser.add_argument("--start",    dest="start")
    fix_parser.add_argument("--court",    dest="court", type=int, required=True)
    fix_parser.add_argument("--dry-run",  action="store_true")

    # ── default schedule+book command ─────────────────────────────────────────
    run_parser = subparsers.add_parser("run", help="Recommend and optionally book events (default)")
    run_parser.add_argument(
        "date",
        nargs="?",
        default=two_weeks_out,
        help=f"Target date M/D/YYYY (default: {two_weeks_out})",
    )
    run_parser.add_argument("--book",    action="store_true")
    run_parser.add_argument("--dry-run", action="store_true")
    run_parser.add_argument("--llm",     action="store_true",
                            help="Use Claude API for Pass 1+2 recommendations (requires ANTHROPIC_API_KEY)")

    # If no subcommand given, default to "run" and re-parse under it
    argv = sys.argv[1:]
    if argv and argv[0] not in ("fix", "run", "-h", "--help"):
        argv = ["run"] + argv
    elif not argv or argv[0] in ("--book", "--dry-run"):
        argv = ["run"] + argv

    args = parser.parse_args(argv)

    if args.command == "fix":
        cmd_fix(args)
        return

    target_date = args.date
    do_book     = args.book or args.dry_run
    dry_run     = args.dry_run

    policy = load_policy()

    print(f"\nFetching schedule for {fmt_date(target_date)}...")

    with browser_session() as page:
        items = fetch_schedule(target_date, target_date, page=page)
        print(f"  {len(items)} event(s) found.")

        print_existing(items, target_date)

        recs, stats = recommend(items, target_date, policy, llm=getattr(args, "llm", False))

        print_recommendations(recs, stats)

        # Remind about fixed events if list is still pending
        maybe_send_fixed_events_reminder(policy)

        if not recs:
            return

        if not do_book:
            # Still post to Discord so the team can see what would be booked,
            # but don't wait for a reply — just notify and exit.
            if WEBHOOK_URL:
                print("\n  Sending recommendations to Discord (preview — not booking)...")
                send_and_wait(target_date, recs, stats, preview_only=True)
            else:
                print("  (Run with --book to book recommendations, --dry-run to test form fills)")
            return

        # Get selection — via Discord if webhook configured, else terminal
        if WEBHOOK_URL:
            print("\n  Sending recommendations to Discord...")
            selected_indices = send_and_wait(target_date, recs, stats)
            if selected_indices is None:
                # Discord bot not configured or timed out — fall back to terminal
                selected_indices = prompt_selection(recs)
        else:
            selected_indices = prompt_selection(recs)

        if not selected_indices:
            print("\n  Nothing selected. Exiting.")
            return

        selected = [recs[i] for i in selected_indices]
        print(f"\n  Booking {len(selected)} event(s)...\n")

    # Re-open headed session for booking
    with browser_session(headless=False) as page:
        # Fetch live schedule once before starting — used for conflict guard
        print("  Fetching live schedule for conflict check...")
        live_items = fetch_schedule(target_date, target_date, page=page)
        print(f"  {len(live_items)} events currently on schedule.\n")

        MAX_RETRY_ROUNDS = 3
        results = []

        def _run_booking_round(recs_to_book: list, round_results: list):
            """Book a list of recommendations; append result dicts to round_results."""
            for r in recs_to_book:
                conflict = _check_conflict(r, live_items)
                if conflict:
                    print(f"  ⚠  SKIPPED (conflict): {r.display()}")
                    print(f"     Conflicts with: {conflict}")
                    round_results.append({
                        "recommendation": r.to_dict(),
                        "result": {"success": False, "error": f"Live conflict: {conflict}", "skipped": True}
                    })
                    continue

                print(f"  Booking: {r.display()}")
                result = book_event(
                    page       = page,
                    event_id   = r.event_id,
                    date       = r.start.strftime("%-m/%-d/%Y"),
                    start_time = r.start.strftime("%-I:%M %p"),
                    end_time   = r.end.strftime("%-I:%M %p"),
                    court_id   = r.court_id,
                    dry_run    = dry_run,
                )
                status = "✓ Booked" if result["success"] else f"✗ Failed: {result.get('error','')}"
                print(f"    {status}  (screenshot: {result.get('screenshot','')})")

                # ── Multi-court edit step ─────────────────────────────────────
                # Fixed events spanning 2+ courts: book primary court first,
                # then edit the occurrence to assign all courts + set max participants.
                if result["success"] and r.is_multi_court:
                    occ_id = result.get("occurrence_id")
                    all_ids = [r.court_id] + r.extra_court_ids
                    courts_display = ", ".join(f"#{n}" for n in [r.court_num] + r.extra_court_nums)
                    print(f"    Editing to assign courts {courts_display}"
                          + (f" + max {r.max_participants} players" if r.max_participants else "") + "...")
                    if occ_id:
                        edit_result = edit_occurrence_multi_court(
                            page             = page,
                            occurrence_id    = occ_id,
                            all_court_ids    = all_ids,
                            event_id         = r.event_id,
                            max_participants = r.max_participants,
                            dry_run          = dry_run,
                        )
                        if edit_result["success"]:
                            print(f"    ✓ Multi-court edit done  (screenshot: {edit_result.get('screenshot','')})")
                        else:
                            print(f"    ✗ Multi-court edit failed: {edit_result.get('error','')}")
                        result["multi_court_edit"] = edit_result
                    else:
                        print(f"    ⚠  No occurrence_id returned — skipping multi-court edit")

                round_results.append({"recommendation": r.to_dict(), "result": result})

                if result["success"] and not dry_run:
                    live_items.append({
                        "StartDateTime": r.start.isoformat(),
                        "EndDateTime":   r.end.isoformat(),
                        "Courts":        f"Court #{r.court_num}",
                        "EventId":       r.event_id,
                        "EventName":     r.event_name,
                    })

        # ── Round 1: initial booking ──────────────────────────────────────────
        _run_booking_round(selected, results)

        # ── Retry loop ────────────────────────────────────────────────────────
        for attempt in range(1, MAX_RETRY_ROUNDS + 1):
            # Post results to Discord
            if not dry_run:
                print(f"\n  Posting results to Discord (attempt {attempt}/{MAX_RETRY_ROUNDS})...")
                failed_entries = [r for r in results if not r["result"].get("success")]
                msg_id = send_booking_results(results, target_date, attempt, MAX_RETRY_ROUNDS)

                if not failed_entries:
                    print("  All events booked successfully — no retry needed.")
                    break

                if attempt >= MAX_RETRY_ROUNDS:
                    print(f"  Retry cap reached ({MAX_RETRY_ROUNDS} attempts). Finishing.")
                    break

                if not (BOT_TOKEN and CHANNEL_ID and msg_id):
                    print("  (Discord bot not configured — skipping retry prompt)")
                    break

                # Ask Discord whether to retry
                retry_positions = wait_for_retry_reply(msg_id, len(failed_entries))

                if retry_positions == "skip" or not retry_positions:
                    print("  Retry skipped.")
                    break

                # Match failed entries back to original Recommendation objects
                # by (event_id, start_time)
                to_retry = []
                for pos in retry_positions:
                    if pos >= len(failed_entries):
                        continue
                    fe = failed_entries[pos]["recommendation"]
                    key = (fe["event_id"], fe["start_time"])
                    # find matching Recommendation
                    for r in selected:
                        if r.event_id == fe["event_id"] and r.start.strftime("%-I:%M %p") == fe["start_time"]:
                            to_retry.append(r)
                            break

                if not to_retry:
                    break

                print(f"\n  Retrying {len(to_retry)} event(s) (attempt {attempt + 1}/{MAX_RETRY_ROUNDS})...")

                # Refresh conflict data before retry
                try:
                    live_items[:] = fetch_schedule(target_date, target_date, page=page)
                except Exception as e:
                    print(f"  ⚠  Could not refresh schedule before retry ({e}) — using cached data")
                    # live_items already has stale data; retrying with it is better than crashing

                # Remove old failed entries for the ones we're retrying so results
                # reflects the latest outcome
                retry_keys = {
                    (r.event_id, r.start.strftime("%-I:%M %p")) for r in to_retry
                }
                results[:] = [
                    entry for entry in results
                    if (entry["recommendation"]["event_id"],
                        entry["recommendation"]["start_time"]) not in retry_keys
                ]

                _run_booking_round(to_retry, results)
            else:
                break  # dry-run: no retry loop

        # ── Post-booking schedule verification ───────────────────────────────
        if not dry_run:
            print("\n  Verifying final schedule...")
            final_items = fetch_schedule(target_date, target_date, page=page)
            baseline = len(live_items)
            print(f"  Schedule now has {len(final_items)} events (was {baseline} before booking).")

            # Build lookup structures keyed by start-minute:
            #   by_event[dt_key][event_id] = {"courts": set, "occurrence_id": int|None}
            #   schedule_courts[dt_key]    = set of all court_nums at that time
            from collections import defaultdict
            by_event: dict[str, dict[int, dict]] = defaultdict(lambda: defaultdict(lambda: {"courts": set(), "occurrence_id": None}))
            schedule_courts: dict[str, set[int]] = defaultdict(set)
            for item in final_items:
                dt_key = item["StartDateTime"][:16]
                courts = _parse_court_nums(item.get("Courts", ""))
                eid    = item.get("EventId")
                oid    = item.get("Id")
                for cn in courts:
                    schedule_courts[dt_key].add(cn)
                    if eid:
                        by_event[dt_key][int(eid)]["courts"].add(cn)
                        if oid:
                            by_event[dt_key][int(eid)]["occurrence_id"] = oid

            for r in selected:
                dt_key     = r.start.isoformat()[:16]
                event_info = by_event[dt_key].get(r.event_id, {})
                event_courts    = event_info.get("courts", set())
                schedule_occurrence_id = event_info.get("occurrence_id")
                any_courts   = schedule_courts.get(dt_key, set())

                if r.court_num in event_courts:
                    status = "confirmed"
                    print(f"  ✓ Confirmed: {r.display()}")
                elif event_courts:
                    # Event found at right time but on different court(s)
                    wrong = ", ".join(f"#{c}" for c in sorted(event_courts))
                    status = "wrong_court"
                    print(f"  ⚠ Wrong court (found Court {wrong}): {r.display()}")
                elif r.court_num in any_courts:
                    # Right court/time but event not matched by ID — likely confirmed
                    status = "confirmed"
                    print(f"  ✓ Confirmed (court match): {r.display()}")
                else:
                    # Check if event exists at this time with no court assigned
                    no_court_match = any(
                        item.get("EventId") and int(item["EventId"]) == r.event_id
                        and item["StartDateTime"][:16] == dt_key
                        and not item.get("Courts", "").strip()
                        for item in final_items
                    )
                    if no_court_match:
                        status = "no_court"
                        print(f"  ⚠ Event found but no court assigned: {r.display()}")
                    else:
                        status = "not_found"
                        print(f"  ? Not found: {r.display()}")

                # ── Auto-remediate court issues ───────────────────────────────
                if status in ("wrong_court", "no_court", "not_found"):
                    action = "fix_court" if status in ("wrong_court", "no_court") else "rebook"
                    print(f"    → Attempting {action}...")

                    # Prefer occurrence_id from the live schedule (most accurate);
                    # fall back to what was captured at booking time
                    occurrence_id = schedule_occurrence_id
                    if not occurrence_id:
                        for entry in results:
                            rec = entry["recommendation"]
                            if (rec["event_id"] == r.event_id
                                    and rec["start_time"] == r.start.strftime("%-I:%M %p")):
                                occurrence_id = entry["result"].get("occurrence_id")
                                break

                    if occurrence_id:
                        print(f"      (occurrence_id={occurrence_id})")

                    fix_result = fix_event_court(
                        page=page,
                        event_id=r.event_id,
                        date=r.start.strftime("%-m/%-d/%Y"),
                        start_time=r.start.strftime("%-I:%M %p"),
                        end_time=r.end.strftime("%-I:%M %p"),
                        court_id=r.court_id,
                        occurrence_id=occurrence_id,
                        dry_run=dry_run,
                    )
                    fix_ok  = fix_result.get("success")
                    method  = fix_result.get("method", "")
                    fix_err = fix_result.get("error", "")
                    if fix_ok:
                        print(f"    ✓ Fixed via {method}  (screenshot: {fix_result.get('screenshot','')})")
                        # Update the result entry so the log reflects the fix
                        for entry in results:
                            rec = entry["recommendation"]
                            if (rec["event_id"] == r.event_id
                                    and rec["start_time"] == r.start.strftime("%-I:%M %p")):
                                entry["result"]["fix"] = fix_result
                                entry["result"]["success"] = True
                    else:
                        print(f"    ✗ Fix failed ({method}): {fix_err}")

        # Save booking log
        import os as _os; _os.makedirs("logs", exist_ok=True)
        log_path = f"logs/booking_log_{target_date.replace('/', '-')}.json"
        with open(log_path, "w") as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\n  Log saved: {log_path}")

        booked  = sum(1 for r in results if r["result"]["success"])
        failed  = len(results) - booked
        print(f"\n  Done: {booked} booked, {failed} failed.")


if __name__ == "__main__":
    main()
