import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resolveFixedEvents, dropExpired } from '../src/fixedEvents'
import type { CourtReserveClient } from '../src/cr/client'
import type { FixedEvent, Policy } from '../src/policy'

const LIVE: FixedEvent[] = [
  { name: 'Live Event', day_of_week: 'Monday', start_time: '09:00', end_time: '11:00' },
]
const SEED: FixedEvent[] = [
  { name: 'Seed Event', day_of_week: 'Tuesday', start_time: '10:00', end_time: '12:00' },
]

const policyWithSeed = (): Policy =>
  ({ fixed_events: { events: SEED } }) as unknown as Policy

function fakeCr(impl: () => Promise<FixedEvent[]>): CourtReserveClient {
  return { fixedEvents: impl } as unknown as CourtReserveClient
}

describe('resolveFixedEvents', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(resolve(tmpdir(), 'fixed-events-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('on a live read: returns the events and writes a cache file', async () => {
    const cr = fakeCr(async () => LIVE)
    const result = await resolveFixedEvents(cr, policyWithSeed(), { dir })

    expect(result.source).toBe('live')
    expect(result.events).toEqual(LIVE)
    expect(result.alert).toBeUndefined()

    const cache = JSON.parse(readFileSync(resolve(dir, 'fixed-events.json'), 'utf8'))
    expect(cache.events).toEqual(LIVE)
    expect(typeof cache.fetched_at).toBe('string')
  })

  it('on failure with a good cache: falls back to the cache and alerts with its date', async () => {
    // Seed a cache as if a prior run succeeded.
    await resolveFixedEvents(fakeCr(async () => LIVE), policyWithSeed(), { dir })

    const cr = fakeCr(async () => {
      throw new Error('courtreserve-api GET /fixed-events -> 500: boom')
    })
    const result = await resolveFixedEvents(cr, policyWithSeed(), { dir })

    expect(result.source).toBe('cache')
    expect(result.events).toEqual(LIVE)
    expect(result.alert).toMatch(/^fixed events read failed — booked from cache dated /)
  })

  it('on failure with no cache: falls back to the policy.json seed and alerts', async () => {
    const cr = fakeCr(async () => {
      throw new Error('courtreserve-api GET /fixed-events -> 500: boom')
    })
    const result = await resolveFixedEvents(cr, policyWithSeed(), { dir })

    expect(result.source).toBe('seed')
    expect(result.events).toEqual(SEED)
    expect(result.alert).toContain('no cache available')
    // Never silently substitutes — the stale fallback is always reported.
    expect(result.alert).toBeTruthy()
    expect(existsSync(resolve(dir, 'fixed-events.json'))).toBe(false)
  })

  it('never throws out of a failed read — always resolves with a fallback', async () => {
    const cr = fakeCr(async () => {
      throw new Error('network down')
    })
    await expect(resolveFixedEvents(cr, policyWithSeed(), { dir })).resolves.toMatchObject({
      source: 'seed',
    })
  })
})

