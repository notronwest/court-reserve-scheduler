"""
Discord Listener — persistent bot for White Mountain Pickleball.

Handles two things, at zero ongoing token cost:
  1. Daily recommendation approval — holds the approval window open indefinitely
     instead of the 10-minute in-process timeout. run.py saves pending state to
     logs/pending_approval.json; this process polls until you reply.
  2. !book <request> — ad-hoc event booking via natural language. Uses Claude
     haiku to parse the request (~$0.0002 per command), posts a preview, then
     books on confirm.

Run as a launchd service (KeepAlive=true) so it always restarts.

Env vars (same .env as the rest of the project):
  DISCORD_BOT_TOKEN
  DISCORD_CHANNEL_ID
  DISCORD_WEBHOOK_URL
  ANTHROPIC_API_KEY
"""

import os
import socket
import sys
import json
import time
import signal
import logging
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path

_HOSTNAME = socket.gethostname().split(".")[0]

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ── Config ────────────────────────────────────────────────────────────────────

BOT_TOKEN   = os.getenv("DISCORD_BOT_TOKEN", "")
CHANNEL_ID  = os.getenv("DISCORD_CHANNEL_ID", "")
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")

POLL_INTERVAL_SECS  = 3
PENDING_FILE          = Path(__file__).parent / "logs" / "pending_approval.json"
PENDING_WAITLIST_FILE = Path(__file__).parent / "logs" / "pending_waitlist.json"
STATE_FILE            = Path(__file__).parent / "logs" / "listener_state.json"
BROWSER_LOCK        = Path(__file__).parent / "logs" / "browser.lock"
LOG_DIR             = Path(__file__).parent / "logs"
PENDING_EXPIRE_DAYS = 2   # auto-clear approvals older than this

# ✅ reaction used for one-tap waitlist-expansion approval
_CHECK_EMOJI     = "✅"
_CHECK_EMOJI_ENC = urllib.parse.quote(_CHECK_EMOJI)

HEADERS = {"Authorization": f"Bot {BOT_TOKEN}"}

