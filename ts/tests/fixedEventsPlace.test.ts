/**
 * A Concord row must never be booked onto a club court — and an UNLABELLED row must
 * never stop being booked (D-0323 rule 9 step a).
 *
 * The clinic programme now runs at two places out of ONE `courtreserve.fixed_events`
 * table: Lincoln (White Mountain Pickleball, Court Reserve organisation 13268) and
 * Concord (Capital City Pickleballers, organisation 16667). `GET /fixed-events` is a
 * `select *` over the whole table, so a Concord row arrives on this repo's wire; this
 * repo books at Lincoln and nowhere else (D-0323 rule 7).
 *
 * ⚠️ **The dangerous half is the absent one.** This filter is deployed BEFORE the
 * migration that adds the column, so on day one every row on the wire carries no place
 * at all, and a `select *` taken between the column being added and the backfill landing
 * returns `place: null` on every row. An earlier draft of this rule said to drop a place
 * that is "absent or unknown" — which would have dropped every standing slot the club
 * has and silently stopped its own sessions being booked. So the tests that matter most
 * here are the two keeping an unlabelled row.
 *
 * Every row in this file goes through the REAL parse path — a raw JSON string off a
 * stubbed `fetch`, the real `CourtReserveClient.fixedEvents()`, the real
 * `resolveFixedEvents` — because the hazard lives in what the wire carries, not in what
 * a hand-built `FixedEvent` object carries. `request()` is a bare `JSON.parse` and
 * `fixedEvents()` returns `items` under a type cast, so an unknown `place` key survives
 * to the filter; a hand-built object would prove none of that.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CourtReserveClient } from '../src/cr/client'
import { resolveFixedEvents, dropOtherPlaces, BOOKS_AT_PLACE } from '../src/fixedEvents'
import { recommend } from '../src/recommender'
import { scanPatternGaps } from '../src/jobs/patternGaps'
import { NaiveDateTime } from '../src/datetime'
import type { FixedEvent, Policy } from '../src/policy'

const FX = resolve(__dirname, 'fixtures')
const basePolicy = (): Policy =>
  JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy

const TODAY = '2026-11-14'

/**
 * A row in the shape `GET /fixed-events` actually serves today: `select *` over
 * `courtreserve.fixed_events`, so snake_case columns, `until` as null, timestamps as
 * ISO strings — and, crucially, **NO `place` key at all**, which is what every row on
 * the wire looks like at the moment this change deploys.
 */
const wireRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 41,
  event_id: 2316716,
  name: 'Co-ed Intermediate Structured Play',
  day_of_week: 'Monday',
  start_time: '17:00',
  end_time: '19:00',
  courts: 2,
  level: 'Intermediate',
  until: null,
  source: 'dashboard',
  active: true,
  preferred_courts: null,
  max_participants: null,
  every_weeks: null,
  anchor_date: null,
  kind: null,
  created_at: '2026-10-02T14:11:03.284Z',
  updated_at: '2026-11-13T09:02:44.117Z',
  ...over,
})

/** A stubbed `fetch` serving a raw JSON body, so the real client parses it. */
function serve(rows: Record<string, unknown>[]) {
  const f = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ items: rows }),
  } as unknown as Response)
  vi.stubGlobal('fetch', f)
  return f
}

function serveFailure() {
  const f = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    text: async () => 'boom',
  } as unknown as Response)
  vi.stubGlobal('fetch', f)
  return f
}

const client = (): CourtReserveClient => new CourtReserveClient('http://svc', 'k')
const names = (events: FixedEvent[]): string[] => events.map((e) => e.name)

describe('the place filter — an unlabelled row is the club\'s', () => {
  let dir: string
  let lines: string[]
  const log = (m: string): void => void lines.push(m)
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'fixed-events-place-'))
    lines = []
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ⚠️ THE TEST THAT MATTERS MOST. Today's `/fixed-events` has no `place` field; the
  // migration that adds it is a later step. Every one of these rows must still book.
  it('books a row carrying NO place field at all — today\'s wire shape', async () => {
    serve([wireRow({ name: 'Monday Structured' }), wireRow({ name: 'Tuesday Level', day_of_week: 'Tuesday' })])
    const result = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    expect(result.source).toBe('live')
    expect(names(result.events)).toEqual(['Monday Structured', 'Tuesday Level'])
    expect(result.elsewhere).toEqual([])
    // Nothing dropped means nothing logged about places, and no alert either: an
    // ordinary day must stay quiet.
    expect(lines.join(' ')).not.toContain('another place')
    expect(result.alert).toBeUndefined()
  })

  // A `select *` between the column being added and the backfill landing serves
  // `place: null` on every row. Same hazard, different spelling.
  it('books a row whose place is explicitly null', async () => {
    serve([wireRow({ place: null })])
    const result = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    expect(names(result.events)).toEqual(['Co-ed Intermediate Structured Play'])
    expect(result.elsewhere).toEqual([])
    expect(result.alert).toBeUndefined()
  })

  it('books a row whose place is lincoln', async () => {
    serve([wireRow({ place: 'lincoln' })])
    const result = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    expect(names(result.events)).toEqual(['Co-ed Intermediate Structured Play'])
    expect(result.events[0].place).toBe('lincoln')
    expect(result.elsewhere).toEqual([])
  })
})

