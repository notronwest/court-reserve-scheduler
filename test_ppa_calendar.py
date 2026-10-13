"""Proof for ppa_calendar — the parser, the floor, and the fail-safe chain.

The floor is the point. The first version of the parser understood only full month names,
found 1 range out of 12 on the tour's own page, and wrote it to the cache marked fresh.
A confidently wrong answer is worse than a failed fetch, so these tests pin the shapes that
must be rejected as loudly as the ones that must be accepted.
"""
import datetime
import ppa_calendar as ppa


def test_abbreviated_months_parse():
    # The tour's page writes "Oct 12-18, 2026", not "October".
    got = ppa.parse_ranges("Oct 12–18, 2026 and Nov 2–8, 2026")
    assert got == [("2026-10-12", "2026-10-18"), ("2026-11-02", "2026-11-08")], got


def test_full_month_names_still_parse():
    got = ppa.parse_ranges("October 12–18, 2026")
    assert got == [("2026-10-12", "2026-10-18")], got


def test_range_spanning_two_months():
    got = ppa.parse_ranges("Oct 30 – Nov 1, 2026")
    assert got == [("2026-10-30", "2026-11-01")], got


def test_range_spanning_the_new_year():
    # December into January is the next year, not a backwards range.
    got = ppa.parse_ranges("Dec 28 – Jan 3, 2026")
    assert got == [("2026-12-28", "2027-01-03")], got


def test_championship_sunday_is_the_LAST_day_only():
    events = [
        ("ends Sunday", "2026-10-12", "2026-10-18"),   # Sunday finish -> counts
        ("ends Saturday", "2026-10-28", "2026-10-31"), # Saturday finish -> does not
    ]
    assert ppa.championship_sundays(events) == ["2026-10-18"]


def test_a_sunday_in_the_MIDDLE_is_not_a_championship_sunday():
    # Mon 10/12 to Fri 10/23 contains two Sundays and finishes on neither.
    assert ppa.championship_sundays([("x", "2026-10-12", "2026-10-23")]) == []


def test_two_stops_ending_the_same_sunday_are_one_date():
    events = [("a", "2026-10-12", "2026-10-18"), ("b", "2026-10-14", "2026-10-18")]
    assert ppa.championship_sundays(events) == ["2026-10-18"]


def test_the_seed_alone_produces_the_known_sundays():
    got = ppa.championship_sundays(ppa.SEED_EVENTS)
    for expected in ["2026-10-18", "2026-10-25", "2026-11-01", "2026-11-08",
                     "2026-11-22", "2026-11-29", "2026-12-06", "2026-12-13"]:
        assert expected in got, (expected, got)
    # Nanjing ends Saturday 10/31 and Tokyo on a Wednesday — neither is a Sunday.
    assert "2026-10-31" not in got
    assert "2026-12-09" not in got


def test_every_seed_sunday_really_is_a_sunday():
    for d in ppa.championship_sundays(ppa.SEED_EVENTS):
        assert datetime.date.fromisoformat(d).weekday() == 6, d


def test_is_championship_sunday_reads_the_list_it_is_given():
    data = {"sundays": ["2026-10-18"]}
    assert ppa.is_championship_sunday("2026-10-18", data) is True
    assert ppa.is_championship_sunday(datetime.date(2026, 10, 18), data) is True
    assert ppa.is_championship_sunday("2026-10-19", data) is False


def test_fetch_refuses_a_thin_parse(monkeypatch):
    # The exact bug: a page shape change yields one range. It must raise, not cache.
    monkeypatch.setattr(ppa, "parse_ranges", lambda _t: [("2027-05-10", "2027-05-16")])
    monkeypatch.setattr(ppa.urllib.request, "urlopen", _fake_page())
    try:
        ppa.fetch()
    except ValueError as exc:
        assert "date range" in str(exc)
    else:
        raise AssertionError("a 1-range parse was accepted")


def test_fetch_refuses_an_archive_page(monkeypatch):
    # Plenty of ranges, all years away: that is an archive, not the live schedule.
    old = [(f"2019-0{i}-01", f"2019-0{i}-07") for i in range(1, 8)]
    monkeypatch.setattr(ppa, "parse_ranges", lambda _t: old)
    monkeypatch.setattr(ppa.urllib.request, "urlopen", _fake_page())
    try:
        ppa.fetch()
    except ValueError as exc:
        assert "near today" in str(exc)
    else:
        raise AssertionError("an archive page was accepted as the live schedule")


def test_load_falls_back_to_the_seed_and_says_it_is_stale(monkeypatch, tmp_path):
    monkeypatch.setattr(ppa, "CACHE_FILE", tmp_path / "none.json")
    def boom(*_a, **_k):
        raise OSError("network down")
    monkeypatch.setattr(ppa, "fetch", boom)
    out = ppa.load()
    assert out["origin"] == "seed"
    assert out["stale"] is True
    assert "2026-10-18" in out["sundays"]
    # NEVER empty: an empty list reads as "no PPA Sundays" and would cancel every slot.
    assert out["sundays"]


class _fake_page:
    def __call__(self, *_a, **_k):
        return self
    def __enter__(self):
        return self
    def __exit__(self, *_a):
        return False
    def read(self):
        return b"<html>Oct 12-18, 2026</html>"
