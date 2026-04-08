"""
Scheduling recommender for White Mountain Pickleball.
Pure Python — no browser dependency.

Usage:
    from recommender import recommend
    recs, stats = recommend(schedule_items, "4/16/2026", policy)
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

# ── Static configuration ─────────────────────────────────────────────────────

COURTS = {
    1: {"id": 52349, "label": "Pickleball-Court #1"},
    2: {"id": 52350, "label": "Pickleball-Court #2"},
    3: {"id": 52351, "label": "Pickleball-Court #3"},
    4: {"id": 52352, "label": "Pickleball-Court #4"},
}

APPROVED_EVENTS = {
    1717147: {"name": "Co-Ed Beginner Open Play",              "level": "Beginner"},
    1717131: {"name": "Co-Ed Advanced Beginner Open Play",     "level": "Advanced Beginner"},
    1931656: {"name": "Co-ed Intermediate Open Play",          "level": "Intermediate"},
    1672774: {"name": "Co-ed Advanced Intermediate Open Play", "level": "Advanced Intermediate"},
    1633147: {"name": "Co-ed Advanced Open Play",              "level": "Advanced"},
}

LEVEL_ORDER = [
    "Beginner",
    "Advanced Beginner",
    "Intermediate",
    "Advanced Intermediate",
    "Advanced",
]

LEVEL_TO_EVENT_ID = {v["level"]: k for k, v in APPROVED_EVENTS.items()}


# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class Recommendation:
    event_id:    int
    event_name:  str
    level:       str
    court_num:   int
    court_id:    int
    court_label: str
    start:       datetime
    end:         datetime

    def display(self) -> str:
        return (
            f"{self.start.strftime('%-I:%M %p')} – {self.end.strftime('%-I:%M %p')}  "
            f"Court #{self.court_num}  [{self.level:<22}]  {self.event_name}"
        )

    def to_dict(self) -> dict:
        return {
            "event_id":    self.event_id,
            "event_name":  self.event_name,
            "level":       self.level,
            "court_num":   self.court_num,
            "court_id":    self.court_id,
            "court_label": self.court_label,
            "date":        self.start.strftime("%-m/%-d/%Y"),
            "start_time":  self.start.strftime("%-I:%M %p"),
            "end_time":    self.end.strftime("%-I:%M %p"),
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_date(date_str: str) -> datetime:
    """Accept 'M/D/YYYY' or 'YYYY-MM-DD'."""
    for fmt in ("%-m/%-d/%Y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            pass
    raise ValueError(f"Cannot parse date: {date_str!r}")


def _parse_court_nums(courts_str: str) -> list[int]:
    """'Court #1, Court #2' → [1, 2]"""
    return [int(m) for m in re.findall(r"Court #(\d+)", courts_str or "")]


def _overlaps(s1: datetime, e1: datetime, s2: datetime, e2: datetime) -> bool:
    return s1 < e2 and e1 > s2


# ── Main recommender ──────────────────────────────────────────────────────────

def recommend(
    schedule_items: list[dict],
    target_date: str,
    policy: dict,
) -> tuple[list[Recommendation], dict]:
    """
    Returns (recommendations, stats).

    Applies all hard constraints from policy.json in precedence order:
      1. No same-court overlap with existing events
      2. One court per recommended event
      3. Max N occurrences of same EventId per day (existing + recommended)
      4. All five levels covered when possible
      5. Fill to utilization target
    """

    td = _parse_date(target_date)
    date_str = td.strftime("%Y-%m-%d")
    day_name  = td.strftime("%A")

    # Operating window
    weekdays = policy["operating_windows"]["weekday"]["days"]
    if day_name in weekdays:
        window    = policy["operating_windows"]["weekday"]
        block_hrs = policy["recommendation_rules"]["preferred_block_duration_hours"]["weekday"]
    else:
        window    = policy["operating_windows"]["weekend"]
        block_hrs = policy["recommendation_rules"]["preferred_block_duration_hours"]["weekend"]

    win_start = datetime.strptime(f"{date_str} {window['start']}", "%Y-%m-%d %H:%M")
    win_end   = datetime.strptime(f"{date_str} {window['end']}",   "%Y-%m-%d %H:%M")
    win_hours = window["hours"]

    # ── Parse existing events for target date ────────────────────────────────
    existing: list[dict] = []
    for item in schedule_items:
        item_start = datetime.fromisoformat(item["StartDateTime"])
        if item_start.strftime("%Y-%m-%d") != date_str:
            continue
        item_end = datetime.fromisoformat(item["EndDateTime"])
        court_nums = _parse_court_nums(item.get("Courts", ""))
        eid = item.get("EventId")
        for cn in court_nums:
            if cn in COURTS:
                existing.append({
                    "court_num": cn,
                    "start":     item_start,
                    "end":       item_end,
                    "event_id":  eid,
                    "name":      (item.get("EventName") or "").strip(),
                })

    # ── Utilization baseline ─────────────────────────────────────────────────
    n_courts   = policy["utilization"]["baseline_courts"]
    target_pct = policy["utilization"]["target_pct"] / 100.0

    existing_court_hours = 0.0
    for e in existing:
        s   = max(e["start"], win_start)
        end = min(e["end"],   win_end)
        if end > s:
            existing_court_hours += (end - s).total_seconds() / 3600.0

    target_court_hours = target_pct * n_courts * win_hours
    needed_court_hours = max(0.0, target_court_hours - existing_court_hours)

    # ── Existing event occurrence counts ─────────────────────────────────────
    max_occ = policy["hard_constraints"]["3_max_occurrences_per_event_per_day"]["limit"]
    event_counts: dict[int, int] = {eid: 0 for eid in APPROVED_EVENTS}
    for e in existing:
        if e["event_id"] in event_counts:
            event_counts[e["event_id"]] += 1

    # ── Generate all free candidate slots ────────────────────────────────────
    preferred_court = policy["recommendation_rules"].get("preferred_court_when_free", 4)
    court_order     = [preferred_court] + [c for c in sorted(COURTS) if c != preferred_court]

    # All open play events are exactly 2 hours (hard rule)
    block = timedelta(hours=2)

    def existing_free(court_num: int, ss: datetime, se: datetime) -> bool:
        for e in existing:
            if e["court_num"] == court_num and _overlaps(ss, se, e["start"], e["end"]):
                return False
        return True

    free_slots: list[tuple[int, datetime, datetime]] = []
    t = win_start
    while t + block <= win_end:
        se = t + block
        for cn in court_order:
            if existing_free(cn, t, se):
                free_slots.append((cn, t, se))
        t += block

    # ── Spread: bucket free slots into time bands ─────────────────────────────
    spread_cfg = policy["recommendation_rules"].get("spread_throughout_day", {})
    spread_enabled = spread_cfg.get("enabled", False)

    def _band(slot_start: datetime) -> int:
        """Return band index 0–3 for a slot start time (for spread ordering)."""
        bands = spread_cfg.get("time_bands", {})
        band_list = [
            ("morning",   "09:00", "12:00"),
            ("midday",    "12:00", "15:00"),
            ("afternoon", "15:00", "18:00"),
            ("evening",   "18:00", "20:00"),
        ]
        for i, (name, bstart, bend) in enumerate(band_list):
            b_s = datetime.strptime(f"{slot_start.strftime('%Y-%m-%d')} {bstart}", "%Y-%m-%d %H:%M")
            b_e = datetime.strptime(f"{slot_start.strftime('%Y-%m-%d')} {bend}",   "%Y-%m-%d %H:%M")
            if b_s <= slot_start < b_e:
                return i
        return 99  # outside all bands

    if spread_enabled:
        # Group free slots by band
        from collections import defaultdict
        bands: dict[int, list] = defaultdict(list)
        for slot in free_slots:
            bands[_band(slot[1])].append(slot)

        # Interleave: one from each band in rotation
        spread_order: list[tuple[int, datetime, datetime]] = []
        band_keys = sorted(bands.keys())
        max_len = max((len(v) for v in bands.values()), default=0)
        for i in range(max_len):
            for bk in band_keys:
                if i < len(bands[bk]):
                    spread_order.append(bands[bk][i])
        free_slots = spread_order

    # ── Build recommendations ─────────────────────────────────────────────────
    recommendations: list[Recommendation] = []
    used: list[tuple[int, datetime, datetime]] = []  # (court_num, start, end)
    levels_covered: set[str] = set()

    def rec_free(court_num: int, ss: datetime, se: datetime) -> bool:
        for cn, us, ue in used:
            if cn == court_num and _overlaps(ss, se, us, ue):
                return False
        return True

    def add(eid: int, cn: int, ss: datetime, se: datetime):
        recommendations.append(Recommendation(
            event_id    = eid,
            event_name  = APPROVED_EVENTS[eid]["name"],
            level       = APPROVED_EVENTS[eid]["level"],
            court_num   = cn,
            court_id    = COURTS[cn]["id"],
            court_label = COURTS[cn]["label"],
            start       = ss,
            end         = se,
        ))
        used.append((cn, ss, se))
        event_counts[eid] += 1
        levels_covered.add(APPROVED_EVENTS[eid]["level"])

    # Constraint 4 — Pass 1: ensure all 5 levels are represented
    for level in LEVEL_ORDER:
        if level in levels_covered:
            continue
        eid = LEVEL_TO_EVENT_ID[level]
        if event_counts[eid] >= max_occ:
            continue
        for cn, ss, se in free_slots:
            if rec_free(cn, ss, se):
                add(eid, cn, ss, se)
                break

    # Constraint 5 — Pass 2: fill toward utilization target
    added_hrs       = sum((se - ss).total_seconds() / 3600 for _, ss, se in used)
    remaining_needed = needed_court_hours - added_hrs

    for cn, ss, se in free_slots:
        if remaining_needed <= 0:
            break
        if not rec_free(cn, ss, se):
            continue
        # Pick the level with fewest recs so far (balanced fill)
        for level in sorted(LEVEL_ORDER, key=lambda l: event_counts[LEVEL_TO_EVENT_ID[l]]):
            eid = LEVEL_TO_EVENT_ID[level]
            if event_counts[eid] < max_occ:
                slot_hrs = (se - ss).total_seconds() / 3600
                add(eid, cn, ss, se)
                remaining_needed -= slot_hrs
                break

    # Sort by time, then court
    recommendations.sort(key=lambda r: (r.start, r.court_num))

    # ── Stats ─────────────────────────────────────────────────────────────────
    added_total = sum((r.end - r.start).total_seconds() / 3600 for r in recommendations)
    achieved    = existing_court_hours + added_total
    max_possible = n_courts * win_hours

    stats = {
        "target_date":             td.strftime("%-m/%-d/%Y"),
        "day_of_week":             day_name,
        "existing_court_hours":    round(existing_court_hours, 1),
        "recommended_court_hours": round(added_total, 1),
        "achieved_court_hours":    round(achieved, 1),
        "target_court_hours":      round(target_court_hours, 1),
        "achieved_pct":            round(achieved / max_possible * 100, 1),
        "target_pct":              policy["utilization"]["target_pct"],
        "gap_court_hours":         round(max(0.0, target_court_hours - achieved), 1),
        "gap_pct_points":          round(max(0.0, (target_court_hours - achieved) / max_possible * 100), 1),
        "levels_covered":          sorted(levels_covered),
        "levels_missing":          [l for l in LEVEL_ORDER if l not in levels_covered],
        "min_recommendations_met": len(recommendations) >= policy["recommendation_rules"]["min_recommendations"],
        "n_recommendations":       len(recommendations),
    }

    return recommendations, stats