describe('the place filter — a Concord row is dropped', () => {
  let dir: string
  let lines: string[]
  const log = (m: string): void => void lines.push(m)
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'fixed-events-place-'))
    lines = []
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('drops a concord row on the LIVE read, keeps the club\'s, and logs it once', async () => {
    serve([
      wireRow({ name: 'Club Structured Play' }),
      wireRow({ id: 90, name: 'Concord Third Shot Academy', place: 'concord', event_id: 777001 }),
      wireRow({ id: 91, name: 'Concord Dinks', place: 'concord', day_of_week: 'Friday', event_id: 777002 }),
    ])
    const result = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    expect(result.source).toBe('live')
    expect(names(result.events)).toEqual(['Club Structured Play'])
    expect(names(result.elsewhere ?? [])).toEqual(['Concord Third Shot Academy', 'Concord Dinks'])

    // Logged ONCE for the whole resolve, naming each row and its place.
    const placeLines = lines.filter((l) => l.includes('another place'))
    expect(placeLines).toHaveLength(1)
    expect(placeLines[0]).toContain('2 pattern(s) at another place skipped')
    expect(placeLines[0]).toContain('Concord Third Shot Academy')
    expect(placeLines[0]).toContain('[concord]')

    // A Concord row is the table's normal state, not a failure: it must NOT raise the
    // Discord alert, or the club gets one every morning from here on.
    expect(result.alert).toBeUndefined()
  })

  it('drops a row whose place is unrecognised, and logs it', async () => {
    serve([wireRow({ name: 'Club Structured Play' }), wireRow({ id: 92, name: 'Somewhere Else', place: 'berlin' })])
    const result = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    expect(names(result.events)).toEqual(['Club Structured Play'])
    expect(names(result.elsewhere ?? [])).toEqual(['Somewhere Else'])
    const placeLines = lines.filter((l) => l.includes('another place'))
    expect(placeLines).toHaveLength(1)
    expect(placeLines[0]).toContain('[berlin]')
  })

  it('a foreign place is foreign whatever its case or padding', () => {
    const row = (place: unknown): FixedEvent =>
      ({ name: String(place), day_of_week: 'Monday', start_time: '09:00', end_time: '11:00', place }) as FixedEvent
    const { kept, elsewhere } = dropOtherPlaces([
      row('Concord'),
      row(' concord '),
      row('CONCORD'),
      row(' Lincoln '),
      row(''),
      row('   '),
    ])
    expect(names(elsewhere)).toEqual(['Concord', ' concord ', 'CONCORD'])
    // Trimmed/odd-cased Lincoln is still the club's; blank is unlabelled, so kept.
    expect(names(kept)).toEqual([' Lincoln ', '', '   '])
    expect(BOOKS_AT_PLACE).toBe('lincoln')
  })

  it('drops a concord row on the CACHE path too — the cache is written unfiltered', async () => {
    const rows = [
      wireRow({ name: 'Club Structured Play' }),
      wireRow({ id: 90, name: 'Concord Third Shot Academy', place: 'concord', event_id: 777001 }),
    ]
    serve(rows)
    await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    // Cached verbatim, Concord row included — exactly as the `until` cutoff is handled,
    // so the filter has to be re-applied on the way back out.
    const cached = JSON.parse(readFileSync(resolve(dir, 'fixed-events.json'), 'utf8'))
    expect(cached.events).toHaveLength(2)

    lines = []
    serveFailure()
    const result = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    expect(result.source).toBe('cache')
    expect(names(result.events)).toEqual(['Club Structured Play'])
    expect(names(result.elsewhere ?? [])).toEqual(['Concord Third Shot Academy'])
    expect(lines.filter((l) => l.includes('another place'))).toHaveLength(1)
  })

  it('the cached and uncached reads return the SAME set', async () => {
    const rows = [
      wireRow({ name: 'Unlabelled Club Slot' }),
      wireRow({ id: 42, name: 'Null-placed Club Slot', place: null, day_of_week: 'Tuesday' }),
      wireRow({ id: 43, name: 'Lincoln Slot', place: 'lincoln', day_of_week: 'Wednesday' }),
      wireRow({ id: 90, name: 'Concord Slot', place: 'concord', day_of_week: 'Thursday' }),
      wireRow({ id: 92, name: 'Berlin Slot', place: 'berlin', day_of_week: 'Friday' }),
    ]
    serve(rows)
    const live = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    serveFailure()
    const cache = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY, log })

    expect(live.source).toBe('live')
    expect(cache.source).toBe('cache')
    expect(cache.events).toEqual(live.events)
    expect(names(live.events)).toEqual(['Unlabelled Club Slot', 'Null-placed Club Slot', 'Lincoln Slot'])
    expect(names(cache.elsewhere ?? [])).toEqual(names(live.elsewhere ?? []))
  })

  it('drops a concord row from the policy.json SEED path as well', async () => {
    const policy = {
      fixed_events: {
        events: [
          { name: 'Seeded Club Slot', day_of_week: 'Monday', start_time: '09:00', end_time: '11:00' },
          { name: 'Seeded Concord Slot', day_of_week: 'Monday', start_time: '09:00', end_time: '11:00', place: 'concord' },
        ],
      },
    } as unknown as Policy
    serveFailure()
    const result = await resolveFixedEvents(client(), policy, { dir, today: TODAY, log })

    expect(result.source).toBe('seed')
    expect(names(result.events)).toEqual(['Seeded Club Slot'])
    expect(names(result.elsewhere ?? [])).toEqual(['Seeded Concord Slot'])
  })
})

