"""
Analyses the locally-stored historical reservations data to produce
popularity scores used by the recommender.

A popularity score is the average MembersCount for a given
(event_id, day_of_week, time_band) combination over the history window.

Falls back gracefully when no history file is present — every score
returns 0.0 so the recommender runs unchanged.
"""

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

HISTORY_FILE = Path(__file__).parent / "history" / "history_latest.json"

# Time bands must match policy.json / recommender.py
TIME_BANDS = [
    ("morning",   6,  12),
    ("midday",   12,  15),
    ("afternoon", 15, 18),
    ("evening",  18,  24),
]


class PopularityKey(NamedTuple):
    event_id:    int
    day_of_week: str   # "Monday", "Tuesday", …
    time_band:   str   # "morning", "midday", "afternoon", "evening"


def _time_band(dt: datetime) -> str:
    h = dt.hour
    for name, lo, hi in TIME_BANDS:
        if lo <= h < hi:
            return name
    return "evening"


def load_popularity(history_file: Path = HISTORY_FILE) -> dict[PopularityKey, float]:
    """
    Load history and return a dict mapping PopularityKey → avg MembersCount.
    Returns an empty dict (all scores implicitly 0) when no history exists.
    """
    if not history_file.exists():
        return {}

    with open(history_file) as f:
        items = json.load(f)

    # Accumulate: key → list of attendance counts
    buckets: dict[PopularityKey, list[int]] = defaultdict(list)

    for item in items:
        eid = item.get("EventId")
        if not eid:
            continue
        try:
            eid = int(eid)
        except (ValueError, TypeError):
            continue

        dt  = datetime.fromisoformat(item["StartDateTime"])
        dow = item.get("DayOfTheWeek") or dt.strftime("%A")
        band = _time_band(dt)
        count = int(item.get("MembersCount") or 0)

        buckets[PopularityKey(eid, dow, band)].append(count)

    return {key: sum(vals) / len(vals) for key, vals in buckets.items()}


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
