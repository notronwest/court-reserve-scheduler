import type {
  ScheduleItem,
  BookRequest,
  MoveRequest,
  CancelRequest,
  SetCourtsRequest,
  FixCourtRequest,
  WaitlistOccurrence,
} from './types'

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

  /** Full occurrences with a waitlist in the next `days` days, for the given events. */
  async waitlists(eventIds: number[], days: number): Promise<WaitlistOccurrence[]> {
    const q = new URLSearchParams({ event_ids: eventIds.join(','), days: String(days) })
    const data = await this.request<{ items: WaitlistOccurrence[] }>('GET', `/waitlists?${q}`)
    return data.items
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
