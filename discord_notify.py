"""
Discord integration for the Court Reserve scheduler.

Two modes:
  1. WEBHOOK-only  — send recommendations, user replies in terminal
  2. BOT two-way   — send recommendations, poll channel for 'book ...' reply

Env vars:
  DISCORD_WEBHOOK_URL   — always required (for sending)
  DISCORD_BOT_TOKEN     — required for two-way mode (bot reads replies)
  DISCORD_CHANNEL_ID    — required for two-way mode
"""

import os
import time
import requests
from datetime import datetime, timezone
from recommender import Recommendation, LEVEL_ORDER

WEBHOOK_URL  = os.getenv("DISCORD_WEBHOOK_URL", "")
BOT_TOKEN    = os.getenv("DISCORD_BOT_TOKEN", "")
CHANNEL_ID   = os.getenv("DISCORD_CHANNEL_ID", "")

POLL_INTERVAL_SECS = 3
POLL_TIMEOUT_SECS  = 600  # 10 minutes


# ── Formatting ────────────────────────────────────────────────────────────────

LEVEL_EMOJI = {
    "Beginner":              "🟢",
    "Advanced Beginner":     "🔵",
    "Intermediate":          "🟡",
    "Advanced Intermediate": "🟠",
    "Advanced":              "🔴",
}


