/**
 * What is a real MISSING standing session (#118)? Ron, 2026-11-10: "Missing sessions could be
 * because I delete them to make room for other events". A deleted occurrence leaves no trace in
 * the calendar, so the sweep reads the booking ledger: booked once and gone is a person's call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPatternGaps, scanPatternGaps, needsAttention } from '../src/jobs/patternGaps'
import { buildPatternGapsEmbed, gapCounts } from '../src/discord/notify'
import { beforeLedger, patternKey, readStandingLedger, wasBooked } from '../src/standingLedger'
import { runScheduler } from '../src/scheduler'
import { NaiveDateTime } from '../src/datetime'
import type { FixedEvent, Policy } from '../src/policy'
import type { ScheduleItem } from '../src/cr/types'

const TODAY = NaiveDateTime.parseDate('10/16/2026') // Friday
const MON = NaiveDateTime.parseDate('10/19/2026') // 3 days out
const THU_TODAY = NaiveDateTime.parseDate('10/19/2026')

const pattern: FixedEvent = {
  name: 'Co-ed Intermediate Structured Play',
  event_id: 2316716,
  day_of_week: 'Monday',
  start_time: '17:00',
  end_time: '19:00',
  courts: 2,
}
const busy = (id: number, court: number): ScheduleItem => ({
  Id: id,
  EventId: 9000 + id,
  EventName: 'Rental',
  StartDateTime: '2026-10-19T17:00:00',
  EndDateTime: '2026-10-19T19:00:00',
  Courts: `Court #${court}`,
})
const session: ScheduleItem = {
  Id: 1,
  EventId: 2316716,
  EventName: pattern.name,
  StartDateTime: '2026-10-19T17:00:00',
  EndDateTime: '2026-10-19T19:00:00',
  Courts: 'Court #2, Court #3',
}

const view = (rows: string[], startedOn: string | null) => ({ startedOn, booked: new Set(rows) })
const row = (ymd: string) => `${patternKey(pattern)}|${ymd}|17:00`

describe('the ledger rules in the scan', () => {
  it('booked once, gone now → removed, with or without the ledger being old', () => {
    const v = view([row('2026-10-19')], '2026-09-01')
    const gaps = scanPatternGaps([pattern], [], [MON], undefined, {}, { view: v, today: TODAY })
    expect(gaps.map((g) => g.status)).toEqual(['removed'])
    expect(gaps[0].before_ledger).toBeUndefined()
  })

  it('never booked, ledger old enough to vouch → stays a gap to book', () => {
    const v = view([], '2026-09-01')
    const gaps = scanPatternGaps([pattern], [], [MON], undefined, {}, { view: v, today: TODAY })
    expect(gaps.map((g) => g.status)).toEqual(['no_court'])
  })

  it('a date the ledger cannot vouch for reads absent as removed (fail-closed), and says why', () => {
    const v = view([], '2026-10-10') // 10/19 is inside started_on + 14 days
    const gaps = scanPatternGaps([pattern], [], [MON], undefined, {}, { view: v, today: TODAY })
    expect(gaps.map((g) => [g.status, g.before_ledger])).toEqual([['removed', true]])
  })

  it('a pattern created after the ledger started, absent and never recorded → missing, booked if a court is free (#140)', () => {
    const v = view([], '2026-10-10')
    const fresh = { ...pattern, created_at: '2026-10-14T16:53:00Z' }
    const gaps = scanPatternGaps([fresh], [], [MON], undefined, {}, { view: v, today: TODAY })
    expect(gaps.map((g) => [g.status, g.before_ledger])).toEqual([['no_court', undefined]])
  })

  it('a pattern older than the ledger, same date → still removed (#140)', () => {
    const v = view([], '2026-10-10')
    const old = { ...pattern, created_at: '2026-09-01T00:00:00Z' }
    const gaps = scanPatternGaps([old], [], [MON], undefined, {}, { view: v, today: TODAY })
    expect(gaps.map((g) => [g.status, g.before_ledger])).toEqual([['removed', true]])
  })

  it('no created_at, or an unreadable ledger → books nothing (#140)', () => {
    const none = scanPatternGaps([pattern], [], [MON], undefined, {}, { view: view([], '2026-10-10'), today: TODAY })
    expect(none.map((g) => g.status)).toEqual(['removed'])
    const fresh = { ...pattern, created_at: '2026-10-14T16:53:00Z' }
    const down = scanPatternGaps([fresh], [], [MON], undefined, {}, { view: null, today: TODAY })
    expect(down.map((g) => g.status)).toEqual(['ledger_down'])
  })

  it('a fresh pattern whose session WAS recorded and then deleted is still removed (D-0315, #140)', () => {
    const fresh = { ...pattern, created_at: '2026-10-14T16:53:00Z' }
    const gaps = scanPatternGaps([fresh], [], [MON], undefined, {}, { view: view([row('2026-10-19')], '2026-10-10'), today: TODAY })
    expect(gaps.map((g) => g.status)).toEqual(['removed'])
  })

  it('an empty ledger vouches for nothing', () => {
    expect(beforeLedger(view([], null), '2030-01-01')).toBe(true)
  })

  it('an unreadable ledger is ledger_down, which needs attention', () => {
    const gaps = scanPatternGaps([pattern], [], [MON], undefined, {}, { view: null, today: TODAY })
    expect(gaps.map((g) => g.status)).toEqual(['ledger_down'])
    expect(needsAttention({ gaps, patternsLive: true, patternsSource: 'live', daysScanned: 1 })).toBe(true)
  })

  it('today and tomorrow are too soon — absent or short — the day after is not', () => {
    const v = view([], '2026-01-01')
    const short = { ...session, Courts: 'Court #2' }
    const at = (today: string, items: ScheduleItem[]) =>
      scanPatternGaps([pattern], items, [MON], undefined, {}, { view: v, today: NaiveDateTime.parseDate(today) }).map((g) => g.status)
    expect(at('10/19/2026', [])).toEqual(['too_soon'])
    expect(at('10/18/2026', [])).toEqual(['too_soon'])
    expect(at('10/17/2026', [])).toEqual(['no_court'])
    expect(at('10/18/2026', [short])).toEqual(['too_soon'])
    expect(at('10/17/2026', [short])).toEqual(['no_court'])
  })

  it('a session on the calendar on all its courts stays silent', () => {
    const v = view([], null)
    expect(scanPatternGaps([pattern], [session], [MON], undefined, {}, { view: v, today: THU_TODAY })).toEqual([])
  })

  it('wasBooked keys on pattern, date and start time', () => {
    const v = view([row('2026-10-19')], '2026-01-01')
    expect(wasBooked(v, pattern, '2026-10-19')).toBe(true)
    expect(wasBooked(v, pattern, '2026-10-26')).toBe(false)
  })
})

describe('the whole sweep', () => {
  const ledgerPayload = (items: unknown[], started: string | null) => async () => ({ items, ledger_started_on: started })
  const rows = (ymd: string) => [
    { pattern_key: patternKey(pattern), occurrence_date: ymd, start_time: '17:00:00', cr_event_id: '2316716', cr_occurrence_id: '5', booked_by: 'daily' },
  ]
  const mk = (over: Record<string, unknown>, schedule: ScheduleItem[] = []) => {
    const booked: unknown[] = []
    const recorded: unknown[] = []
    const cr = {
      fixedEvents: async () => [pattern],
      schedule: async () => schedule,
      standingLedger: ledgerPayload([], '2026-01-01'),
      recordStandingBooking: async (r: unknown) => { recorded.push(r); return {} },
      book: async (r: unknown) => { booked.push(r); return { success: true, occurrence_id: 77 } },
      ...over,
    } as never
    return { cr, booked, recorded }
  }
  const run = async (cr: never, reported?: { load(): Record<string, true> | null; save(l: Record<string, true>): void }, fix = true) => {
    const posted: unknown[] = []
    const result = await runPatternGaps(
      cr,
      { rest: { postEmbed: async (p: unknown) => { posted.push(p); return 'm' } } as never, policy: { fixed_events: { events: [] } } as never, reported },
      { fix, horizonDays: 4, today: TODAY },
    )
    return { result, posted }
  }

  it('a never-booked session with a free court, 2+ days out, is booked with all its courts and recorded', async () => {
    const { cr, booked, recorded } = mk({})
    const { result } = await run(cr)
    expect(booked).toHaveLength(1)
    expect((booked[0] as { court_ids: string[] }).court_ids).toHaveLength(2)
    expect(result.gaps.map((g) => g.status)).toEqual(['booked'])
    expect(recorded).toEqual([
      { pattern_key: patternKey(pattern), occurrence_date: '2026-10-19', start_time: '17:00', cr_event_id: '2316716', cr_occurrence_id: '77', booked_by: 'gap_sweep' },
    ])
  })

  it('booked, then deleted: not re-booked, no alarm, listed once as removed', async () => {
    const { cr, booked } = mk({ standingLedger: ledgerPayload(rows('2026-10-19'), '2026-09-01') })
    let held: Record<string, true> | null = {}
    const reported = { load: () => held, save: (l: Record<string, true>) => { held = l } }
    const first = await run(cr, reported)
    expect(booked).toEqual([])
    expect(first.result.gaps.map((g) => g.status)).toEqual(['removed'])
    expect(needsAttention(first.result)).toBe(false)
    const second = await run(cr, reported)
    expect(second.result.gaps).toEqual([])
    expect(second.posted).toEqual([])
  })

  it('a report-only run does not use up the "once"', async () => {
    const { cr } = mk({ standingLedger: ledgerPayload(rows('2026-10-19'), '2026-09-01') })
    let held: Record<string, true> | null = {}
    const reported = { load: () => held, save: (l: Record<string, true>) => { held = l } }
    await run(cr, reported, false)
    expect((await run(cr, reported)).result.gaps.map((g) => g.status)).toEqual(['removed'])
  })

  it('never booked, every court held by other events: made way, reported on the first sweep only', async () => {
    const all = [1, 2, 3, 4].map((c) => busy(c, c))
    const { cr, booked } = mk({}, all)
    let held: Record<string, true> | null = {}
    const reported = { load: () => held, save: (l: Record<string, true>) => { held = l } }
    const first = await run(cr, reported)
    expect(first.result.gaps.map((g) => g.status)).toEqual(['made_way'])
    expect(needsAttention(first.result)).toBe(false)
    expect((await run(cr, reported)).result.gaps).toEqual([])
    expect(booked).toEqual([])
  })

  it('an unreachable ledger books nothing absent and says so', async () => {
    const { cr, booked } = mk({ standingLedger: async () => { throw new Error('503') } })
    const { result } = await run(cr)
    expect(booked).toEqual([])
    expect(result.gaps.map((g) => g.status)).toEqual(['ledger_down'])
    expect(needsAttention(result)).toBe(true)
  })

  it('readStandingLedger returns null when the read throws', async () => {
    const cr = { standingLedger: async () => { throw new Error('down') } } as never
    expect(await readStandingLedger(cr, '2026-10-16', '2026-10-30')).toBeNull()
  })

  it('a booking whose ledger write fails still counts as booked', async () => {
    const { cr } = mk({ recordStandingBooking: async () => { throw new Error('nope') } })
    expect((await run(cr)).result.gaps.map((g) => g.status)).toEqual(['booked'])
  })
})

describe('the report', () => {
  const g = (status: string) => ({ date: '10/19/2026', day_of_week: 'Monday', start_time: '17:00', name: 'X', wants_courts: 2, has_courts: 0, status })
  it('ends with the five counts', () => {
    const gaps = [g('booked'), g('widened'), g('removed'), g('made_way'), g('too_soon'), g('failed'), g('no_court')]
    expect(gapCounts(gaps)).toBe('2 booked · 1 removed by you · 1 made way · 1 too soon · 2 could not book')
    const embed = buildPatternGapsEmbed(gaps, { daysScanned: 14, patternsLive: true }) as { embeds: { description: string }[] }
    expect(embed.embeds[0].description.trimEnd().endsWith(gapCounts(gaps))).toBe(true)
    expect(embed.embeds[0].description).toContain('you took this off')
  })
})

describe('daily and catch-up record what they book', () => {
  let tmp: string
  beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'sl-'))))
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))
  const policy = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'policy.json'), 'utf8'),
  ) as Policy

  const go = async (bookedBy?: 'catch_up') => {
    const recorded: Array<{ booked_by: string; pattern_key: string; occurrence_date: string }> = []
    const cr = {
      schedule: async () => [],
      book: async () => ({ success: true, occurrence_id: 31 }),
      recordStandingBooking: async (r: never) => { recorded.push(r); return {} },
    } as never
    await runScheduler(
      '10/19/2026',
      {
        cr,
        rest: { postEmbed: async () => 'm' } as never,
        policy,
        pendingPath: resolve(tmp, 'pending_approval.json'),
        stateDir: resolve(tmp, 'state'),
        resolveProvenance: () => ({ policy_sha: 'a', head_sha: 'a', behind_origin_main: 0 }),
        resolveFixedEvents: async () => ({ events: [pattern], source: 'live', expired: [] }),
      },
      { llm: false, autoBook: true, bookedBy },
    )
    return recorded
  }

  it('the daily run records its standing booking as daily', async () => {
    const r = await go()
    expect(r.filter((x) => x.pattern_key === patternKey(pattern))).toEqual([
      expect.objectContaining({ booked_by: 'daily', occurrence_date: '2026-10-19' }),
    ])
  })

  it('catch-up records it as catch_up', async () => {
    const r = await go('catch_up')
    expect(r.filter((x) => x.pattern_key === patternKey(pattern))[0]?.booked_by).toBe('catch_up')
  })
})
