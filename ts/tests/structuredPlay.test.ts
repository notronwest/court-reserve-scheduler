import { describe, it, expect } from 'vitest'
import { loadPolicy } from '../src/policy'
import { recommend } from '../src/recommender'

/**
 * D-0056 / #62 acceptance: "Co-Ed Advanced Structured Play" (event 1135589,
 * resurrected 2026-10-06) must book as its own distinct event — never collide
 * with the generic Advanced Open Play (1633147) — on all four standing slots,
 * each on 2 courts. Loads the real repo `policy.json` (not the test fixture)
 * since that's where the resurrected slots live.
 */
const STRUCTURED_PLAY = 1135589
const ADVANCED_OPEN_PLAY = 1633147

describe('Co-Ed Advanced Structured Play (real policy.json)', () => {
  it.each([
    ['Tuesday', '10/13/2026', '17:00'],
    ['Thursday', '10/15/2026', '10:00'],
    ['Saturday', '10/17/2026', '15:00'],
    ['Sunday', '10/18/2026', '10:00'],
  ])('books on %s (%s %s) as its own event, on 2 courts', (_day, date, time) => {
    const policy = loadPolicy()
    const { recommendations } = recommend([], date, policy, { popularity: new Map() })

    const slot = recommendations.find((r) => r.event_id === STRUCTURED_PLAY && r.start.formatHm() === time)
    expect(slot).toBeDefined()
    expect(slot!.level).toBe('Advanced')
    expect(slot!.extra_court_nums).toHaveLength(1) // 2 courts total

    // Did not also book the generic Advanced Open Play at the same slot.
    expect(
      recommendations.some((r) => r.event_id === ADVANCED_OPEN_PLAY && r.start.formatHm() === time),
    ).toBe(false)
  })
})
