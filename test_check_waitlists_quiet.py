"""The waitlist alert posts quietly: flags 4096 and no @mention can ring (D-0308)."""
import os

os.environ.setdefault("DISCORD_WEBHOOK_URL", "https://discord.example/api/webhooks/1/x")

import requests

import check_waitlists

FLAG = 4096


class _Resp:
    def raise_for_status(self):
        pass

    def json(self):
        return {"id": "m1"}


def test_quiet_payload_ors_into_existing_flags_never_doubles():
    assert check_waitlists.quiet_payload({})["flags"] == FLAG
    assert check_waitlists.quiet_payload({"flags": 64})["flags"] == 64 | FLAG
    assert check_waitlists.quiet_payload({"flags": FLAG})["flags"] == FLAG


def test_waitlist_alert_body_carries_flag_and_no_mentions(monkeypatch):
    sent = {}
    monkeypatch.setattr(check_waitlists, "WEBHOOK_URL", "https://discord.example/x")
    monkeypatch.setattr(requests, "post",
                        lambda url, json=None, **kw: sent.update(json) or _Resp())
    alert = {"registered": 8, "waitlist": 2, "max_people": 8, "res_id": 1,
             "event_name": "Open Play", "date_text": "d", "time_text": "t", "courts_text": "Court 1"}
    proposal = {"new_max": 10, "all_court_nums": [1, 2], "num_courts_after": 2, "per_court": 5}
    assert check_waitlists.post_discord_alert(alert, proposal) == "m1"
    assert sent["flags"] & FLAG
    assert sent["allowed_mentions"] == {"parse": []}
