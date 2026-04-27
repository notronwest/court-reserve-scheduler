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
    import logging as _logging
    _log = _logging.getLogger(__name__)

    url = ADD_OCCURRENCE_URL.format(event_id=event_id)
    _log.info("Navigating to: %s", url)
    page.goto(url)
    # networkidle ensures jQuery/Kendo scripts have fully loaded (domcontentloaded is too early)
    page.wait_for_load_state("networkidle", timeout=20000)
    page.wait_for_timeout(1000)

    # Log where we actually landed (could be a login redirect)
    landed_url = page.url
    page_title  = page.title()
    _log.info("Landed at: %s  title=%r", landed_url, page_title)
    if "login" in landed_url.lower() or "login" in page_title.lower():
        _log.error("Redirected to login page — session may have expired")
        return {"success": False, "error": "Redirected to login — session expired", "url": landed_url}

    # Parse date into parts for unambiguous JS Date constructor
    from datetime import datetime as _dt
    _d = _dt.strptime(date, "%m/%d/%Y") if "/" in date else _dt.strptime(date, "%Y-%m-%d")
    _year, _month0, _day = _d.year, _d.month - 1, _d.day  # JS months are 0-indexed

    # Check which Kendo widgets are present before filling
    widget_state = page.evaluate("""
        (function() {
            return {
                jquery:    typeof $ !== 'undefined',
                datePicker: !!$("#Date").data("kendoDatePicker"),
                startTime:  !!$("#StartTime").data("kendoTimePicker"),
                endTime:    !!$("#EndTime").data("kendoTimePicker"),
                courts:     !!$("#Courts").data("kendoMultiSelect"),
            };
        })()
    """)
    _log.info("Kendo widget state: %s", widget_state)

    # Set all Kendo widgets
    filled = page.evaluate(f"""
        (function() {{
            var filled = {{}};

            // Date
            var dp = $("#Date").data("kendoDatePicker");
            if (dp) {{
                dp.value(new Date({_year}, {_month0}, {_day}));
                dp.trigger("change");
                filled.date = dp.value() ? dp.value().toString() : null;
            }}

            // Start time
            var tp1 = $("#StartTime").data("kendoTimePicker");
            if (tp1) {{
                tp1.value("{start_time}");
                tp1.trigger("change");
                filled.startTime = tp1.value() ? tp1.value().toString() : null;
            }}

            // End time
            var tp2 = $("#EndTime").data("kendoTimePicker");
            if (tp2) {{
                tp2.value("{end_time}");
                tp2.trigger("change");
                filled.endTime = tp2.value() ? tp2.value().toString() : null;
            }}

            // Courts — clear first, then set
            var ms = $("#Courts").data("kendoMultiSelect");
            if (ms) {{
                ms.value([]);
                ms.value([{court_id}]);
                ms.trigger("change");
                filled.courts = ms.value();
            }}

            return filled;
        }})();
    """)
    _log.info("Form filled: %s", filled)

    # Wait for Kendo to re-render after all changes
    page.wait_for_timeout(1500)

    # Screenshot before submit (always, for audit trail)
    import os as _os
    from pathlib import Path as _Path
    _SCREENSHOTS = _Path(__file__).parent / "logs" / "screenshots"
    _os.makedirs(_SCREENSHOTS, exist_ok=True)
    screenshot_path = str(_SCREENSHOTS / f"booking_{event_id}_{date.replace('/', '-')}_{start_time.replace(':', '').replace(' ', '')}.png")
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
        # Wait for Court Reserve to redirect away from the add form.
        # The redirect can take several seconds — use wait_for_url to avoid
        # a fixed sleep that times out before the navigation completes.
        page.wait_for_url(
            lambda url: "AddEventOccurrence" not in url,
            timeout=12000,
        )
    except Exception:
        pass  # timeout = still on form (failure); navigation away = success

    try:
        current_url = page.url
    except Exception:
        current_url = "unknown"

    # Check for explicit error messages (only relevant if still on the form)
    if "AddEventOccurrence" in current_url:
        error_text = "Still on form — possible validation error (check screenshot)"
        try:
            # Try multiple selectors for Court Reserve error display
            for selector in [
                ".alert-danger",
                ".validation-summary-errors",
                ".field-validation-error",
                ".alert-warning",
                "[data-valmsg-summary]",
            ]:
                error_el = page.query_selector(selector)
                if error_el and error_el.is_visible():
                    error_text = error_el.inner_text().strip()
                    break
        except Exception:
            pass

        fail_shot = str(_SCREENSHOTS / f"FAILED_{event_id}_{date.replace('/', '-')}_{start_time.replace(':', '').replace(' ', '')}.png")
        try:
            page.screenshot(path=fail_shot, full_page=True)
        except Exception:
            fail_shot = screenshot_path

        _log.error("Booking failed — still on form. URL=%s error=%r screenshot=%s", current_url, error_text, fail_shot)
        return {"success": False, "url": current_url, "error": error_text, "screenshot": fail_shot}

    # Success = navigated away from the add-occurrence form.
    success = "AddEventOccurrence" not in current_url

    # ── Capture occurrence ID ─────────────────────────────────────────────────
    # After a successful save Court Reserve redirects to the occurrences list.
    # Court Reserve uses Bootstrap modals for editing — the edit links carry the
    # reservationId in a data-remote attribute or in onclick handlers rather than
    # in plain href links.  We look for the row matching our booking date and
    # extract the reservationId from whichever attribute is present.
    occurrence_id = None
    if success:
        # Give the Kendo grid time to load its rows via AJAX before scanning
        page.wait_for_timeout(3000)
        try:
            occurrence_id = page.evaluate(f"""
                (function() {{
                    var d = new Date({_year}, {_month0}, {_day});
                    var pad = function(n) {{ return n < 10 ? '0'+n : ''+n; }};
                    var variants = [
                        (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear(),
                        pad(d.getMonth()+1) + '/' + pad(d.getDate()) + '/' + d.getFullYear(),
                    ];

                    var rows = Array.from(document.querySelectorAll('tr'));
                    for (var row of rows) {{
                        var text = row.innerText || '';
                        if (!variants.some(function(v) {{ return text.indexOf(v) !== -1; }})) continue;

                        // Strategy 1: data-remote="/Reservation/UpdateReservation?reservationId=NNN"
                        var drLink = row.querySelector('a[data-remote*="UpdateReservation"]');
                        if (drLink) {{
                            var dr = drLink.getAttribute('data-remote') || '';
                            var m = dr.match(/reservationId=([0-9]+)/);
                            if (m) return parseInt(m[1]);
                        }}

                        // Strategy 2: onclick="revertReservationToSeries(NNN, eventId)"
                        var onclickLinks = Array.from(row.querySelectorAll('a[onclick]'));
                        for (var ol of onclickLinks) {{
                            var oc = ol.getAttribute('onclick') || '';
                            var m2 = oc.match(/revertReservationToSeries\\s*\\(\\s*([0-9]+)/);
                            if (m2) return parseInt(m2[1]);
                        }}

                        // Strategy 3: legacy href occurrenceId
                        var hrefLink = row.querySelector('a[href*="occurrenceId"]');
                        if (hrefLink) {{
                            var m3 = hrefLink.href.match(/occurrenceId=([0-9]+)/);
                            if (m3) return parseInt(m3[1]);
                        }}
                    }}

                    // Fallback: largest reservationId from any UpdateReservation data-remote on page
                    var allDr = Array.from(document.querySelectorAll('a[data-remote*="UpdateReservation"]'));
                    var ids = allDr.map(function(l) {{
                        var m = (l.getAttribute('data-remote') || '').match(/reservationId=([0-9]+)/);
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


def edit_occurrence_multi_court(
    page:             Page,
    occurrence_id:    int,
    all_court_ids:    list,   # ALL court IDs including the primary (e.g. [52351, 52352])
    event_id:         int = 0,
    max_participants: int = 0,
    dry_run:          bool = False,
) -> dict:
    """
    Edit an existing occurrence to assign multiple courts and optionally
    set the maximum number of participants (MaxPeople field).

    UpdateReservation is rendered as a Bootstrap modal inside the occurrences
    grid — it does not function as a standalone page (jQuery/Kendo are missing).
    This function opens the modal by navigating to the occurrences grid and
    clicking the edit button for the matching occurrence_id row.

    Call this after book_event() returns a successful occurrence_id for a
    fixed event that spans more than one court.

    Returns {"success", "method", "screenshot", "error"}
    """
    import os as _os
    from pathlib import Path as _Path
    _SCREENSHOTS = _Path(__file__).parent / "logs" / "screenshots"
    _os.makedirs(_SCREENSHOTS, exist_ok=True)
    shot_base = str(_SCREENSHOTS / f"multicourt_{occurrence_id}")

    if dry_run:
        return {
            "success": True, "dry_run": True,
            "method": "dry_run",
            "screenshot": f"{shot_base}_dryrun.png",
            "error": None,
        }

    # Navigate to the occurrences grid so jQuery+Kendo are available,
    # then trigger the edit modal by clicking the data-remote link.
    occ_url = OCCURRENCES_URL.format(event_id=event_id) if event_id else None
    if not occ_url:
        return {
            "success": False, "method": "edit_multi_court",
            "screenshot": f"{shot_base}_no_form.png",
            "error": "event_id required to open edit modal via occurrences grid",
        }

    page.goto(occ_url)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    # Click the edit (UpdateReservation) modal link for this occurrence_id
    clicked = page.evaluate(f"""
        (function() {{
            var links = Array.from(document.querySelectorAll('a[data-remote*="UpdateReservation"]'));
            for (var l of links) {{
                if (l.getAttribute('data-remote').indexOf('{occurrence_id}') !== -1) {{
                    l.click();
                    return true;
                }}
            }}
            return false;
        }})()
    """)

    if not clicked:
        page.screenshot(path=f"{shot_base}_no_edit_link.png")
        return {
            "success": False, "method": "edit_multi_court",
            "screenshot": f"{shot_base}_no_edit_link.png",
            "error": f"Edit link for occurrence_id={occurrence_id} not found in occurrences grid",
        }

    # Wait for the modal to be fully open (.action-modal.in = Bootstrap "shown" state)
    # Note: Kendo replaces #Courts <select> with its own widget, so the original
    # element has offsetParent=null — we wait for the modal overlay instead.
    try:
        page.wait_for_selector(".action-modal.in", timeout=10000)
    except Exception:
        page.screenshot(path=f"{shot_base}_modal_timeout.png")
        return {
            "success": False, "method": "edit_multi_court",
            "screenshot": f"{shot_base}_modal_timeout.png",
            "error": "Timed out waiting for edit modal to open",
        }
    page.wait_for_timeout(1500)  # let Kendo fully initialize inside the modal

    # Build JS values
    court_ids_js  = ", ".join(str(c) for c in all_court_ids)
    max_people_js = str(max_participants) if max_participants > 0 else ""

    page.evaluate(f"""
        (function() {{
            // Check "Edit Only Current Occurrence" so we don't affect the whole series
            var cb = $('#EditOnlyCurrentOccurrence');
            if (cb.length && !cb.is(':checked')) {{
                cb.prop('checked', true).trigger('change');
            }}

            // Set all courts on the Kendo multiselect
            var ms = $('#Courts').data('kendoMultiSelect');
            if (ms) {{
                ms.value([]);
                ms.value([{court_ids_js}]);
                ms.trigger('change');
            }}

            // Set max participants
            {"var maxEl = $('#MaxPeople'); if (maxEl.length) { maxEl.val('" + max_people_js + "').trigger('change'); }" if max_people_js else ""}
        }})();
    """)
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{shot_base}_before_save.png")

    save_btn = page.query_selector(
        ".action-modal button.btn-success:not(:has-text('Register')), "
        ".modal button:has-text('Save'):not(:has-text('Register'))"
    )
    if not save_btn:
        save_btn = page.query_selector(".action-modal button:has-text('Save'), .modal button:has-text('Save')")
    if not save_btn:
        # Fallback: any visible Save button on the page
        save_btn = page.query_selector("button:has-text('Save'):not(:has-text('Register'))")
    if not save_btn:
        return {
            "success": False, "method": "edit_multi_court",
            "screenshot": f"{shot_base}_before_save.png",
            "error": "Save button not found in modal",
        }

    try:
        save_btn.click()
        page.wait_for_timeout(3000)
    except Exception:
        pass

    # Check for visible errors in the modal
    try:
        err_el = page.query_selector(".alert-danger, .validation-summary-errors, .field-validation-error")
        if err_el and err_el.is_visible():
            err_text = err_el.inner_text().strip()
            page.screenshot(path=f"{shot_base}_error.png")
            return {
                "success": False, "method": "edit_multi_court",
                "screenshot": f"{shot_base}_error.png",
                "error": err_text,
            }
    except Exception:
        pass

    page.screenshot(path=f"{shot_base}_after_save.png")
    return {
        "success": True, "method": "edit_multi_court_modal",
        "screenshot": f"{shot_base}_after_save.png",
        "error": None,
    }


def move_occurrence(
    page:           Page,
    event_id:       int,
    occurrence_id:  int,
    new_start_time: str,          # '11:00 AM'
    new_end_time:   str,          # '1:00 PM'
    new_court_id:   int = None,   # None = keep existing court
    dry_run:        bool = False,
) -> dict:
    """
    Move an existing occurrence to a new timeslot (and optionally a new court)
    by opening the UpdateReservation modal on the occurrences grid page.

    Returns {"success", "screenshot", "error"}
    """
    from pathlib import Path as _Path
    import os as _os
    _SCREENSHOTS = _Path(__file__).parent / "logs" / "screenshots"
    _os.makedirs(_SCREENSHOTS, exist_ok=True)
    shot_base = str(_SCREENSHOTS / f"move_{occurrence_id}")

    if dry_run:
        return {"success": True, "dry_run": True, "screenshot": f"{shot_base}_dryrun.png", "error": None}

    # Navigate to occurrences grid (jQuery + Kendo available here)
    page.goto(OCCURRENCES_URL.format(event_id=event_id))
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    # Click the UpdateReservation modal link for this occurrence
    clicked = page.evaluate(f"""
        (function() {{
            var links = Array.from(document.querySelectorAll('a[data-remote*="UpdateReservation"]'));
            for (var l of links) {{
                if (l.getAttribute('data-remote').indexOf('{occurrence_id}') !== -1) {{
                    l.click();
                    return true;
                }}
            }}
            return false;
        }})()
    """)

    if not clicked:
        page.screenshot(path=f"{shot_base}_no_edit_link.png")
        return {
            "success": False,
            "screenshot": f"{shot_base}_no_edit_link.png",
            "error": f"Edit link for occurrence_id={occurrence_id} not found in grid",
        }

    try:
        page.wait_for_selector(".action-modal.in", timeout=10000)
    except Exception:
        page.screenshot(path=f"{shot_base}_modal_timeout.png")
        return {
            "success": False,
            "screenshot": f"{shot_base}_modal_timeout.png",
            "error": "Timed out waiting for edit modal",
        }
    page.wait_for_timeout(1500)

    court_js = ""
    if new_court_id:
        court_js = f"""
            var ms = $('#Courts').data('kendoMultiSelect');
            if (ms) {{ ms.value([]); ms.value([{new_court_id}]); ms.trigger('change'); }}
        """

    page.evaluate(f"""
        (function() {{
            // Edit only this occurrence, not the whole series
            var cb = $('#EditOnlyCurrentOccurrence');
            if (cb.length && !cb.is(':checked')) {{
                cb.prop('checked', true).trigger('change');
            }}
            // New start time
            var tp1 = $('#StartTime').data('kendoTimePicker');
            if (tp1) {{ tp1.value('{new_start_time}'); tp1.trigger('change'); }}
            // New end time
            var tp2 = $('#EndTime').data('kendoTimePicker');
            if (tp2) {{ tp2.value('{new_end_time}'); tp2.trigger('change'); }}
            // Optionally change court
            {court_js}
        }})();
    """)
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{shot_base}_before_save.png")

    save_btn = page.query_selector(
        ".action-modal button.btn-success:not(:has-text('Register')), "
        ".modal button:has-text('Save'):not(:has-text('Register'))"
    )
    if not save_btn:
        save_btn = page.query_selector(".action-modal button:has-text('Save'), .modal button:has-text('Save')")
    if not save_btn:
        return {
            "success": False,
            "screenshot": f"{shot_base}_before_save.png",
            "error": "Save button not found in modal",
        }

    try:
        save_btn.click()
        page.wait_for_timeout(3000)
    except Exception:
        pass

    try:
        err_el = page.query_selector(".alert-danger, .validation-summary-errors, .field-validation-error")
        if err_el and err_el.is_visible():
            err_text = err_el.inner_text().strip()
            page.screenshot(path=f"{shot_base}_error.png")
            return {"success": False, "screenshot": f"{shot_base}_error.png", "error": err_text}
    except Exception:
        pass

    page.screenshot(path=f"{shot_base}_after_save.png")
    return {"success": True, "screenshot": f"{shot_base}_after_save.png", "error": None}


def fix_event_court(
    page:          Page,
    event_id:      int,
    date:          str,            # 'M/D/YYYY'
    start_time:    str,            # '9:00 AM'
    end_time:      str,            # '11:00 AM'
    court_id:      int,
    occurrence_id = None,  # if known, skip grid search entirely
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
