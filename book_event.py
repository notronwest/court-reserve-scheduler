"""
Books a single event occurrence via the Add Event Date form on Court Reserve.
Expects an already-logged-in Playwright page from cr_client.browser_session().
"""

import json as _json
from playwright.sync_api import Page


ADD_OCCURRENCE_URL = (
    "https://app.courtreserve.com/EventReservation/AddEventOccurrence"
    "?eventId={event_id}&source=EditOccurrences"
)

OCCURRENCES_URL = (
    "https://app.courtreserve.com/Events/Edit/{event_id}?page=occurrences"
)


def book_event(
    page: Page,
    event_id:   int,
    date:       str,   # 'M/D/YYYY'
    start_time: str,   # '9:00 AM'
    end_time:   str,   # '11:00 AM'
    court_id:   int,   # e.g. 52352
    dry_run:    bool = False,
) -> dict:
    """
    Fill and submit the Add Event Date form.
    Returns {"success": bool, "url": str, "error": str|None}
    """
    url = ADD_OCCURRENCE_URL.format(event_id=event_id)
    page.goto(url)
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(2000)

    # Parse date into parts for unambiguous JS Date constructor
    from datetime import datetime as _dt
    _d = _dt.strptime(date, "%m/%d/%Y") if "/" in date else _dt.strptime(date, "%Y-%m-%d")
    _year, _month0, _day = _d.year, _d.month - 1, _d.day  # JS months are 0-indexed

    # Set all Kendo widgets in a single evaluate call to avoid timing issues
    page.evaluate(f"""
        (function() {{
            // Date
            var dp = $("#Date").data("kendoDatePicker");
            if (dp) {{
                dp.value(new Date({_year}, {_month0}, {_day}));
                dp.trigger("change");
            }}

            // Start time
            var tp1 = $("#StartTime").data("kendoTimePicker");
            if (tp1) {{
                tp1.value("{start_time}");
                tp1.trigger("change");
            }}

            // End time
            var tp2 = $("#EndTime").data("kendoTimePicker");
            if (tp2) {{
                tp2.value("{end_time}");
                tp2.trigger("change");
            }}

            // Courts — clear first, then set
            var ms = $("#Courts").data("kendoMultiSelect");
            if (ms) {{
                ms.value([]);
                ms.value([{court_id}]);
                ms.trigger("change");
            }}
        }})();
    """)

    # Wait for Kendo to re-render after all changes
    page.wait_for_timeout(1500)

    # Screenshot before submit (always, for audit trail)
    import os as _os
    _os.makedirs("logs/screenshots", exist_ok=True)
    screenshot_path = f"logs/screenshots/booking_{event_id}_{date.replace('/', '-')}_{start_time.replace(':', '').replace(' ', '')}.png"
    page.screenshot(path=screenshot_path)

    if dry_run:
        print(f"  [DRY RUN] Would submit form. Screenshot: {screenshot_path}")
        return {"success": True, "dry_run": True, "screenshot": screenshot_path, "error": None}

    # ── Submit ────────────────────────────────────────────────────────────────
    # Click the plain "Save" button (not "Save Changes & Register Members")
    save_btn = page.query_selector("button.btn-success:not(:has-text('Register')), button:has-text('Save'):not(:has-text('Register'))")
    if not save_btn:
        save_btn = page.query_selector("button:has-text('Save')")

    if not save_btn:
        return {"success": False, "error": "Could not find Save button", "screenshot": screenshot_path}

    try:
        save_btn.click()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(2000)
    except Exception:
        pass

    try:
        current_url = page.url
    except Exception:
        current_url = "unknown"

    # Check for explicit error messages
    try:
        error_el = page.query_selector(".alert-danger, .validation-summary-errors, .field-validation-error")
        if error_el and error_el.is_visible():
            error_text = error_el.inner_text().strip()
            page.screenshot(path=screenshot_path.replace("logs/screenshots/booking_", "logs/screenshots/error_booking_"))
            return {"success": False, "url": current_url, "error": error_text, "screenshot": screenshot_path}
    except Exception:
        pass

    # Success = navigated away from the add-occurrence form.
    # Court Reserve redirects to the occurrences page on success, e.g.:
    #   /Events/Edit/{id}?page=occurrences  OR  /EventReservation/...
    # We treat anything that left AddEventOccurrence as success.
    success = "AddEventOccurrence" not in current_url

    # ── Capture occurrence ID ─────────────────────────────────────────────────
    # After a successful save we land on the occurrences list.  Each row has an
    # edit link like /EventReservation/EditEventOccurrence?occurrenceId=XXXXXX.
    # Find the row whose date matches our booking and pull the ID from its link.
    occurrence_id = None
    if success:
        try:
            occurrence_id = page.evaluate(f"""
                (function() {{
                    var links = Array.from(document.querySelectorAll('a[href*="occurrenceId"]'));
                    // Build date variants to match against row text
                    var d = new Date({_year}, {_month0}, {_day});
                    var pad = function(n) {{ return n < 10 ? '0'+n : ''+n; }};
                    var variants = [
                        (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear(),
                        pad(d.getMonth()+1) + '/' + pad(d.getDate()) + '/' + d.getFullYear(),
                    ];
                    for (var link of links) {{
                        var row = link.closest('tr');
                        if (!row) continue;
                        var text = row.innerText || '';
                        if (variants.some(function(v) {{ return text.indexOf(v) !== -1; }})) {{
                            var m = link.href.match(/occurrenceId=([0-9]+)/);
                            if (m) return parseInt(m[1]);
                        }}
                    }}
                    // Fallback: return the ID from the most-recently-added link
                    // (highest occurrenceId number, as CR appends new rows)
                    var ids = links.map(function(l) {{
                        var m = l.href.match(/occurrenceId=([0-9]+)/);
                        return m ? parseInt(m[1]) : 0;
                    }}).filter(function(n) {{ return n > 0; }});
                    return ids.length ? Math.max.apply(null, ids) : null;
                }})();
            """)
        except Exception:
            occurrence_id = None

    return {
        "success":       success,
        "url":           current_url,
        "screenshot":    screenshot_path,
        "occurrence_id": occurrence_id,
        "error":         None if success else "Still on form — possible validation error (check screenshot)",
    }


