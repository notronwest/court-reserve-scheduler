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

/** Request bodies mirror courtreserve-api's endpoints (service.py). */
export interface BookRequest {
  event_id: string
  date: string // M/D/YYYY
  start_time: string // e.g. "2:00 PM"
  end_time: string
  court_id: string
  dry_run?: boolean
}
export interface MoveRequest {
  res_id: string
  new_date: string
  new_start: string
  new_end: string
}
export interface CancelRequest {
  res_id: string
}
export interface SetCourtsRequest {
  res_id: string
  court_ids: string[]
  max_people: number
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
