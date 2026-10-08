import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanCatchUp,
  runCatchUp,
  classify,
  bookingLogCandidates,
  readBookingLogState,
} from '../src/jobs/catchUp'
import { NaiveDateTime } from '../src/datetime'
import type { Policy } from '../src/policy'
import type { ScheduleItem } from '../src/cr/types'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const policy = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy

// Mirrors the #50 incidents. Today is 10/8/2026. The 8 AM run:
//   - died at the fetch on 9/30 → 10/14 has only its standing events (a few
//     hours) and NO booking log — the 2026-10-08 hole this job exists for;
//   - died at the fetch on 9/22 → 10/6-style day is totally empty, no log;
//   - finished for 10/9 but someone cancelled most of it → thin, log present;
//   - finished for every other day → full, log present.
const TODAY = new Date(Date.UTC(2026, 9, 8)) // 10/8/2026
const ymd = (mdy: string) => NaiveDateTime.parseDate(mdy).formatYmd()

function fullDay(dateYmd: string): ScheduleItem[] {
  return [1, 2, 3, 4].map((n) => ({
    EventId: 999,
    Id: n,
    StartDateTime: `${dateYmd}T00:00:00`,
    EndDateTime: `${dateYmd}T23:59:00`,
    Courts: `Court #${n}`,
  }))
}

function fewHours(dateYmd: string): ScheduleItem[] {
  return [
    { EventId: 998, Id: 1, StartDateTime: `${dateYmd}T09:00:00`, EndDateTime: `${dateYmd}T11:00:00`, Courts: 'Court #1' },
  ]
}

const EMPTY_DAY = '10/10/2026' // fetch died, nothing landed
const MISSED_DAY = '10/14/2026' // fetch died, only standing events landed
const THIN_DAY = '10/9/2026' // run finished, calendar since thinned

function fakeCr(bookedDates: string[] = [], fetchFailures: Map<string, number> = new Map()) {
  return {
    schedule: async (start: string) => {
      const left = fetchFailures.get(start) ?? 0
      if (left > 0) {
        fetchFailures.set(start, left - 1)
        throw new Error('courtreserve-api GET /schedule -> 500: Page.goto: Timeout 30000ms exceeded')
      }
      if (start === EMPTY_DAY) return []
      if (start === MISSED_DAY || start === THIN_DAY) return fewHours(ymd(start))
      return fullDay(ymd(start))
    },
    book: async (req: { date: string }) => {
      bookedDates.push(req.date)
      return { success: true, occurrence_id: 1 }
    },
    setCourts: async () => ({ success: true }),
    fixedEvents: async () => policy.fixed_events?.events ?? [],
  } as never
}

let tmp: string
let logsDir: string
beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'catchup-'))
  logsDir = resolve(tmp, 'logs')
  mkdirSync(logsDir)
  // The daily run finished (booked > 0) for every horizon day except the two
  // dead-fetch days. 10/14's log is written zero-padded, like launchd passes it.
  for (let i = 0; i <= 14; i++) {
    const d = new Date(Date.UTC(2026, 9, 8 + i))
    const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
    if (date === EMPTY_DAY || date === MISSED_DAY) continue
    writeFileSync(
      resolve(logsDir, `booking_log_${date.replace(/\//g, '-')}.json`),
      JSON.stringify({ target_date: date, booked: 6, failed: 0, results: [] }),
    )
  }
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function deps() {
  return {
    rest: { postEmbed: async () => 'm1' } as never,
    policy,
    pendingPath: resolve(logsDir, 'pending_approval.json'),
    stateDir: resolve(tmp, 'state'),
    resolveProvenance: () => ({ policy_sha: 'abc', head_sha: 'abc', behind_origin_main: 0 }),
  }
}

describe('booking log lookup', () => {
  it('accepts both the zero-padded (launchd) and unpadded (hand-run) file spellings', () => {
    const names = bookingLogCandidates('/x', '10/5/2026').map((p) => p.split('/').pop())
    expect(names).toContain('booking_log_10-05-2026.json')
    expect(names).toContain('booking_log_10-5-2026.json')
    writeFileSync(resolve(logsDir, 'booking_log_10-5-2026.json'), JSON.stringify({ booked: 3 }))
    expect(readBookingLogState(logsDir, '10/05/2026')).toBe('ok')
  })

  it('reports none when no log exists and zero_booked when the run booked nothing', () => {
    expect(readBookingLogState(logsDir, '11/1/2026')).toBe('none')
    writeFileSync(resolve(logsDir, 'booking_log_11-01-2026.json'), JSON.stringify({ booked: 0, failed: 5 }))
    expect(readBookingLogState(logsDir, '11/1/2026')).toBe('zero_booked')
  })
})

describe('classify', () => {
  const stats = (existing: number, target = 24) => ({ existing_court_hours: existing, target_court_hours: target })
  it('empty beats everything; a full day is ok whatever the log says', () => {
    expect(classify(stats(0), 5, 'ok')).toBe('empty')
    expect(classify(stats(20), 0, 'none')).toBe('ok')
  })
  it('a missing or zero-booked log with room to fill is missed', () => {
    expect(classify(stats(4.5), 6, 'none')).toBe('missed')
    expect(classify(stats(4.5), 6, 'zero_booked')).toBe('missed')
  })
  it('a finished run whose day has shrunk under half target is thin, above it ok', () => {
    expect(classify(stats(4.5), 6, 'ok')).toBe('thin')
    expect(classify(stats(14), 3, 'ok')).toBe('ok')
  })
})