# Persistent session with automatic retry on connection errors.
# This handles RemoteDisconnected and similar transient TCP failures
# without surfacing them as warnings.
def _make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    retry = Retry(
        total=3,
        read=False,       # don't retry read timeouts — Discord is reachable, just slow
        backoff_factor=1,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s

_session = _make_session()

# ── Logging ───────────────────────────────────────────────────────────────────

LOG_DIR.mkdir(exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "listener.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
# Suppress urllib3's internal "Retrying..." warnings — our listener already
# logs a clean warning when the final attempt fails.
logging.getLogger("urllib3.connectionpool").setLevel(logging.ERROR)
log = logging.getLogger("listener")

# ── State ─────────────────────────────────────────────────────────────────────

_state = {
    "last_message_id":       None,   # last Discord message ID we processed
    "pending_book_msg_id":   None,   # message_id of the !book preview we posted
    "pending_book_params":   None,   # parsed booking params awaiting confirm
    "pending_move_msg_id":   None,   # message_id of the !move preview we posted
    "pending_move_params":   None,   # parsed move params awaiting confirm
    "waitlist_seeded":       [],     # alert msg_ids we've added our ✅ seed to
    "waitlist_handled":      [],     # alert msg_ids whose expansion we've run
}


def _load_state():
    if STATE_FILE.exists():
        try:
            _state.update(json.loads(STATE_FILE.read_text()))
        except Exception:
            pass


def _save_state():
    STATE_FILE.write_text(json.dumps(_state, indent=2))


# ── Discord helpers ───────────────────────────────────────────────────────────

def _get_messages(after_id=None):
    params = {"limit": 20}
    if after_id:
        params["after"] = after_id
    try:
        r = _session.get(
            f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages",
            params=params, timeout=15,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("Discord poll error: %s", e)
        return None  # None = error (vs [] = no new messages)


def _get_bot_id():
    try:
        r = _session.get("https://discord.com/api/v10/users/@me", timeout=10)
        r.raise_for_status()
        return r.json()["id"]
    except Exception as e:
        log.warning("Could not fetch bot user ID: %s", e)
        return None


def _post_embed(payload):
    params = {"wait": "true"} if BOT_TOKEN else {}
    try:
        r = _session.post(WEBHOOK_URL, json=payload, params=params, timeout=10)
        r.raise_for_status()
        return r.json().get("id")
    except Exception as e:
        log.warning("Discord post error: %s", e)
        return None


def _post_message(text: str):
    """Post a plain text message via webhook."""
    return _post_embed({"content": text})


def _add_reaction(message_id: str, emoji_enc: str = _CHECK_EMOJI_ENC) -> bool:
    """Add the bot's reaction to a message. Returns True on success."""
    try:
        r = _session.put(
            f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages/"
            f"{message_id}/reactions/{emoji_enc}/@me",
            timeout=10,
        )
        if r.status_code in (200, 204):
            return True
        log.warning("Add reaction failed (%s) for msg %s: %s",
                    r.status_code, message_id, r.text[:200])
        return False
    except Exception as e:
        log.warning("Add reaction error for msg %s: %s", message_id, e)
        return False


def _get_reaction_users(message_id: str, emoji_enc: str = _CHECK_EMOJI_ENC):
    """Return the list of users who reacted with emoji, or None on error."""
    try:
        r = _session.get(
            f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages/"
            f"{message_id}/reactions/{emoji_enc}",
            params={"limit": 100}, timeout=15,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("Reaction fetch error for msg %s: %s", message_id, e)
        return None


# ── Pending approval helpers ──────────────────────────────────────────────────

def _load_pending():
    if not PENDING_FILE.exists():
        return None
    try:
        data = json.loads(PENDING_FILE.read_text())
        # Auto-expire old entries
        posted = datetime.fromisoformat(data.get("posted_at", "2000-01-01"))
        if datetime.now() - posted > timedelta(days=PENDING_EXPIRE_DAYS):
            log.info("Pending approval expired (> %d days old) — clearing", PENDING_EXPIRE_DAYS)
            PENDING_FILE.unlink()
            return None
        return data
    except Exception:
        return None


def _clear_pending():
    if PENDING_FILE.exists():
        PENDING_FILE.unlink()


# ── Browser lock helpers ──────────────────────────────────────────────────────

def _acquire_lock():
    """Returns True if we got the browser lock."""
    if BROWSER_LOCK.exists():
        try:
            pid = int(BROWSER_LOCK.read_text().strip())
            os.kill(pid, 0)   # check if process is alive
            return False      # lock held by live process
        except (ProcessLookupError, ValueError):
            pass              # stale lock — take it
    BROWSER_LOCK.write_text(str(os.getpid()))
    return True


def _release_lock():
    if BROWSER_LOCK.exists():
        try:
            if BROWSER_LOCK.read_text().strip() == str(os.getpid()):
                BROWSER_LOCK.unlink()
        except Exception:
            pass


# ── Booking execution ─────────────────────────────────────────────────────────

def _execute_bookings(pending: dict, selected_indices: list):
    """
    Book the selected recommendations from a pending approval entry.
    Posts results to Discord when done.
    """
    from recommender import Recommendation
    from cr_client import browser_session, fetch_schedule
    from book_event import book_event, edit_occurrence_multi_court
    from discord_notify import LEVEL_EMOJI

    recs_raw = pending["recommendations"]
    target_date = pending["target_date"]

    selected = [Recommendation.from_dict(recs_raw[i]) for i in selected_indices]
    log.info("Booking %d event(s) for %s", len(selected), target_date)

    if not _acquire_lock():
        log.warning("Browser lock held by another process — retrying in 60s")
        _post_message("⏳ Scheduler is currently running — will retry your approval in 60 seconds.")
        time.sleep(60)
        if not _acquire_lock():
            _post_message("❌ Browser still locked. Please try again in a few minutes.")
            return

    results = []
    try:
        with browser_session(headless=False) as page:
            live_items = fetch_schedule(target_date, target_date, page=page)
            for r in selected:
                log.info("  Booking: %s", r.display())
                result = book_event(
                    page       = page,
                    event_id   = r.event_id,
                    date       = target_date,
                    start_time = r.start.strftime("%-I:%M %p"),
                    end_time   = r.end.strftime("%-I:%M %p"),
                    court_id   = r.court_id,
                    dry_run    = False,
                )
                if result["success"] and r.is_multi_court:
                    occ_id = result.get("occurrence_id")
                    all_ids = [r.court_id] + r.extra_court_ids
                    if occ_id:
                        edit_occurrence_multi_court(
                            page             = page,
                            occurrence_id    = occ_id,
                            all_court_ids    = all_ids,
                            event_id         = r.event_id,
                            max_participants = r.max_participants,
                        )
                results.append({"recommendation": r.to_dict(), "result": result})

    finally:
        _release_lock()

    from discord_notify import send_booking_results, wait_for_retry_reply

    MAX_ATTEMPTS = 3
    attempt = 1

    while True:
        n_ok   = sum(1 for r in results if r["result"]["success"])
        n_fail = len(results) - n_ok
        log.info("Done: %d booked, %d failed (attempt %d/%d)", n_ok, n_fail, attempt, MAX_ATTEMPTS)

        result_msg_id = send_booking_results(results, target_date, attempt=attempt, max_attempts=MAX_ATTEMPTS)

        if n_fail == 0 or attempt >= MAX_ATTEMPTS or not result_msg_id:
            break

        # Wait for retry/skip reply (blocks up to 3 minutes)
        log.info("Waiting for retry reply...")
        retry, last_seen_id = wait_for_retry_reply(result_msg_id, n_fail, timeout=180)

        # Advance the listener cursor so the retry message isn't reprocessed
        if last_seen_id and last_seen_id > _state.get("last_message_id", "0"):
            _state["last_message_id"] = last_seen_id
            _save_state()

        if not retry or retry == "skip":
            log.info("Retry skipped or timed out.")
            break

        # Build list of recs to retry (retry is 0-based indices into the failed list)
        failed_list = [r for r in results if not r["result"]["success"]]
        to_retry    = [Recommendation.from_dict(failed_list[i]["recommendation"]) for i in retry]
        attempt    += 1
        log.info("Retrying %d booking(s), attempt %d/%d", len(to_retry), attempt, MAX_ATTEMPTS)

        if not _acquire_lock():
            _post_message("❌ Browser locked — cannot retry. Try again in a few minutes.")
            break

        retry_results = []
        try:
            with browser_session(headless=False) as page:
                for r in to_retry:
                    log.info("  Retrying: %s", r.display())
                    res = book_event(
                        page       = page,
                        event_id   = r.event_id,
                        date       = target_date,
                        start_time = r.start.strftime("%-I:%M %p"),
                        end_time   = r.end.strftime("%-I:%M %p"),
                        court_id   = r.court_id,
                        dry_run    = False,
                    )
                    if res["success"] and r.is_multi_court:
                        occ_id  = res.get("occurrence_id")
                        all_ids = [r.court_id] + r.extra_court_ids
                        if occ_id:
                            edit_occurrence_multi_court(
                                page             = page,
                                occurrence_id    = occ_id,
                                all_court_ids    = all_ids,
                                event_id         = r.event_id,
                                max_participants = r.max_participants,
                            )
                    retry_results.append({"recommendation": r.to_dict(), "result": res})
        finally:
            _release_lock()

        # Merge retry results back into the main results list (match by event_id + start_time)
        for rr in retry_results:
            key = (rr["recommendation"]["event_id"], rr["recommendation"]["start_time"])
            for i, orig in enumerate(results):
                if (orig["recommendation"]["event_id"], orig["recommendation"]["start_time"]) == key:
                    results[i] = rr
                    break

    _clear_pending()


def _execute_single_booking(params: dict):
    """Book a single ad-hoc event from a !book command."""
    from recommender import Recommendation, COURTS, APPROVED_EVENTS
    from cr_client import browser_session
    from book_event import book_event, edit_occurrence_multi_court

    target_date = params["date"]
    event_info  = APPROVED_EVENTS.get(str(params["event_id"]), {})
    court_info  = COURTS.get(str(params["court_id"]), {})

    # Build a minimal Recommendation for display purposes
    from datetime import datetime as _dt
    start = _dt.strptime(f"{target_date} {params['start_time']}", "%m/%d/%Y %I:%M %p")
    end   = _dt.strptime(f"{target_date} {params['end_time']}",   "%m/%d/%Y %I:%M %p")

    r = Recommendation(
        event_id         = params["event_id"],
        event_name       = event_info.get("name", params.get("event_name", "Unknown")),
        level            = event_info.get("level", ""),
        court_num        = params["court_num"],
        court_id         = params["court_id"],
        court_label      = court_info.get("label", f"Pickleball-Court #{params['court_num']}"),
        start            = start,
        end              = end,
        extra_court_ids  = params.get("extra_court_ids", []),
        extra_court_nums = params.get("extra_court_nums", []),
        max_participants = params.get("max_participants", 0),
    )

    log.info("Ad-hoc booking: %s", r.display())

    if not _acquire_lock():
        _post_message("⏳ Scheduler is currently running — try your `!book` again in a few minutes.")
        return

    try:
        with browser_session(headless=False) as page:
            result = book_event(
                page       = page,
                event_id   = r.event_id,
                date       = target_date,
                start_time = r.start.strftime("%-I:%M %p"),
                end_time   = r.end.strftime("%-I:%M %p"),
                court_id   = r.court_id,
                dry_run    = False,
            )
            if result["success"] and r.is_multi_court:
                occ_id = result.get("occurrence_id")
                all_ids = [r.court_id] + r.extra_court_ids
                if occ_id:
                    edit_occurrence_multi_court(
                        page             = page,
                        occurrence_id    = occ_id,
                        all_court_ids    = all_ids,
                        event_id         = r.event_id,
                        max_participants = r.max_participants,
                    )
    finally:
        _release_lock()

    if result["success"]:
        from discord_notify import LEVEL_EMOJI
        emoji = LEVEL_EMOJI.get(r.level, "⚪")
        all_courts = [r.court_num] + list(r.extra_court_nums or [])
        court_str = (
            "Courts #" + " & #".join(str(c) for c in sorted(all_courts))
            if len(all_courts) > 1 else f"Court #{r.court_num}"
        )
        suffix = " (max 8)" if r.is_multi_court else ""
        day_label = start.strftime("%A, %B %-d")
        _post_embed({"embeds": [{
            "title": "✅ Booked!",
            "color": 0x2ECC71,
            "description": (
                f"{emoji} **{r.event_name}**\n"
                f"{day_label}  ·  "
                f"{r.start.strftime('%-I:%M %p')} – {r.end.strftime('%-I:%M %p')}  ·  "
                f"{court_str}{suffix}"
            ),
            "footer": {"text": "White Mountain Pickleball • Court Reserve Scheduler"},
        }]})
        log.info("Ad-hoc booking succeeded")
    else:
        _post_message(f"❌ Booking failed: {result.get('error', 'unknown error')}")
        log.warning("Ad-hoc booking failed: %s", result.get("error"))


# ── !expand execution ─────────────────────────────────────────────────────────

def _execute_expand(res_id: str) -> bool:
    """
    Expand a waitlisted occurrence to an additional court by editing it via
    the UpdateReservation modal.  Proposal details are read from
    logs/pending_waitlist.json (written by check_waitlists.py).

    Returns False only when the browser was locked (a transient condition the
    caller may retry); returns True for every terminal outcome — success, a
    real failure, or nothing to do.
    """
    from book_event import edit_occurrence_multi_court

    # Load pending waitlist proposals
    if not PENDING_WAITLIST_FILE.exists():
        _post_message(f"❌ No pending waitlist expansions found (missing {PENDING_WAITLIST_FILE.name}).")
        return True

    try:
        pending = json.loads(PENDING_WAITLIST_FILE.read_text())
    except Exception as e:
        _post_message(f"❌ Could not read pending waitlist file: {e}")
        return True

    if res_id not in pending:
        _post_message(
            f"❌ No pending expansion for res_id `{res_id}`.\n"
            "Run `make check-waitlists` to refresh the list."
        )
        return True

    p = pending[res_id]

    if not _acquire_lock():
        _post_message("⏳ Scheduler is currently running — try again in a few minutes.")
        return False

    try:
        with browser_session(headless=False) as page:
            result = edit_occurrence_multi_court(
                page             = page,
                occurrence_id    = int(res_id),
                all_court_ids    = p["all_court_ids"],
                event_id         = p["event_id"],
                max_participants = p["new_max"],
            )
    finally:
        _release_lock()

    courts_str = "Courts #" + ", #".join(str(n) for n in p["all_court_nums"])

    if result["success"]:
        # Remove from pending
        del pending[res_id]
        PENDING_WAITLIST_FILE.write_text(json.dumps(pending, indent=2))

        _post_embed({"embeds": [{
            "title": "✅ Court Expanded!",
            "color": 0x2ECC71,
            "description": (
                f"**{p['event_name']}**\n"
                f"📅  {p['date_text']}  ·  {p['time_text']}\n"
                f"🎾  {p['courts_text']} → **{courts_str}**\n"
                f"👥  New max: **{p['new_max']}** players\n\n"
                f"Waitlisted members will be notified automatically by Court Reserve."
            ),
            "footer": {"text": "White Mountain Pickleball • Court Reserve Scheduler"},
        }]})
        log.info("Expanded res_id=%s to %s (max %d)", res_id, courts_str, p["new_max"])
    else:
        _post_message(
            f"❌ Expansion failed for `{p['event_name']}` on {p['date_text']}: "
            f"{result.get('error', 'unknown error')}"
        )
        log.warning("Expansion failed for res_id=%s: %s", res_id, result.get("error"))

    return True


# ── ✅ tap-to-approve for waitlist expansions ──────────────────────────────────

def _process_waitlist_reactions(bot_id: str):
    """
    One-tap approval for waitlist expansions.

    check_waitlists.py posts an alert embed and records its message_id in
    logs/pending_waitlist.json.  Each poll cycle we:
      1. Seed each alert with a ✅ reaction so approving is a single tap.
      2. If a non-bot user has tapped ✅ on a seeded alert, run the expansion.

    The `!expand <res_id>` text command remains a fully-supported fallback.
    """
    if not bot_id:
        return   # can't tell our own seed from a human's tap without our id
    try:
        pending = (json.loads(PENDING_WAITLIST_FILE.read_text())
                   if PENDING_WAITLIST_FILE.exists() else {})
    except Exception:
        return   # transient read error mid-write — leave state untouched

    # Empty/absent pending falls through to the prune below (which clears the
    # seeded/handled lists), so they don't grow unbounded across expansions.
    live_msg_ids = set()

    for res_id, entry in list(pending.items()):
        mid = entry.get("message_id")
        if not mid:
            continue
        live_msg_ids.add(mid)

        # 1. Seed our ✅ once so the user just taps the existing checkmark.
        #    If we can't react (permissions/transient), fall through and still
        #    watch for a ✅ the user adds manually.
        if mid not in _state["waitlist_seeded"]:
            if _add_reaction(mid):
                _state["waitlist_seeded"].append(mid)
                _save_state()
                continue   # let the seed land before counting reactors

        if mid in _state["waitlist_handled"]:
            continue

        # 2. Has anyone other than us tapped ✅?
        users = _get_reaction_users(mid)
        if users is None:
            continue   # transient error — retry next cycle
        approver = next((u for u in users if u.get("id") != bot_id), None)
        if not approver:
            continue

        log.info("Waitlist expansion approved via ✅ by %s — res_id=%s (msg %s)",
                 approver.get("username", approver.get("id")), res_id, mid)
        # Mark handled BEFORE executing so a crash-restart won't re-fire.
        _state["waitlist_handled"].append(mid)
        _save_state()
        try:
            ok = _execute_expand(res_id)
        except Exception as exc:
            log.error("Reaction expand error: %s", exc, exc_info=True)
            _post_message(f"❌ Expand error: {exc}")
            ok = True   # hard error — don't auto-retry
        if ok is False:
            # Browser was locked — allow a retry on the next cycle.
            _state["waitlist_handled"].remove(mid)
            _save_state()

    # Prune state to messages still pending so the lists don't grow unbounded.
    _state["waitlist_seeded"]  = [m for m in _state["waitlist_seeded"]  if m in live_msg_ids]
    _state["waitlist_handled"] = [m for m in _state["waitlist_handled"] if m in live_msg_ids]


# ── Move execution ────────────────────────────────────────────────────────────

def _execute_move(params: dict):
    """
    Find the occurrence on Court Reserve and move it to the new timeslot.
    Fetches the live schedule inside the browser session to get the occurrence_id.
    """
    from cr_client import browser_session, fetch_schedule
    from book_event import move_occurrence
    from discord_notify import LEVEL_EMOJI
    from policy_loader import load_policy

    target_date        = params["date"]
    event_id           = params["event_id"]
    event_name         = params["event_name"]
    current_start      = params["current_start_time"]
    new_start          = params["new_start_time"]
    new_end            = params["new_end_time"]
    new_court_id       = params.get("new_court_id")
    new_court_num      = params.get("new_court_num")

    if not _acquire_lock():
        _post_message("⏳ Scheduler is currently running — try `!move` again in a few minutes.")
        return

    policy = load_policy()
    level  = policy.get("approved_events", {}).get(str(event_id), {}).get("level", "")
    emoji  = LEVEL_EMOJI.get(level, "⚪")

    try:
        with browser_session(headless=False) as page:
            items = fetch_schedule(target_date, target_date, page=page)

            # Find the occurrence matching event_id + current start time
            from datetime import datetime as _dt
            target_hhmm = _dt.strptime(current_start, "%I:%M %p").strftime("%H:%M")

            match = None
            for item in items:
                if str(item.get("EventId", "")) == str(event_id):
                    item_hhmm = item.get("StartDateTime", "")[11:16]
                    if item_hhmm == target_hhmm:
                        match = item
                        break

            if not match:
                _post_message(
                    f"❌ Couldn't find **{event_name}** at {current_start} on {target_date}.\n"
                    "Double-check the event name, date, and current start time."
                )
                log.warning("Move: no matching occurrence found for event_id=%s start=%s", event_id, current_start)
                return

            occurrence_id = match.get("Id")
            if not occurrence_id:
                _post_message(f"❌ Found the event but couldn't read its occurrence ID.")
                return

            # Determine which court we're keeping or moving to (for the result message)
            existing_courts = match.get("Courts", "")
            log.info(
                "Move: %s occ_id=%s from %s → %s%s",
                event_name, occurrence_id, current_start, new_start,
                f" Court #{new_court_num}" if new_court_num else "",
            )

            result = move_occurrence(
                page           = page,
                event_id       = event_id,
                occurrence_id  = occurrence_id,
                new_start_time = new_start,
                new_end_time   = new_end,
                new_court_id   = new_court_id,
            )
    finally:
        _release_lock()

    if result["success"]:
        court_note = f" → Court #{new_court_num}" if new_court_num else ""
        _post_embed({"embeds": [{
            "title": "✅ Moved!",
            "color": 0x2ECC71,
            "description": (
                f"{emoji} **{event_name}**\n"
                f"{target_date}  ·  "
                f"~~{current_start}~~ → **{new_start} – {new_end}**"
                f"{court_note}"
            ),
            "footer": {"text": "White Mountain Pickleball • Court Reserve Scheduler"},
        }]})
        log.info("Move succeeded: %s %s → %s", event_name, current_start, new_start)
    else:
        _post_message(f"❌ Move failed: {result.get('error', 'unknown error')}")
        log.warning("Move failed: %s", result.get("error"))


# ── Date parser (shared by !schedule) ────────────────────────────────────────

def _parse_date(text: str):
    """
    Parse flexible date text into M/D/YYYY string.
    Accepts: 4/29  ·  4/29/2026  ·  wednesday  ·  tomorrow  ·  today
    Returns None if unrecognised.
    """
    from datetime import datetime as _dt, timedelta as _td
    t = text.strip().lower()
    today = _dt.now()

    if t == "today":
        return today.strftime("%-m/%-d/%Y")
    if t == "tomorrow":
        return (today + _td(days=1)).strftime("%-m/%-d/%Y")

    # Day-name → next occurrence (never today, always ≥ tomorrow)
    _days = {
        "monday": 0, "mon": 0,
        "tuesday": 1, "tue": 1,
        "wednesday": 2, "wed": 2,
        "thursday": 3, "thu": 3,
        "friday": 4, "fri": 4,
        "saturday": 5, "sat": 5,
        "sunday": 6, "sun": 6,
    }
    if t in _days:
        delta = (_days[t] - today.weekday()) % 7 or 7
        return (today + _td(days=delta)).strftime("%-m/%-d/%Y")

    # M/D or M/D/YYYY (also handle M-D-YYYY)
    normalised = text.strip().replace("-", "/")
    for fmt in ("%m/%d/%Y", "%m/%d"):
        try:
            d = _dt.strptime(normalised, fmt)
            if d.year == 1900:
                d = d.replace(year=today.year)
                if d.date() < today.date():
                    d = d.replace(year=today.year + 1)
            return d.strftime("%-m/%-d/%Y")
        except ValueError:
            pass

    return None


# ── !schedule command handler ─────────────────────────────────────────────────

def _handle_schedule_command(text: str):
    """
    Kick off run.py for the requested date.
    Posts a 'generating…' message immediately; run.py posts the
    recommendations embed to Discord when it finishes.
    """
    import subprocess

    date_str = _parse_date(text)
    if not date_str:
        _post_message(
            f"❌ Couldn't parse date: `{text}`\n"
            "Try: `!schedule wednesday`  ·  `!schedule 4/30`  ·  `!schedule 4/30/2026`"
        )
        return

    # Warn if an approval is already waiting
    if PENDING_FILE.exists():
        _post_message(
            f"⚠️ There's already a pending approval in Discord — reply to that first, "
            f"then try `!schedule {date_str}` again."
        )
        return

    from datetime import datetime as _dt
    try:
        day_label = _dt.strptime(date_str, "%m/%d/%Y").strftime("%A, %B %-d %Y")
    except Exception:
        day_label = date_str

    log.info("!schedule command: generating recommendations for %s", date_str)
    _post_message(f"⏳ Generating recommendations for **{day_label}**…")

    proj_root = Path(__file__).parent
    python    = proj_root / "venv" / "bin" / "python"
    log_path  = proj_root / "logs" / f"run_{date_str.replace('/', '-')}.log"

    log_fh = open(log_path, "w")
    proc = subprocess.Popen(
        [str(python), str(proj_root / "run.py"), date_str, "--llm", "--book"],
        cwd=str(proj_root),
        stdout=log_fh,
        stderr=subprocess.STDOUT,
    )
    log_fh.close()   # parent closes its copy; child keeps the fd
    log.info("run.py started (pid=%d) for %s", proc.pid, date_str)


# ── !move command handler ─────────────────────────────────────────────────────

def _handle_move_command(text: str):
    """Parse !move text, post preview embed, save params for confirmation."""
    from llm_parser import parse_move_command
    from policy_loader import load_policy
    from discord_notify import LEVEL_EMOJI

    log.info("!move command received: %s", text)
    policy = load_policy()

    try:
        params = parse_move_command(text, policy)
    except Exception as e:
        _post_message(f"❌ Could not parse move request: {e}")
        log.warning("Move parse error: %s", e)
        return

    if params.get("error") or not params.get("event_id"):
        _post_message(
            f"❌ Couldn't understand that move request.\n"
            f"Reason: {params.get('error', 'unknown')}\n\n"
            "Try: `!move Intermediate open play 4/30 from 9am to 11am`"
        )
        return

    from datetime import datetime as _dt
    try:
        day_label = _dt.strptime(params["date"], "%m/%d/%Y").strftime("%A, %B %-d %Y")
    except Exception:
        day_label = params["date"]

    level  = policy.get("approved_events", {}).get(str(params["event_id"]), {}).get("level", "")
    emoji  = LEVEL_EMOJI.get(level, "⚪")
    fields = [
        {"name": "Event",   "value": f"{emoji} {params['event_name']}", "inline": True},
        {"name": "Date",    "value": day_label, "inline": True},
        {"name": "From",    "value": f"~~{params['current_start_time']}~~ – {params['new_start_time']} – {params['new_end_time']}", "inline": False},
    ]
    if params.get("new_court_num"):
        fields.append({"name": "New court", "value": f"Court #{params['new_court_num']}", "inline": True})

    msg_id = _post_embed({"embeds": [{
        "title": "🔀 Move Preview",
        "color": 0xF39C12,
        "fields": fields,
        "footer": {"text": "Reply confirm to move  ·  cancel to skip"},
    }]})

    # Clear any pending book action so confirm applies to this move
    _state["pending_book_msg_id"]  = None
    _state["pending_book_params"]  = None
    _state["pending_move_msg_id"]  = msg_id
    _state["pending_move_params"]  = params
    _save_state()
    log.info("Move preview posted (msg_id=%s)", msg_id)


# ── !book command handler ─────────────────────────────────────────────────────

def _handle_book_command(text: str):
    """Parse !book text, post preview embed, save params for confirmation."""
    from llm_parser import parse_book_command
    from policy_loader import load_policy

    log.info("!book command received: %s", text)
    policy = load_policy()

    try:
        params = parse_book_command(text, policy)
    except Exception as e:
        _post_message(f"❌ Could not parse booking request: {e}")
        log.warning("Parse error: %s", e)
        return

    if params.get("error") or not params.get("event_id"):
        _post_message(
            f"❌ Couldn't understand that booking request.\n"
            f"Reason: {params.get('error', 'unknown')}\n\n"
            f"Try: `!book Advanced Intermediate open play 4/28 at 2pm Court 2`"
        )
        return

    # Build preview embed
    from datetime import datetime as _dt
    try:
        start = _dt.strptime(f"{params['date']} {params['start_time']}", "%m/%d/%Y %I:%M %p")
        end   = _dt.strptime(f"{params['date']} {params['end_time']}",   "%m/%d/%Y %I:%M %p")
    except Exception as e:
        _post_message(f"❌ Date/time parse error: {e}")
        return

    from discord_notify import LEVEL_EMOJI
    emoji = LEVEL_EMOJI.get(params.get("level", ""), "⚪")
    all_courts = [params["court_num"]] + params.get("extra_court_nums", [])
    court_str = (
        "Courts #" + " & #".join(str(c) for c in sorted(all_courts))
        if len(all_courts) > 1 else f"Court #{params['court_num']}"
    )
    max_note = f"  ·  max {params['max_participants']} players" if params.get("max_participants") else ""
    day_label = start.strftime("%A, %B %-d %Y")

    msg_id = _post_embed({"embeds": [{
        "title": "📅 Booking Preview",
        "color": 0x3498DB,
        "fields": [
            {"name": "Event",  "value": f"{emoji} {params['event_name']}", "inline": True},
            {"name": "Date",   "value": day_label, "inline": True},
            {"name": "Time",   "value": f"{start.strftime('%-I:%M %p')} – {end.strftime('%-I:%M %p')}", "inline": True},
            {"name": "Courts", "value": f"{court_str}{max_note}", "inline": True},
        ],
        "footer": {"text": "Reply confirm to book  ·  cancel to skip"},
    }]})

    _state["pending_book_msg_id"]  = msg_id
    _state["pending_book_params"]  = params
    _save_state()
    log.info("Preview posted (msg_id=%s) — waiting for confirm/cancel", msg_id)


# ── Approval reply parser (reuses discord_notify logic) ──────────────────────

def _parse_approval(text: str, n_recs: int):
    """
    Returns list of 0-based indices, 'none', or None if not recognised.
    Accepts:
      all / yes / ok / sure / go / approve / book all / book them / yep / yeah → all
      1,3,5 / book 1,3,5 → specific items
      none / no / skip / cancel / pass → none
    """
    t = text.strip().lower()

    # Strip leading "book" / "approve"
    for prefix in ("book", "approve"):
        if t.startswith(prefix):
            t = t[len(prefix):].strip()
            break

    # Positive affirmations → book all
    # Note: "" is intentionally excluded — empty content means an embed/attachment,
    # not a human approval. Auto-booking on embeds caused the recommendation message
    # itself to trigger an immediate booking.
    _all_words = {"all", "yes", "y", "yep", "yeah", "ok", "okay", "sure",
                  "go", "do it", "sounds good", "great", "perfect",
                  "them", "them all", "everything"}
    if t in _all_words:
        return list(range(n_recs))

    # Negative → skip
    if t in ("none", "no", "nope", "skip", "cancel", "pass", "not today", "nevermind", "nvm"):
        return "none"

    # Numeric list: "1,3,5" or "1 3 5"
    try:
        # Accept comma or space as separator
        parts = t.replace(",", " ").split()
        indices = [int(x) - 1 for x in parts if x]
        valid = [i for i in indices if 0 <= i < n_recs]
        if valid:
            return valid
    except ValueError:
        pass

    return None


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    if not BOT_TOKEN or not CHANNEL_ID or not WEBHOOK_URL:
        log.error("DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID and DISCORD_WEBHOOK_URL are required")
        sys.exit(1)

    bot_id = _get_bot_id()
    log.info("Listener started (bot_id=%s)", bot_id)

    _load_state()

    # Graceful shutdown
    def _shutdown(sig, frame):
        log.info("Shutting down")
        _release_lock()
        _save_state()
        sys.exit(0)
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    log.info("Polling channel %s every %ds", CHANNEL_ID, POLL_INTERVAL_SECS)

    _consecutive_errors = 0
    _MAX_BACKOFF = 60  # cap backoff at 60s

    while True:
        messages = _get_messages(after_id=_state["last_message_id"])

        if messages is None:
            # Discord error — back off exponentially, cap at 60s
            _consecutive_errors += 1
            backoff = min(POLL_INTERVAL_SECS * (2 ** (_consecutive_errors - 1)), _MAX_BACKOFF)
            if _consecutive_errors == 1 or _consecutive_errors % 5 == 0:
                log.warning("Discord unreachable (error #%d) — retrying in %ds", _consecutive_errors, backoff)
            time.sleep(backoff)
            continue

        _consecutive_errors = 0  # reset on success

        # Process oldest-first
        for msg in reversed(messages):
            msg_id     = msg["id"]
            author_id  = msg.get("author", {}).get("id")
            content    = msg.get("content", "").strip()

            # Always advance cursor
            _state["last_message_id"] = msg_id

            # Skip our own messages (bot posts)
            if bot_id and author_id == bot_id:
                continue

            # Skip embed-only messages (webhooks posting embeds have empty content).
            # Without this guard, the recommendations embed itself would be seen as
            # an empty-string approval and trigger immediate booking.
            if not content:
                continue

            # ── Check for !help command ──────────────────────────────────────
            if content.lower().strip() in ("!help", "!commands"):
                _post_embed({"embeds": [{
                    "title": "🏓 White Mountain Pickleball — Bot Commands",
                    "color": 0x3498DB,
                    "fields": [
                        {
                            "name": "Daily recommendation approval",
                            "value": (
                                "`all` — book everything\n"
                                "`1,3,5` — book specific items by number\n"
                                "`none` — skip all"
                            ),
                            "inline": False,
                        },
                        {
                            "name": "!schedule <date>",
                            "value": (
                                "Generate recommendations for any day\n"
                                "`!schedule wednesday`\n"
                                "`!schedule 4/30`  ·  `!schedule 4/30/2026`"
                            ),
                            "inline": False,
                        },
                        {
                            "name": "!book <request>",
                            "value": (
                                "Add a single event ad-hoc\n"
                                "`!book Intermediate open play 4/28 at 2pm Court 3`\n"
                                "`!book Advanced Saturday 5/2 noon Courts 3 and 4`\n"
                                "Then reply `confirm` to book or `cancel` to skip."
                            ),
                            "inline": False,
                        },
                        {
                            "name": "!move <event> <date> from <time> to <time>",
                            "value": (
                                "Move an existing event to a different timeslot\n"
                                "`!move Intermediate 4/30 from 9am to 11am`\n"
                                "`!move Advanced 4/29 from 1pm to 3pm Court 1`\n"
                                "Then reply `confirm` to move or `cancel` to skip."
                            ),
                            "inline": False,
                        },
                        {
                            "name": "Court expansion (waitlist alerts)",
                            "value": (
                                "**Tap the ✅** on a waitlist alert to approve — that's it.\n"
                                "Or reply `!expand <res_id>` (e.g. `!expand 54377320`).\n"
                                "Run `make check-waitlists` to refresh pending proposals."
                            ),
                            "inline": False,
                        },
                    ],
                    "footer": {"text": f"White Mountain Pickleball • Court Reserve Scheduler • {_HOSTNAME}"},
                }]})
                _save_state()
                continue

            # ── Check for !schedule command ──────────────────────────────────
            if content.lower().startswith("!schedule"):
                date_text = content[9:].strip()
                if date_text:
                    _handle_schedule_command(date_text)
                else:
                    _post_message(
                        "Usage: `!schedule <date>`\n"
                        "Examples: `!schedule wednesday`  ·  "
                        "`!schedule 4/30`  ·  `!schedule 4/30/2026`"
                    )
                _save_state()
                continue

            # ── Check for !expand command ────────────────────────────────────
            if content.lower().startswith("!expand"):
                arg = content[7:].strip()
                if not arg:
                    _post_message(
                        "Usage: `!expand <res_id>`\n"
                        "Run `make check-waitlists` to see pending proposals."
                    )
                else:
                    try:
                        _execute_expand(arg)
                    except Exception as exc:
                        log.error("Expand error: %s", exc, exc_info=True)
                        _post_message(f"❌ Expand error: {exc}")
                _save_state()
                continue

            # ── Check for !move command ──────────────────────────────────────
            if content.lower().startswith("!move"):
                move_text = content[5:].strip()
                if move_text:
                    _handle_move_command(move_text)
                else:
                    _post_message(
                        "Usage: `!move <event> <date> from <time> to <time>`\n"
                        "Example: `!move Intermediate open play 4/30 from 9am to 11am`\n"
                        "Optional: add a court — `… to 11am Court 2`"
                    )
                _save_state()
                continue

            # ── Check for !book command ──────────────────────────────────────
            if content.lower().startswith("!book"):
                request_text = content[5:].strip()
                if request_text:
                    _handle_book_command(request_text)
                else:
                    _post_message(
                        "Usage: `!book <description>`\n"
                        "Example: `!book Intermediate open play 4/28 at 2pm Court 3`"
                    )
                _save_state()
                continue

            # ── Check for pending !move confirmation ─────────────────────────
            if _state.get("pending_move_params"):
                lower = content.lower()
                if lower in ("confirm", "yes", "ok", "do it"):
                    params = _state["pending_move_params"]
                    _state["pending_move_msg_id"] = None
                    _state["pending_move_params"] = None
                    _save_state()
                    try:
                        _execute_move(params)
                    except Exception as exc:
                        log.error("Move error: %s", exc, exc_info=True)
                        _post_message(f"❌ Move error: {exc}")
                    _save_state()
                    continue
                elif lower in ("cancel", "no", "skip", "nevermind", "nvm"):
                    _state["pending_move_msg_id"] = None
                    _state["pending_move_params"] = None
                    _save_state()
                    _post_message("🚫 Move cancelled.")
                    log.info("Move cancelled by user")
                    continue

            # ── Check for pending !book confirmation ─────────────────────────
            if _state.get("pending_book_params"):
                lower = content.lower()
                if lower in ("confirm", "yes", "ok", "book it", "do it"):
                    params = _state["pending_book_params"]
                    _state["pending_book_msg_id"] = None
                    _state["pending_book_params"] = None
                    _save_state()   # clear pending BEFORE booking so crash-restart doesn't re-confirm
                    try:
                        _execute_single_booking(params)
                    except Exception as exc:
                        log.error("Ad-hoc booking error: %s", exc, exc_info=True)
                        _post_message(f"❌ Booking error: {exc}")
                    _save_state()
                    continue
                elif lower in ("cancel", "no", "skip", "nevermind", "nvm"):
                    _state["pending_book_msg_id"] = None
                    _state["pending_book_params"] = None
                    _save_state()
                    _post_message("🚫 Booking cancelled.")
                    log.info("Ad-hoc booking cancelled by user")
                    continue

            # ── Check for daily recommendation approval ──────────────────────
            pending = _load_pending()
            if pending:
                n = len(pending["recommendations"])
                result = _parse_approval(content, n)
                if result is None:
                    log.info("Unrecognised reply while approval pending: %r (try: all / 1,3 / none)", content[:80])
                    continue   # keep polling
                if result == "none" or result == []:
                    _post_message("🚫 Booking skipped.")
                    _clear_pending()
                    log.info("Approval declined by user")
                else:
                    log.info("Approval received: indices %s", result)
                    # Persist cursor BEFORE booking — if booking crashes, restart
                    # won't re-process the same approval message.
                    _save_state()
                    try:
                        _execute_bookings(pending, result)
                    except Exception as exc:
                        log.error("Booking error: %s", exc, exc_info=True)
                        _post_message(f"❌ Booking error: {exc}")
                        _clear_pending()
                _save_state()

        # ── ✅ tap-to-approve for waitlist expansions ────────────────────────
        try:
            _process_waitlist_reactions(bot_id)
        except Exception as exc:
            log.error("Waitlist reaction processing error: %s", exc, exc_info=True)

        _save_state()
        time.sleep(POLL_INTERVAL_SECS)


if __name__ == "__main__":
    main()
