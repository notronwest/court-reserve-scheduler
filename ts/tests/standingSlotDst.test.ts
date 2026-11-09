/**
 * A standing 16:00 slot must reach /book as "4:00 PM" whichever side of a clock change
 * its date falls on (notronwest/courtreserve-api#653). The slot's start is a zone-less
 * wall-clock time, so the string handed to Court Reserve is the one the pattern carries,
 * never an instant resolved at the moment the job runs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { runPatternGaps } from '../src/jobs/patternGaps'
import { NaiveDateTime } from '../src/datetime'
import type { FixedEvent } from '../src/policy'

const clinic = (start: string, end: string): FixedEvent => ({
  name: 'Clinic',
  event_id: 4242,
  day_of_week: 'Monday',
  start_time: start,
  end_time: end,
  courts: 1,
})

async function bookRequests(slot: FixedEvent, today: string, tz: string) {
  const prior = process.env.TZ
  process.env.TZ = tz
  try {
    const booked: Array<{ date: string; start_time: string; end_time: string }> = []
    const cr = {
      fixedEvents: async () => [slot],
      schedule: async () => [],
      book: async (req: { date: string; start_time: string; end_time: string }) => {
        booked.push(req)
        return { success: true }
      },
    } as never
    const rest = { postEmbed: async () => 'm1' } as never
    await runPatternGaps(
      cr,
      { rest, policy: { fixed_events: { events: [] } } as never },
      { fix: true, horizonDays: 30, today: NaiveDateTime.parseDate(today) },
    )
    return booked
  } finally {
    if (prior === undefined) delete process.env.TZ
    else process.env.TZ = prior
  }
}

afterEach(() => {
  delete process.env.TZ
})

describe.each(['America/New_York', 'UTC', 'America/Los_Angeles'])('standing slot across a clock change (%s)', (tz) => {
  it.each(['16:00', '16:00:00'])('fall: %s resolved before 2026-11-01 books 11/16 at 4:00 PM', async (start) => {
    const req = (await bookRequests(clinic(start, '18:00'), '10/20/2026', tz)).find((b) => b.date === '11/16/2026')
    expect(req).toMatchObject({ start_time: '4:00 PM', end_time: '6:00 PM' })
  })

  it.each(['16:00', '16:00:00'])('spring: %s resolved before 2027-03-14 books 3/22 at 4:00 PM', async (start) => {
    const req = (await bookRequests(clinic(start, '18:00'), '3/1/2027', tz)).find((b) => b.date === '3/22/2027')
    expect(req).toMatchObject({ start_time: '4:00 PM', end_time: '6:00 PM' })
  })
})