// ── The `until` cutoff (D-0056) ─────────────────────────────────────────────────
// `until` is the retirement switch: the dashboard stamps a date rather than
// deleting the row. The service filters retired rows server-side, but a cache
// written days ago and policy.json's seed do NOT — so the cutoff is re-applied
// on every read, whatever the source. Booking a retired slot off a stale cache
// is precisely how four retired Level Play slots stayed "live".
describe('resolveFixedEvents — the `until` cutoff', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(resolve(tmpdir(), 'fixed-events-until-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const TODAY = '2026-10-08'
  const retired = (until: string | null): FixedEvent => ({
    name: 'Co-Ed 3.75+ Level Play',
    day_of_week: 'Thursday',
    start_time: '17:00',
    end_time: '19:00',
    until,
  })

  it('drops a row whose `until` is before today, on a live read', async () => {
    const cr = fakeCr(async () => [...LIVE, retired('2026-10-01')])
    const result = await resolveFixedEvents(cr, policyWithSeed(), { dir, today: TODAY })

    expect(result.source).toBe('live')
    expect(result.events).toEqual(LIVE)
    expect(result.expired.map((e) => e.name)).toEqual(['Co-Ed 3.75+ Level Play'])
  })

  it('drops a row whose `until` is TODAY — on or before today is retired', async () => {
    const cr = fakeCr(async () => [...LIVE, retired(TODAY)])
    const result = await resolveFixedEvents(cr, policyWithSeed(), { dir, today: TODAY })

    expect(result.events).toEqual(LIVE)
    expect(result.expired).toHaveLength(1)
  })

  it('keeps a row whose `until` is still in the future, and one with no `until`', async () => {
    const cr = fakeCr(async () => [...LIVE, retired('2026-12-25')])
    const result = await resolveFixedEvents(cr, policyWithSeed(), { dir, today: TODAY })

    expect(result.events).toHaveLength(2)
    expect(result.expired).toEqual([])
  })

  it('applies the cutoff to the CACHE too — a slot retired since the cache was written', async () => {
    // A successful run caches the pattern verbatim, including a row that was
    // still live at the time.
    await resolveFixedEvents(fakeCr(async () => [...LIVE, retired('2026-10-05')]), policyWithSeed(), {
      dir,
      today: '2026-10-01',
    })
    const cached = JSON.parse(readFileSync(resolve(dir, 'fixed-events.json'), 'utf8'))
    expect(cached.events).toHaveLength(2) // cached unfiltered, by design

    // Days later the read fails: the retired row must not come back from the cache.
    const result = await resolveFixedEvents(
      fakeCr(async () => {
        throw new Error('courtreserve-api GET /fixed-events -> 500: boom')
      }),
      policyWithSeed(),
      { dir, today: TODAY },
    )
    expect(result.source).toBe('cache')
    expect(result.events).toEqual(LIVE)
    expect(result.expired).toHaveLength(1)
  })

  it('applies the cutoff to the policy.json SEED too', async () => {
    const policy = { fixed_events: { events: [...SEED, retired('2026-09-30')] } } as unknown as Policy
    const result = await resolveFixedEvents(
      fakeCr(async () => {
        throw new Error('down')
      }),
      policy,
      { dir, today: TODAY },
    )
    expect(result.source).toBe('seed')
    expect(result.events).toEqual(SEED)
    expect(result.expired).toHaveLength(1)
    expect(result.alert).toContain('no cache available')
  })

  it('alerts when the pattern resolves to zero active slots, even on a clean live read', async () => {
    // "Everything retired" and "the read quietly returned nothing" look identical
    // to the recommender — so an empty pattern is never silent.
    const cr = fakeCr(async () => [retired('2026-01-01')])
    const result = await resolveFixedEvents(cr, policyWithSeed(), { dir, today: TODAY })

    expect(result.source).toBe('live')
    expect(result.events).toEqual([])
    expect(result.alert).toContain('ZERO active standing patterns')
  })

  it('falls through to the seed when the cache file is corrupt', async () => {
    writeFileSync(resolve(dir, 'fixed-events.json'), '{ not json')
    const result = await resolveFixedEvents(
      fakeCr(async () => {
        throw new Error('down')
      }),
      policyWithSeed(),
      { dir, today: TODAY },
    )
    expect(result.source).toBe('seed')
    expect(result.events).toEqual(SEED)
  })
})

describe('dropExpired', () => {
  it('treats a timestamp-shaped `until` as its date part', () => {
    const { kept, expired } = dropExpired(
      [
        { name: 'a', day_of_week: 'Monday', start_time: '09:00', end_time: '11:00', until: '2026-10-08T00:00:00Z' },
        { name: 'b', day_of_week: 'Monday', start_time: '09:00', end_time: '11:00', until: '2026-10-09T00:00:00Z' },
      ],
      '2026-10-08',
    )
    expect(expired.map((e) => e.name)).toEqual(['a'])
    expect(kept.map((e) => e.name)).toEqual(['b'])
  })
})
