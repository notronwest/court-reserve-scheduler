"""
Logs in to Court Reserve and fetches the schedule report for a given date range.
Usage:
    python fetch_schedule.py [start_date] [end_date]
    python fetch_schedule.py 4/2/2026
    python fetch_schedule.py 4/2/2026 4/8/2026
    python fetch_schedule.py  # defaults to today
"""

import os
import sys
from datetime import date
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from playwright_stealth import Stealth

load_dotenv()

USERNAME = os.environ["CR_USERNAME"]
PASSWORD = os.environ["CR_PASSWORD"]
LOGIN_URL = os.environ["CR_LOGIN_URL"]

REPORT_URL = (
    "https://app.courtreserve.com/ReservationReportBuilder/RunReportWithFields"
    "?fields=3,4,5,199,8,9,10,11,12"
    "&StartDate={start}%2012%3A00%20AM&EndDate={end}%2012%3A00%20AM"
    "&IncludeReservations=True&IncludeEvents=True"
    "&RecurringReservationsOnly=False&GroupReservationsByMembers=True"
    "&take=500&skip=0&page=1&pageSize=500"
)


def login(page):
    page.goto(LOGIN_URL)
    # Wait for the form to appear (also gives Cloudflare time to clear)
    page.wait_for_selector('input[placeholder="Enter Your Email"]', timeout=30000)

    page.fill('input[placeholder="Enter Your Email"]', USERNAME)
    page.fill('input[placeholder="Enter Your Password"]', PASSWORD)
    page.click('button:has-text("Continue")')

    # Wait for navigation away from login page (up to 30s for Cloudflare challenge)
    page.wait_for_url(lambda url: "login" not in url.lower(), timeout=30000)

    print(f"Logged in. Current URL: {page.url}")


def fetch_schedule(start: str, end: str):
    url = REPORT_URL.format(start=start, end=end)

    with sync_playwright() as p:
        # Use real Chrome with stealth to bypass Cloudflare
        browser = p.chromium.launch(
            channel="chrome",
            headless=False,  # headed is more reliable against Cloudflare
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context()
        page = context.new_page()

        try:
            Stealth().apply_stealth_sync(page)
            login(page)
            print(f"Fetching schedule: {start} → {end}")

            # Hit the JSON data endpoint directly
            response = page.goto(url)
            page.wait_for_load_state("networkidle")

            raw = page.inner_text("body").strip()

            # Try to parse as JSON (the API endpoint returns JSON)
            import json
            try:
                data = json.loads(raw)
                items = data.get("Data", data) if isinstance(data, dict) else data
                total = data.get("Total", len(items)) if isinstance(data, dict) else len(items)
                print(f"\nTotal items: {total}\n")
                print("\n--- SCHEDULE ---")
                for item in items:
                    print(
                        f"{item.get('StartDateTime', '')} → {item.get('EndDateTime', '')}  "
                        f"[{item.get('Day', '')}]  "
                        f"{item.get('ReservationType', '')}  "
                        f"{item.get('EventName', '') or ''}  "
                        f"Courts: {item.get('CourtLabel', '')}"
                    )
                print("--- END ---")

                out_file = f"schedule_{start.replace('/', '-')}_{end.replace('/', '-')}.json"
                with open(out_file, "w") as f:
                    json.dump(data, f, indent=2)
                print(f"\nFull data saved to: {out_file}")
            except json.JSONDecodeError:
                # Fallback: just print raw text
                print("\n--- SCHEDULE CONTENT ---")
                print(raw)
                print("--- END ---")

        except PlaywrightTimeoutError as e:
            print(f"Timeout: {e}")
            page.screenshot(path="error_screenshot.png")
            print("Screenshot saved to error_screenshot.png")
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    today = date.today().strftime("%-m/%-d/%Y")

    if len(sys.argv) == 1:
        start = end = today
    elif len(sys.argv) == 2:
        start = end = sys.argv[1]
    else:
        start, end = sys.argv[1], sys.argv[2]

    fetch_schedule(start, end)
