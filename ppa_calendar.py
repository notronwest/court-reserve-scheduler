"""PPA Championship Sundays — fetched, not hardcoded.

Ron, 2026-10-12, after a command-bar card refused an "every Sunday that has a PPA
Championship" cadence because it had no PPA schedule: *"Make sure that Court Reserve
Scheduler knows how to get the dates for the PPA Sundays. No more I can't."*

**What a Championship Sunday is.** A PPA tour stop runs several days and finishes with the
gold-medal matches. When that final day is a Sunday, that is a Championship Sunday — the
day members are most likely to want the club's screens on and a watch-party slot held.

**Why this fetches rather than storing a list.** A hardcoded list is correct until the tour
publishes its next block and then silently wrong, which is the failure that cannot be seen
from inside the club. This reads the tour's own events page, derives the Sundays, and caches
the result.

**Fail-safe, deliberately.** A fetch that fails returns the CACHE, and a cache that is
missing returns the SEED below — never an empty list. An empty list reads as "no PPA
Sundays", which would quietly cancel every watch-party slot; a stale list is visibly stale
(`fetched_at`) and still roughly right. Callers get `stale=True` so a surface can say so.

The seed is the 2026 schedule as published on 2026-10-12, kept so a brand-new install works
offline on day one.
"""
from __future__ import annotations

import datetime
import json
import re
import urllib.request
from pathlib import Path

PPA_EVENTS_URL = "https://www.ppatour.com/events/"
CACHE_FILE = Path(__file__).parent / "ppa_calendar_cache.json"
CACHE_MAX_AGE_DAYS = 7
#: A tour page lists many stops. Fewer than this means the page shape moved, not that the
#: tour shrank — see the floor in fetch().
MIN_PLAUSIBLE_EVENTS = 5
#: At least one stop must finish within this many days of today, or we are reading an
#: archive page rather than the live schedule.
NEAR_HORIZON_DAYS = 120

# The 2026 tour as published 2026-10-12. Each entry is (event name, first day, last day).
SEED_EVENTS: list[tuple[str, str, str]] = [
    ("Mojo Energy Pouches Virginia Beach Open", "2026-10-12", "2026-10-18"),
    ("WALKER Australia Pickleball Cup", "2026-10-14", "2026-10-18"),
    ("Hang Seng Bank Hong Kong Slam", "2026-10-19", "2026-10-25"),
    ("PPA Canada Ottawa 125", "2026-10-22", "2026-10-25"),
    ("Skechers Nanjing Challenger", "2026-10-28", "2026-10-31"),
    ("College World Championship", "2026-10-30", "2026-11-01"),
    ("Opendoor Pickleball World Championships", "2026-11-02", "2026-11-08"),
    ("Proton Daytona Beach Open", "2026-11-16", "2026-11-22"),
    ("PPA Canada Toronto 125", "2026-11-26", "2026-11-29"),
    ("PPA Canada Vancouver 125", "2026-12-03", "2026-12-06"),
    ("PJ Tokyo Challenger", "2026-12-07", "2026-12-09"),
    ("PPA125 Adelaide", "2026-12-10", "2026-12-13"),
]

_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"]
# Keyed on the first THREE letters, because the tour's own page writes "Oct 12-18, 2026".
# Matching only full names found one range out of twelve and cached it as fresh.
_MONTHS = {m[:3]: i for i, m in enumerate(_MONTH_NAMES, start=1)}


def _month(name: str) -> int | None:
    return _MONTHS.get((name or "").strip().lower()[:3])

# "October 12–18, 2026" / "October 30 – November 1, 2026" / "December 3-6, 2026"
_RANGE = re.compile(
    r"([A-Z][a-z]+)\s+(\d{1,2})\s*[–—-]\s*(?:([A-Z][a-z]+)\s+)?(\d{1,2}),\s*(\d{4})")


def parse_ranges(text: str) -> list[tuple[str, str]]:
    """Every (first day, last day) date range in a blob of page text, ISO, in order seen."""
    out: list[tuple[str, str]] = []
    for m in _RANGE.finditer(text):
        m1, d1, m2, d2, year = m.groups()
        a = _month(m1)
        b = _month(m2 or m1)
        if not a or not b:
            continue
        try:
            start = datetime.date(int(year), a, int(d1))
            # A range that wraps the new year ends in the following one.
            end_year = int(year) + 1 if b < a else int(year)
            end = datetime.date(end_year, b, int(d2))
        except ValueError:
            continue
        if end >= start:
            out.append((start.isoformat(), end.isoformat()))
    return out


