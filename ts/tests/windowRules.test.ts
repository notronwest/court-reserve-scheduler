import { describe, it, expect } from 'vitest'
import { loadPolicy, type FixedEvent, type Policy } from '../src/policy'
import { recommend } from '../src/recommender'
import {
  inMorningCrewWindow,
  mixedMorningCrewSeries,
  splitByMorningCrewWindow,
  startsAtForbiddenNoon,
} from '../src/windowRules'

/** Ron, 2026-11-16: no event starts at 12:00 Mon–Thu; one Morning Crew price per event. */

const noPop = new Map()
const noonOn = (day: string): FixedEvent => ({
  name: 'Noon Open Play',
  day_of_week: day,
  start_time: '12:00',
  end_time: '14:00',
  courts: 1,
  level: 'Advanced',
})
const withPattern = (events: FixedEvent[]): Policy => {
  const p = loadPolicy()
  return { ...p, fixed_events: { events } }
}
const startsAtNoon = (policy: Policy, date: string): boolean => {
  const { recommendations } = recommend([], date, policy, { popularity: noPop })
  return recommendations.some((r) => r.start.formatHm() === '12:00')
}

describe('hard constraint 7: nothing starts at noon Monday–Thursday', () => {
  const days: Array<[string, string, boolean]> = [
    ['Monday', '11/16/2026', false],
    ['Tuesday', '11/17/2026', false],
    ['Wednesday', '11/18/2026', false],
    ['Thursday', '11/19/2026', false],
    ['Friday', '11/20/2026', true],
    ['Saturday', '11/21/2026', true],
    ['Sunday', '11/22/2026', true],
  ]
  for (const [day, date, allowed] of days) {
    it(`a 12:00 fixed event on ${day} is ${allowed ? 'still booked' : 'refused'}`, () => {
      expect(startsAtNoon(withPattern([noonOn(day)]), date)).toBe(allowed)
    })
  }

  it('says why a refused fixed event was not booked', () => {
    const { stats } = recommend([], '11/16/2026', withPattern([noonOn('Monday')]), { popularity: noPop })
    expect(stats.skipped_fixed_events.map((s) => s.reason)).toContain('noon_start')
  })

  it('the live policy proposes no noon start on any Mon–Thu', () => {
    for (const date of ['11/16/2026', '11/17/2026', '11/18/2026', '11/19/2026']) {
      expect(startsAtNoon(loadPolicy(), date)).toBe(false)
    }
  })

  it('the predicate agrees', () => {
    const p = loadPolicy()
    expect(startsAtForbiddenNoon(p, 'Monday', '12:00')).toBe(true)
    expect(startsAtForbiddenNoon(p, 'Monday', '12:30')).toBe(false)
    expect(startsAtForbiddenNoon(p, 'Friday', '12:00')).toBe(false)
  })
})

describe('hard constraint 8: a series never mixes the Morning Crew window', () => {
  const policy = loadPolicy()

  it('Mon 10:00 + Fri 16:00 comes out as two events, not one series', () => {
    const rows = [
      { day_of_week: 'Monday', start_time: '10:00' },
      { day_of_week: 'Friday', start_time: '16:00' },
    ]
    const groups = splitByMorningCrewWindow(policy, rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual([rows[0]])
    expect(groups[1]).toEqual([rows[1]])
  })

  it('a series wholly inside, or wholly outside, stays one event', () => {
    const inside = [
      { day_of_week: 'Monday', start_time: '08:00' },
      { day_of_week: 'Wednesday', start_time: '10:00' },
    ]
    const outside = [
      { day_of_week: 'Monday', start_time: '14:00' },
      { day_of_week: 'Saturday', start_time: '09:00' },
    ]
    expect(splitByMorningCrewWindow(policy, inside)).toHaveLength(1)
    expect(splitByMorningCrewWindow(policy, outside)).toHaveLength(1)
  })

  it('a session starting 11:00 Mon–Thu that runs to 13:00 is inside the window', () => {
    expect(inMorningCrewWindow(policy, 'Monday', '11:00')).toBe(true)
    expect(inMorningCrewWindow(policy, 'Thursday', '11:59')).toBe(true)
    expect(inMorningCrewWindow(policy, 'Monday', '12:00')).toBe(false)
    expect(inMorningCrewWindow(policy, 'Friday', '10:00')).toBe(false)
  })

  it('names a mixed series in a pattern, and only that one', () => {
    const rows = [
      { name: 'Unleashed', level: 'Advanced', day_of_week: 'Monday', start_time: '10:00' },
      { name: 'Unleashed', level: 'Advanced', day_of_week: 'Friday', start_time: '16:00' },
      { name: 'Evening', level: 'Beginner', day_of_week: 'Tuesday', start_time: '18:00' },
    ]
    expect(mixedMorningCrewSeries(policy, rows)).toEqual(['Unleashed'])
  })
})
