"""
Analyses the locally-stored historical reservations data to produce
popularity scores used by the recommender.

A popularity score is the average MembersCount for a given
(canonical_event_id, day_of_week, time_band) combination.

Event matching uses two strategies (in order):
  1. Exact EventId match against our 5 approved event IDs.
  2. Title-based match: detect the skill level from the event name,
     then map to the canonical approved event ID for that level.
     Only events whose names contain "open play" are matched this way —
     lessons, ratings sessions, contract times, and private bookings
     are excluded.

Falls back gracefully when no history file is present.
"""

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

HISTORY_FILE = Path(__file__).parent / "history" / "history_latest.json"

# 1-hour time bands so history reflects actual session start hours.
# Using 2-hour bands caused 9am sessions to appear as "8am band",
# leading the AI to recommend 8am slots for levels that never ran at 8am.
TIME_BANDS = [
    ("0600",  6,  7),
    ("0700",  7,  8),
    ("0800",  8,  9),
    ("0900",  9, 10),
    ("1000", 10, 11),
    ("1100", 11, 12),
    ("1200", 12, 13),
    ("1300", 13, 14),
    ("1400", 14, 15),
    ("1500", 15, 16),
    ("1600", 16, 17),
    ("1700", 17, 18),
    ("1800", 18, 19),
    ("1900", 19, 20),
    ("2000", 20, 24),
]

# Canonical approved event IDs (must stay in sync with recommender.py)
APPROVED_EVENT_IDS = {
    1717147: "Beginner",
    1717131: "Advanced Beginner",
    1931656: "Intermediate",
    1672774: "Advanced Intermediate",
    1633147: "Advanced",
}

# Reverse map: level name → canonical event ID
_LEVEL_TO_ID = {v: k for k, v in APPROVED_EVENT_IDS.items()}

# Level keywords — longest first so "Advanced Intermediate" matches before "Advanced"
_LEVEL_KEYWORDS = sorted(APPROVED_EVENT_IDS.values(), key=len, reverse=True)


def _canonical_event_id(raw_eid, event_name: str):
    """
    Return the canonical approved event ID for a history record, or None.

    Strategy:
      1. If raw_eid is already one of our 5 approved IDs → use it directly.
      2. If the event name contains "open play" → detect level from title
         and map to our canonical ID for that level.
      3. Otherwise → None (record is excluded from popularity scores).
    """
    # Strategy 1: direct ID match
    try:
        eid = int(raw_eid) if raw_eid is not None else None
    except (ValueError, TypeError):
        eid = None

    if eid in APPROVED_EVENT_IDS:
        return eid

    # Strategy 2: title-based match (open play events only)
    name_lower = (event_name or "").lower()
    if "open play" not in name_lower:
        return None

    for level in _LEVEL_KEYWORDS:
        if level.lower() in name_lower:
            return _LEVEL_TO_ID[level]

    return None


class PopularityKey(NamedTuple):
    event_id:    int
    day_of_week: str   # "Monday", "Tuesday", …
    time_band:   str   # "0800", "1000", "1400", …


def _time_band(dt: datetime) -> str:
    h = dt.hour
    for name, lo, hi in TIME_BANDS:
        if lo <= h < hi:
            return name
    return "2000"


class PopularityStats(NamedTuple):
    avg:      float
    peak:     int
    sessions: int


def load_popularity(history_file: Path = HISTORY_FILE) -> dict[PopularityKey, float]:
    """
    Load history and return a dict mapping PopularityKey → avg MembersCount.
    Returns an empty dict (all scores implicitly 0) when no history exists.
    """
    return {k: v.avg for k, v in load_popularity_full(history_file).items()}