def _build_embed(
    target_date: str,
    recs: list[Recommendation],
    stats: dict,
) -> dict:
    """Build a Discord embed with recommendations."""

    day_label = datetime.strptime(target_date, "%m/%d/%Y").strftime("%A, %B %-d %Y") \
        if "/" in target_date else target_date

    fields = []

    # Recommendations list
    rec_lines = []
    for i, r in enumerate(recs, 1):
        emoji = LEVEL_EMOJI.get(r.level, "⚪")
        rec_lines.append(
            f"`{i}.` {emoji} **{r.start.strftime('%-I:%M %p')} – {r.end.strftime('%-I:%M %p')}** "
            f"Court #{r.court_num} — {r.event_name}"
        )

    fields.append({
        "name": "📋 Recommendations",
        "value": "\n".join(rec_lines) if rec_lines else "_None_",
        "inline": False,
    })

    # Utilization stats
    achieved_bar = _progress_bar(stats["achieved_pct"], stats["target_pct"])
    fields.append({
        "name": "📊 Utilization",
        "value": (
            f"{achieved_bar}\n"
            f"Existing: **{stats['existing_court_hours']}** hrs  "
            f"+ Recommended: **{stats['recommended_court_hours']}** hrs  "
            f"= **{stats['achieved_court_hours']}** / {stats['target_court_hours']} target "
            f"(**{stats['achieved_pct']}%** vs {stats['target_pct']}% goal)"
        ),
        "inline": False,
    })

    # Level coverage
    covered = [LEVEL_EMOJI.get(l, "⚪") + " " + l for l in stats["levels_covered"]]
    missing = ["❌ " + l for l in stats.get("levels_missing", [])]
    level_lines = covered + missing
    fields.append({
        "name": "🎯 Skill Level Coverage",
        "value": "  ".join(level_lines) if level_lines else "_None_",
        "inline": False,
    })

    # Instructions
    fields.append({
        "name": "✅ How to approve",
        "value": (
            "Reply in this channel with:\n"
            "`all` — book all recommendations\n"
            "`1,3,5` — book specific numbers\n"
            "`none` — skip all\n\n"
            "_This message will be monitored for 10 minutes._"
        ),
        "inline": False,
    })

    color = 0x2ECC71 if not stats.get("levels_missing") else 0xF39C12  # green or orange

    return {
        "embeds": [{
            "title": f"🏓 Schedule Recommendations — {day_label}",
            "color": color,
            "fields": fields,
            "footer": {"text": "White Mountain Pickleball • Court Reserve Scheduler"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }]
    }


def _fixed_events_pending(policy: dict) -> bool:
    fe = policy.get("fixed_events", {})
    return fe.get("status", "").startswith("PENDING") or not fe.get("events")


def maybe_send_fixed_events_reminder(policy: dict):
    """Post a standalone reminder if fixed_events list is still pending."""
    if not _fixed_events_pending(policy):
        return
    if not WEBHOOK_URL:
        return

    from datetime import date as _date
    pending_since = policy["fixed_events"].get("pending_since", "unknown")
    days_pending  = (datetime.now().date() - datetime.strptime(pending_since, "%Y-%m-%d").date()).days

    payload = {
        "embeds": [{
            "title": "📌 Action Required — Fixed Events List",
            "color": 0xE74C3C,  # red
            "description": (
                "The **fixed events list** has not been defined yet.\n\n"
                "Fixed events are sessions that should **always** appear on the schedule "
                "regardless of utilization (e.g. *'Saturday morning Beginner Open Play'*).\n\n"
                f"Pending for **{days_pending} day{'s' if days_pending != 1 else ''}** (since {pending_since})."
            ),
            "fields": [
                {
                    "name": "What to provide for each fixed event",
                    "value": (
                        "• Which event (from the approved list)\n"
                        "• Day(s) of week\n"
                        "• Start & end time\n"
                        "• Preferred court #"
                    ),
                    "inline": False,
                },
                {
                    "name": "How to add them",
                    "value": (
                        "Tell Claude Code: *\"Add fixed event: Beginner Open Play, "
                        "Saturdays 9–11 AM, Court #4\"* and it will update `policy.json`."
                    ),
                    "inline": False,
                },
            ],
            "footer": {"text": "White Mountain Pickleball • This reminder posts daily until the list is complete"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }]
    }

    requests.post(WEBHOOK_URL, json=payload, timeout=10).raise_for_status()
    print("  ⚠  Fixed events reminder posted to Discord.")


def _progress_bar(pct: float, target: float, width: int = 20) -> str:
    filled = int(round(pct / 100 * width))
    bar    = "█" * filled + "░" * (width - filled)
    marker = int(round(target / 100 * width))
    bar_list = list(bar)
    if 0 <= marker < width:
        bar_list[marker] = "│"
    return f"`[{''.join(bar_list)}]` {pct}%  (target: {target}%)"


# ── Send ──────────────────────────────────────────────────────────────────────

def send_recommendations(
    target_date: str,
    recs: list[Recommendation],
    stats: dict,
) -> str | None:
    """
    Post recommendations to Discord via webhook.
    Returns the message_id if BOT_TOKEN is available (needed for polling),
    otherwise None.
    """
    if not WEBHOOK_URL:
        raise ValueError("DISCORD_WEBHOOK_URL not set in .env")

    payload = _build_embed(target_date, recs, stats)

    # If we have a bot token we can get the message ID back for reply tracking
    params = {"wait": "true"} if BOT_TOKEN else {}

    resp = requests.post(WEBHOOK_URL, json=payload, params=params, timeout=10)
    resp.raise_for_status()

    if BOT_TOKEN and resp.status_code == 200:
        return resp.json().get("id")
    return None


# ── Poll for response ─────────────────────────────────────────────────────────

def _get_recent_messages(after_id: str = None) -> list[dict]:
    """Fetch recent messages from the channel using the bot token."""
    headers = {"Authorization": f"Bot {BOT_TOKEN}"}
    params  = {"limit": 10}
    if after_id:
        params["after"] = after_id

    resp = requests.get(
        f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages",
        headers=headers,
        params=params,
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def _parse_booking_reply(content: str) -> list[int] | str | None:
    """
    Parse a Discord reply. Accepts flexible formats:
      all / book all               → book everything
      none / skip / skip all / book none / no → book nothing
      1,3,5 / book 1,3,5           → book specific numbers
    Returns list of 0-based indices, 'all', 'none', or None if unrecognised.

    NOTE: anything starting with 'skip' always means none — never book.
    """
    text = content.strip().lower()

    # "skip" always means none, regardless of what follows
    if text.startswith("skip"):
        return "none"

    # Strip optional leading "book" keyword
    if text.startswith("book"):
        text = text[4:].strip()

    if text in ("all", ""):
        return "all"
    if text in ("none", "no"):
        return "none"
    # Try comma-separated numbers
    try:
        return [int(x.strip()) - 1 for x in text.split(",") if x.strip()]
    except ValueError:
        return None


def wait_for_reply(
    after_message_id: str,
    n_recs: int,
    timeout: int = POLL_TIMEOUT_SECS,
) -> list[int] | None:
    """
    Poll the Discord channel for a 'book ...' reply.
    Returns list of 0-based indices to book, or None on timeout.
    Requires DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID.
    """
    if not BOT_TOKEN or not CHANNEL_ID:
        raise ValueError("DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID required for two-way mode")

    print(f"  Waiting for Discord reply (timeout: {timeout}s)...")
    deadline = time.time() + timeout
    last_id  = after_message_id

    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_SECS)
        try:
            messages = _get_recent_messages(after_id=last_id)
        except Exception as e:
            print(f"  Discord poll error: {e}")
            continue

        for msg in reversed(messages):  # oldest first
            last_id = msg["id"]
            parsed  = _parse_booking_reply(msg.get("content", ""))
            if parsed is None:
                continue
            if parsed == "all":
                return list(range(n_recs))
            if parsed == "none":
                return []
            # Validate indices
            indices = [i for i in parsed if 0 <= i < n_recs]
            return indices

    print("  Timed out waiting for Discord reply.")
    return None


# ── Results post ─────────────────────────────────────────────────────────────

def send_booking_results(
    results: list[dict],
    target_date: str,
    attempt: int = 1,
    max_attempts: int = 3,
) -> str | None:
    """
    Post booking results to Discord.
    Returns message_id if bot token available, else None.
    """
    if not WEBHOOK_URL:
        return None

    day_label = datetime.strptime(target_date, "%m/%d/%Y").strftime("%A, %B %-d %Y") \
        if "/" in target_date else target_date

    lines = []
    n_ok = n_fail = 0
    for r in results:
        rec    = r["recommendation"]
        res    = r["result"]
        emoji  = LEVEL_EMOJI.get(rec.get("level", ""), "⚪")
        time_s = f"{rec['start_time']} – {rec['end_time']}"
        court  = f"Court #{rec['court_num']}"
        name   = rec["event_name"]
        if res.get("success"):
            lines.append(f"✅ {emoji} **{time_s}** {court} — {name}")
            n_ok += 1
        else:
            err = res.get("error") or "unknown error"
            lines.append(f"❌ {emoji} **{time_s}** {court} — {name}\n  ↳ _{err}_")
            n_fail += 1

    color = 0x2ECC71 if n_fail == 0 else (0xE74C3C if n_ok == 0 else 0xF39C12)

    footer_text = "White Mountain Pickleball • Court Reserve Scheduler"

    fields = [{
        "name": f"Results — {n_ok} booked, {n_fail} failed",
        "value": "\n".join(lines) if lines else "_No events processed._",
        "inline": False,
    }]

    # If there are failures and retries remain, add retry instructions
    if n_fail > 0 and attempt < max_attempts:
        failed_nums = [
            str(i + 1)
            for i, r in enumerate(results)
            if not r["result"].get("success")
        ]
        fields.append({
            "name": f"🔄 Retry? (attempt {attempt}/{max_attempts})",
            "value": (
                f"Failed events: **{', '.join(failed_nums)}**\n\n"
                "Reply with:\n"
                "`retry` — retry all failed\n"
                f"`retry {','.join(failed_nums)}` — retry specific ones\n"
                "`skip` — finish without retrying\n\n"
                "_Monitoring for 3 minutes._"
            ),
            "inline": False,
        })
        footer_text += f" • Retry window closes in 3 min"

    payload = {
        "embeds": [{
            "title": f"📋 Booking Results — {day_label}",
            "color": color,
            "fields": fields,
            "footer": {"text": footer_text},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }]
    }

    params = {"wait": "true"} if BOT_TOKEN else {}
    resp = requests.post(WEBHOOK_URL, json=payload, params=params, timeout=10)
    resp.raise_for_status()

    if BOT_TOKEN and resp.status_code == 200:
        return resp.json().get("id")
    return None


def _parse_retry_reply(content: str, n_failed: int) -> list[int] | str | None:
    """
    Parse a retry reply.
      retry / retry all → [0, 1, ...] (all failed indices within failed list)
      retry 1,2         → [0, 1]      (specific failed-list positions, 1-based)
      skip / done / no  → 'skip'
    Returns list of 0-based positions in the failed list, 'skip', or None if unrecognised.
    """
    text = content.strip().lower()
    if text in ("skip", "done", "no", "none"):
        return "skip"
    if text.startswith("retry"):
        rest = text[5:].strip()
        if not rest or rest in ("all", ""):
            return list(range(n_failed))
        try:
            indices = [int(x.strip()) - 1 for x in rest.split(",") if x.strip()]
            return [i for i in indices if 0 <= i < n_failed]
        except ValueError:
            return None
    return None


def wait_for_retry_reply(
    after_message_id: str,
    n_failed: int,
    timeout: int = 180,  # 3 minutes for retries
) -> list[int] | str | None:
    """
    Poll for a retry/skip reply after a results post.
    Returns list of 0-based failed-list positions to retry, 'skip', or None on timeout.
    """
    if not BOT_TOKEN or not CHANNEL_ID:
        return None

    print(f"  Waiting for retry reply (timeout: {timeout}s)...")
    deadline = time.time() + timeout
    last_id  = after_message_id

    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_SECS)
        try:
            messages = _get_recent_messages(after_id=last_id)
        except Exception as e:
            print(f"  Discord poll error: {e}")
            continue

        for msg in reversed(messages):
            last_id = msg["id"]
            parsed  = _parse_retry_reply(msg.get("content", ""), n_failed)
            if parsed is None:
                continue
            return parsed

    print("  Retry window timed out — treating as skip.")
    return "skip"


# ── Two-way flow ──────────────────────────────────────────────────────────────

def send_and_wait(
    target_date: str,
    recs: list[Recommendation],
    stats: dict,
) -> list[int] | None:
    """
    Send recommendations and wait for reply.
    Returns selected indices (0-based), or None on timeout.
    Falls back to terminal input if bot credentials not configured.
    """
    msg_id = send_recommendations(target_date, recs, stats)
    print(f"  Recommendations posted to Discord.")

    if BOT_TOKEN and CHANNEL_ID and msg_id:
        return wait_for_reply(msg_id, len(recs))
    else:
        print("  (Bot token not configured — enter selection here instead)")
        return None  # caller falls back to terminal input
