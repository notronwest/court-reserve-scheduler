import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { recommend, recommendLlm, toDict, type ScheduleItem } from '../src/recommender'
import type { Policy } from '../src/policy'
import { savePendingApproval, runScheduler } from '../src/scheduler'
import { resolveFixedEvents } from '../src/fixedEvents'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(FX, name), 'utf8')) as T
const policy = readJson<Policy>('policy.json')
const DATE = '7/13/2026'
const noPop = new Map()

/** Fake Anthropic-like client that returns a fixed book_slots tool call. */
function fakeClient(bookings: unknown[]) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', name: 'book_slots', input: { bookings } }],
        stop_reason: 'tool_use',
      }),
    },
  } as never
}

function throwingClient() {
  return { messages: { create: async () => { throw new Error('api down') } } } as never
}

describe('recommendLlm', () => {
  it('falls back to the rule-based passes when the LLM throws', async () => {
    const ruleBased = recommend([], DATE, policy, { popularity: noPop })
    const llm = await recommendLlm([], DATE, policy, { popularity: noPop, client: throwingClient() })
    expect(llm.stats.rec_source).toBe('fallback')
    expect(llm.recommendations.map(toDict)).toEqual(ruleBased.recommendations.map(toDict))
  })

  it('tags source=llm and keeps only Pass 0 when the LLM returns no bookings', async () => {
    const llm = await recommendLlm([], DATE, policy, { popularity: noPop, client: fakeClient([]) })
    expect(llm.stats.rec_source).toBe('llm')
    // With no LLM bookings, only fixed-event (Pass 0) recs remain — never more than
    // the rule-based path, which additionally runs Pass 1+2.
    const ruleBased = recommend([], DATE, policy, { popularity: noPop })
    expect(llm.recommendations.length).toBeLessThanOrEqual(ruleBased.recommendations.length)
  })

  it('commits a valid LLM booking that survives re-validation', async () => {
    // Borrow a real free-slot placement from the rule-based path, feed it to the LLM.
    const ruleBased = recommend([], DATE, policy, { popularity: noPop })
    const pick = ruleBased.recommendations.find((r) => r.extra_court_nums.length === 0)
    if (!pick) return // date has no single-court rec — skip
    const booking = {
      event_id: pick.event_id,
      court_num: pick.court_num,
      start_time: pick.start.formatHm(),
    }
    const llm = await recommendLlm([], DATE, policy, { popularity: noPop, client: fakeClient([booking]) })
    expect(llm.stats.rec_source).toBe('llm')
    expect(
      llm.recommendations.some(
        (r) => r.event_id === pick.event_id && r.court_num === pick.court_num,
      ),
    ).toBe(true)
  })
})

describe('savePendingApproval', () => {
  let tmp: string
  beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'sched-'))))
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('writes the shape the listener reads', () => {
    const { recommendations, stats } = recommend([], DATE, policy, { popularity: noPop })
    const path = resolve(tmp, 'nested', 'pending_approval.json')
    savePendingApproval(path, DATE, recommendations, stats, 'msg-9')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    expect(data.target_date).toBe(DATE)
    expect(data.message_id).toBe('msg-9')
    expect(typeof data.posted_at).toBe('string')
    expect(data.recommendations).toEqual(recommendations.map(toDict))
    expect(data.stats.rec_source).toBe('rule_based')
  })
})