def load_popularity_full(history_file: Path = HISTORY_FILE) -> dict[PopularityKey, PopularityStats]:
    """
    Load history and return full stats (avg, peak, session count) per key.
    Returns an empty dict when no history exists.
    """
    if not history_file.exists():
        return {}

    with open(history_file) as f:
        items = json.load(f)

    # Accumulate: key → list of attendance counts
    buckets: dict[PopularityKey, list[int]] = defaultdict(list)

    for item in items:
        event_name = item.get("EventName") or ""
        raw_eid    = item.get("EventId")
        eid = _canonical_event_id(raw_eid, event_name)
        if eid is None:
            continue

        dt    = datetime.fromisoformat(item["StartDateTime"])
        dow   = item.get("DayOfTheWeek") or dt.strftime("%A")
        band  = _time_band(dt)
        count = int(item.get("MembersCount") or 0)

        buckets[PopularityKey(eid, dow, band)].append(count)

    return {
        key: PopularityStats(
            avg=round(sum(vals) / len(vals), 1),
            peak=max(vals),
            sessions=len(vals),
        )
        for key, vals in buckets.items()
    }


class TimePattern(NamedTuple):
    modal_hour:      int    # most common start hour (0-23)
    consistency_pct: float  # % of sessions at modal hour
    n_sessions:      int    # total sessions for this (event, day)
    avg_at_modal:    float  # avg attendance at the modal time


def load_time_patterns(
    history_file: Path = HISTORY_FILE,
    min_sessions: int = 3,
    min_consistency: float = 0.60,
) -> dict[tuple[int, str], TimePattern]:
    """
    Identify recurring start-time tendencies from history.

    Returns a dict keyed by (event_id, day_of_week) where the pattern is
    strong enough to be worth surfacing to the AI:
      - at least min_sessions total sessions for that (event, day)
      - the modal start hour accounts for >= min_consistency of those sessions

    Only approved event IDs are included.
    """
    if not history_file.exists():
        return {}

    with open(history_file) as f:
        items = json.load(f)

    # Accumulate start hours and attendance per (event_id, day_of_week, hour)
    hour_counts:      dict[tuple, list[int]] = defaultdict(list)   # key=(eid,dow,hour) → [attendance]
    session_totals:   dict[tuple, int]       = defaultdict(int)    # key=(eid,dow) → total sessions

    for item in items:
        event_name = item.get("EventName") or ""
        raw_eid    = item.get("EventId")
        eid = _canonical_event_id(raw_eid, event_name)
        if eid is None:
            continue

        dt    = datetime.fromisoformat(item["StartDateTime"])
        dow   = item.get("DayOfTheWeek") or dt.strftime("%A")
        hour  = dt.hour
        count = int(item.get("MembersCount") or 0)

        hour_counts[(eid, dow, hour)].append(count)
        session_totals[(eid, dow)] += 1

    patterns: dict[tuple[int, str], TimePattern] = {}

    for (eid, dow), total in session_totals.items():
        if total < min_sessions:
            continue

        # Find the modal hour and its session count
        modal_hour = max(
            (h for e, d, h in hour_counts if e == eid and d == dow),
            key=lambda h: len(hour_counts[(eid, dow, h)]),
        )
        modal_n    = len(hour_counts[(eid, dow, modal_hour)])
        consistency = modal_n / total

        if consistency < min_consistency:
            continue

        avg_at_modal = sum(hour_counts[(eid, dow, modal_hour)]) / modal_n

        patterns[(eid, dow)] = TimePattern(
            modal_hour      = modal_hour,
            consistency_pct = round(consistency * 100, 0),
            n_sessions      = total,
            avg_at_modal    = round(avg_at_modal, 1),
        )

    return patterns


def popularity_score(
    scores: dict[PopularityKey, float],
    event_id: int,
    day_of_week: str,
    slot_start: datetime,
) -> float:
    """
    Return the avg attendance for this event on this day/time-band.
    Returns 0.0 when no history exists for the combination.
    """
    key = PopularityKey(event_id, day_of_week, _time_band(slot_start))
    return scores.get(key, 0.0)


def summary(scores: dict[PopularityKey, float]) -> list[dict]:
    """
    Return a sorted list of dicts for display / debugging.
    Each dict: event_id, day_of_week, time_band, avg_attendance.
    """
    rows = [
        {
            "event_id":       k.event_id,
            "day_of_week":    k.day_of_week,
            "time_band":      k.time_band,
            "avg_attendance": round(v, 1),
        }
        for k, v in scores.items()
    ]
    return sorted(rows, key=lambda r: -r["avg_attendance"])
