/**
 * Court Reserve payload shapes as exposed by the `courtreserve-api` service.
 * CR's report data is loosely typed, so `ScheduleItem` is intentionally open.
 */
export interface ScheduleItem {
  Id?: number
  EventId?: number
  StartDateTime?: string
  EndDateTime?: string
  Courts?: string
  EventName?: string
  [key: string]: unknown
}

/** One full occurrence with a waitlist, from GET /waitlists. */
export interface WaitlistOccurrence {
  res_id: string
  event_id: number
  date: string // ISO "YYYY-MM-DD"
  date_text: string
  time_text: string
  courts_text: string
  registered: number
  max_people: number
  waitlist: number
}

/** A past occurrence with registrants (from GET /checkin/scan). */
export interface CheckinCandidate {
  res_id: string
  event_id: number
  date: string // ISO "YYYY-MM-DD"
  date_text: string
  registrations: string
}

/** Result of POST /checkin for one occurrence. */
export interface CheckinResult {
  success: boolean
  checked_in: number
  total: number
  names: string[]
  error: string | null
}

/** One registered participant on an occurrence, from GET /events/{id}/roster. */
export interface RosterEntry {
  org_member_id: number
  member_name: string
  email: string | null
  has_email: boolean
}

/**
 * Move ONE member between two occurrences of the SAME event
 * (courtreserve-api `POST /events/registrations/move`).
 *
 * The service registers the destination and verifies it BEFORE withdrawing the
 * source, so a half-finished move leaves the member on both rosters — visible,
 * one click to undo — rather than on neither, and answers 409 naming which half
 * landed. It also reads what the member paid off the source row rather than
 * assuming the move is free.
 */
export interface MoveRegistrantRequest {
  event_id: number
  from_res_id: number
  to_res_id: number
  org_member_id: number
  /**
   * Court Reserve's own confirmation email. The service defaults this to TRUE
   * (Ron, 2026-10-14: registration emails go via CR), but a duplicate cleanup
   * passes FALSE — Ron, 2026-10-25: "I am ok with them getting an email because
   * I don't think there is a way to prevent that -- but if there is one -- then
   * use it". There is one, so a member is not emailed about a tidy-up they did
   * not ask for.
   */
  notify?: boolean
  reason?: string
  allow_waitlist_promotion?: boolean
  max_cost?: number
}

/** Request bodies mirror courtreserve-api's endpoints (service.py). */
export interface BookRequest {
  event_id: string
  date: string // M/D/YYYY
  start_time: string // e.g. "2:00 PM"
  end_time: string
  /** ONE court. Kept for callers that only ever book one; `/book` reads it as a list of one. */
  court_id?: string
  /**
   * EVERY court the occurrence should hold (courtreserve-api #409). Court Reserve books an
   * occurrence on one court and assigns the rest by editing it, and a caller that did that
   * itself — one `/book` per court — produced TWO half-capacity events on the member panel
   * three times in October. The endpoint owns both steps now; asking for N courts and
   * getting fewer comes back as a failure, never a partial success (daemon D-0166).
   */
  court_ids?: string[]
  /** The cap for the whole occurrence, applied in the same edit as the courts. */
  max_people?: number
  dry_run?: boolean
}
export interface MoveRequest {
  event_id: string        // the parent event (needed to open the occurrences grid)
  occurrence_id: string   // the reservation/occurrence being moved
  current_date: string    // M/D/YYYY the occurrence sits on today
  new_date: string        // M/D/YYYY to move it to (== current_date for a same-day retime)
  new_start: string
  new_end: string
  new_court_id?: string | null
  event_name?: string
  edit_series?: boolean    // same-day only: apply to the whole series forward
}
export interface CancelRequest {
  res_id: string
}
export interface SetCourtsRequest {
  res_id: string
  court_ids: string[]
  max_people: number
  event_id: string // selects the occurrence's edit grid (required by the service)
}
export interface FixCourtRequest {
  event_id: string
  date: string
  start_time: string
  court_id: string
}

/**
 * Normalized result of a CR mutation (book / move / setCourts). Verified against
 * the live `courtreserve-api` (`courtreserve_api/booking.py`): `/book` returns the
 * `book_event` dict `{success, occurrence_id, error, …}` and `/events/courts`
 * returns `edit_occurrence_multi_court` `{success, error, …}`. `normalizeCrResult`
 * (execute.ts) coerces those (plus tolerant aliases) into this shape.
 */
export interface CrActionResult {
  success: boolean
  occurrence_id?: number
  error?: string
}