describe('scanCatchUp', () => {
  it('finds the 10/14-shaped hole as MISSED, an empty day as EMPTY, a cancelled day as THIN, full days OK', async () => {
    const days = await scanCatchUp(fakeCr(), policy, { today: TODAY, horizonDays: 14, logsDir, retryDelaysMs: [] })
    expect(days).toHaveLength(15)
    const by = (d: string) => days.find((x) => x.date === d)!
    expect(by(EMPTY_DAY).status).toBe('empty')
    expect(by(MISSED_DAY).status).toBe('missed')
    expect(by(MISSED_DAY).booking_log).toBe('none')
    expect(by(THIN_DAY).status).toBe('thin')
    expect(by(THIN_DAY).booking_log).toBe('ok')
    // Every other day is full and must NOT be flagged — the old "short" test
    // flagged 15/15 real days and hid the hole.
    const others = days.filter((d) => ![EMPTY_DAY, MISSED_DAY, THIN_DAY].includes(d.date))
    expect(others.every((d) => d.status === 'ok')).toBe(true)
  })

  it('retries a flaky fetch and still classifies the day', async () => {
    const failures = new Map([[MISSED_DAY, 2]]) // two timeouts, third attempt succeeds
    const log: string[] = []
    const days = await scanCatchUp(fakeCr([], failures), policy, {
      today: TODAY,
      horizonDays: 14,
      logsDir,
      retryDelaysMs: [0, 0],
      log: (m) => log.push(m),
    })
    expect(days.find((d) => d.date === MISSED_DAY)?.status).toBe('missed')
    expect(log.filter((l) => l.includes('retrying')).length).toBe(2)
  })

  it('a fetch dead after retries is UNKNOWN — never guessed, never booked', async () => {
    const failures = new Map([[MISSED_DAY, 99]])
    const days = await scanCatchUp(fakeCr([], failures), policy, {
      today: TODAY,
      horizonDays: 14,
      logsDir,
      retryDelaysMs: [0],
    })
    const d = days.find((x) => x.date === MISSED_DAY)!
    expect(d.status).toBe('unknown')
    expect(d.error).toContain('Timeout')
  })
})

describe('runCatchUp', () => {
  it('without --book: reports the gaps, books nothing, posts one Discord report', async () => {
    const bookedDates: string[] = []
    const posted: unknown[] = []
    const d = { ...deps(), rest: { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never }
    const result = await runCatchUp(fakeCr(bookedDates), d, { today: TODAY, horizonDays: 14, logsDir, retryDelaysMs: [] })
    expect(result.booked).toEqual([])
    expect(bookedDates).toEqual([])
    const flagged = result.days.filter((x) => x.status !== 'ok').map((x) => x.date).sort()
    expect(flagged).toEqual([EMPTY_DAY, MISSED_DAY, THIN_DAY].sort())
    expect(posted).toHaveLength(1)
  })

  it('with --book: re-books empty + missed only — thin is reported, full days untouched', async () => {
    const bookedDates: string[] = []
    const posted: { embeds?: { title?: string; description?: string }[] }[] = []
    const d = { ...deps(), rest: { postEmbed: async (p: unknown) => { posted.push(p as never); return 'm1' } } as never }
    const result = await runCatchUp(fakeCr(bookedDates), d, {
      today: TODAY,
      horizonDays: 14,
      logsDir,
      retryDelaysMs: [],
      book: true,
    })
    expect(result.booked.map((b) => b.date).sort()).toEqual([EMPTY_DAY, MISSED_DAY].sort())
    expect(bookedDates.length).toBeGreaterThan(0)
    expect(bookedDates.every((x) => x === EMPTY_DAY || x === MISSED_DAY)).toBe(true)
    // The re-book wrote the daily run's booking log, so tomorrow's scan sees it as finished.
    expect(readBookingLogState(logsDir, MISSED_DAY)).toBe('ok')
    // One report (plus the daily path's own per-day confirmations), naming the hole.
    const report = posted.find((p) => p.embeds?.[0].title?.includes('Catch-up'))
    expect(report?.embeds?.[0].description).toContain(MISSED_DAY)
    expect(report?.embeds?.[0].description).toContain('MISSED')
    expect(report?.embeds?.[0].description).toContain('THIN')
  })

  it('--book-thin also refills thin days', async () => {
    const bookedDates: string[] = []
    const result = await runCatchUp(fakeCr(bookedDates), deps(), {
      today: TODAY,
      horizonDays: 14,
      logsDir,
      retryDelaysMs: [],
      book: true,
      bookThin: true,
      report: false,
    })
    expect(result.booked.map((b) => b.date).sort()).toEqual([EMPTY_DAY, MISSED_DAY, THIN_DAY].sort())
  })

  it('a clean horizon posts nothing', async () => {
    for (const date of [EMPTY_DAY, MISSED_DAY]) {
      writeFileSync(resolve(logsDir, `booking_log_${date.replace(/\//g, '-')}.json`), JSON.stringify({ booked: 6 }))
    }
    const cr = {
      schedule: async (start: string) => fullDay(ymd(start)),
      book: async () => ({ success: true, occurrence_id: 1 }),
      setCourts: async () => ({ success: true }),
      fixedEvents: async () => policy.fixed_events?.events ?? [],
    } as never
    const posted: unknown[] = []
    const d = { ...deps(), rest: { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never }
    const result = await runCatchUp(cr, d, { today: TODAY, horizonDays: 14, logsDir, retryDelaysMs: [], book: true })
    expect(result.days.every((x) => x.status === 'ok')).toBe(true)
    expect(result.booked).toEqual([])
    expect(posted).toEqual([])
  })
})
