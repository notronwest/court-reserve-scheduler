"""
LLM-powered recommendation engine (Pass 1 + Pass 2) for White Mountain Pickleball.

Replaces the rule-based level-coverage and utilization-fill passes with a single
Claude API call that reasons over all constraints simultaneously.

Public entry point:
    call_llm_ranker(...) -> list[Recommendation]

Raises an exception on API failure; caller (recommender.py) handles the fallback
to rule-based logic.
"""

import logging
import os
from collections import defaultdict
from datetime import datetime

import anthropic

from history_analysis import PopularityKey, summary as pop_summary
from recommender import (
    APPROVED_EVENTS,
    COURTS,
    LEVEL_ORDER,
    Recommendation,
)

log = logging.getLogger(__name__)

MODEL      = "claude-sonnet-4-6"
MAX_TOKENS = 1024
TOP_SCORES = 20   # top N historical scores to include per day

# Level abbreviations for compact prompt rendering
_ABBREV = {
    "Beginner":             "B",
    "Advanced Beginner":    "AB",
    "Intermediate":         "I",
    "Advanced Intermediate":"AI",
    "Advanced":             "A",
}

BOOK_SLOTS_TOOL = {
    "name": "book_slots",
    "description": (
        "Return the open play events to book into the available court slots. "
        "Only reference exact court# and start-time combinations from the FREE SLOTS list. "
        "Never double-book a court/time. Respect the occurrence limit per event_id."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "bookings": {
                "type": "array",
                "description": "Slots to book, ordered earliest-first.",
                "items": {
                    "type": "object",
                    "properties": {
                        "event_id":   {
                            "type": "integer",
                            "description": "One of the 5 approved event IDs",
                            "enum": list(APPROVED_EVENTS.keys()),
                        },
                        "court_num":  {
                            "type": "integer",
                            "description": "Court number (1–4)",
                            "enum": list(COURTS.keys()),
                        },
                        "start_time": {
                            "type": "string",
                            "description": "24h HH:MM matching a FREE SLOT start, e.g. '09:00'",
                        },
                        "reasoning": {
                            "type": "string",
                            "description": "One-line reason for this choice",
                        },
                    },
                    "required": ["event_id", "court_num", "start_time"],
                    "additionalProperties": False,
                },
            },
            "summary": {
                "type": "string",
                "description": "Brief description of the overall scheduling strategy used.",
            },
        },
        "required": ["bookings"],
        "additionalProperties": False,
    },
}


# ── Public entry point ───────────────────────────────────────────────────────

def call_llm_ranker(
    pass0_recs:           list,        # Recommendation objects already placed (Pass 0)
    free_slots:           list,        # [(court_num, start_dt, end_dt)] still available
    pop_scores:           dict,        # PopularityKey -> avg attendance float
    policy:               dict,
    date_str:             str,         # "YYYY-MM-DD"
    day_name:             str,         # "Monday" … "Sunday"
    event_counts:         dict,        # event_id -> occurrences already placed
    level_counts:         dict,        # level_name -> sessions already on schedule
    target_court_hours:   float,
    existing_court_hours: float,
) -> list:
    """
    Call Claude to select recommendations for Pass 1 + Pass 2.
    Returns list[Recommendation] — does NOT include pass0_recs.
    Raises on API failure; recommender.py catches and falls back.
    """
    # Load .env from the project root (same dir as this file)
    try:
        from dotenv import load_dotenv
        from pathlib import Path
        load_dotenv(Path(__file__).parent / ".env", override=True)
    except ImportError:
        pass
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not set — add it to .env or your shell environment")
    client = anthropic.Anthropic(api_key=api_key)

    system_msg = _system_prompt(policy)
    user_msg   = _user_prompt(
        pass0_recs, free_slots, pop_scores, policy,
        date_str, day_name, event_counts, level_counts,
        target_court_hours, existing_court_hours,
    )

    log.debug("LLM user prompt (%d chars):\n%s", len(user_msg), user_msg)

    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system_msg,
        tools=[BOOK_SLOTS_TOOL],
        tool_choice={"type": "tool", "name": "book_slots"},
        messages=[{"role": "user", "content": user_msg}],
    )

    tool_block = next(
        (b for b in response.content if b.type == "tool_use" and b.name == "book_slots"),
        None,
    )
    if tool_block is None:
        raise ValueError(f"No book_slots call in response; stop_reason={response.stop_reason}")

    summary = tool_block.input.get("summary", "")
    if summary:
        log.info("LLM strategy: %s", summary)
        print(f"\n  [LLM] {summary}")

    return _parse_bookings(
        tool_block.input.get("bookings", []),
        date_str,
        free_slots,
        event_counts,
        policy,
    )


# ── Prompt construction ──────────────────────────────────────────────────────

