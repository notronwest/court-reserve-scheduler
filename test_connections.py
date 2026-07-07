#!/usr/bin/env python3
"""
Live connectivity test for the Court Reserve Scheduler.
Run this on a new machine to confirm everything is wired up before going live.

Usage:
    venv/bin/python test_connections.py
    make test
"""

import os
import sys
import requests
from dotenv import load_dotenv

load_dotenv(override=True)

GREEN  = '\033[0;32m'
RED    = '\033[0;31m'
YELLOW = '\033[1;33m'
CYAN   = '\033[0;36m'
BOLD   = '\033[1m'
RESET  = '\033[0m'

FAILURES = 0
WARNINGS = 0


def ok(msg):
    print(f"  {GREEN}✓{RESET}  {msg}")

def fail(msg):
    global FAILURES
    FAILURES += 1
    print(f"  {RED}✗{RESET}  {msg}")

def warn(msg):
    global WARNINGS
    WARNINGS += 1
    print(f"  {YELLOW}⚠{RESET}  {msg}")

def info(msg):
    print(f"  {CYAN}→{RESET}  {msg}")

def head(msg):
    print(f"\n{BOLD}{msg}{RESET}")


# ── 1. Court Reserve login + schedule fetch ───────────────────────────────────
head("1. Court Reserve")
try:
    info("Logging in (this opens a headless browser — takes ~10s)...")
    from courtreserve_api import browser_session, fetch_schedule
    from datetime import date
    today = date.today()
    date_str = f"{today.month}/{today.day}/{today.year}"

    with browser_session(headless=True) as page:
        ok("Logged in to Court Reserve")
        info(f"Fetching today's schedule ({date_str})...")
        items = fetch_schedule(date_str, date_str, page=page)
        ok(f"Schedule fetched — {len(items)} event(s) today")
        if items:
            first = items[0]
            name  = first.get("EventName") or first.get("Name") or "?"
            start = first.get("StartDateTime") or first.get("StartTime") or "?"
            info(f"  First event: {name} at {start}")
except Exception as exc:
    fail(f"Court Reserve: {exc}")
    print(f"  {YELLOW}  Check CR_LOGIN_URL / CR_USERNAME / CR_PASSWORD in .env{RESET}")


# ── 2. Discord webhook ────────────────────────────────────────────────────────
head("2. Discord webhook")
webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "")
if not webhook_url or "YOUR_" in webhook_url.upper():
    fail("DISCORD_WEBHOOK_URL not set")
else:
    try:
        resp = requests.post(webhook_url, json={
            "content": (
                "✅ **Scheduler connectivity test** — "
                "new machine is live and can post to Discord."
            )
        }, timeout=10)
        if resp.status_code in (200, 204):
            ok("Test message posted to Discord ✓")
        else:
            fail(f"Webhook returned HTTP {resp.status_code}")
    except Exception as exc:
        fail(f"Webhook request failed: {exc}")


# ── 3. Discord bot token ──────────────────────────────────────────────────────
head("3. Discord bot")
bot_token = os.environ.get("DISCORD_BOT_TOKEN", "")
if not bot_token or "your_" in bot_token.lower():
    fail("DISCORD_BOT_TOKEN not set")
else:
    try:
        resp = requests.get(
            "https://discord.com/api/v10/users/@me",
            headers={"Authorization": f"Bot {bot_token}"},
            timeout=10,
        )
        if resp.status_code == 200:
            username = resp.json().get("username", "?")
            ok(f"Bot token valid — logged in as '{username}'")
        else:
            fail(f"Bot token returned HTTP {resp.status_code} — check DISCORD_BOT_TOKEN")
    except Exception as exc:
        fail(f"Bot token check failed: {exc}")


# ── 4. Anthropic API ──────────────────────────────────────────────────────────
head("4. Anthropic API")
anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
if not anthropic_key or "your_" in anthropic_key.lower():
    fail("ANTHROPIC_API_KEY not set")
else:
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=anthropic_key)
        client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )
        ok("Anthropic API key valid")
    except Exception as exc:
        fail(f"Anthropic API call failed: {exc}")


# ── 5. launchd services ───────────────────────────────────────────────────────
head("5. launchd services")
import subprocess

services = {
    "com.whitemountain.listener":     "Discord listener (always-on)",
    "com.whitemountain.scheduler":    "Daily scheduler (8:00 AM)",
    "com.whitemountain.fetch-history": "History fetcher (Mondays 7:00 AM)",
}
try:
    loaded = subprocess.check_output(["launchctl", "list"], text=True)
    for svc, label in services.items():
        if svc in loaded:
            line = next(l for l in loaded.splitlines() if svc in l)
            pid  = line.split()[0]
            if pid == "-":
                warn(f"{label}: loaded, not currently running (triggers on schedule)")
            else:
                ok(f"{label}: running (pid {pid})")
        else:
            fail(f"{label}: NOT loaded — run ./setup.sh")
except Exception as exc:
    fail(f"Could not check launchd: {exc}")


# ── Summary ───────────────────────────────────────────────────────────────────
print(f"\n{'─' * 72}")
if FAILURES == 0 and WARNINGS == 0:
    print(f"{GREEN}{BOLD}All tests passed — this machine is ready to go live.{RESET}")
elif FAILURES == 0:
    print(f"{YELLOW}{BOLD}{WARNINGS} warning(s) — system operational, review above.{RESET}")
else:
    print(f"{RED}{BOLD}{FAILURES} failure(s), {WARNINGS} warning(s) — fix the errors above before going live.{RESET}")
print()
sys.exit(FAILURES)
