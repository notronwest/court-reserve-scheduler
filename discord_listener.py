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
import sys
import json
import time
import signal
import logging
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

import requests

# ── Config ────────────────────────────────────────────────────────────────────

BOT_TOKEN   = os.getenv("DISCORD_BOT_TOKEN", "")
CHANNEL_ID  = os.getenv("DISCORD_CHANNEL_ID", "")
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")

POLL_INTERVAL_SECS  = 3
PENDING_FILE        = Path(__file__).parent / "logs" / "pending_approval.json"
STATE_FILE          = Path(__file__).parent / "logs" / "listener_state.json"
BROWSER_LOCK        = Path(__file__).parent / "logs" / "browser.lock"
LOG_DIR             = Path(__file__).parent / "logs"
PENDING_EXPIRE_DAYS = 2   # auto-clear approvals older than this

HEADERS = {"Authorization": f"Bot {BOT_TOKEN}"}

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
log = logging.getLogger("listener")

# ── State ─────────────────────────────────────────────────────────────────────

_state = {
    "last_message_id":       None,   # last Discord message ID we processed
    "pending_book_msg_id":   None,   # message_id of the !book preview we posted
    "pending_book_params":   None,   # parsed booking params awaiting confirm
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
        r = requests.get(
            f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages",
            headers=HEADERS, params=params, timeout=10,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("Discord poll error: %s", e)
        return []


def _get_bot_id():
    try:
        r = requests.get("https://discord.com/api/v10/users/@me", headers=HEADERS, timeout=10)
        r.raise_for_status()
        return r.json()["id"]
    except Exception as e:
        log.warning("Could not fetch bot user ID: %s", e)
        return None


def _post_embed(payload):
    params = {"wait": "true"} if BOT_TOKEN else {}
    try:
        r = requests.post(WEBHOOK_URL, json=payload, params=params, timeout=10)
        r.raise_for_status()
        return r.json().get("id")
    except Exception as e:
        log.warning("Discord post error: %s", e)
        return None


def _post_message(text: str):
    """Post a plain text message via webhook."""
    return _post_embed({"content": text})


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
    from discord_notify import send_booking_results, LEVEL_EMOJI

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

    # Post results to Discord
    send_booking_results(results, target_date)

    n_ok  = sum(1 for r in results if r["result"]["success"])
    n_fail = len(results) - n_ok
    log.info("Done: %d booked, %d failed", n_ok, n_fail)
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
    Accepts: all / book all / 1,3,5 / book 1,3,5 / none / skip
    """
    t = text.strip().lower()
    if t.startswith("skip"):
        return "none"
    if t.startswith("book"):
        t = t[4:].strip()
    if t in ("all", ""):
        return list(range(n_recs))
    if t in ("none", "no"):
        return "none"
    try:
        indices = [int(x.strip()) - 1 for x in t.split(",") if x.strip()]
        return [i for i in indices if 0 <= i < n_recs]
    except ValueError:
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

    while True:
        try:
            messages = _get_messages(after_id=_state["last_message_id"])
        except Exception as e:
            log.warning("Poll error: %s", e)
            time.sleep(POLL_INTERVAL_SECS)
            continue

        # Process oldest-first
        for msg in reversed(messages):
            msg_id     = msg["id"]
            author_id  = msg.get("author", {}).get("id")
            content    = msg.get("content", "").strip()

            # Always advance cursor
            _state["last_message_id"] = msg_id

            # Skip our own messages
            if bot_id and author_id == bot_id:
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

            # ── Check for pending !book confirmation ─────────────────────────
            if _state.get("pending_book_params"):
                lower = content.lower()
                if lower in ("confirm", "yes", "ok", "book it", "do it"):
                    params = _state["pending_book_params"]
                    _state["pending_book_msg_id"] = None
                    _state["pending_book_params"] = None
                    _save_state()
                    _execute_single_booking(params)
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
                    continue   # unrecognised message — keep polling
                if result == "none" or result == []:
                    _post_message("🚫 Booking skipped.")
                    _clear_pending()
                    log.info("Approval declined by user")
                else:
                    log.info("Approval received: indices %s", result)
                    _execute_bookings(pending, result)
                _save_state()

        _save_state()
        time.sleep(POLL_INTERVAL_SECS)


if __name__ == "__main__":
    main()
