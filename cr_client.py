"""Shared Court Reserve browser login and schedule fetch."""

import os
from contextlib import contextmanager
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, Page, Browser
from playwright_stealth import Stealth

load_dotenv()

LOGIN_URL    = os.environ["CR_LOGIN_URL"]
USERNAME     = os.environ["CR_USERNAME"]
PASSWORD     = os.environ["CR_PASSWORD"]

REPORT_URL = (
    "https://app.courtreserve.com/ReservationReportBuilder/RunReportWithFields"
    "?fields=3,4,5,199,8,9,10,11,12"
    "&StartDate={start}%2012%3A00%20AM&EndDate={end}%2012%3A00%20AM"
    "&IncludeReservations=True&IncludeEvents=True"
    "&RecurringReservationsOnly=False&GroupReservationsByMembers=True"
    "&take=500&skip=0&page=1&pageSize=500"
)


def login(page: Page):
    page.goto(LOGIN_URL)
    page.wait_for_selector('input[placeholder="Enter Your Email"]', timeout=30000)
    page.fill('input[placeholder="Enter Your Email"]', USERNAME)
    page.fill('input[placeholder="Enter Your Password"]', PASSWORD)
    page.click('button:has-text("Continue")')
    page.wait_for_url(lambda url: "login" not in url.lower(), timeout=30000)


@contextmanager
def browser_session(headless: bool = False):  # headless=True breaks Cloudflare — always use False
    """Context manager that yields a logged-in Playwright page."""
    with sync_playwright() as p:
        browser: Browser = p.chromium.launch(
            channel="chrome",
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context()
        page = context.new_page()
        Stealth().apply_stealth_sync(page)
        login(page)
        try:
            yield page
        finally:
            browser.close()


def dedup_schedule(items: list[dict]) -> list[dict]:
    """
    Remove duplicate rows caused by groupReservationsByMembers=True.
    One event with N registered members appears as N rows — keep only the first.
    Primary dedup key: occurrence Id (most precise).
    Fallback key: (StartDateTime, EndDateTime, Courts, EventId).
    """
    seen = set()
    unique = []
    for item in items:
        occurrence_id = item.get("Id")
        key = occurrence_id if occurrence_id else (
            item.get("StartDateTime", ""),
            item.get("EndDateTime", ""),
            item.get("Courts", ""),
            item.get("EventId", ""),
        )
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def fetch_schedule(start: str, end: str, page: Page = None) -> list[dict]:
    """
    Fetch schedule items for a date range, deduplicated.
    start/end: 'M/D/YYYY'
    If page is provided (already logged-in session), uses it. Otherwise opens a new session.
    """
    import json

    url = REPORT_URL.format(start=start, end=end)

    def _fetch(pg: Page) -> list[dict]:
        pg.goto(url)
        pg.wait_for_load_state("networkidle", timeout=30000)
        raw = pg.inner_text("body").strip()
        data = json.loads(raw)
        items = data if isinstance(data, list) else data.get("Data", [])
        return dedup_schedule(items)

    if page is not None:
        return _fetch(page)

    with browser_session() as pg:
        return _fetch(pg)