// The filter sits in the ONE shared reader, so proving the downstream claims means
// feeding what that reader returns into the real consumers — Pass 0 (and its tally of
// what it skipped) and the 8:45 gap scan.
describe('a Concord row reaches neither Pass 0 nor the gap scan', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(resolve(tmpdir(), 'fixed-events-place-'))))
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // 11/16/2026 is a Monday.
  const MON = '11/16/2026'
  const concordSlot = (over: Record<string, unknown> = {}) =>
    wireRow({
      id: 90,
      name: 'Concord Third Shot Academy',
      event_id: 777001,
      day_of_week: 'Monday',
      start_time: '12:00',
      end_time: '14:00',
      courts: 2,
      level: 'Intermediate',
      ...over,
    })

  it('Pass 0 never books it and never counts it among what it skipped', async () => {
    serve([concordSlot({ place: 'concord' })])
    const resolved = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY })
    const policy: Policy = {
      ...basePolicy(),
      fixed_events: { events: resolved.events },
    }
    const { recommendations, stats } = recommend([], MON, policy, { popularity: new Map() })

    expect(recommendations.some((r) => r.event_id === 777001)).toBe(false)
    expect(recommendations.some((r) => r.event_name === 'Concord Third Shot Academy')).toBe(false)
    // Not merely skipped — never seen. A Concord slot is not a club gap to report.
    expect(stats.skipped_fixed_events.some((s) => s.event_id === 777001)).toBe(false)

    // And it shifted NOTHING else either. Pass 0's per-level tally counts `fe.level`
    // for every on-week pattern, so a Concord row carrying a level would nudge which
    // levels the later passes think still need coverage — a quiet way for Concord to
    // change what the club books without ever appearing on the calendar. Comparing the
    // whole run against one with an empty pattern covers the tally and anything else
    // derived from it, rather than only the fields this test thought to name.
    const empty = recommend([], MON, { ...basePolicy(), fixed_events: { events: [] } }, {
      popularity: new Map(),
    })
    expect(recommendations).toEqual(empty.recommendations)
    expect(stats).toEqual(empty.stats)
  })

  it('the SAME row with place = lincoln is booked — proving the filter, not a typo', async () => {
    serve([concordSlot({ name: 'Club Afternoon Structured Play', event_id: 777001, place: 'lincoln' })])
    const resolved = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY })
    const policy: Policy = {
      ...basePolicy(),
      fixed_events: { events: resolved.events },
    }
    const { recommendations } = recommend([], MON, policy, { popularity: new Map() })

    const booked = recommendations.find((r) => r.event_id === 777001)
    expect(booked).toBeDefined()
    expect(booked!.start.formatHm()).toBe('12:00')
  })

  it('the 8:45 gap scan sees no hole for it — and sees one for the lincoln twin', async () => {
    serve([concordSlot({ place: 'concord' })])
    const concord = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY })
    const dates = [NaiveDateTime.parseDate(MON)]
    expect(scanPatternGaps(concord.events, [], dates)).toEqual([])

    serve([concordSlot({ place: 'lincoln' })])
    const lincoln = await resolveFixedEvents(client(), basePolicy(), { dir, today: TODAY })
    const gaps = scanPatternGaps(lincoln.events, [], dates)
    // `scanPatternGaps` never emits 'missing': it reports "the shape of the problem,
    // not its fate", which for a row carrying an event id is `no_court` (and `no_event`
    // for one without). The acting half resolves it.
    expect(gaps).toHaveLength(1)
    expect(gaps[0].name).toBe('Concord Third Shot Academy')
    expect(gaps[0].status).toBe('no_court')
    expect(gaps[0].wants_courts).toBe(2)
    expect(gaps[0].has_courts).toBe(0)
  })
})
