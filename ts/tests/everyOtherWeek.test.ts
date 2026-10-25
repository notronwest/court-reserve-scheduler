/**
 * D-0202's enforced-by: one two-week row, and Pass 0, catch-up and the gap scan must agree
 * on which dates in a four-week window are sessions. All three ask `onWeekStatus`, so a
 * second copy of the arithmetic anywhere would show up here as a disagreement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { recommend } from '../src/recommender'
import { scanPatternGaps, horizonDates } from '../src/jobs/patternGaps'
import { scanCatchUp } from '../src/jobs/catchUp'
import { NaiveDateTime } from '../src/datetime'
import { invalidCadence, isOnWeek, onWeekStatus, type FixedEvent, type Policy } from '../src/policy'
import { dropExpired, resolveFixedEvents } from '../src/fixedEvents'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const base = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy

const EID = 777777
const divas: FixedEvent = {
  name: "Caryn's Dink Divas",
  event_id: EID,
  day_of_week: 'Wednesday',
  start_time: '17:00',
  end_time: '19:00',
  courts: 2,
  every_weeks: 2,
  anchor_date: '2026-10-07',
}
const policyWith = (rows: FixedEvent[]): Policy => ({ ...base, fixed_events: { events: rows } })

// Four weeks of the Wednesday and the days around it: 10/5 (Mon) .. 11/1 (Sun).
const WINDOW = horizonDates(NaiveDateTime.parseDate('10/5/2026'), 28)
const SESSIONS = ['2026-10-07', '2026-10-21'] // on-weeks; 10/14 and 10/28 are off

describe('every-other-week standing sessions', () => {
  it('Pass 0, catch-up and the gap scan agree on the sessions in a 4-week window', () => {
    const policy = policyWith([divas])

    const pass0 = WINDOW.filter((d) =>
      recommend([], d.formatDate(), policy).recommendations.some((r) => r.event_id === EID),
    ).map((d) => d.formatYmd())

    const gapScan = WINDOW.filter(
      (d) => scanPatternGaps([divas], [], [d]).length > 0,
    ).map((d) => d.formatYmd())

    const predicate = WINDOW.filter((d) => isOnWeek(divas, d)).map((d) => d.formatYmd())

    expect(predicate).toEqual(SESSIONS)
    expect(pass0).toEqual(SESSIONS)
    expect(gapScan).toEqual(SESSIONS)
  })

  it('catch-up (which drives recommend) sees the session only on on-weeks', async () => {
    const cr = { schedule: async () => [] } as never
    const run = async (rows: FixedEvent[]) =>
      scanCatchUp(cr, policyWith(rows), {
        today: new Date(Date.UTC(2026, 9, 5)),
        horizonDays: 27,
        retryDelaysMs: [],
        logsDir: '/nonexistent',
        log: () => {},
      } as never)
    const withRow = await run([divas])
    const without = await run([])
    const differs = withRow
      .filter((d, i) => d.n_recommendations !== without[i].n_recommendations)
      .map((d) => NaiveDateTime.parseDate(d.date).formatYmd())
    // Off-weeks must look exactly like a policy with no such row at all.
    expect(differs.every((d) => SESSIONS.includes(d))).toBe(true)
  })

  it('does not report an off-week as missing, nor count its level', () => {
    const off = NaiveDateTime.parseDate('10/14/2026')
    expect(scanPatternGaps([divas], [], [off])).toEqual([])
    expect(onWeekStatus(divas, off)).toBe('off')
  })

  it('treats a missing every_weeks as weekly', () => {
    const weekly: FixedEvent = { ...divas, every_weeks: null, anchor_date: null }
    expect(WINDOW.filter((d) => isOnWeek(weekly, d)).length).toBe(4)
  })

  it('is off before the anchor, on every second week after it', () => {
    expect(isOnWeek(divas, NaiveDateTime.parseDate('9/30/2026'))).toBe(false)
    expect(isOnWeek(divas, NaiveDateTime.parseDate('9/23/2026'))).toBe(false)
    expect(isOnWeek(divas, NaiveDateTime.parseDate('10/7/2026'))).toBe(true)
    expect(isOnWeek(divas, NaiveDateTime.parseDate('10/28/2026'))).toBe(false)
    expect(isOnWeek(divas, NaiveDateTime.parseDate('11/4/2026'))).toBe(true)
  })

  it.each([
    ['missing anchor', { anchor_date: null }],
    ['malformed anchor', { anchor_date: 'next week' }],
    ['impossible date', { anchor_date: '2026-02-31' }],
    ['anchor on the wrong weekday', { anchor_date: '2026-10-08' }],
    ['unsupported cadence', { every_weeks: 3 }],
  ])('skips and never books weekly: %s', (_label, over) => {
    const bad: FixedEvent = { ...divas, ...over }
    const policy = policyWith([bad])
    for (const d of WINDOW) {
      expect(isOnWeek(bad, d)).toBe(false)
      expect(recommend([], d.formatDate(), policy).recommendations.some((r) => r.event_id === EID)).toBe(false)
    }
    // Recorded on its weekday, so the booking log shows why.
    const wed = recommend([], '10/7/2026', policy)
    expect(wed.stats.skipped_fixed_events).toContainEqual(
      expect.objectContaining({ event_id: EID, reason: 'bad_anchor' }),
    )
  })

  // D-0224: the anchor answers WHICH WEEK, not when the series begins. A pattern put on a
  // group that has already been meeting has to name a Wednesday it really ran on, and the
  // only honest one is in the past — so a back-dated anchor is a correct row, not a defect.
  // What it must never do is add a session: it sets parity and nothing else.
  it('a back-dated anchor sets the parity and books nothing extra', () => {
    // Same Wednesdays as `divas` (10/7, 10/21, 11/4 …), named from four weeks earlier.
    const running: FixedEvent = { ...divas, anchor_date: '2026-09-09' }
    expect(invalidCadence(running)).toBe(false)
    for (const d of WINDOW) expect(isOnWeek(running, d)).toBe(isOnWeek(divas, d))

    // The OTHER parity is a different series, not the same one read loosely — one week of
    // back-dating flips which Wednesdays run, which is why it is never guessed at.
    const offParity: FixedEvent = { ...divas, anchor_date: '2026-09-16' }
    expect(isOnWeek(offParity, NaiveDateTime.parseDate('10/7/2026'))).toBe(false)
    expect(isOnWeek(offParity, NaiveDateTime.parseDate('10/14/2026'))).toBe(true)

    // And nothing is booked before the pattern's own window: the scheduler only ever asks
    // about dates from today forward, and a date before the anchor is off either way.
    expect(isOnWeek(running, NaiveDateTime.parseDate('9/2/2026'))).toBe(false)
    const policy = policyWith([running])
    expect(recommend([], '10/7/2026', policy).recommendations.some((r) => r.event_id === EID)).toBe(true)
    expect(recommend([], '10/14/2026', policy).recommendations.some((r) => r.event_id === EID)).toBe(false)
  })

  it('alerts when a resolved pattern has an unusable anchor, and passes the fields through', async () => {
    const bad: FixedEvent = { ...divas, anchor_date: null }
    const cr = { fixedEvents: async () => [divas, bad] } as never
    const res = await resolveFixedEvents(cr, base, { dir: '/tmp/everyotherweek-state', today: '2026-10-05' })
    expect(res.events[0]).toMatchObject({ every_weeks: 2, anchor_date: '2026-10-07' })
    expect(res.alert).toMatch(/every-other-week/)
    expect(dropExpired([divas], '2026-10-05').kept).toHaveLength(1)
  })
})
