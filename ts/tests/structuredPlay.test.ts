import { describe, it, expect } from 'vitest'
import { loadPolicy } from '../src/policy'
import { recommend } from '../src/recommender'

/**
 * D-0056 / #62 acceptance: "Co-Ed Advanced Structured Play" (event 1135589,
 * resurrected 2026-10-06) must book as its own distinct event — never collide
 * with the generic Advanced Open Play (1633147) — on each standing slot. Loads
 * the real repo `policy.json` (not the test fixture) since that's where the
 * resurrected slots live.
 *
 * Tuesday / Thursday / Saturday are unpinned and take 2 courts. SUNDAY is its own
 * case below: Ron moved it to 16:00–18:00 on 2026-10-25 and pinned it to court 4,
 * and a 2-court pattern pinned to ONE court books one court with its cap scaled
 * down (8 -> 4). That asymmetry is deliberate here rather than hidden — whether
 * the slot should hold two courts or one is an open question of Ron's, and this
 * test states what the file says today so the answer has to come back here.
 */
const STRUCTURED_PLAY = 1135589
const ADVANCED_OPEN_PLAY = 1633147

describe('Co-Ed Advanced Structured Play (real policy.json)', () => {
  it.each([
    ['Tuesday', '10/13/2026', '17:00'],
    ['Thursday', '10/15/2026', '10:00'],
    ['Saturday', '10/17/2026', '15:00'],
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

  it('books on Sunday (10/18/2026 16:00) pinned to court 4, which is one court, not two', () => {
    const policy = loadPolicy()
    const { recommendations } = recommend([], '10/18/2026', policy, { popularity: new Map() })

    const slot = recommendations.find(
      (r) => r.event_id === STRUCTURED_PLAY && r.start.formatHm() === '16:00',
    )
    expect(slot).toBeDefined()
    expect(slot!.level).toBe('Advanced')
    expect(slot!.court_num).toBe(4)
    // The pin names ONE court, so `courts: 2` cannot be satisfied and the cap scales.
    expect(slot!.extra_court_nums).toHaveLength(0)

    // Nothing is left behind at the slot it was moved away from.
    expect(
      recommendations.some((r) => r.event_id === STRUCTURED_PLAY && r.start.formatHm() === '10:00'),
    ).toBe(false)
  })
})
