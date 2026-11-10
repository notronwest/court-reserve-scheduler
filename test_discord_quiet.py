"""Every Discord POST from the Python posters carries SUPPRESS_NOTIFICATIONS (1 << 12).

Only a needs-you card with a button rings Ron's phone (D-0308); everything else posts quietly.
"""
import os

os.environ.setdefault("DISCORD_WEBHOOK_URL", "https://discord.example/api/webhooks/1/x")

import discord_notify
import discord_listener

FLAG = 1 << 12


class _Resp:
    status_code = 200
    text = ""

    def raise_for_status(self):
        pass

    def json(self):
        return {"id": "m1"}


def test_quiet_sets_the_bit_and_keeps_existing_flags():
    assert discord_notify.quiet({"content": "x"})["flags"] == FLAG
    assert discord_notify.quiet({"flags": 64})["flags"] == 64 | FLAG
    assert discord_notify.quiet({"flags": FLAG})["flags"] == FLAG


def test_notify_post_embed_carries_the_flag(monkeypatch):
    sent = {}
    monkeypatch.setattr(discord_notify, "WEBHOOK_URL", "https://discord.example/x")
    monkeypatch.setattr(discord_notify.requests, "post",
                        lambda url, json=None, **kw: sent.update(json) or _Resp())
    discord_notify._post_embed({"content": "results"}, {})
    assert sent["flags"] & FLAG


def test_notify_send_recommendations_carries_the_flag(monkeypatch):
    sent = {}
    monkeypatch.setattr(discord_notify, "WEBHOOK_URL", "https://discord.example/x")
    monkeypatch.setattr(discord_notify, "_build_embed", lambda *a, **k: {"embeds": []})
    monkeypatch.setattr(discord_notify.requests, "post",
                        lambda url, json=None, **kw: sent.update(json) or _Resp())
    discord_notify.send_recommendations("5/7/2026", [], {})
    assert sent["flags"] & FLAG


def test_listener_post_carries_the_flag_and_keeps_existing(monkeypatch):
    sent = []

    class _S:
        def post(self, url, json=None, **kw):
            sent.append(json)
            return _Resp()

    monkeypatch.setattr(discord_listener, "_session", _S())
    discord_listener._post_message("hello")
    discord_listener._post_embed({"embeds": [], "flags": 64})
    assert sent[0]["flags"] & FLAG
    assert sent[1]["flags"] == 64 | FLAG