def championship_sundays(events: list[tuple[str, str, str]]) -> list[str]:
    """The Sundays an event FINISHES on, de-duplicated and sorted.

    The last day is what matters: gold medals are played on it. A Sunday in the middle of a
    stop is not a Championship Sunday, and two stops ending the same Sunday are one date.
    """
    days: set[str] = set()
    for _name, _start, end in events:
        d = datetime.date.fromisoformat(end)
        if d.weekday() == 6:  # Sunday
            days.add(d.isoformat())
    return sorted(days)


def _read_cache() -> dict | None:
    try:
        with open(CACHE_FILE) as fh:
            return json.load(fh)
    except Exception:
        return None


def _write_cache(payload: dict) -> None:
    try:
        with open(CACHE_FILE, "w") as fh:
            json.dump(payload, fh, indent=2)
    except Exception:
        pass            # a cache we cannot write is not a reason to fail the caller


def fetch(timeout: int = 20) -> dict:
    """Read the tour's events page and derive the Championship Sundays.

    Returns {"sundays": [...], "events": [...], "fetched_at": iso, "source": ...}.
    Raises on a network or parse failure — `load()` is what callers want.
    """
    req = urllib.request.Request(PPA_EVENTS_URL, headers={"User-Agent": "wmpc-scheduler/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        html = resp.read().decode("utf-8", "replace")
    text = re.sub(r"<[^>]+>", " ", html)
    ranges = parse_ranges(text)
    # A FLOOR, not a nicety. The first version of this parser understood only full month
    # names, found 1 range out of 12, and wrote it to the cache marked fresh — a confidently
    # wrong answer, which is worse than a failed fetch. A real tour page always carries many
    # stops, several of them near today, so a thin or far-off result is treated as a failure
    # and the caller falls back to the cache or the seed.
    if len(ranges) < MIN_PLAUSIBLE_EVENTS:
        raise ValueError(f"only {len(ranges)} date range(s) parsed — page shape changed?")
    today = datetime.date.today()
    horizon = today + datetime.timedelta(days=NEAR_HORIZON_DAYS)
    near = [r for r in ranges if today - datetime.timedelta(days=30)
            <= datetime.date.fromisoformat(r[1]) <= horizon]
    if not near:
        raise ValueError("no events anywhere near today — page shape changed?")
    events = [("", a, b) for a, b in ranges]
    return {
        "sundays": championship_sundays(events),
        "events": [{"start": a, "end": b} for a, b in ranges],
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "source": PPA_EVENTS_URL,
    }


def load(refresh: bool = False) -> dict:
    """Championship Sundays, with the fail-safe chain: live → cache → seed.

    `stale` is True whenever the list did not come from a fetch in this call or a cache
    younger than CACHE_MAX_AGE_DAYS, so a caller can say so rather than present an old
    list as current.
    """
    cache = _read_cache()
    if cache and not refresh:
        try:
            age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(
                cache["fetched_at"])
            if age.days < CACHE_MAX_AGE_DAYS:
                return {**cache, "stale": False, "origin": "cache"}
        except Exception:
            pass
    try:
        fresh = fetch()
        _write_cache(fresh)
        return {**fresh, "stale": False, "origin": "live"}
    except Exception as exc:
        if cache:
            return {**cache, "stale": True, "origin": "cache", "error": str(exc)[:160]}
        return {
            "sundays": championship_sundays(SEED_EVENTS),
            "events": [{"start": a, "end": b} for _n, a, b in SEED_EVENTS],
            "fetched_at": "2026-10-12T00:00:00+00:00",
            "source": "seed (published schedule, 2026-10-12)",
            "stale": True, "origin": "seed", "error": str(exc)[:160],
        }


def is_championship_sunday(day: datetime.date | str, data: dict | None = None) -> bool:
    """Is this date a Championship Sunday? The question a scheduling rule actually asks."""
    d = day.isoformat() if isinstance(day, datetime.date) else str(day)
    return d in set((data or load())["sundays"])


if __name__ == "__main__":
    import sys
    out = load(refresh="--refresh" in sys.argv)
    print(f"origin={out['origin']} stale={out['stale']} fetched_at={out['fetched_at']}")
    if out.get("error"):
        print(f"note: {out['error']}")
    for s in out["sundays"]:
        print(" ", s, datetime.date.fromisoformat(s).strftime("%A %B %-d, %Y"))
