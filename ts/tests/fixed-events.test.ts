import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { recommend } from '../src/recommender'
import type { Policy } from '../src/policy'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const basePolicy = (): Policy => JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy

// 7/13/2026 is a Monday, when the "Co-Ed 3.75+ Level Play" fixed event (17:00, Advanced) runs.
const MON = '7/13/2026'

describe('distinct fixed events (Level Play)', () => {
  it('books a fixed event with its own event_id as that distinct event', () => {
    const policy = basePolicy()
    const fe = policy.fixed_events!.events!.find((e) => e.name === 'Co-Ed 3.75+ Level Play')!
    fe.event_id = 1982138
    const { recommendations } = recommend([], MON, policy, { popularity: new Map() })

    const levelPlay = recommendations.find((r) => r.event_id === 1982138)
    expect(levelPlay).toBeDefined()
    expect(levelPlay!.event_name).toBe('Co-Ed 3.75+ Level Play')
    expect(levelPlay!.level).toBe('Advanced')
    expect(levelPlay!.start.formatHm()).toBe('17:00')
    // It did NOT also book the generic Advanced Open Play at that same slot.
    expect(
      recommendations.some((r) => r.event_id === 1633147 && r.start.formatHm() === '17:00'),
    ).toBe(false)
  })

  it('without event_id, maps to the generic Open Play event (unchanged behaviour)', () => {
    const policy = basePolicy() // fixture has no event_id on fixed events
    const { recommendations } = recommend([], MON, policy, { popularity: new Map() })
    const at17 = recommendations.find((r) => r.start.formatHm() === '17:00')
    expect(at17?.event_id).toBe(1633147) // generic Co-ed Advanced Open Play
  })
})

// 7/9/2026 is a Thursday: the fixture has "Co-Ed 3.25-3.5 Level Play" 17:00 (Intermediate).
const THU = '7/9/2026'
const INTERMEDIATE = 1931656

describe('Pass 0 respects the min-gap constraint (hard constraint 3b)', () => {
  it('does not book the same event twice at the same hour, and records why', () => {
    const policy = basePolicy()
    // A second Intermediate fixed event at the same hour as "Co-Ed 3.25-3.5 Level
    // Play" — both resolve to the generic Intermediate id, so this is a duplicate.
    policy.fixed_events!.events!.push({
      name: 'Co-ed Intermediate Open Play',
      day_of_week: 'Thursday',
      start_time: '17:00',
      end_time: '19:00',
      courts: 1,
      level: 'Intermediate',
    })
    const { recommendations, stats } = recommend([], THU, policy, { popularity: new Map() })

    const at17 = recommendations.filter(
      (r) => r.event_id === INTERMEDIATE && r.start.formatHm() === '17:00',
    )
    expect(at17).toHaveLength(1)
    expect(stats.skipped_fixed_events).toContainEqual(
      expect.objectContaining({ event_id: INTERMEDIATE, reason: 'min_gap', start_time: '17:00' }),
    )
  })

  it('skips a fixed event whose event id is already on the live schedule at that hour', () => {
    const policy = basePolicy()
    const live = [
      {
        StartDateTime: '2026-07-09T17:00:00',
        EndDateTime: '2026-07-09T19:00:00',
        Courts: 'Pickleball-Court #1',
        EventId: INTERMEDIATE,
        EventName: 'Co-ed Intermediate Open Play',
      },
    ]
    const { recommendations, stats } = recommend(live, THU, policy, { popularity: new Map() })

    // Pass 0 must not add a second copy on a different free court.
    expect(
      recommendations.some((r) => r.event_id === INTERMEDIATE && r.start.formatHm() === '17:00'),
    ).toBe(false)
    expect(stats.skipped_fixed_events).toContainEqual(
      expect.objectContaining({ event_id: INTERMEDIATE, reason: 'min_gap' }),
    )
  })

  it('a distinct event_id lets both run at the same hour — they are different events', () => {
    const policy = basePolicy()
    // This is the unblock for a genuinely separate Thursday session: give the
    // branded Level Play entry its own CR id so it no longer collides.
    const levelPlay = policy.fixed_events!.events!.find(
      (e) => e.name === 'Co-Ed 3.25-3.5 Level Play',
    )!
    levelPlay.event_id = 1990001
    policy.fixed_events!.events!.push({
      name: 'Co-ed Intermediate Open Play',
      day_of_week: 'Thursday',
      start_time: '17:00',
      end_time: '19:00',
      courts: 1,
      level: 'Intermediate',
    })
    const { recommendations, stats } = recommend([], THU, policy, { popularity: new Map() })

    // Thursday 17:00 also legitimately holds Mens Advanced Plus (a different id);
    // what matters is that the two Intermediate-level entries now BOTH run.
    const ids17 = recommendations.filter((r) => r.start.formatHm() === '17:00').map((r) => r.event_id)
    expect(ids17).toContain(INTERMEDIATE)
    expect(ids17).toContain(1990001)
    expect(stats.skipped_fixed_events).toEqual([])
  })
})

// A 2-court fixed event must never vanish just because no court PAIR is free
// (the women's Thursday 16:00–18:00 rule). Fixture Monday has only the 17:00
// Level Play, so 12:00–14:00 is a clean window to crowd with live bookings.
const live = (courts: number[]) =>
  courts.map((cn) => ({
    StartDateTime: '2026-07-13T12:00:00',
    EndDateTime: '2026-07-13T14:00:00',
    Courts: `Pickleball-Court #${cn}`,
    EventId: 1,
    EventName: 'Reservation',
  }))

const womens = () => ({
  name: "Women's Advanced Intermediate Open Play",
  day_of_week: 'Monday',
  start_time: '12:00',
  end_time: '14:00',
  courts: 2,
  max_participants: 10,
  level: 'Advanced Intermediate',
  event_id: 1717124,
})

describe('Pass 0 never drops a fixed event silently', () => {
  it('books a 2-court fixed event on a single court when no pair is free', () => {
    const policy = basePolicy()
    policy.fixed_events!.events!.unshift(womens())
    // Courts 1, 2 and 3 are taken: no priority pair fits, only court 4 is free.
    const { recommendations, stats } = recommend(live([1, 2, 3]), MON, policy, {
      popularity: new Map(),
    })

    const w = recommendations.find((r) => r.event_id === 1717124)
    expect(w).toBeDefined()
    expect(w!.court_num).toBe(4)
    expect(w!.extra_court_nums).toEqual([])
    expect(w!.max_participants).toBe(5) // 10 configured for 2 courts -> 5 on 1
    expect(stats.skipped_fixed_events).toEqual([])
  })

  it('keeps the full pair and max_participants when a pair is free', () => {
    const policy = basePolicy()
    policy.fixed_events!.events!.unshift(womens())
    const { recommendations } = recommend([], MON, policy, { popularity: new Map() })

    const w = recommendations.find((r) => r.event_id === 1717124)!
    expect(w.extra_court_nums).toHaveLength(1)
    expect(w.max_participants).toBe(10)
  })

  it('reports no_court when every court is taken instead of skipping silently', () => {
    const policy = basePolicy()
    policy.fixed_events!.events!.unshift(womens())
    const { recommendations, stats } = recommend(live([1, 2, 3, 4]), MON, policy, {
      popularity: new Map(),
    })

    expect(recommendations.some((r) => r.event_id === 1717124)).toBe(false)
    expect(stats.skipped_fixed_events).toContainEqual(
      expect.objectContaining({ event_id: 1717124, reason: 'no_court', start_time: '12:00' }),
    )
  })
})
