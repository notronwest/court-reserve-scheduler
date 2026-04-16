"""
Natural-language parser for !book Discord commands.

Uses claude-haiku (cheapest model) to interpret free-form booking requests
and return structured parameters validated against policy.

Cost: ~$0.0002 per command — effectively free.
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

MODEL = "claude-haiku-4-5"


def parse_book_command(text: str, policy: dict, today: str = None) -> dict:
    """
    Parse a free-form booking request into structured booking parameters.

    Args:
        text:   The user's request (everything after !book)
        policy: Loaded policy.json dict
        today:  Today's date string M/D/YYYY (defaults to actual today)

    Returns dict with keys:
        event_id, event_name, level, date, start_time, end_time,
        court_num, court_id, extra_court_nums, extra_court_ids,
        max_participants, error (if parsing failed)
    """
    import anthropic

    if today is None:
        today = datetime.now().strftime("%-m/%-d/%Y")

    # Build approved events and courts context from policy
    events_text = "\n".join(
        f"  {eid}: {e['name']} (level: {e['level']})"
        for eid, e in policy["approved_events"].items()
    )
    courts_text = "\n".join(
        f"  {cid}: Court #{c['number']}"
        for cid, c in policy["courts"].items()
    )

    prompt = f"""You are parsing a pickleball court booking request into structured JSON.

Today is {today}.

Approved events:
{events_text}

Available courts:
{courts_text}

Rules:
- All open play sessions are exactly 2 hours long
- court_id and court_num must match the courts list above
- event_id must be one of the approved event IDs above
- For multi-court bookings, primary court goes in court_num/court_id,
  additional courts go in extra_court_nums/extra_court_ids
- max_participants is 8 for 2-court events, 0 otherwise
- If the request is ambiguous about level, pick the closest match
- Return ONLY valid JSON, no explanation

Booking request: "{text}"

Return JSON:
{{
  "event_id": <int>,
  "event_name": <string>,
  "level": <string>,
  "date": "<M/D/YYYY>",
  "start_time": "<H:MM AM/PM>",
  "end_time": "<H:MM AM/PM>",
  "court_num": <int>,
  "court_id": <int>,
  "extra_court_nums": [],
  "extra_court_ids": [],
  "max_participants": <int>,
  "error": null
}}

If you cannot parse the request, return {{"error": "<reason>", "event_id": null}}"""

    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    resp = client.messages.create(
        model=MODEL,
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = resp.content[0].text.strip()

    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

    parsed = json.loads(raw)

    # Validate event_id is approved
    if parsed.get("event_id"):
        approved = policy.get("approved_events", {})
        if str(parsed["event_id"]) not in approved:
            parsed["error"] = f"Event ID {parsed['event_id']} is not in the approved events list"

    # Validate court_id is known
    if parsed.get("court_id"):
        known = policy.get("courts", {})
        if str(parsed["court_id"]) not in known:
            parsed["error"] = f"Court ID {parsed['court_id']} is not recognised"

    return parsed