UPDATE_RESERVATION_URL = (
    "https://app.courtreserve.com/Reservation/UpdateReservation"
    "?reservationId={occurrence_id}"
)


def fix_event_court(
    page:          Page,
    event_id:      int,
    date:          str,            # 'M/D/YYYY'
    start_time:    str,            # '9:00 AM'
    end_time:      str,            # '11:00 AM'
    court_id:      int,
    occurrence_id: int | None = None,  # if known, skip grid search entirely
    dry_run:       bool = False,
) -> dict:
    """
    Fix a court assignment for an existing occurrence.

    Strategy:
      1. If occurrence_id is known → navigate directly to EditEventOccurrence.
      2. Otherwise navigate to the occurrences grid, find the row by date,
         click its Edit button.
      3. Update the Courts multiselect and save.
      4. If the edit row can't be found/clicked, fall back to re-adding the
         occurrence via book_event() (Court Reserve may update or re-create it).

    Returns {"success", "method", "screenshot", "error"}
    """
    from datetime import datetime as _dt

    d = _dt.strptime(date, "%m/%d/%Y") if "/" in date else _dt.strptime(date, "%Y-%m-%d")
    # Build several date string variants for matching against whatever format CR uses
    date_variants = [
        d.strftime("%-m/%-d/%Y"),   # 4/22/2026
        d.strftime("%m/%d/%Y"),     # 04/22/2026
        d.strftime("%-m/%-d/%y"),   # 4/22/26
    ]
    import os as _os
    _os.makedirs("logs/screenshots", exist_ok=True)
    shot_base = (
        f"logs/screenshots/fixcourt_{event_id}_{date.replace('/', '-')}"
        f"_{start_time.replace(':', '').replace(' ', '')}"
    )

    if dry_run:
        return {
            "success": True, "dry_run": True,
            "method": "dry_run",
            "screenshot": f"{shot_base}_dryrun.png",
            "error": None,
        }

    def _update_court_and_save(method_label: str) -> dict:
        """Shared: update Courts widget on current page and save. Returns result dict."""
        page.evaluate(f"""
            (function() {{
                var ms = $("#Courts").data("kendoMultiSelect");
                if (ms) {{
                    ms.value([]);
                    ms.value([{court_id}]);
                    ms.trigger("change");
                }}
            }})();
        """)
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{shot_base}_before_save.png")

        save_btn = page.query_selector(
            "button.btn-success:not(:has-text('Register')), "
            "button:has-text('Save'):not(:has-text('Register'))"
        )
        if not save_btn:
            save_btn = page.query_selector("button:has-text('Save')")
        if not save_btn:
            return {
                "success": False, "method": method_label,
                "screenshot": f"{shot_base}_before_save.png",
                "error": "Save button not found on edit form",
            }

        try:
            save_btn.click()
            page.wait_for_load_state("domcontentloaded")
            page.wait_for_timeout(2000)
        except Exception:
            pass  # navigation away counts as success

        try:
            current_url = page.url
        except Exception:
            current_url = "unknown"

        try:
            err_el = page.query_selector(".alert-danger, .validation-summary-errors, .field-validation-error")
            if err_el and err_el.is_visible():
                err_text = err_el.inner_text().strip()
                page.screenshot(path=f"error_{shot_base}.png")
                return {
                    "success": False, "method": method_label,
                    "url": current_url,
                    "screenshot": f"{shot_base}_before_save.png",
                    "error": err_text,
                }
        except Exception:
            pass

        page.screenshot(path=f"{shot_base}_after_save.png")
        return {
            "success": True, "method": method_label,
            "url": current_url,
            "screenshot": f"{shot_base}_after_save.png",
            "error": None,
        }

    # ── Fast path: direct edit via occurrence/reservation ID ─────────────────
    if occurrence_id:
        edit_url = UPDATE_RESERVATION_URL.format(occurrence_id=occurrence_id)
        page.goto(edit_url)
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(2500)
        # Confirm we landed on an edit form (has a Courts widget)
        # Wait for jQuery + Kendo to initialise before checking
        has_form = page.evaluate("""
            () => typeof $ !== 'undefined' && !!$('#Courts').data('kendoMultiSelect')
        """)
        if has_form:
            # Ensure we're editing only this occurrence, not the whole series
            page.evaluate("""
                (function() {
                    var cb = $('#EditOnlyCurrentOccurrence');
                    if (cb.length && !cb.is(':checked')) cb.prop('checked', true).trigger('change');
                })();
            """)
            return _update_court_and_save(f"direct_edit (reservationId={occurrence_id})")
        # If the direct URL didn't work, fall through to grid search

    # ── Step 1: Navigate to the occurrences list ────────────────────────────
    occ_url = OCCURRENCES_URL.format(event_id=event_id)
    page.goto(occ_url)
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(2500)

    # ── Step 2: Find the occurrence row and click Edit ───────────────────────
    edit_result = page.evaluate(f"""
        (function() {{
            var targets = {_json.dumps(date_variants)};

            // Walk every table row on the page
            var rows = Array.from(document.querySelectorAll("tr"));
            for (var row of rows) {{
                var text = row.innerText || "";
                var matched = targets.some(function(t) {{ return text.indexOf(t) !== -1; }});
                if (!matched) continue;

                // Priority 1: href contains EditEventOccurrence
                var el = row.querySelector('a[href*="EditEventOccurrence"]');
                if (!el) {{
                    // Priority 2: Kendo grid edit command button
                    el = row.querySelector(".k-grid-edit-command, a.k-button[data-role]");
                }}
                if (!el) {{
                    // Priority 3: any link/button whose text or title is "edit"
                    var btns = row.querySelectorAll("a, button");
                    for (var b of btns) {{
                        var label = ((b.innerText || "") + (b.title || "") + (b.getAttribute("aria-label") || "")).toLowerCase();
                        if (label.includes("edit")) {{ el = b; break; }}
                    }}
                }}

                if (el) {{
                    el.click();
                    return {{ status: "clicked", href: el.href || el.outerHTML.substring(0, 80) }};
                }}
                return {{ status: "row_found_no_button", preview: text.substring(0, 120) }};
            }}
            return {{ status: "no_row_found" }};
        }})();
    """)

    if isinstance(edit_result, dict) and edit_result.get("status") == "clicked":
        # ── Step 3: Update the court on the edit form ────────────────────────
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(2000)
        return _update_court_and_save("edit_occurrence (grid)")

    else:
        # ── Fallback: re-add the occurrence ──────────────────────────────────
        debug = edit_result.get("status", "unknown") if isinstance(edit_result, dict) else str(edit_result)
        page.screenshot(path=f"{shot_base}_fallback.png")
        result = book_event(
            page=page, event_id=event_id, date=date,
            start_time=start_time, end_time=end_time,
            court_id=court_id, dry_run=dry_run,
        )
        result["method"] = f"re_add (edit_row: {debug})"
        return result
