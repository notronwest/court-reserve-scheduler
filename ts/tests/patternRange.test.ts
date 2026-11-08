/**
 * #111: a standing pattern's run is [anchor_date, until] for EVERY cadence. A weekly row
 * used to ignore its anchor and was only cut off once `until` had passed today, so a
 * clinic block could book outside its dates. Pass 0 and the gap scan both ask onWeekStatus.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { recommend } from '../src/recommender'
import { scanPatternGaps } from '../src/jobs/patternGaps'
import { NaiveDateTime } from '../src/datetime'
import { isOnWeek, type FixedEvent, type Policy } from '../src/policy'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const base = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy
const EID = 888888
const monday: FixedEvent = {
  name: 'Clinic Block Monday',
  event_id: EID,
  day_of_week: 'Monday',
  start_time: '17:00',
  end_time: '19:00',
  courts: 2,
}
const d = (s: string) => NaiveDateTime.parseDate(s)
const booked = (fe: FixedEvent, date: string) =>
  recommend([], d(date).formatDate(), { ...base, fixed_events: { events: [fe] } }).recommendations.some(
    (r) => r.event_id === EID,
  )

describe('pattern run range', () => {
  const anchored = { ...monday, every_weeks: 1, anchor_date: '2026-11-16' }
  it('a weekly row is not booked before its anchor, and is on the anchor', () => {
    expect(booked(anchored, '2026-11-09')).toBe(false)
    expect(booked(anchored, '2026-11-16')).toBe(true)
    expect(booked({ ...monday, anchor_date: '2026-11-16' }, '2026-11-09')).toBe(false)
  })
  it('a weekly row is not booked after its until, and is on the until date', () => {
    const ending = { ...monday, until: '2026-12-20T00:00:00Z' }
    expect(booked(ending, '2026-12-21')).toBe(false)
    expect(booked(ending, '2027-01-04')).toBe(false)
    expect(booked({ ...ending, until: '2026-12-21' }, '2026-12-21')).toBe(true)
  })
  it('null anchor and until books every matching weekday as before', () => {
    expect(isOnWeek(monday, d('2026-11-09'))).toBe(true)
    expect(isOnWeek(monday, d('2027-03-01'))).toBe(true)
  })
  it('every-other-week still alternates inside the range', () => {
    const eow = { ...monday, every_weeks: 2, anchor_date: '2026-11-16', until: '2026-12-20' }
    const on = ['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21']
      .filter((x) => isOnWeek(eow, d(x)))
    expect(on).toEqual(['2026-11-16', '2026-11-30', '2026-12-14'])
  })
  it('the gap scan reports nothing outside the range', () => {
    const fe = { ...monday, anchor_date: '2026-11-16', until: '2026-12-20' }
    expect(scanPatternGaps([fe], [], [d('2026-11-09')])).toEqual([])
    expect(scanPatternGaps([fe], [], [d('2026-12-21')])).toEqual([])
    expect(scanPatternGaps([fe], [], [d('2026-11-16')]).length).toBe(1)
  })
})