def _system_prompt(policy: dict) -> str:
    max_occ  = policy["hard_constraints"]["3_max_occurrences_per_event_per_day"]["limit"]
    min_gap  = policy["hard_constraints"]["3b_min_gap_same_event_hours"]["hours"]
    sat_thr  = policy["hard_constraints"]["4_required_level_coverage"].get("saturation_threshold", 2)
    tgt_pct  = policy["utilization"]["target_pct"]
    n_courts = policy["utilization"]["baseline_courts"]
    return (
        f"You are a court scheduling assistant for White Mountain Pickleball Club.\n"
        f"Select open play events to book into available slots to maximize member engagement "
        f"and skill-level diversity.\n\n"
        f"HARD CONSTRAINTS (always enforce):\n"
        f"1. Never double-book a court/time combination\n"
        f"2. Each booking is exactly 2 hours on exactly one court\n"
        f"3. Each event_id may appear at most {max_occ} times total (existing + your bookings)\n"
        f"4. Two bookings of the SAME event_id must be separated by at least {min_gap} hours "
        f"(end of first to start of next) — no back-to-back sessions of the same type\n"
        f"5. Only use the 5 approved event IDs\n\n"
        f"GOALS (priority order):\n"
        f"1. Cover all 5 skill levels; skip levels already at {sat_thr}+ sessions today\n"
        f"2. Fill toward {tgt_pct}% utilization across {n_courts} courts\n"
        f"3. Weight toward historically popular time bands\n"
        f"4. Vary times — spread sessions across the day rather than stacking the same hour"
    )


