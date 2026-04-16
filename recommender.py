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
from history_analysis import load_popularity, popularity_score

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
    # Multi-court fixed events: book primary court first, then edit to add these
    extra_court_ids:  list = None   # additional court IDs to add via edit step
    extra_court_nums: list = None   # matching court numbers (for display)
    max_participants: int  = 0      # set MaxPeople on edit form if > 0

    def __post_init__(self):
        if self.extra_court_ids is None:
            self.extra_court_ids = []
        if self.extra_court_nums is None:
            self.extra_court_nums = []

    @property
    def is_multi_court(self) -> bool:
        return bool(self.extra_court_ids)

    def display(self) -> str:
        if self.extra_court_nums:
            courts_str = ", ".join(f"#{n}" for n in [self.court_num] + self.extra_court_nums)
            court_part = f"Courts {courts_str}"
        else:
            court_part = f"Court #{self.court_num}"
        suffix = f"  (max {self.max_participants})" if self.max_participants else ""
        return (
            f"{self.start.strftime('%-I:%M %p')} – {self.end.strftime('%-I:%M %p')}  "
            f"{court_part}  [{self.level:<22}]  {self.event_name}{suffix}"
        )

    def to_dict(self) -> dict:
        return {
            "event_id":        self.event_id,
            "event_name":      self.event_name,
            "level":           self.level,
            "court_num":       self.court_num,
            "court_id":        self.court_id,
            "court_label":     self.court_label,
            "extra_court_ids": self.extra_court_ids,
            "extra_court_nums":self.extra_court_nums,
            "max_participants":self.max_participants,
            "date":            self.start.strftime("%-m/%-d/%Y"),
            "start_time":      self.start.strftime("%-I:%M %p"),
            "end_time":        self.end.strftime("%-I:%M %p"),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Recommendation":
        """Reconstruct a Recommendation from a to_dict() snapshot."""
        from datetime import datetime as _dt
        date_str  = d["date"]
        start_str = d["start_time"]
        end_str   = d["end_time"]
        start = _dt.strptime(f"{date_str} {start_str}", "%m/%d/%Y %I:%M %p")
        end   = _dt.strptime(f"{date_str} {end_str}",   "%m/%d/%Y %I:%M %p")
        return cls(
            event_id        = d["event_id"],
            event_name      = d["event_name"],
            level           = d["level"],
            court_num       = d["court_num"],
            court_id        = d["court_id"],
            court_label     = d.get("court_label", f"Pickleball-Court #{d['court_num']}"),
            start           = start,
            end             = end,
            extra_court_ids = d.get("extra_court_ids", []),
            extra_court_nums= d.get("extra_court_nums", []),
            max_participants= d.get("max_participants", 0),
        )


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
    *,
    llm: bool = False,
) -> tuple[list[Recommendation], dict]:
    """
    Returns (recommendations, stats).

    Applies all hard constraints from policy.json in precedence order:
      1. No same-court overlap with existing events
      2. One court per recommended event
      3. Max N occurrences of same EventId per day (existing + recommended)
      4. All five levels covered when possible
      5. Fill to utilization target

    Pass llm=True to replace Pass 1+2 with a Claude API call.
    Falls back to rule-based automatically if the API call fails.
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

    # ── Existing level saturation ─────────────────────────────────────────────
    # Count how many sessions of each skill level are ALREADY on the schedule
    # today — including non-approved events and fixed recurring events.
    # Used to avoid over-recommending levels that are already well-covered.
    level_counts: dict[str, int] = {level: 0 for level in LEVEL_ORDER}

    def _detect_level(name: str):
        """Return the skill level for an event name, or None if unrecognised."""
        n = name.lower()
        for level in sorted(LEVEL_ORDER, key=len, reverse=True):
            if level.lower() in n:
                return level
        return None

    # Count from live schedule items
    for item in schedule_items:
        item_dt = datetime.fromisoformat(item["StartDateTime"])
        if item_dt.strftime("%Y-%m-%d") != date_str:
            continue
        name = item.get("EventName") or item.get("ReservationType") or ""
        level = _detect_level(name)
        if level:
            level_counts[level] += 1

    # Also count fixed recurring events for this day of the week — these may
    # not yet be on the live schedule if we're looking ahead, but we know
    # they will be there.
    for fe in policy.get("fixed_events", {}).get("events", []):
        if fe.get("day_of_week") == day_name and fe.get("level") in level_counts:
            level_counts[fe["level"]] += 1

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

    # ── Load historical popularity scores ────────────────────────────────────
    pop_scores = load_popularity()   # empty dict → scores all 0, no change in behaviour

    def _pop(eid: int, slot_start: datetime) -> float:
        return popularity_score(pop_scores, eid, day_name, slot_start)

    def _time_pref(slot_start: datetime) -> float:
        """Time-of-day preference [0–1] used as a tiebreaker when history is absent.
        Reflects when members actually show up — peaks at midday/early afternoon.
        History dominates whenever a real popularity score exists.
        """
        h = slot_start.hour + slot_start.minute / 60
        if h < 9:
            return 0.0    # before 9 AM — avoid unless history says otherwise
        elif h < 10:
            return 0.4    # 9–10 AM — acceptable
        elif h < 12:
            return 0.7    # 10 AM–noon — good
        elif h < 17:
            return 1.0    # noon–5 PM — peak hours
        elif h < 19:
            return 0.7    # 5–7 PM — still reasonable
        else:
            return 0.3    # after 7 PM — low preference

    # ── Build recommendations ─────────────────────────────────────────────────
    recommendations: list[Recommendation] = []
    used: list[tuple[int, datetime, datetime]] = []  # (court_num, start, end)
    levels_covered: set[str] = set()

    def rec_free(court_num: int, ss: datetime, se: datetime) -> bool:
        for cn, us, ue in used:
            if cn == court_num and _overlaps(ss, se, us, ue):
                return False
        return True

    def already_on_schedule(court_num: int, ss: datetime, se: datetime) -> bool:
        """True if an existing event already occupies this court/time."""
        for e in existing:
            if e["court_num"] == court_num and _overlaps(ss, se, e["start"], e["end"]):
                return True
        return False

    def add(eid: int, cn: int, ss: datetime, se: datetime,
            extra_court_nums=None, max_participants=0):
        extra = extra_court_nums or []
        recommendations.append(Recommendation(
            event_id         = eid,
            event_name       = APPROVED_EVENTS[eid]["name"],
            level            = APPROVED_EVENTS[eid]["level"],
            court_num        = cn,
            court_id         = COURTS[cn]["id"],
            court_label      = COURTS[cn]["label"],
            start            = ss,
            end              = se,
            extra_court_ids  = [COURTS[c]["id"] for c in extra],
            extra_court_nums = list(extra),
            max_participants = max_participants,
        ))
        # Mark ALL courts (primary + extra) as used so Pass 1/2 won't double-book them
        used.append((cn, ss, se))
        for ecn in extra:
            used.append((ecn, ss, se))
        event_counts[eid] += 1
        levels_covered.add(APPROVED_EVENTS[eid]["level"])

    # ── Pass 0: Place fixed recurring events ─────────────────────────────────
    # Multi-court fixed events are booked as ONE occurrence on the primary court,
    # then edited to add extra courts and set max participants.
    # Skip any slot already occupied by a live schedule event.
    name_to_event_id = {v["name"].lower(): k for k, v in APPROVED_EVENTS.items()}

    for fe in policy.get("fixed_events", {}).get("events", []):
        if fe.get("day_of_week") != day_name:
            continue

        fe_start = datetime.strptime(f"{date_str} {fe['start_time']}", "%Y-%m-%d %H:%M")
        fe_end   = datetime.strptime(f"{date_str} {fe['end_time']}",   "%Y-%m-%d %H:%M")

        # Find matching approved event by level (closest match)
        fe_level = fe.get("level", "")
        eid = LEVEL_TO_EVENT_ID.get(fe_level)
        if not eid:
            continue

        # Determine courts to use — fixed events can span multiple courts
        n_courts_needed = fe.get("courts", 1)
        preferred = fe.get("preferred_courts", [])
        courts_assigned = []

        if n_courts_needed == 2 and not preferred:
            # Use the ranked pair list from policy — try each pair until one fits
            pairs = policy["recommendation_rules"].get("two_court_priority_pairs", [[4, 3], [4, 1], [1, 2], [2, 3]])
            for pair in pairs:
                if all(
                    cn in COURTS
                    and not already_on_schedule(cn, fe_start, fe_end)
                    and rec_free(cn, fe_start, fe_end)
                    for cn in pair
                ):
                    courts_assigned = list(pair)
                    break
        elif preferred:
            # Explicit preferred_courts on this fixed event — use them directly
            courts_assigned = [
                cn for cn in preferred
                if cn in COURTS
                and not already_on_schedule(cn, fe_start, fe_end)
                and rec_free(cn, fe_start, fe_end)
            ][:n_courts_needed]
        else:
            # Single-court: pick first available from court_order
            for cn in court_order:
                if len(courts_assigned) >= n_courts_needed:
                    break
                if cn in COURTS and not already_on_schedule(cn, fe_start, fe_end) and rec_free(cn, fe_start, fe_end):
                    courts_assigned.append(cn)

        if not courts_assigned:
            continue

        # Book as ONE occurrence on the primary court, then edit to add extras.
        # This matches Court Reserve's workflow: add date → edit to assign all
        # courts and set max participants.
        if event_counts[eid] < max_occ:
            primary = courts_assigned[0]
            extras  = courts_assigned[1:]
            max_p   = fe.get("max_participants", 0)
            add(eid, primary, fe_start, fe_end,
                extra_court_nums=extras, max_participants=max_p)

    # ── LLM path: replace Pass 1 + Pass 2 with Claude API call ──────────────
    llm_source = "rule_based"
    if llm:
        try:
            import logging as _logging
            from llm_ranker import call_llm_ranker
            _current_free = [(cn, ss, se) for cn, ss, se in free_slots if rec_free(cn, ss, se)]
            _llm_recs = call_llm_ranker(
                pass0_recs           = list(recommendations),
                free_slots           = _current_free,
                pop_scores           = pop_scores,
                policy               = policy,
                date_str             = date_str,
                day_name             = day_name,
                event_counts         = dict(event_counts),
                level_counts         = dict(level_counts),
                target_court_hours   = target_court_hours,
                existing_court_hours = existing_court_hours,
            )
            for rec in _llm_recs:
                # Re-validate before committing — guard against hallucinations
                if rec_free(rec.court_num, rec.start, rec.end) and event_counts.get(rec.event_id, 0) < max_occ:
                    add(rec.event_id, rec.court_num, rec.start, rec.end)
            llm_source = "llm"
        except Exception as _exc:
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "LLM ranker failed (%s: %s) — falling back to rule-based", type(_exc).__name__, _exc
            )
            llm_source = "fallback"
            llm = False  # fall through to Pass 1 + Pass 2 below

    if not llm:
        # Constraint 4 — Pass 1: ensure all 5 levels are represented.
        # Skip levels already saturated by existing events (configurable threshold).
        # For each missing level rank available slots by historical popularity so
        # we place the event in the time band where it has drawn best attendance.
        saturation_threshold = (
            policy["hard_constraints"]["4_required_level_coverage"].get("saturation_threshold", 2)
        )

        for level in LEVEL_ORDER:
            if level in levels_covered:
                continue
            # Skip if this level is already well-covered by existing events
            if saturation_threshold > 0 and level_counts.get(level, 0) >= saturation_threshold:
                levels_covered.add(level)  # count as covered — no new rec needed
                continue
            eid = LEVEL_TO_EVENT_ID[level]
            if event_counts[eid] >= max_occ:
                continue
            candidates = [(cn, ss, se) for cn, ss, se in free_slots if rec_free(cn, ss, se)]
            if not candidates:
                continue
            # Sort: highest popularity first; ties broken by time-of-day preference
            # (peak hours over early morning); further ties by earliest slot.
            candidates.sort(key=lambda s: (-_pop(eid, s[1]), -_time_pref(s[1]), s[1]))
            cn, ss, se = candidates[0]
            add(eid, cn, ss, se)

        # Constraint 5 — Pass 2: fill toward utilization target.
        # Sort slots by desirability first (peak hours > early morning) so we fill
        # the best time windows before falling back to fringe hours like 8 AM.
        # Within the same preference tier, earlier slots come first.
        added_hrs        = sum((se - ss).total_seconds() / 3600 for _, ss, se in used)
        remaining_needed = needed_court_hours - added_hrs

        fill_slots = sorted(free_slots, key=lambda s: (-_time_pref(s[1]), s[1]))
        for cn, ss, se in fill_slots:
            if remaining_needed <= 0:
                break
            if not rec_free(cn, ss, se):
                continue
            eligible = [
                (LEVEL_TO_EVENT_ID[l], l)
                for l in LEVEL_ORDER
                if event_counts[LEVEL_TO_EVENT_ID[l]] < max_occ
            ]
            if not eligible:
                break
            # Rank by:
            #  1. Fewest existing sessions of that level today (fill gaps first)
            #  2. Highest historical popularity for this time slot
            #  3. Time-of-day preference (peak hours > early morning) — tiebreaker
            #     when no history exists for this event/day/band combination
            #  4. Fewest recommended occurrences so far (balance within level)
            eligible.sort(key=lambda x: (
                level_counts[APPROVED_EVENTS[x[0]]["level"]] + event_counts[x[0]],
                -_pop(x[0], ss),
                -_time_pref(ss),
                event_counts[x[0]],
            ))
            eid, _ = eligible[0]
            slot_hrs = (se - ss).total_seconds() / 3600
            add(eid, cn, ss, se)
            remaining_needed -= slot_hrs

    # Sort by time, then court
    recommendations.sort(key=lambda r: (r.start, r.court_num))

    # ── Stats ─────────────────────────────────────────────────────────────────
    # Multi-court recommendations count N courts × duration (not 1 × duration)
    def _rec_hrs(r):
        return (r.end - r.start).total_seconds() / 3600 * (1 + len(r.extra_court_ids))

    added_total = sum(_rec_hrs(r) for r in recommendations)
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
        "popularity_used":         bool(pop_scores),
        "existing_level_counts":   dict(level_counts),
        "rec_source":              llm_source,
    }

    return recommendations, stats
