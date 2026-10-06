import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resolveFixedEvents } from '../src/fixedEvents'
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