def _user_prompt(
    pass0_recs:           list,
    free_slots:           list,
    pop_scores:           dict,
    policy:               dict,
    date_str:             str,
    day_name:             str,
    event_counts:         dict,
    level_counts:         dict,
    target_court_hours:   float,
    existing_court_hours: float,
) -> str:
    weekdays = policy["operating_windows"]["weekday"]["days"]
    win = (
        policy["operating_windows"]["weekday"]
        if day_name in weekdays
        else policy["operating_windows"]["weekend"]
    )
    max_occ  = policy["hard_constraints"]["3_max_occurrences_per_event_per_day"]["limit"]
    sat_thr  = policy["hard_constraints"]["4_required_level_coverage"].get("saturation_threshold", 2)

    # Multi-court recs count N courts × duration
    pass0_hrs    = sum(
        (r.end - r.start).total_seconds() / 3600 * (1 + len(r.extra_court_ids))
        for r in pass0_recs
    )
    already_hrs  = existing_court_hours + pass0_hrs
    needed_hrs   = max(0.0, target_court_hours - already_hrs)
    needed_slots = max(0, -(-int(needed_hrs) // 2))  # ceil divide by 2

    lines = []

    # ── Header ────────────────────────────────────────────────────────────
    lines += [
        f"DATE: {day_name}, {date_str}",
        f"WINDOW: {win['start']}–{win['end']}  ({win['hours']}h, 4 courts)",
        f"ALREADY BOOKED: {already_hrs:.1f} court-hrs  |  STILL NEEDED: {needed_hrs:.1f} court-hrs (~{needed_slots} slots)",
        "",
    ]

    # ── Approved events ───────────────────────────────────────────────────
    lines.append("APPROVED EVENTS (id, abbrev, level):")
    for eid, info in APPROVED_EVENTS.items():
        lines.append(f"  {eid}  {_ABBREV[info['level']]}  {info['level']}")
    lines.append("")

    # ── Level coverage status ─────────────────────────────────────────────
    lines.append(f"LEVEL COVERAGE (saturated at {sat_thr}+):")
    for level in LEVEL_ORDER:
        cnt    = level_counts.get(level, 0)
        status = "COVERED" if cnt >= sat_thr else "NEEDED"
        lines.append(f"  {_ABBREV[level]:>2}  {cnt} existing  [{status}]")
    lines.append("")

    # ── Occurrence headroom ───────────────────────────────────────────────
    occ_parts = [
        f"{_ABBREV[APPROVED_EVENTS[eid]['level']]}({eid})={event_counts.get(eid, 0)}/{max_occ}"
        for eid in APPROVED_EVENTS
    ]
    lines.append("OCCURRENCE COUNTS used/limit:  " + "  ".join(occ_parts))
    lines.append("")

    # ── Pass 0 / already booked ───────────────────────────────────────────
    if pass0_recs:
        lines.append("ALREADY BOOKED — do NOT re-book:")
        for r in sorted(pass0_recs, key=lambda x: (x.start, x.court_num)):
            lines.append(
                f"  Court#{r.court_num}  {r.start.strftime('%H:%M')}–{r.end.strftime('%H:%M')}"
                f"  {_ABBREV[r.level]}({r.event_id})"
            )
        lines.append("")

    # ── Free slots ────────────────────────────────────────────────────────
    lines.append("FREE SLOTS — only choose from this list (court#, HH:MM-HH:MM):")
    by_time: dict[str, list[int]] = defaultdict(list)
    for cn, ss, se in free_slots:
        key = f"{ss.strftime('%H:%M')}-{se.strftime('%H:%M')}"
        by_time[key].append(cn)

    for tkey in sorted(by_time):
        courts_str = "  ".join(f"C{c}" for c in sorted(by_time[tkey]))
        lines.append(f"  {tkey}  [{courts_str}]")
    lines.append("")

    # ── Historical popularity ─────────────────────────────────────────────
    all_scores = pop_summary(pop_scores)
    day_scores = [s for s in all_scores if s["day_of_week"] == day_name][:TOP_SCORES]
    if day_scores:
        lines.append(f"HISTORICAL ATTENDANCE for {day_name} (top {len(day_scores)}, avg members):")
        for s in day_scores:
            eid  = s["event_id"]
            abbr = _ABBREV.get(APPROVED_EVENTS.get(eid, {}).get("level", ""), "?")
            lines.append(
                f"  {abbr}({eid})  band {s['time_band']}  avg={s['avg_attendance']:.1f}"
            )
        lines.append("")

    lines.append("Call book_slots with your selections.")
    return "\n".join(lines)


# ── Response parsing ─────────────────────────────────────────────────────────

def _parse_bookings(
    bookings:     list,
    date_str:     str,
    free_slots:   list,
    event_counts: dict,
    policy:       dict,
) -> list:
    """
    Convert raw booking dicts to Recommendation objects.
    Re-validates every booking — silently drops hallucinations.
    """
    from datetime import timedelta as _td
    max_occ  = policy["hard_constraints"]["3_max_occurrences_per_event_per_day"]["limit"]
    min_gap  = _td(hours=policy["hard_constraints"]["3b_min_gap_same_event_hours"]["hours"])

    # Build slot lookup: (court_num, "HH:MM") -> (start_dt, end_dt)
    slot_lookup: dict[tuple[int, str], tuple] = {}
    for cn, ss, se in free_slots:
        slot_lookup[(cn, ss.strftime("%H:%M"))] = (ss, se)

    used_slots:    set[tuple[int, str]] = set()
    local_counts:  dict[int, int] = dict(event_counts)
    local_sessions: dict[int, list] = {eid: [] for eid in APPROVED_EVENTS}
    results: list[Recommendation] = []

    for b in bookings:
        eid        = b.get("event_id")
        court_num  = b.get("court_num")
        start_hhmm = b.get("start_time", "")

        if eid not in APPROVED_EVENTS:
            log.warning("LLM: invalid event_id=%s — dropped", eid)
            continue
        if court_num not in COURTS:
            log.warning("LLM: invalid court_num=%s — dropped", court_num)
            continue

        slot_key = (court_num, start_hhmm)
        if slot_key not in slot_lookup:
            log.warning("LLM: slot not in free list Court#%s %s — dropped", court_num, start_hhmm)
            continue
        if slot_key in used_slots:
            log.warning("LLM: double-booked Court#%s %s — dropped duplicate", court_num, start_hhmm)
            continue
        if local_counts.get(eid, 0) >= max_occ:
            log.warning("LLM: event_id=%s would exceed max_occ=%s — dropped", eid, max_occ)
            continue

        ss, se = slot_lookup[slot_key]

        # Gap check: no two suggestions of same event_id back-to-back
        gap_ok = all(
            se + min_gap <= us or ue + min_gap <= ss
            for us, ue in local_sessions.get(eid, [])
        )
        if not gap_ok:
            log.warning(
                "LLM: event_id=%s at %s violates %dh gap rule — dropped",
                eid, start_hhmm, int(min_gap.total_seconds() / 3600),
            )
            continue

        reasoning = b.get("reasoning", "")
        if reasoning:
            level_abbr = _ABBREV.get(APPROVED_EVENTS[eid]["level"], "?")
            log.debug("  [LLM] %s Court#%s %s — %s", level_abbr, court_num, start_hhmm, reasoning)

        results.append(Recommendation(
            event_id    = eid,
            event_name  = APPROVED_EVENTS[eid]["name"],
            level       = APPROVED_EVENTS[eid]["level"],
            court_num   = court_num,
            court_id    = COURTS[court_num]["id"],
            court_label = COURTS[court_num]["label"],
            start       = ss,
            end         = se,
        ))
        used_slots.add(slot_key)
        local_counts[eid] = local_counts.get(eid, 0) + 1
        local_sessions[eid].append((ss, se))

    return results
