"""Shared Court Reserve browser login and schedule fetch."""

import os
from contextlib import contextmanager
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, Page, Browser
from playwright_stealth import Stealth

load_dotenv(override=True)

# Support both key naming conventions
_base = os.environ.get("CR_BASE_URL", "https://app.courtreserve.com").rstrip("/")
LOGIN_URL = os.environ.get("CR_LOGIN_URL") or f"{_base}/Account/Login"
USERNAME  = os.environ.get("CR_USERNAME")  or os.environ.get("CR_EMAIL", "")
PASSWORD  = os.environ.get("CR_PASSWORD", "")

REPORT_URL = (
    "https://app.courtreserve.com/ReservationReportBuilder/RunReportWithFields"
    "?fields=3,4,5,199,8,9,10,11,12"
    "&StartDate={start}%2012%3A00%20AM&EndDate={end}%2012%3A00%20AM"
    "&IncludeReservations=True&IncludeEvents=True"
    "&RecurringReservationsOnly=False&GroupReservationsByMembers=True"
    "&take=500&skip=0&page=1&pageSize=500"
)


def dismiss_popups(page: Page):
    """Dismiss any visible modal/popup overlays (e.g. Court Reserve announcements)."""
    import logging
    _log = logging.getLogger(__name__)
    try:
        # Wait briefly for a modal to appear
        page.wait_for_selector(".modal.in, .modal.show", timeout=4000)
        # Try buttons in priority order: explicit close/dismiss, then OK/primary, then any button
        for selector in [
            ".modal.in .close",
            ".modal.show .close",
            ".modal.in [data-dismiss='modal']",
            ".modal.show [data-dismiss='modal']",
            ".modal.in .btn-primary",
            ".modal.show .btn-primary",
            ".modal.in .btn",
            ".modal.show .btn",
        ]:
            btn = page.query_selector(selector)
            if btn and btn.is_visible():
                _log.info("Dismissing popup via: %s", selector)
                btn.click()
                page.wait_for_timeout(800)
                break
    except Exception:
        pass  # No popup — that's fine


def login(page: Page):
    page.goto(LOGIN_URL)
    page.wait_for_selector('input[placeholder="Enter Your Email"]', timeout=30000)
    page.fill('input[placeholder="Enter Your Email"]', USERNAME)
    page.fill('input[placeholder="Enter Your Password"]', PASSWORD)
    page.click('button:has-text("Continue")')
    page.wait_for_url(lambda url: "login" not in url.lower(), timeout=30000)
    dismiss_popups(page)  # dismiss any announcement modal shown after login


@contextmanager
def browser_session(headless: bool = False):  # headless=True breaks Cloudflare — always use False
    """Context manager that yields a logged-in Playwright page.

    Uses a dedicated Chrome user-data-dir so this instance is fully isolated
    from the user's normal Chrome windows — no interference, no accidental
    closures, no shared session state.
    """
    import tempfile, shutil
    # Temporary profile dir — fresh each run, cleaned up on exit
    profile_dir = tempfile.mkdtemp(prefix="cr_scheduler_chrome_")
    try:
        with sync_playwright() as p:
            # launch_persistent_context gives an isolated profile — completely
            # separate from the user's normal Chrome windows
            # Use installed Chrome if available, otherwise fall back to
            # the playwright-managed Chromium build (also works with stealth).
            import shutil as _shutil
            launch_kwargs = dict(
                user_data_dir=profile_dir,
                headless=headless,
                args=["--disable-blink-features=AutomationControlled"],
            )
            if _shutil.which("google-chrome") or _shutil.which("chrome"):
                launch_kwargs["channel"] = "chrome"
            context = p.chromium.launch_persistent_context(**launch_kwargs)
            page = context.new_page()
            Stealth().apply_stealth_sync(page)
            login(page)
            try:
                yield page
            finally:
                context.close()
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)


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
        # 'load' is sufficient for a JSON endpoint — no jQuery/Kendo needed,
        # and 'networkidle' hangs on Court Reserve's background polling.
        pg.wait_for_load_state("load", timeout=30000)
        raw = pg.inner_text("body").strip()
        data = json.loads(raw)
        items = data if isinstance(data, list) else data.get("Data", [])
        return dedup_schedule(items)

    if page is not None:
        return _fetch(page)

    with browser_session() as pg:
        return _fetch(pg)
