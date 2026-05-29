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

from history_analysis import PopularityKey, PopularityStats, load_popularity_full, load_time_patterns, summary as pop_summary
from recommender import (
    APPROVED_EVENTS,
    COURTS,
    LEVEL_ORDER,
    Recommendation,
)

log = logging.getLogger(__name__)

MODEL      = "claude-sonnet-4-6"
MAX_TOKENS = 1500
TOP_SCORES = 20   # kept for legacy summary(), not used in main prompt

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

    global _DOW_WORD
    _DOW_WORD  = day_name
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
        f"You are the head scheduler for White Mountain Pickleball Club. "
        f"You've been running this club for years and you know your members well.\n\n"

        f"Your job is to build the best possible open-play schedule for the day — "
        f"'best' means the most members actually show up and have a good experience. "
        f"You have 3 months of real attendance data. Use it as your primary guide.\n\n"

        f"HOW TO USE THE HISTORY:\n"
        f"- avg attendance tells you how popular a slot typically is\n"
        f"- peak attendance shows the ceiling — how many can show up when conditions are right\n"
        f"- session count shows how reliable the pattern is (10 sessions is solid; 2 is a hint)\n"
        f"- A level with avg=8 is genuinely in demand; avg=1 means members aren't interested "
        f"in that slot regardless of whether we schedule it\n"
        f"- If a level has almost no history, it means it rarely gets scheduled — "
        f"don't automatically skip it, but don't force it if better options exist\n\n"

        f"REASONING APPROACH:\n"
        f"Think like a club manager, not an algorithm. Ask yourself:\n"
        f"- Which levels do members actually want today based on past {_DOW_WORD} data?\n"
        f"- What times have historically drawn the biggest crowds for each level?\n"
        f"- If I only have room for one more slot, which level and time will get the most people on court?\n"
        f"- Am I giving a popular level a second session because demand justifies it, "
        f"or just to fill court-hours?\n\n"

        f"HARD RULES (always enforce — no exceptions):\n"
        f"1. Never double-book a court/time slot\n"
        f"2. Each booking is exactly 2 hours on one court\n"
        f"3. Each event_id may appear at most {max_occ}x total (existing + new); "
        f"Advanced Intermediate (event 1672774) is capped at 1x per day — "
        f"everyone self-identifies as AI so fewer AI sessions drives members toward Intermediate\n"
        f"4. Two bookings of the SAME event_id must be ≥{min_gap}h apart (end-to-start)\n"
        f"5. Only use the 5 approved event IDs\n"
        f"6. Never fill all 4 courts at the same time — at least 1 court must stay free "
        f"at every time slot across the whole day\n\n"

        f"SOFT TARGETS (use judgment):\n"
        f"- Aim to cover all 5 skill levels when attendance history supports it; "
        f"skip a level only if history shows consistently low demand on this day\n"
        f"- A level already at {sat_thr}+ sessions today is saturated — don't add more\n"
        f"- Fill toward {tgt_pct}% court utilization across {n_courts} courts, "
        f"but never schedule a low-demand slot just to hit a number\n"
        f"- Spread sessions across the day — avoid stacking the same hour\n"
        f"- Prioritize Intermediate (event 1931656): target 2 sessions per day when slots allow — "
        f"Intermediate is under-served because members over-report their level as Advanced Intermediate\n"
        f"- For Advanced Intermediate: vary start times across days rather than always using the same hour; "
        f"this intentionally builds data about which AI times actually draw members\n"
        f"- Respect scheduling patterns when free slots allow it: members build habits "
        f"around consistent start times — a Tuesday group expecting noon will show up at noon"
    )

_DOW_WORD = "this day of week"  # replaced dynamically in call


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

    # ── Historical attendance — full profile per level for this day ───────
    full_stats = load_popularity_full()
    day_data: dict[int, list[tuple]] = {eid: [] for eid in APPROVED_EVENTS}

    for key, stats in full_stats.items():
        if key.day_of_week == day_name and key.event_id in APPROVED_EVENTS:
            day_data[key.event_id].append((key.time_band, stats))

    has_history = any(rows for rows in day_data.values())
    if has_history:
        lines.append(f"ATTENDANCE HISTORY — {day_name}s (avg / peak / sessions):")
        for eid, info in APPROVED_EVENTS.items():
            level = info["level"]
            abbr  = _ABBREV[level]
            rows  = sorted(day_data[eid], key=lambda x: -x[1].avg)
            if not rows:
                lines.append(f"  {abbr:>2} ({eid})  {level}: NO DATA for {day_name}s — schedule with caution")
                continue
            total_sessions = sum(s.sessions for _, s in rows)
            best_avg  = rows[0][1].avg
            best_peak = max(s.peak for _, s in rows)
            lines.append(
                f"  {abbr:>2} ({eid})  {level}  "
                f"[{total_sessions} sessions tracked, best avg={best_avg:.1f}, peak={best_peak}]"
            )
            for band, stats in rows:
                h = int(band) // 100
                time_label = f"{h % 12 or 12}{'am' if h < 12 else 'pm'}"
                lines.append(
                    f"      {time_label:>6} start  avg={stats.avg:.1f}  peak={stats.peak}  ({stats.sessions} sessions)"
                )
        lines.append("")
        lines.append(
            "Use this data to decide: which levels draw well on this day, "
            "and which specific time slots get the most members on court.\n"
            "NOTE: Historical start hours may not align exactly with the free slot boundaries — "
            "map each to the nearest available slot in the FREE SLOTS list above."
        )
    else:
        lines.append("ATTENDANCE HISTORY: No data available yet — use general scheduling judgment.")
    lines.append("")

    # ── Time patterns (scheduling consistency) ────────────────────────────
    time_patterns = load_time_patterns()
    day_patterns = {
        eid: tp
        for (eid, dow), tp in time_patterns.items()
        if dow == day_name and eid in APPROVED_EVENTS
    }
    if day_patterns:
        lines.append(f"SCHEDULING PATTERNS — {day_name} tendencies (not hard rules, but worth preserving):")
        lines.append(
            "Members build habits. If a level has consistently started at the same time, "
            "try to match it — schedule predictability matters for member experience."
        )
        for eid, tp in sorted(day_patterns.items(),
                               key=lambda x: APPROVED_EVENTS[x[0]]["level"]):
            level = APPROVED_EVENTS[eid]["level"]
            abbr  = _ABBREV[level]
            h     = tp.modal_hour
            strength = "strong" if tp.consistency_pct >= 80 else "moderate"
            time_label = f"{h % 12 or 12}{'am' if h < 12 else 'pm'}"
            lines.append(
                f"  {abbr:>2}  {level}: usually {time_label}  "
                f"({tp.consistency_pct:.0f}% of {tp.n_sessions} sessions — {strength} pattern, "
                f"avg {tp.avg_at_modal:.1f} members)"
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
