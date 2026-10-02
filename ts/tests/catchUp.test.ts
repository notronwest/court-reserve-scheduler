import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { scanCatchUp, runCatchUp } from '../src/jobs/catchUp'
import { NaiveDateTime } from '../src/datetime'
import type { Policy } from '../src/policy'
import type { ScheduleItem } from '../src/cr/types'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const policy = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy

// Mirrors the #50 incident: today is 10/2/2026, the daily job missed 10/6
// (dead fetch — totally empty) and partially missed 10/8 (3 of 7 slots
// failed — some existing events, but still room to fill).
const TODAY = new Date(Date.UTC(2026, 9, 2)) // 10/2/2026

function fullyBookedItems(dateYmd: string): ScheduleItem[] {
  return [1, 2, 3, 4].map((n) => ({
    EventId: 999,
    Id: n,
    StartDateTime: `${dateYmd}T00:00:00`,
    EndDateTime: `${dateYmd}T23:59:00`,
    Courts: `Court #${n}`,
  }))
}

function partialItems(dateYmd: string): ScheduleItem[] {
  return [
    { EventId: 998, Id: 1, StartDateTime: `${dateYmd}T09:00:00`, EndDateTime: `${dateYmd}T11:00:00`, Courts: 'Court #1' },
  ]
}

function fakeCr(bookedDates: string[] = []) {
  return {
    schedule: async (start: string) => {
      if (start === '10/6/2026') return [] // dead fetch day — nothing landed
      if (start === '10/8/2026') return partialItems('2026-10-08') // partially booked
      const ymd = NaiveDateTime.parseDate(start).formatYmd()
      return fullyBookedItems(ymd)
    },
    book: async (req: { date: string }) => {
      bookedDates.push(req.date)
      return { success: true, occurrence_id: 1 }
    },
    setCourts: async () => ({ success: true }),
  } as never
}

describe('scanCatchUp', () => {
  it('flags a dead-fetch day as empty and a partially-booked day as short, leaving full days ok', async () => {
    const days = await scanCatchUp(fakeCr(), policy, { today: TODAY, horizonDays: 14 })
    expect(days).toHaveLength(15) // today..today+14 inclusive

    const empty = days.find((d) => d.date === '10/6/2026')
    expect(empty?.status).toBe('empty')
    expect(empty?.existing_court_hours).toBe(0)

    const short = days.find((d) => d.date === '10/8/2026')
    expect(short?.status).toBe('short')
    expect(short!.n_recommendations).toBeGreaterThan(0)

    const ok = days.find((d) => d.date === '10/3/2026')
    expect(ok?.status).toBe('ok')
    expect(ok?.n_recommendations).toBe(0)
  })
})

describe('runCatchUp', () => {
  let tmp: string
  beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'catchup-'))))
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function deps() {
    return {
      rest: { postEmbed: async () => 'm1' } as never,
      policy,
      pendingPath: resolve(tmp, 'pending_approval.json'),
    }
  }

  it('without --book: reports the gaps but books nothing', async () => {
    const bookedDates: string[] = []
    const result = await runCatchUp(fakeCr(bookedDates), deps(), { today: TODAY, horizonDays: 14 })
    expect(result.booked).toEqual([])
    expect(bookedDates).toEqual([])
    const flagged = result.days.filter((d) => d.status !== 'ok')
    expect(flagged.map((d) => d.date).sort()).toEqual(['10/6/2026', '10/8/2026'])
  })

  it('with --book: re-books only the flagged dates, never an already-full one', async () => {
    const bookedDates: string[] = []
    const result = await runCatchUp(fakeCr(bookedDates), deps(), {
      today: TODAY,
      horizonDays: 14,
      book: true,
    })
    expect(result.booked.sort()).toEqual(['10/6/2026', '10/8/2026'])
    expect(bookedDates.length).toBeGreaterThan(0)
    expect(bookedDates.every((d) => d === '10/6/2026' || d === '10/8/2026')).toBe(true)
  })
})
