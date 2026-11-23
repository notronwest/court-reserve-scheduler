/**
 * A standing row whose start time carries seconds ("16:00:00", how a Postgres `time`
 * serialises) must book exactly as "16:00" — and a row whose time cannot be read must
 * cost only that slot, never the day's run (2026-11-23: the 8:00 booker and the 8:30
 * catch-up both died on `Cannot parse "2026-12-07 16:00:00"`, Dec 7 went unbooked).
 *
 * Rows go through the real client parse + `resolveFixedEvents`; the booker, the
 * catch-up and the 8:45 scan all consume that one resolved list.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CourtReserveClient } from '../src/cr/client'
import { resolveFixedEvents, normalizeClock } from '../src/fixedEvents'
import { recommend } from '../src/recommender'
import { scanPatternGaps, ledgerKey } from '../src/jobs/patternGaps'
import { NaiveDateTime } from '../src/datetime'
import type { Policy } from '../src/policy'

const basePolicy = (): Policy =>
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'policy.json'), 'utf8')) as Policy

const TODAY = '2026-11-23'
const MON = '12/7/2026'

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 64,
  event_id: 777002,
  name: 'Contract Time',
  day_of_week: 'Monday',
  start_time: '16:00:00',
  end_time: '18:00:00',
  courts: 1,
  level: 'Intermediate',
  until: null,
  active: true,
  ...over,
})

function serve(rows: Record<string, unknown>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: rows }),
    } as unknown as Response),
  )
}
const client = (): CourtReserveClient => new CourtReserveClient('http://svc', 'k')

describe('standing-row clock times', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'fixed-events-clock-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('normalizeClock reads HH:MM, HH:MM:SS and rejects the rest', () => {
    expect(normalizeClock('16:00:00')).toBe('16:00')
    expect(normalizeClock('9:30')).toBe('09:30')
    expect(normalizeClock('13:00:00.000')).toBe('13:00')
    for (const bad of ['', null, undefined, 'noon', '25:00', '12:75', '12']) {
      expect(normalizeClock(bad)).toBeNull()
    }
  })

  it('a 16:00:00 row books exactly as 16:00, and keys the ledger the same', async () => {
    serve([row()])
    const seconds = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY })
    serve([row({ start_time: '16:00', end_time: '18:00' })])
    const plain = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY })

    expect(seconds.alert).toBeUndefined()
    expect(seconds.events[0].start_time).toBe('16:00')
    expect(seconds.events[0].end_time).toBe('18:00')

    const date = NaiveDateTime.parseDate(MON)
    expect(ledgerKey(seconds.events[0], date)).toBe(ledgerKey(plain.events[0], date))

    const policy = (r: typeof seconds): Policy => ({
      ...basePolicy(),
      fixed_events: { events: r.events },
    })
    const a = recommend([], MON, policy(seconds), { popularity: new Map() })
    const b = recommend([], MON, policy(plain), { popularity: new Map() })
    expect(a.recommendations.find((r) => r.event_id === 777002)?.start.formatHm()).toBe('16:00')
    expect(a.recommendations).toEqual(b.recommendations)

    const gaps = scanPatternGaps(seconds.events, [], [date])
    expect(gaps).toEqual(scanPatternGaps(plain.events, [], [date]))
  })

  it('one unreadable row alarms and the rest of the day is still booked', async () => {
    serve([
      row({ id: 65, name: 'Garbage Slot', event_id: 777003, start_time: 'half past four' }),
      row(),
    ])
    const r = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY })

    expect(r.events.map((e) => e.name)).toEqual(['Contract Time'])
    expect(r.alert).toContain('Garbage Slot')
    expect(r.alert).toContain('unreadable start/end time')

    const policy: Policy = { ...basePolicy(), fixed_events: { events: r.events } }
    const { recommendations } = recommend([], MON, policy, { popularity: new Map() })
    expect(recommendations.some((x) => x.event_id === 777002)).toBe(true)
  })
})