describe('runScheduler', () => {
  let tmp: string
  beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'sched-'))))
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const scheduleItems: ScheduleItem[] = []
  const FAKE_PROVENANCE = { policy_sha: 'abc1234def', head_sha: 'abc1234def', behind_origin_main: 0 }

  function deps(posted: unknown[]) {
    return {
      cr: {
        schedule: async () => scheduleItems,
        // Mirrors a healthy live read — tests not exercising fixed-events resolution
        // itself shouldn't see a fallback alert mixed into their `posted` assertions.
        fixedEvents: async () => policy.fixed_events?.events ?? [],
      } as never,
      rest: { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never,
      policy,
      pendingPath: resolve(tmp, 'pending_approval.json'),
      stateDir: resolve(tmp, 'state'),
      // Avoid real git/network calls in tests that aren't exercising provenance itself.
      resolveProvenance: () => FAKE_PROVENANCE,
    }
  }

  it('posts recommendations and saves pending (rule-based path, no API)', async () => {
    const posted: unknown[] = []
    const res = await runScheduler(DATE, deps(posted), { llm: false })
    expect(res.stats.rec_source).toBe('rule_based')
    expect(posted.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(resolve(tmp, 'pending_approval.json'))).toBe(true)
  })

  it('dry-run posts a preview but does NOT save pending', async () => {
    const posted: unknown[] = []
    await runScheduler(DATE, deps(posted), { llm: false, dryRun: true })
    expect(posted.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(resolve(tmp, 'pending_approval.json'))).toBe(false)
  })

  it('auto-book books directly, posts a green confirmation, no pending file', async () => {
    const posted: { embeds?: { title?: string }[] }[] = []
    const booked: unknown[] = []
    const d = {
      ...deps(posted),
      cr: {
        schedule: async () => scheduleItems,
        fixedEvents: async () => policy.fixed_events?.events ?? [],
        book: async (r: unknown) => {
          booked.push(r)
          return { success: true, occurrence_id: 111 }
        },
        setCourts: async () => ({ success: true }),
      } as never,
    }
    const res = await runScheduler(DATE, d, { llm: false, autoBook: true })
    expect(res.booked).toBe(res.recommendations.length)
    expect(booked.length).toBe(res.recommendations.length)
    expect(existsSync(resolve(tmp, 'pending_approval.json'))).toBe(false)
    // Confirmation posted (exactly one embed), titled with the booked count.
    expect(posted.length).toBe(1)
    expect(posted[0].embeds?.[0].title).toContain(`Booked ${res.booked}/${res.recommendations.length}`)
    // Durable booking log written too.
    const logged = JSON.parse(readFileSync(resolve(tmp, 'booking_log_7-13-2026.json'), 'utf8'))
    expect(logged.failed).toBe(0)
    expect(logged.results).toHaveLength(res.recommendations.length)
    // Policy provenance recorded alongside the results — so a stale checkout shows up.
    expect(logged.policy_provenance).toEqual(FAKE_PROVENANCE)
  })

  it('auto-book flags a stale checkout: STALE POLICY in the embed, behind_origin_main > 0 in the log', async () => {
    const posted: { embeds?: { title?: string; description?: string }[] }[] = []
    const d = {
      ...deps(posted),
      resolveProvenance: () => ({ policy_sha: 'abc1234def', head_sha: 'ffff000111', behind_origin_main: 3 }),
      cr: {
        schedule: async () => scheduleItems,
        fixedEvents: async () => policy.fixed_events?.events ?? [],
        book: async () => ({ success: true, occurrence_id: 111 }),
        setCourts: async () => ({ success: true }),
      } as never,
    }
    const res = await runScheduler(DATE, d, { llm: false, autoBook: true })
    expect(posted[0].embeds?.[0].description).toContain('STALE POLICY')
    const logged = JSON.parse(readFileSync(resolve(tmp, 'booking_log_7-13-2026.json'), 'utf8'))
    expect(logged.policy_provenance.behind_origin_main).toBeGreaterThan(0)
    expect(res.booked).toBe(res.recommendations.length)
  })

  it('a run with no network tolerance still completes — behind_origin_main null, not thrown', async () => {
    const posted: unknown[] = []
    const d = {
      ...deps(posted),
      resolveProvenance: () => ({ policy_sha: 'abc1234def', head_sha: 'abc1234def', behind_origin_main: null }),
    }
    await expect(runScheduler(DATE, d, { llm: false })).resolves.toBeTruthy()
  })

  it('auto-book confirmation shows failures and the log records them', async () => {
    const posted: { embeds?: { title?: string }[] }[] = []
    let n = 0
    const d = {
      ...deps(posted),
      cr: {
        schedule: async () => scheduleItems,
        fixedEvents: async () => policy.fixed_events?.events ?? [],
        book: async () => {
          n += 1
          return n === 1 ? { success: false, error: 'court busy' } : { success: true, occurrence_id: 1 }
        },
        setCourts: async () => ({ success: true }),
      } as never,
    }
    const res = await runScheduler(DATE, d, { llm: false, autoBook: true })
    expect(res.failed).toBe(1)
    expect(res.booked).toBe(res.recommendations.length - 1)
    expect(posted.length).toBe(1)
    expect(posted[0].embeds?.[0].title).toContain('failed')
    const logged = JSON.parse(readFileSync(resolve(tmp, 'booking_log_7-13-2026.json'), 'utf8'))
    expect(logged.failed).toBe(1)
    expect(
      logged.results.some(
        (r: { success: boolean; error: string | null }) => r.success === false && r.error === 'court busy',
      ),
    ).toBe(true)
  })

  it('a dead schedule fetch posts a Discord alert and rethrows — never exits silently (#50)', async () => {
    const posted: { embeds?: { title?: string; description?: string }[] }[] = []
    const d = {
      ...deps(posted),
      cr: {
        schedule: async () => {
          throw new Error('courtreserve-api GET /schedule -> 500: boom')
        },
        fixedEvents: async () => policy.fixed_events?.events ?? [],
      } as never,
    }
    await expect(runScheduler(DATE, d, { llm: false, autoBook: true })).rejects.toThrow('500')
    expect(posted.length).toBe(1)
    expect(posted[0].embeds?.[0].title).toContain('Schedule fetch failed')
    expect(posted[0].embeds?.[0].description).toContain('boom')
    expect(existsSync(resolve(tmp, 'pending_approval.json'))).toBe(false)
  })

  it('zero recommendations in auto-book mode posts a loud alert (#50)', async () => {
    const posted: { embeds?: { title?: string }[] }[] = []
    // Every court occupied all day — recommend() legitimately has nothing to add.
    const fullDay: ScheduleItem[] = [1, 2, 3, 4].map((n) => ({
      EventId: 999,
      Id: n,
      StartDateTime: '2026-07-13T09:00:00',
      EndDateTime: '2026-07-13T20:00:00',
      Courts: `Court #${n}`,
    }))
    const d = {
      ...deps(posted),
      cr: { schedule: async () => fullDay, fixedEvents: async () => policy.fixed_events?.events ?? [] } as never,
    }
    const res = await runScheduler(DATE, d, { llm: false, autoBook: true })
    expect(res.recommendations.length).toBe(0)
    expect(posted.some((p) => p.embeds?.[0].title?.includes('Zero recommendations'))).toBe(true)
  })

  it('fixed-events API down with a good cache: books from cache and alerts (#62)', async () => {
    const posted: { embeds?: { title?: string; description?: string }[] }[] = []
    const stateDir = resolve(tmp, 'state')
    // Seed a good cache, as a prior successful run would have left behind.
    await resolveFixedEvents({ fixedEvents: async () => policy.fixed_events?.events ?? [] } as never, policy, {
      dir: stateDir,
    })

    const d = {
      ...deps(posted),
      stateDir,
      cr: {
        schedule: async () => scheduleItems,
        fixedEvents: async () => {
          throw new Error('courtreserve-api GET /fixed-events -> 500: down')
        },
        book: async () => ({ success: true, occurrence_id: 111 }),
        setCourts: async () => ({ success: true }),
      } as never,
    }
    const res = await runScheduler(DATE, d, { llm: false, autoBook: true })

    expect(res.booked).toBe(res.recommendations.length)
    const alert = posted.find((p) => p.embeds?.[0].title?.includes('Fixed events read failed'))
    expect(alert).toBeDefined()
    expect(alert!.embeds?.[0].description).toContain('booked from cache dated')
  })

  it('fixed-events API down with no cache: falls back to the policy.json seed and alerts (#62)', async () => {
    const posted: { embeds?: { title?: string; description?: string }[] }[] = []
    const d = {
      ...deps(posted),
      stateDir: resolve(tmp, 'no-cache-state'),
      cr: {
        schedule: async () => scheduleItems,
        fixedEvents: async () => {
          throw new Error('courtreserve-api GET /fixed-events -> 500: down')
        },
        book: async () => ({ success: true, occurrence_id: 111 }),
        setCourts: async () => ({ success: true }),
      } as never,
    }
    const res = await runScheduler(DATE, d, { llm: false, autoBook: true })

    expect(res.booked).toBe(res.recommendations.length)
    const alert = posted.find((p) => p.embeds?.[0].title?.includes('Fixed events read failed'))
    expect(alert).toBeDefined()
    expect(alert!.embeds?.[0].description).toContain('no cache available')
  })
})
