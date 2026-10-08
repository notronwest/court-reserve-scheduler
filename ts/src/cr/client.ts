import type {
  ScheduleItem,
  BookRequest,
  MoveRequest,
  CancelRequest,
  SetCourtsRequest,
  FixCourtRequest,
  WaitlistOccurrence,
  CheckinCandidate,
  CheckinResult,
} from './types'
import type { FixedEvent } from '../policy'

/**
 * HTTP client for the `courtreserve-api` service — the fleet's single Court Reserve
 * boundary. There is **no Playwright/browser here**: all CR access happens in one
 * process (the service on the Mac mini), so this repo is immune to the browser /
 * Playwright version drift that used to break the Python scheduler.
 *
 * Methods mirror the service endpoints (see courtreserve-api `service.py`).
 */
export class CourtReserveClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 180_000, // a live CR call drives a browser server-side
  ) {}

  /** Deduplicated schedule for a date range. Dates are M/D/YYYY (no leading zeros). */
  async schedule(start: string, end: string): Promise<ScheduleItem[]> {
    const q = new URLSearchParams({ start, end })
    const data = await this.request<{ items: ScheduleItem[] }>('GET', `/schedule?${q}`)
    return data.items
  }

  /** The standing weekly pattern (D-0056) — Postgres-backed, written by the mini on a
   *  dashboard confirm; read here over HTTP rather than from policy.json directly.
   *
   *  The service wraps the rows in `items`, like every other list endpoint here
   *  (`schedule()` above, `waitlists()` below) — see courtreserve-api
   *  `queries.fixed_events`. This used to read `data.events`, which is a key the
   *  endpoint has never sent: the read "succeeded" with `undefined`, Pass 0 then
   *  iterated an empty pattern, and NOTHING alerted — the whole standing weekly
   *  schedule silently stopped being booked. So a payload without an `items`
   *  array is a FAILED read and throws, which routes `resolveFixedEvents` to its
   *  cache and fires the Discord alert instead of booking nothing in silence. */
  async fixedEvents(): Promise<FixedEvent[]> {
    const data = await this.request<{ items?: FixedEvent[] }>('GET', '/fixed-events')
    const items = data?.items
    if (!Array.isArray(items)) {
      throw new Error(
        'courtreserve-api GET /fixed-events -> no `items` array in the payload: ' +
          `${JSON.stringify(data ?? null).slice(0, 200)}`,
      )
    }
    return items
  }

  /** Full occurrences with a waitlist in the next `days` days, for the given events. */
  async waitlists(eventIds: number[], days: number): Promise<WaitlistOccurrence[]> {
    const q = new URLSearchParams({ event_ids: eventIds.join(','), days: String(days) })
    const data = await this.request<{ items: WaitlistOccurrence[] }>('GET', `/waitlists?${q}`)
    return data.items
  }

  /** Past occurrences with registrants that may need check-in (read-only). */
  async checkinScan(eventIds: number[], daysBack: number): Promise<CheckinCandidate[]> {
    const q = new URLSearchParams({ event_ids: eventIds.join(','), days_back: String(daysBack) })
    const data = await this.request<{ items: CheckinCandidate[] }>('GET', `/checkin/scan?${q}`)
    return data.items
  }

  /** Check in every not-yet-checked-in registrant for one occurrence (mutating). */
  checkin(eventId: number, resId: string): Promise<CheckinResult> {
    return this.request<CheckinResult>('POST', '/checkin', {
      event_id: String(eventId),
      res_id: String(resId),
    })
  }

  book(req: BookRequest): Promise<unknown> {
    return this.request('POST', '/book', req)
  }
  move(req: MoveRequest): Promise<unknown> {
    return this.request('POST', '/move', req)
  }
  cancel(req: CancelRequest): Promise<unknown> {
    return this.request('POST', '/cancel', req)
  }
  setCourts(req: SetCourtsRequest): Promise<unknown> {
    return this.request('POST', '/events/courts', req)
  }
  fixCourt(req: FixCourtRequest): Promise<unknown> {
    return this.request('POST', '/events/fix-court', req)
  }

  async health(): Promise<boolean> {
    try {
      await this.request('GET', '/health')
      return true
    } catch {
      return false
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'X-API-Key': this.apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`courtreserve-api ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
      }
      return (text ? JSON.parse(text) : undefined) as T
    } finally {
      clearTimeout(timer)
    }
  }
}
